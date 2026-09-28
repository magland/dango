// Browser checks: the page script, run in a real browser.
//
// scripts/smoke.sh drives the server the way a program does, which cannot see
// whether the page script works, and a page script that quietly did nothing
// shipped because of it. This starts the compiled server on a fresh
// workspace, launches headless Chrome, and drives real pages over the
// DevTools protocol (Node's built-in WebSocket; no dependencies): live
// unread badges, the tab title and favicon, reading across pages,
// @-completion, the account menu, notifications, invite links, moving
// between pages in place, and calls, between two pages with Chrome's fake
// camera and microphone.
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
// No STUN servers: the calls below connect on this machine's own addresses,
// and a check should not wait on a server on the internet.
// The per-person limits are a person's pace, and one test account sends
// faster than that; they are raised here, and tested in the unit tests.
fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify({ calls: { stun: [] }, limits: { messagesPerMinute: 200, actionsPerMinute: 300 } }));
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
    '--disable-features=NativeNotifications,SystemNotifications,WebRtcHideLocalIpsWithMdns',
    // A camera and a microphone that exist without hardware, allowed without
    // asking, for the calls; and host candidates as plain addresses rather
    // than mDNS names, which a sandbox may not resolve.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--allow-loopback-in-peer-connection',
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
      const code = { Enter: 13, ArrowDown: 40, ArrowUp: 38, Tab: 9, Escape: 27 }[key];
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
const pasteInto = (text, name = 'image.png', type = 'image/png') => s1.eval(`(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  ${text ? `dt.setData('text/plain', ${JSON.stringify(text)});` : ''}
  const ta = document.querySelector('.composer textarea');
  return !ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`);
if (await pasteInto('A1\tB1\nA2\tB2')) fail('a paste with text in it was taken as an attachment');
if ((await s1.eval("document.querySelector('.composer input[type=file]').files.length")) !== 0) fail('a paste with text in it attached its picture');
if (!(await pasteInto()) || !(await pasteInto())) fail('pasting an image was not taken as an attachment');
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
// A file copied in a file manager arrives with its path as the text; the
// file is what was meant, under its own name.
if (!(await pasteInto('/home/someone/Downloads/cymbal (1).gif', 'cymbal (1).gif', 'image/gif'))) fail('a file pasted with its path was taken as text');
if ((await chosen()).join('|') !== 'cymbal (1).gif') fail(`a file pasted with its path was not attached under its name: ${JSON.stringify(await chosen())}`);
if ((await s1.eval("document.querySelector('.composer textarea').value")) !== '') fail('a file pasted with its path also pasted the path');
await s1.eval("document.querySelector('[data-remove-file]').click(); true");
ok('a file copied in a file manager is attached, not pasted as its path');

// ---- deleting asks first ----

const doomed = (await api(bob, 'POST', '/channels/random/messages', { body: 'delete me' })).id;
await waitFor('the message to arrive', async () => s1.eval(`!!document.getElementById('msg-${doomed}')`));
// The question is the page's own dialog, not the browser's, with the safe
// answer focused.
const asked = () => s1.eval("(() => { const d = document.querySelector('dialog.ask[open]'); return d ? d.textContent : ''; })()");
await s1.eval(`document.querySelector('#msg-${doomed} a[data-delete-message]').click(); true`);
await waitFor('the confirmation to be asked', async () => /Delete this message\?/.test(await asked()));
if (!(await s1.eval("document.activeElement && document.activeElement.hasAttribute('data-ask-cancel')"))) fail('the delete question does not focus Cancel');
await s1.eval("document.querySelector('dialog.ask [data-ask-cancel]').click(); true");
await sleep(500);
if ((await api(bob, 'GET', `/channels/random/messages/${doomed}`)).deleted) fail('a declined confirmation still deleted the message');
if (await asked()) fail('the dialog stayed open after Cancel');
ok('deleting a message asks first, in the page, and declining keeps it');
await s1.eval(`document.querySelector('#msg-${doomed} a[data-delete-message]').click(); true`);
await waitFor('the confirmation to be asked again', async () => /Delete this message\?/.test(await asked()));
await s1.eval("document.querySelector('dialog.ask [data-ask-ok]').click(); true");
await waitFor('the message to be deleted', async () => (await api(bob, 'GET', `/channels/random/messages/${doomed}`)).deleted === true);
await waitFor('the page to show it deleted', async () => /This message was deleted/.test(await s1.eval(`document.getElementById('msg-${doomed}').textContent`)));
ok('accepting deletes it, without leaving the room');

// ---- typing on while a message sends ----
// The text leaves the composer as it is sent, so what is typed meanwhile is
// kept, and Enter pressed again sends it once the first is through.

const bodyOf = async (id) => (await api(bob, 'GET', `/channels/random/messages/${id}`)).body;
const beforeTyping = await lastId();
await s1.eval("document.querySelector('.composer textarea').value = 'first, with a file'; true");
await s1.setFiles('.composer input[type=file]', [bigFile]);
await s1.network({ uploadThroughput: 1024 * 1024 });
await s1.eval("document.querySelector('.composer button[type=submit]').click(); true");
await waitFor('the send to start', async () => s1.eval("document.querySelector('form[data-composer]').hasAttribute('data-busy')"));
if ((await s1.eval("document.querySelector('.composer textarea').value")) !== '') fail('the text stayed in the composer while it was sent');
await s1.eval("document.querySelector('.composer textarea').focus(); true");
await s1.type('second, typed meanwhile');
await s1.key('Enter');
if ((await s1.eval("document.querySelector('.composer textarea').value")) !== 'second, typed meanwhile') fail('what was typed during a send was lost');
await waitFor('both messages to be sent', async () => (await lastId()) === beforeTyping + 2, 20000);
await s1.network({});
if ((await bodyOf(beforeTyping + 1)) !== 'first, with a file' || (await bodyOf(beforeTyping + 2)) !== 'second, typed meanwhile') fail('the two messages were not sent as typed');
await waitFor('the composer to empty', async () => (await s1.eval("document.querySelector('.composer textarea').value")) === '');
ok('text typed while a message sends is kept, and Enter sends it once the first is through');

// ---- a completion that arrives late ----
// The member list is fetched on the first @; if it arrives after the caret
// has left the name, nothing is offered, and Enter does not take text away.

await s1.eval(`(() => {
  members = null;
  const real = window.fetch;
  window.fetch = function (url) {
    if (String(url).indexOf('/assets/users.json') >= 0) return new Promise((r) => setTimeout(r, 600)).then(() => real.apply(window, arguments));
    return real.apply(window, arguments);
  };
  window.dangoRealFetch = real;
  document.querySelector('.composer textarea').focus();
  return true;
})()`);
await s1.type('hi @a');
await s1.type(' and the rest of it');
await sleep(900);
if (!(await s1.eval("document.querySelector('[data-mention-list]').hidden"))) fail('a completion that arrived late was offered after the caret had moved on');
if ((await s1.eval("document.querySelector('.composer textarea').value")) !== 'hi @a and the rest of it') fail('the text changed under a late completion');
await s1.eval("window.fetch = window.dangoRealFetch; document.querySelector('.composer textarea').value = ''; true");
ok('a completion that arrives after the caret has left the name is not offered');

// ---- editing in place ----

const toEdit = (await api(bob, 'POST', '/channels/random/messages', { body: 'to be edited' })).id;
await waitFor('the message to arrive', async () => s1.eval(`!!document.getElementById('msg-${toEdit}')`));
await s1.eval("document.querySelector('.composer textarea').focus(); true");
await s1.key('ArrowUp');
await waitFor('Up to open the last message for editing', async () =>
  (await s1.eval(`(() => { const t = document.querySelector('#msg-${toEdit} form.msg-edit textarea'); return t && document.activeElement === t ? t.value : ''; })()`)) === 'to be edited'
);
if ((await s1.eval('location.pathname')) !== '/c/random') fail('editing left the room');
await s1.eval(`document.querySelector('#msg-${toEdit} form.msg-edit textarea').value = 'edited in place'; true`);
await s1.key('Enter');
await waitFor('the edit to be saved and repainted', async () =>
  s1.eval(`(() => { const li = document.getElementById('msg-${toEdit}'); return !li.querySelector('form.msg-edit') && li.querySelector('.msg-body').textContent.trim() === 'edited in place'; })()`)
);
if ((await bodyOf(toEdit)) !== 'edited in place') fail('the edit made in place was not saved');
ok('Up in an empty composer edits the last message in place, and Enter saves it');

// ---- search, in place: focused, and a result opens at its message ----

await s1.eval("document.querySelector('.side-foot a[href=\"/search\"]').click(); true");
await waitFor('the search page, with its box focused', async () => s1.eval("location.pathname === '/search' && document.activeElement && document.activeElement.name === 'q'"));
ok('the search box has the focus when search opens in place');
await s1.eval("document.activeElement.value = 'edited in place'; document.activeElement.form.requestSubmit(); true");
await waitFor('the result', async () => s1.eval("!!document.querySelector('.search-result .markdown-body')"));
await s1.eval("document.querySelector('.search-result .markdown-body').click(); true");
await waitFor('the room to open at the message, marked', async () =>
  s1.eval(`location.pathname === '/c/random' && location.hash === '#msg-${toEdit}' && document.getElementById('msg-${toEdit}').classList.contains('target')`)
);
ok('clicking a search result opens the room at that message, marked');
if (!(await s1.eval("document.querySelector('[data-theme-name=\"auto\"]').getAttribute('aria-checked') === 'true'"))) fail('the appearance menu does not mark the theme in use after moving in place');
ok('the appearance menu marks the theme in use');
if (!/(UTC|GMT|[A-Z]{2,5}|[+-]\d)/.test(await s1.eval(`document.querySelector('#msg-${toEdit} time').title`))) fail('a message’s tooltip time does not say its time zone');
ok('a message’s tooltip gives its time with the time zone');

// ---- a thread's first reply, in a room whose first message it hangs from ----

await api(owner, 'POST', '/channels', { name: 'threads' });
const parent = (await api(bob, 'POST', '/channels/threads/messages', { body: 'the thread starts here' })).id;
if (parent !== 1) fail(`the new channel's first message is not 1: ${parent}`);
await s1.go('/c/threads/t/1');
await s1.eval("document.querySelector('.composer textarea').focus(); true");
await s1.type('the first reply');
await s1.key('Enter');
await waitFor('the reply to show', async () => (await s1.eval("document.getElementById('msg-list').textContent")).includes('the first reply'));
await sleep(300);
if (!(await s1.eval("document.querySelector('.thread-anchor').textContent")).includes('the thread starts here')) fail('the first reply replaced the message the thread hangs from');
ok('a thread’s first reply is added under the message it hangs from, not over it');

// ---- a new channel's name that is not one ----

await s1.go('/new');
await s1.eval("(() => { const f = document.querySelector('form[action=\"/new\"]'); f.noValidate = true; f.querySelector('#name').value = 'Claude Test!'; f.querySelector('#topic').value = 'kept'; f.requestSubmit(); return true; })()");
await waitFor('the refusal', async () => s1.eval("!!document.querySelector('.form-error')"));
const refill = await s1.eval("(() => { const f = document.querySelector('form[action=\"/new\"]'); return f.querySelector('#name').value + '|' + f.querySelector('#topic').value; })()");
if (refill !== 'claude-test|kept') fail(`a refused channel name emptied the form rather than offering a name: ${refill}`);
ok('a channel name that is not one is offered back as one, and the topic is kept');
await s1.go('/c/random');

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

// ---- who is typing ----
// alice typing in the room shows under bob's composer and not under her own;
// emptying her composer takes it away, and so does sending.

const typingLine = "document.querySelector('[data-typing]').textContent";
await watcher.eval("document.querySelector('.composer textarea').focus(); true");
await watcher.type('half a tho');
await waitFor('bob to see alice typing', async () => (await s1.eval(typingLine)) === 'alice is typing…');
if ((await watcher.eval(typingLine)) !== '') fail('alice was shown herself typing');
ok('someone typing is shown under the composer of everyone else in the room, and not their own');
await watcher.eval("(() => { const t = document.querySelector('.composer textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
await waitFor('the line to clear when alice empties her composer', async () => (await s1.eval(typingLine)) === '');
await watcher.type('a whole thought');
await waitFor('bob to see alice typing again', async () => (await s1.eval(typingLine)) === 'alice is typing…');
await watcher.key('Enter');
await waitFor('the line to clear when alice sends', async () => (await s1.eval(typingLine)) === '');
await waitFor('the message to arrive', async () => (await s1.eval("document.getElementById('msg-list').textContent")).includes('a whole thought'));
ok('the line clears when the composer is emptied, and when the message is sent');

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

// ---- moving between pages in place ----

const nav = await openPage(aliceCookie);
await nav.go('/c/general');
await nav.eval('window.stillHere = true; true');
await nav.eval("document.querySelector('.side-rooms a[href=\"/c/random\"]').click(); true");
await waitFor('#random to be shown', async () => (await nav.eval("location.pathname + '|' + document.querySelector('.room-head h1').textContent")) === '/c/random|#random');
if (!(await nav.eval('window.stillHere === true'))) fail('following a room link reloaded the page');
if ((await nav.eval("document.querySelector('.side-rooms a.current').getAttribute('href')")) !== '/c/random') fail('the sidebar did not mark the new room');
ok('following a link to a room shows it in place, without reloading the page');
await api(bob, 'POST', '/channels/random/messages', { body: 'live after moving' });
await waitFor('a message to arrive live in the room moved to', async () => (await nav.eval("document.getElementById('msg-list').textContent")).includes('live after moving'));
ok('the room moved to streams its messages live');
// A stream that drops is opened again, and what changed while it was down
// (an edit to a message already shown, and a new one) reaches the page.
const beforeDrop = (await api(bob, 'GET', '/channels/random/messages?limit=1')).messages[0];
await nav.eval('roomStream.close(); roomStream.onerror(); true');
await api(bob, 'PATCH', `/channels/random/messages/${beforeDrop.id}`, { body: 'edited while the stream was down' });
await api(bob, 'POST', '/channels/random/messages', { body: 'sent while the stream was down' });
await waitFor('the edit and the new message to reach the page', async () => {
  const text = await nav.eval("document.getElementById('msg-list').textContent");
  return text.includes('edited while the stream was down') && text.includes('sent while the stream was down');
}, 10000);
if (!(await nav.eval('window.stillHere === true'))) fail('catching up after a drop reloaded the page');
ok('a stream opened again after a drop repaints what was edited meanwhile, and adds what was sent');
await nav.eval('history.back(); true');
await waitFor('the back button to bring #general back', async () => (await nav.eval("location.pathname + '|' + document.querySelector('.room-head h1').textContent")) === '/c/general|#general');
if (!(await nav.eval('window.stillHere === true'))) fail('the back button reloaded the page');
ok('the back button brings the previous room back in place');
await nav.eval("document.querySelector('.mute-form button').click(); true");
await waitFor('the bell to show the room muted', async () => nav.eval("document.querySelector('.mute-form button').classList.contains('is-muted')"));
if (!(await nav.eval('window.stillHere === true'))) fail('posting a form reloaded the page');
ok('a form posts and shows its answer in place');
await nav.eval("document.querySelector('.mute-form button').click(); true");
await waitFor('the bell to show the room unmuted', async () => nav.eval("!document.querySelector('.mute-form button').classList.contains('is-muted')"));

// ---- calls ----

const inCallCount = (page) => page.eval("(() => { const s = document.querySelector('.call-dock .call-status'); return s ? s.textContent : ''; })()");
const connectedTo = (page) => page.eval("(() => { const t = document.querySelector('.call-dock .call-tile:not([data-peer=\"self\"])'); if (!t || t.classList.contains('connecting')) return 0; return t.querySelector('video').videoWidth; })()");
const c1 = await openPage(aliceCookie);
await c1.go('/c/general');
await c1.eval('window.stillHere = true; true');
if (!(await c1.eval("getComputedStyle(document.querySelector('[data-call-start]')).display !== 'none'"))) fail('the call button is not shown where the browser can make calls');
await c1.eval("document.querySelector('[data-call-start]').click(); true");
await waitFor('alice to be in the call', async () => (await inCallCount(c1)) === '1 in the call', 10000);
if (!(await c1.eval("!!document.querySelector('.app-main > .room-head + .call-dock.strip')"))) fail('the call is not a strip under the room’s header');
ok('starting a call shows it as a strip under the room’s header');
await waitFor('the timeline to say a call started', async () => c1.eval("!!document.querySelector('#msg-list .call-entry.live')"));
const entry = (await api(alice, 'GET', '/channels/general/messages?limit=1')).messages[0];
if (!entry.call || entry.call.people[0] !== 'alice') fail(`the call's entry does not record it: ${JSON.stringify(entry)}`);
ok('the call has an entry in the timeline, live');

// carol, elsewhere, sees the call beside the room's name
await fresh.go('/c/random');
await waitFor('carol’s sidebar to mark the call', async () => fresh.eval("!document.querySelector('.side-rooms [data-room=\"/c/general\"] [data-room-call]').hidden"));
ok('the sidebar marks a room with a call going on');

const b1 = await openPage(await sessionCookie(bob));
await b1.go('/c/general');
await b1.eval("document.querySelector('#msg-list .call-entry [data-call-join]').click(); true");
await waitFor('both to count two in the call', async () => (await inCallCount(b1)) === '2 in the call' && (await inCallCount(c1)) === '2 in the call', 10000);
await waitFor('alice and bob to connect, with video', async () => (await connectedTo(c1)) > 0 && (await connectedTo(b1)) > 0, 20000);
ok('joining from the timeline connects the two pages, peer to peer, with video');
await c1.eval("document.querySelector('.call-dock [data-call-act=\"settings\"]').click(); true");
await waitFor('the panel to show the connection to bob, direct', async () => (await c1.eval("document.querySelector('[data-call-diag]').textContent")).includes('bob: connected directly'));
if (!(await c1.eval("document.querySelector('[data-call-diag]').textContent")).includes('This browser found its own addresses')) fail('the panel does not say what this browser found');
await c1.eval("document.querySelector('.call-dock [data-call-act=\"settings\"]').click(); true");
ok('the call’s panel shows each connection and the path it took');
const logged = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(workspace, 'call-log.json'), 'utf8'));
  } catch {
    return [];
  }
};
await waitFor('both sides to report the connection', async () => {
  const connected = logged().filter((r) => r.outcome === 'connected');
  return connected.some((r) => r.user === 'alice' && r.with === 'bob') && connected.some((r) => r.user === 'bob' && r.with === 'alice');
}, 10000);
const report = logged().find((r) => r.outcome === 'connected');
if (!report.path || report.path.local === 'relay' || !report.gathered.length) fail(`the report does not say how it connected: ${JSON.stringify(report)}`);
ok('each side reports its connection to the workspace, with the path it took');
await waitFor('the entry to count two', async () => (await c1.eval("document.querySelector('#msg-list .call-entry').textContent")).includes('2 in the call'));
ok('the timeline entry says who is in the call, live');

await c1.eval("document.querySelector('.call-dock [data-call-act=\"mic\"]').click(); true");
await waitFor('bob to see alice’s microphone on', async () => b1.eval("!document.querySelector('.call-dock .call-tile:not([data-peer=\"self\"]) .call-muted')"));
ok('turning the microphone on is shown to the others');

await c1.eval("document.querySelector('.side-rooms a[href=\"/c/random\"]').click(); true");
await waitFor('alice to be in #random with the call floating', async () => (await c1.eval("location.pathname + '|' + !!document.querySelector('body > .call-dock.mini')")) === '/c/random|true');
if (!(await c1.eval('window.stillHere === true'))) fail('moving to another room reloaded the page and ended the call');
await sleep(500);
if (!((await connectedTo(c1)) > 0)) fail('the call dropped when alice moved to another room');
ok('moving to another room keeps the call, floating in the corner');
await c1.eval("document.querySelector('.call-dock [data-call-act=\"size\"]').click(); true");
await waitFor('the call to fill the page', async () => c1.eval("!!document.querySelector('.call-dock.full')"));
await c1.key('Escape');
await waitFor('Escape to put the call back in the corner', async () => c1.eval("!!document.querySelector('.call-dock.mini')"));
ok('the call expands to the full page, and collapses back');
await c1.eval("document.querySelector('.call-dock .call-where').click(); true");
await waitFor('the room’s link to lead back with the call as a strip', async () => (await c1.eval("location.pathname + '|' + !!document.querySelector('.room-head + .call-dock.strip')")) === '/c/general|true');
ok('the call’s link leads back to its room, where it is a strip again');

await b1.eval("document.querySelector('.call-dock [data-call-act=\"leave\"]').click(); true");
await waitFor('alice to be alone in the call', async () => (await inCallCount(c1)) === '1 in the call');
if (await b1.eval("!!document.querySelector('.call-dock')")) fail('leaving left the call on screen');
await c1.eval("document.querySelector('.call-dock [data-call-act=\"leave\"]').click(); true");
await waitFor('the entry to say the call ended', async () => (await b1.eval("document.querySelector('#msg-list .call-entry').textContent")).includes('lasted'));
await waitFor('carol’s sidebar to clear the mark', async () => fresh.eval("document.querySelector('.side-rooms [data-room=\"/c/general\"] [data-room-call]').hidden"));
const ended = (await api(alice, 'GET', '/channels/general/messages?limit=1')).messages[0];
if (!ended.call?.ended || ended.call.people.join() !== 'alice,bob') fail(`the entry does not record the end: ${JSON.stringify(ended.call)}`);
ok('when the last person leaves the call ends, and its entry says who was in it and for how long');

// ---- a meeting, with a guest from outside the workspace ----

const meeting = await api(alice, 'POST', '/meetings', { title: 'Design review', users: ['bob'] });
const m1 = await openPage(aliceCookie);
await m1.go('/c/general');
await m1.eval('window.stillHere = true; true');
const g1 = await openPage(null);
await g1.go(meeting.link.slice(base.length));
if ((await g1.eval('location.hash')) !== '') fail('the guest link’s key was left in the address bar');
if (!(await g1.eval("document.querySelector('[data-meeting-key]').value"))) fail('the guest link’s key was not moved into the form');
ok('a guest link moves its key into the form and out of the address bar');
await g1.eval("document.getElementById('guest-name').value = 'Dana'; document.querySelector('[data-meeting-join] button[type=submit]').click(); true");
await waitFor('the guest to wait in the lobby', async () => (await g1.eval('location.pathname')) === `/m/${meeting.id}/lobby`);
await waitFor('alice, in another room, to be told Dana is waiting', async () => (await m1.eval("document.querySelector('.lobby-notice')?.textContent ?? ''")).includes('Dana is waiting to join Design review'), 10000);
ok('a guest who asks to join is shown to the meeting’s members, whatever page they are on');
await m1.eval("[...document.querySelectorAll('.lobby-notice button')].find((b) => b.textContent === 'Let in').click(); true");
await waitFor('the guest to go on to the meeting', async () => (await g1.eval("location.pathname + '|' + !!document.querySelector('.app.guest-app')")) === `/m/${meeting.id}|true`, 10000);
await waitFor('the notice to go once the guest is in', async () => m1.eval("!document.querySelector('.lobby-notice')"));
if (await g1.eval("!!document.querySelector('.app-side')")) fail('a guest was shown the workspace’s sidebar');
if (!(await g1.eval("document.querySelector('[data-call-start]').disabled"))) fail('a guest could start the meeting’s call');
ok('let in, the guest goes on to the meeting by themselves, sees no sidebar, and cannot start its call');

await m1.eval(`document.querySelector('.side-rooms a[href="/m/${meeting.id}"]').click(); true`);
await waitFor('alice to be in the meeting', async () => (await m1.eval("location.pathname + '|' + (document.querySelector('.room-head h1')?.textContent ?? '')")) === `/m/${meeting.id}|Design review`);
await g1.eval("document.querySelector('.composer textarea').focus(); true");
await g1.type('hello from outside');
await g1.key('Enter');
await waitFor('alice to see the guest’s message, named as a guest', async () => {
  const text = await m1.eval("document.getElementById('msg-list').textContent");
  return text.includes('hello from outside') && text.includes('Dana (guest)');
});
ok('a guest writes in the meeting, and its members see it live, under the name the guest gave');

await m1.eval("document.querySelector('[data-call-start]').click(); true");
await waitFor('alice to be in the meeting’s call', async () => (await inCallCount(m1)) === '1 in the call', 10000);
await waitFor('the guest’s call button to offer the call', async () => g1.eval("!document.querySelector('[data-call-start]').disabled"));
await g1.eval("document.querySelector('[data-call-start]').click(); true");
await waitFor('both to count two in the call', async () => (await inCallCount(m1)) === '2 in the call' && (await inCallCount(g1)) === '2 in the call', 10000);
await waitFor('alice and the guest to connect, with video', async () => (await connectedTo(m1)) > 0 && (await connectedTo(g1)) > 0, 20000);
const guestTile = await m1.eval("document.querySelector('.call-dock .call-tile:not([data-peer=\"self\"]) .call-label').textContent");
if (!guestTile.includes('Dana (guest)')) fail(`the guest's tile does not name them as a guest: ${guestTile}`);
ok('a guest joins the call a member started, peer to peer, with their tile naming them as a guest');
await g1.eval("document.querySelector('.call-dock [data-call-act=\"leave\"]').click(); true");
await waitFor('alice to be alone in the meeting’s call', async () => (await inCallCount(m1)) === '1 in the call');
await m1.eval("document.querySelector('.call-dock [data-call-act=\"leave\"]').click(); true");
await waitFor('the meeting’s call to end', async () => (await m1.eval("document.querySelector('#msg-list .call-entry')?.textContent ?? ''")).includes('lasted'));

// ---- the admin's test of how calls connect ----

const adm = await openPage(await sessionCookie(owner));
await adm.go('/admin');
await waitFor('the test to run', async () => {
  const t = await adm.eval("document.querySelector('[data-relay-results]').textContent");
  return t.includes('No STUN servers are set.') && t.includes('No TURN relay is set');
}, 10000);
if (!(await adm.eval("document.querySelector('.call-log').textContent")).includes('connected directly')) fail('the admin page does not list the call’s connections');
ok('the admin page tests how calls connect, and lists the connections calls made');

console.log('');
console.log(`All ${checks} browser checks passed.`);
ws.close();
process.exit(0);
