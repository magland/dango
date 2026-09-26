// Browser checks: the page script, run in a real browser.
//
// scripts/smoke.sh drives the server the way a program does, which cannot see
// whether the page script works, and a page script that quietly did nothing
// shipped because of it. This starts the compiled server on a fresh
// workspace, launches headless Chrome, and drives real pages over the
// DevTools protocol (Node's built-in WebSocket; no dependencies): live
// unread badges, the tab title and favicon, reading across pages,
// @-completion, the account menu, notifications, and invite links.
//
// Run from the repository root after a build: node scripts/browser.mjs
// Needs Node 22 or newer, and Chrome or Chromium (CHROME=<path> to choose).

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dango-browser-'));
const children = [];
let checks = 0;

function cleanup() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {}
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);

function ok(what) {
  checks++;
  console.log(`ok: ${what}`);
}
function fail(what) {
  console.log(`FAIL: ${what}`);
  const log = path.join(tmp, 'server.log');
  if (fs.existsSync(log)) console.log('--- server log\n' + fs.readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'));
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(what, fn, ms = 5000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  fail(`${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch {}
  }
  fail('no Chrome or Chromium on PATH; set CHROME=<path>');
}

// ---- a workspace, served ----

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace);
const owner = 'dango_browser_owner_token_' + Math.random().toString(16).slice(2);
const server = spawn(process.execPath, ['dist/dango/src/index.js', 'serve', workspace, '--port', String(port)], {
  env: { ...process.env, DANGO_OWNER_TOKEN: owner },
  stdio: ['ignore', fs.openSync(path.join(tmp, 'server.log'), 'w'), fs.openSync(path.join(tmp, 'server.log'), 'a')],
});
children.push(server);
await waitFor('the server to start', async () => (await fetch(`${base}/login`)).ok, 10000);

async function api(token, method, p, body) {
  const r = await fetch(`${base}/api${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
const alice = (await api(owner, 'POST', '/users', { username: 'alice' })).token;
const bob = (await api(owner, 'POST', '/users', { username: 'bob' })).token;
const carolInvite = (await api(owner, 'POST', '/users', { username: 'carol' })).invite;
await api(owner, 'POST', '/channels', { name: 'general' });
await api(owner, 'POST', '/channels', { name: 'random' });
const dm = await api(bob, 'POST', '/dms', { users: ['alice'] });
await api(alice, 'POST', `/dms/${dm.id}/messages`, { body: 'hello bob' });

async function sessionCookie(token) {
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ token, next: '/' }),
    redirect: 'manual',
  });
  const m = /dango_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) fail('signing in did not set a session cookie');
  return m[1];
}
const aliceCookie = await sessionCookie(alice);

// ---- a browser, driven ----

const debugPort = await freePort();
const chrome = spawn(
  findChrome(),
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(tmp, 'chrome')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    // Chrome hands notifications to the desktop's own notification service
    // even when headless, so the pushes below would pop up on the screen of
    // whoever runs this. Its built-in notifications stay inside the browser,
    // and the checks read them through the service worker either way.
    '--disable-features=NativeNotifications,SystemNotifications',
    '--window-size=1200,800',
    'about:blank',
  ],
  { stdio: 'ignore' }
);
children.push(chrome);
const version = await waitFor(
  'Chrome to start',
  async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(),
  15000
);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method) for (const fn of listeners) fn(msg);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** A page in its own browser context (its own cookies), optionally signed in. */
async function openPage(cookie) {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  if (cookie) {
    await send('Network.enable', {}, sessionId);
    await send('Network.setCookie', { name: 'dango_session', value: cookie, url: base }, sessionId);
  }
  const page = {
    sessionId,
    contextId: browserContextId,
    /** Answer every JavaScript dialog (confirm, alert) this page opens from now on, recording its text. */
    answerDialogs(accept) {
      const seen = [];
      listeners.push((msg) => {
        if (msg.method === 'Page.javascriptDialogOpening' && msg.sessionId === sessionId) {
          seen.push(msg.params.message);
          send('Page.handleJavaScriptDialog', { accept }, sessionId);
        }
      });
      return seen;
    },
    async setFiles(selector, files) {
      const { root } = await send('DOM.getDocument', {}, sessionId);
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
      await send('DOM.setFileInputFiles', { nodeId, files }, sessionId);
      await page.eval(`document.querySelector('${selector}').dispatchEvent(new Event('change', { bubbles: true })); true`);
    },
    async network(conditions) {
      await send('Network.enable', {}, sessionId);
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...conditions }, sessionId);
    },
    async go(p) {
      await send('Page.navigate', { url: base + p }, sessionId);
      await waitFor(`${p} to load`, () => page.eval("document.readyState === 'complete'"));
      await sleep(300); // the streams open on DOMContentLoaded
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluation failed');
      return r.result.value;
    },
    async type(text) {
      await send('Input.insertText', { text }, sessionId);
    },
    async key(key) {
      const code = { Enter: 13, ArrowDown: 40, Tab: 9, Escape: 27 }[key];
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code }, sessionId);
      }
    },
  };
  return page;
}

const badgeOf = (url) =>
  `(() => { const b = document.querySelector('.side-rooms [data-room="${url}"] [data-room-badge]'); return b && !b.hidden ? b.textContent + (b.classList.contains('mention') ? '!' : '') : ''; })()`;

// ---- live counts on a page showing another room ----

const a1 = await openPage(aliceCookie);
await a1.go('/c/random');
if (!(await a1.eval("!!document.querySelector('.app')"))) fail('alice is not signed in');
const title0 = await a1.eval('document.title');
if (title0 !== 'dango') fail(`the tab title is not the workspace's name alone: ${title0}`);
ok('the tab title is the workspace’s name, not the room’s');

await api(bob, 'POST', '/channels/general/messages', { body: 'news in general' });
await waitFor('the #general badge to show 1', async () => (await a1.eval(badgeOf('/c/general'))) === '1');
ok('a new message in another channel updates its badge live');
await waitFor('the title to count it', async () => (await a1.eval('document.title')) === '(1) dango');
await waitFor('the favicon to carry a dot', async () =>
  /unread=some/.test(await a1.eval("document.querySelector('link[rel=icon]').getAttribute('href')"))
);
ok('the tab title and favicon count it');

await api(bob, 'POST', `/dms/${dm.id}/messages`, { body: 'psst' });
await waitFor('the DM badge to show 1, urgent', async () => (await a1.eval(badgeOf(`/d/${dm.id}`))) === '1!');
await waitFor('the title to count both', async () => /^\(2\) /.test(await a1.eval('document.title')));
await waitFor('the favicon dot to turn urgent', async () =>
  /unread=urgent/.test(await a1.eval("document.querySelector('link[rel=icon]').getAttribute('href')"))
);
ok('a direct message is counted and marked urgent, in the badge and the favicon');

// ---- reading on one page clears the count on another ----

const a2 = await openPage(aliceCookie);
await a2.go(`/d/${dm.id}`);
await waitFor('the DM badge on the other page to clear', async () => (await a1.eval(badgeOf(`/d/${dm.id}`))) === '');
await waitFor('the other page’s title to drop to 1', async () => /^\(1\) /.test(await a1.eval('document.title')));
ok('reading a room on one page clears its count on another, live');

// ---- the room on screen ----

await a2.go('/c/general');
await waitFor('#general to be read', async () => !(await api(alice, 'GET', '/unread')).rooms.some((r) => r.url === '/c/general'));
await api(bob, 'POST', '/channels/general/messages', { body: 'while alice watches' });
await waitFor('the message to appear', async () => (await a2.eval("document.getElementById('msg-list').textContent")).includes('while alice watches'));
await waitFor('the server to hear it was read', async () => !(await api(alice, 'GET', '/unread')).rooms.some((r) => r.url === '/c/general'));
if ((await a2.eval(badgeOf('/c/general'))) !== '') fail('the room on screen showed a badge for a message being read');
ok('a message arriving in the room on screen is read, and reported read');

await a2.eval(
  "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); true"
);
await api(bob, 'POST', '/channels/general/messages', { body: 'while alice is away' });
await waitFor('the hidden tab’s title to count it', async () => (await a2.eval('document.title')) === '(1) dango');
if (!(await api(alice, 'GET', '/unread')).rooms.some((r) => r.url === '/c/general')) fail('a hidden tab reported a message read');
ok('a hidden tab counts what arrives in its own room, in its title');
await a2.eval(
  "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); true"
);
await waitFor('the returning tab’s title to clear', async () => (await a2.eval('document.title')) === 'dango');
await waitFor('the server to hear it was read', async () => !(await api(alice, 'GET', '/unread')).rooms.some((r) => r.url === '/c/general'));
ok('coming back to the tab reads it, and clears the title');

// A visible page nobody has touched in a while is not being read: it counts
// what arrives, and the server is not told it was read (so the phone is
// notified), until someone is back at it. The idle clock is wound back rather
// than waited out.
await a2.eval('lastActive = Date.now() - 10 * 60 * 1000; true');
await api(bob, 'POST', '/channels/general/messages', { body: 'while alice is at lunch' });
await waitFor('the message to appear', async () => (await a2.eval("document.getElementById('msg-list').textContent")).includes('at lunch'));
await waitFor('the unattended tab’s title to count it', async () => (await a2.eval('document.title')) === '(1) dango');
await sleep(300);
if (!(await api(alice, 'GET', '/unread')).rooms.some((r) => r.url === '/c/general')) fail('a visible but unattended tab reported a message read');
ok('a visible tab nobody has used in a while counts what arrives, and does not report it read');
await a2.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' })); true");
await waitFor('the title to clear once someone is back', async () => (await a2.eval('document.title')) === 'dango');
await waitFor('the server to hear it was read', async () => !(await api(alice, 'GET', '/unread')).rooms.some((r) => r.url === '/c/general'));
ok('the first key pressed on returning reads it, and clears the title');

// ---- @-completion ----

await a2.eval("document.querySelector('.composer textarea').focus(); true");
await a2.type('hi @b');
await waitFor('the completion list to offer bob', async () =>
  (await a2.eval("(() => { const l = document.querySelector('[data-mention-list]'); return l && !l.hidden ? l.textContent : ''; })()")).includes('@bob')
);
await a2.key('Enter');
const typed = await a2.eval("document.querySelector('.composer textarea').value");
if (typed !== 'hi @bob ') fail(`Enter did not complete the mention: ${JSON.stringify(typed)}`);
ok('typing @ offers members, and Enter completes the name');

// ---- the account menu ----

await a2.eval("document.querySelector('.side-user').click(); true");
const box = await a2.eval(
  "(() => { const r = document.querySelector('.user-menu .dropdown-menu').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, open: document.querySelector('.user-menu').open }; })()"
);
if (!box.open || box.top < 0 || box.bottom > box.h) fail(`the account menu is not on screen: ${JSON.stringify(box)}`);
ok('clicking your name opens the account menu, entirely on screen');

// ---- sending: one message per send, however often the button is pressed ----

const s1 = await openPage(await sessionCookie(bob));
await s1.go('/c/random');
const lastId = async () => (await api(bob, 'GET', '/channels/random/messages?limit=1')).messages[0]?.id ?? 0;
const beforeSend = await lastId();
const bigFile = path.join(tmp, 'recording.bin');
fs.writeFileSync(bigFile, Buffer.alloc(3 * 1024 * 1024, 7));
await s1.eval("document.querySelector('.composer textarea').value = 'a slow upload'; true");
await s1.setFiles('.composer input[type=file]', [bigFile]);
if (!/recording\.bin\s*3\.0 MB/.test(await s1.eval("document.querySelector('[data-file-list]').textContent"))) fail('the composer does not show the chosen file’s name and size');
ok('choosing a file shows its name and size under the text');
// About a megabyte a second, so the upload lasts long enough to press again.
await s1.network({ uploadThroughput: 1024 * 1024 });
await s1.eval("document.querySelector('.composer button[type=submit]').click(); true");
await waitFor('the composer to lock and show progress', async () =>
  s1.eval("document.querySelector('.composer button[type=submit]').disabled && /Uploading/.test(document.querySelector('[data-send-status]').textContent)")
);
ok('while sending, the button is disabled and the upload’s progress is shown');
await s1.eval("document.querySelector('form[data-composer]').requestSubmit(); true");
await s1.eval("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true");
await waitFor('the send to finish', async () => s1.eval("!document.querySelector('form[data-composer]').hasAttribute('data-busy')"), 20000);
await s1.network({});
if ((await lastId()) !== beforeSend + 1) fail(`pressing Send again during an upload sent more than once (${beforeSend} -> ${await lastId()})`);
if ((await s1.eval("document.querySelector('.composer textarea').value")) !== '') fail('the composer was not cleared after sending');
ok('submitting and pressing Enter again during the upload still sends once');
await waitFor('the attachment’s size to show on the message', async () =>
  /3\.0 MB/.test(await s1.eval("document.getElementById('msg-list').lastElementChild.textContent"))
);
ok('the sent attachment shows its size');

await s1.eval("document.querySelector('.composer textarea').value = 'sent while offline'; true");
await s1.network({ offline: true });
await s1.eval("document.querySelector('.composer button[type=submit]').click(); true");
await waitFor('the failure to be shown', async () =>
  /Not sent: the connection/.test(await s1.eval("document.querySelector('[data-send-status]').textContent"))
);
if ((await s1.eval("document.querySelector('.composer textarea').value")) !== 'sent while offline') fail('a failed send lost the text');
if (await s1.eval("document.querySelector('.composer button[type=submit]').disabled")) fail('a failed send left the button disabled');
ok('a send that fails keeps the message, says why, and can be sent again');
await s1.network({});
const beforeRetry = await lastId();
await s1.eval("document.querySelector('.composer button[type=submit]').click(); true");
await waitFor('the retry to go through', async () => (await lastId()) === beforeRetry + 1);
ok('sending again after the failure delivers it once');

fs.writeFileSync(path.join(tmp, 'huge.bin'), Buffer.alloc(21 * 1024 * 1024));
await s1.eval("document.querySelector('.composer textarea').value = 'too big'; true");
await s1.setFiles('.composer input[type=file]', [path.join(tmp, 'huge.bin')]);
const beforeHuge = await lastId();
await s1.eval("document.querySelector('.composer button[type=submit]').click(); true");
await waitFor('the size refusal', async () => /at most 20\.0 MB/.test(await s1.eval("document.querySelector('[data-send-status]').textContent")));
await sleep(300);
if ((await lastId()) !== beforeHuge) fail('an oversized attachment was sent');
ok('attachments over 20 MB are refused before any of it is uploaded');
await s1.eval("document.querySelector('[data-remove-file]').click(); true");
if ((await s1.eval("document.querySelector('.composer input[type=file]').files.length")) !== 0) fail('removing the only file left it chosen');
if (!(await s1.eval("document.querySelector('[data-file-list]').hidden"))) fail('the file list stayed after its last file was removed');

// A screenshot pasted into the composer becomes an attachment with a name of
// its own; a paste that carries text as well stays text.
const pasteInto = (withText) => s1.eval(`(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
  ${withText ? "dt.setData('text/plain', 'cells');" : ''}
  const ta = document.querySelector('.composer textarea');
  return !ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`);
if (await pasteInto(true)) fail('a paste with text in it was taken as an attachment');
if ((await s1.eval("document.querySelector('.composer input[type=file]').files.length")) !== 0) fail('a paste with text in it attached its picture');
if (!(await pasteInto(false)) || !(await pasteInto(false))) fail('pasting an image was not taken as an attachment');
const pasted = await s1.eval("Array.from(document.querySelector('.composer input[type=file]').files).map((f) => f.name)");
if (pasted.length !== 2 || !pasted.every((n) => /^Pasted image .*\.png$/.test(n)) || pasted[0] === pasted[1]) fail(`pasted images were not attached under names of their own: ${JSON.stringify(pasted)}`);
if (!/^2 files, /.test(await s1.eval("document.querySelector('[data-file-total]').textContent"))) fail('pasted images are not counted beside the picker');
if ((await s1.eval("document.querySelectorAll('[data-file-list] img').length")) !== 2) fail('pasted images are not shown as pictures');
// Choosing with the paperclip adds to what was pasted, and one file can be
// taken out and leave the rest.
const note = path.join(tmp, 'notes.txt');
fs.writeFileSync(note, 'notes');
await s1.setFiles('.composer input[type=file]', [note]);
const chosen = async () => s1.eval("Array.from(document.querySelector('.composer input[type=file]').files).map((f) => f.name)");
if ((await chosen()).join('|') !== [...pasted, 'notes.txt'].join('|')) fail(`choosing a file did not add it to the pasted ones: ${JSON.stringify(await chosen())}`);
await s1.eval("document.querySelectorAll('[data-remove-file]')[1].click(); true");
if ((await chosen()).join('|') !== [pasted[0], 'notes.txt'].join('|')) fail(`removing one file did not leave the others: ${JSON.stringify(await chosen())}`);
if ((await s1.eval("document.querySelectorAll('[data-file-list] li').length")) !== 2) fail('the file list does not match what is chosen');
ok('choosing adds to what is there, and one file can be removed, leaving the rest');
const beforePaste = await lastId();
await s1.eval("document.querySelector('.composer textarea').value = 'a screenshot'; document.querySelector('.composer button[type=submit]').click(); true");
await waitFor('the pasted images to be sent', async () => (await lastId()) === beforePaste + 1);
const sentFiles = ((await api(bob, 'GET', '/channels/random/messages?limit=1')).messages[0].files ?? []).map((f) => f.name);
if (sentFiles.join('|') !== [pasted[0], 'notes.txt'].join('|')) fail(`what was sent is not what was shown: ${JSON.stringify(sentFiles)}`);
if (!(await s1.eval("document.querySelector('[data-file-list]').hidden && document.querySelector('.composer input[type=file]').files.length === 0"))) fail('the files stayed chosen after sending');
ok('pasting an image attaches it under its own name, and a paste with text stays text');

// ---- deleting asks first ----

const doomed = (await api(bob, 'POST', '/channels/random/messages', { body: 'delete me' })).id;
await waitFor('the message to arrive', async () => s1.eval(`!!document.getElementById('msg-${doomed}')`));
const declined = s1.answerDialogs(false);
await s1.eval(`document.querySelector('#msg-${doomed} a[data-delete-message]').click(); true`);
await waitFor('the confirmation to be asked', async () => declined.length === 1);
await sleep(500);
if ((await api(bob, 'GET', `/channels/random/messages/${doomed}`)).deleted) fail('a declined confirmation still deleted the message');
ok('deleting a message asks first, and declining keeps it');
listeners.length = 0;
s1.answerDialogs(true);
await s1.eval(`document.querySelector('#msg-${doomed} a[data-delete-message]').click(); true`);
await waitFor('the message to be deleted', async () => (await api(bob, 'GET', `/channels/random/messages/${doomed}`)).deleted === true);
await waitFor('the page to show it deleted', async () => /This message was deleted/.test(await s1.eval(`document.getElementById('msg-${doomed}').textContent`)));
ok('accepting deletes it, without leaving the room');

// ---- pinning, live on another page ----

const pinned = (await api(bob, 'POST', '/channels/random/messages', { body: 'pin me, and see https://example.com/page' })).id;
const watcher = await openPage(aliceCookie);
await watcher.go('/c/random');
await waitFor('the message to show', async () => s1.eval(`!!document.getElementById('msg-${pinned}')`));
await s1.eval(`document.querySelector('#msg-${pinned} form[action$="/pin"] button').click(); true`);
await waitFor('the pinned marker on the pinner’s page', async () => /Pinned by bob/.test(await s1.eval(`document.getElementById('msg-${pinned}').textContent`)));
await waitFor('the pinned marker on another page, live', async () => /Pinned by bob/.test(await watcher.eval(`document.getElementById('msg-${pinned}').textContent`)));
await waitFor('the header count on another page, live', async () => (await watcher.eval("document.querySelector('[data-pin-count]').textContent")) === '1');
ok('pinning marks the message and counts it in the header, live on every open page');
await watcher.eval(`document.querySelector('#msg-${pinned} form[action$="/unpin"] button').click(); true`);
await waitFor('the unpin to reach the other page', async () => (await s1.eval("document.querySelector('[data-pin-count]').textContent")) === '');
ok('anyone in the room can unpin, and every page hears it');
const link = await watcher.eval(`(() => { const a = document.querySelector('#msg-${pinned} .msg-body a[href^="https://example.com"]'); return a ? a.target + ' ' + a.rel : ''; })()`);
if (!/^_blank .*noopener/.test(link)) fail(`a link out of the workspace does not open in a new tab: ${link}`);
ok('a link out of the workspace opens in a new tab');

// ---- notifications ----
// No push service is reachable from here, so the push itself is handed to
// the service worker over the DevTools protocol, which is the same event a
// push service's message raises: what is checked is the worker's own code.

const n1 = await openPage(aliceCookie);
await send('Browser.grantPermissions', { permissions: ['notifications'], origin: base, browserContextId: n1.contextId });
const registrations = [];
listeners.push((msg) => {
  if (msg.method === 'ServiceWorker.workerRegistrationUpdated' && msg.sessionId === n1.sessionId) registrations.push(...msg.params.registrations);
});
await send('ServiceWorker.enable', {}, n1.sessionId);
await n1.go('/account');
await waitFor('the service worker to be active', () => n1.eval("navigator.serviceWorker.getRegistration('/').then((r) => !!(r && r.active))"));
ok('a signed-in page registers the service worker');
await waitFor('the device status', async () => /off in this browser/.test(await n1.eval("document.querySelector('[data-push-status]').textContent")));
if (await n1.eval("document.querySelector('[data-push-on]').hidden")) fail('the account page offers no way to turn notifications on');
ok('the account page says notifications are off here, and offers to turn them on');
// The list of devices marks the one that is this browser. No push service
// is reachable to subscribe for real, so a row is made with the id the
// server gives an endpoint (deviceId in notify.ts), and the page is asked to
// find it from the endpoint the way it does for its own subscription.
const endpoint = 'https://push.example.org/send/abc123';
const devId = createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
await n1.eval(`document.body.insertAdjacentHTML('beforeend', '<ul><li data-device="${devId}"><span>Chrome on Linux</span></li></ul>'); markThisDevice('${endpoint}'); true`);
await waitFor('this browser to be marked in the list', () => n1.eval(`!!document.querySelector('[data-device="${devId}"] .this-device')`));
ok('the list of devices says which one is this browser');
const zone = await n1.eval("document.querySelector('[data-tz-fill]').value");
if (zone !== (await n1.eval('Intl.DateTimeFormat().resolvedOptions().timeZone'))) fail(`the quiet hours' time zone was not filled from the browser: ${zone}`);
ok("the quiet hours' time zone is filled in from the browser");
const reg = await waitFor('the registration to be reported', async () => registrations.find((r) => r.scopeURL === base + '/' && !r.isDeleted));
// A real click, as the browser counts one, so the page may make sound.
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: 600, y: 700, button: 'left', clickCount: 1 }, n1.sessionId);
}
await waitFor('the page’s audio to start', () => n1.eval("!!audio && audio.state === 'running'"));
await send(
  'ServiceWorker.deliverPushMessage',
  {
    origin: base,
    registrationId: reg.registrationId,
    data: JSON.stringify({ title: '#general', body: 'bob: lunch?', tag: '/c/general', url: '/c/general', unread: 2, time: Date.now() }),
  },
  n1.sessionId
);
const shown = await waitFor('the notification to show', () =>
  n1.eval(
    "navigator.serviceWorker.getRegistration('/').then((r) => r.getNotifications()).then((ns) => (ns.length ? ns.map((n) => [n.title, n.body, n.tag, n.data && n.data.url].join('|')) : null))"
  )
);
if (shown[0] !== '#general|bob: lunch?|/c/general|/c/general') fail(`the notification was not what the push said: ${JSON.stringify(shown)}`);
ok('a push shows a notification naming the room and the message, and where pressing it goes');
if ((await n1.eval('chimes')) !== 1) fail(`the open tab did not chime once for the push: ${await n1.eval('chimes')}`);
if (!(await n1.eval("navigator.serviceWorker.getRegistration('/').then((r) => r.getNotifications()).then((ns) => ns[0].silent)")))
  fail('the notification made a sound of its own beside the chime');
ok('an open tab plays the chime, and the notification is shown silent so there is one sound');
await n1.eval("localStorage.setItem('dango.chime', 'off'); true");
await send(
  'ServiceWorker.deliverPushMessage',
  { origin: base, registrationId: reg.registrationId, data: JSON.stringify({ title: '#general', body: 'bob: again', tag: '/c/general', url: '/c/general', time: Date.now() }) },
  n1.sessionId
);
await waitFor('the second notification', () =>
  n1.eval("navigator.serviceWorker.getRegistration('/').then((r) => r.getNotifications()).then((ns) => ns.length && ns[0].body === 'bob: again')")
);
if ((await n1.eval('chimes')) !== 1) fail('the tab chimed with the chime turned off');
if (await n1.eval("navigator.serviceWorker.getRegistration('/').then((r) => r.getNotifications()).then((ns) => ns[0].silent)"))
  fail('with the chime off, the notification was silenced anyway');
ok('with the chime turned off, the notification keeps the system’s sound');

// ---- the list as it reads ----

await api(owner, 'POST', '/channels', { name: 'runs' });
await api(bob, 'POST', '/channels/runs/messages', { body: 'run one, in #runs' });
const r1 = await openPage(aliceCookie);
await r1.go('/c/runs'); // alice has read up to "run one"
await r1.go('/search'); // and looks away, so what comes next waits for her
await api(bob, 'POST', '/channels/runs/messages', { body: 'run two' });
await api(bob, 'POST', '/channels/runs/messages', { body: 'run three' });
await r1.go('/c/runs');
const shape = await r1.eval(`(() => {
  const items = [...document.querySelectorAll('#msg-list > li')];
  return items.map((li) => li.classList.contains('new-rule') ? 'new' : li.classList.contains('day-rule') ? 'day'
    : (li.classList.contains('msg-cont') ? '+' : '') + li.querySelector('.msg-body').textContent.trim()).join(' / ');
})()`);
if (shape !== 'day / run one, in #runs / new / run two / +run three') fail(`the list does not read as it should: ${shape}`);
ok('what is unread begins under a "New" rule, and a run from one person is drawn as one');
if (!(await r1.eval(`!!document.querySelector('#msg-list a[href="/c/runs"]')`))) fail('a channel named in a message is not a link to it');
ok('a channel named in a message links to the channel');
const atBottom = await r1.eval("(() => { const p = document.querySelector('.msgs'); return p.scrollHeight - p.scrollTop - p.clientHeight < 2; })()");
if (!atBottom) fail('the room did not open at its newest message');
if (!/^\d{1,2}:\d\d/.test(await r1.eval("document.querySelector('#msg-list .msg-head time').textContent"))) fail('a message’s time is not the time of day');
ok('a room opens at its newest message, with times of day');
await api(bob, 'POST', '/channels/runs/messages', { body: 'run four' });
await waitFor('the live message to continue the run', () =>
  r1.eval("(() => { const li = [...document.querySelectorAll('#msg-list > .msg')].pop(); return li.textContent.includes('run four') && li.classList.contains('msg-cont'); })()")
);
ok('a message arriving live continues its author’s run');

// On a touch screen Enter is a new line: a phone's keyboard has no Shift+Enter.
const t1 = await openPage(aliceCookie);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, t1.sessionId);
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, t1.sessionId);
await t1.go('/c/runs');
const beforeEnter = (await api(alice, 'GET', '/channels/runs/messages?limit=1')).messages[0].id;
await t1.eval("document.querySelector('.composer textarea').focus(); true");
await t1.type('line one');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, t1.sessionId);
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, t1.sessionId);
await t1.type('line two');
await sleep(300);
if ((await t1.eval("document.querySelector('.composer textarea').value")) !== 'line one\nline two') fail('Enter on a touch screen did not make a new line');
if ((await api(alice, 'GET', '/channels/runs/messages?limit=1')).messages[0].id !== beforeEnter) fail('Enter on a touch screen sent the message');
ok('on a touch screen Enter makes a new line, and Send sends');

// ---- an invite link ----

const fresh = await openPage(null);
await fresh.go(carolInvite.slice(base.length));
const filled = await fresh.eval("document.getElementById('token').value");
if (!filled.startsWith('dango_')) fail('the invite did not fill in the token');
if ((await fresh.eval('location.hash')) !== '') fail('the token was left in the address bar');
ok('an invite link fills in the token and clears it from the address bar');
await fresh.eval("document.querySelector('[data-invite] button[type=submit]').click(); true");
await waitFor('carol to be signed in', async () => (await fresh.eval("document.querySelector('.whoami')?.textContent ?? ''")) === 'carol');
ok('one press of the button signs the invited person in');

console.log('');
console.log(`All ${checks} browser checks passed.`);
ws.close();
process.exit(0);
