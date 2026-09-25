// Browser checks: the page script, run in a real browser.
//
// scripts/smoke.sh drives the server the way a program does, which cannot see
// whether the page script works, and a page script that quietly did nothing
// shipped because of it. This starts the compiled server on a fresh
// workspace, launches headless Chrome, and drives real pages over the
// DevTools protocol (Node's built-in WebSocket; no dependencies): live
// unread badges, the tab title and favicon, reading across pages,
// @-completion, the account menu, and invite links.
//
// Run from the repository root after a build: node scripts/browser.mjs
// Needs Node 22 or newer, and Chrome or Chromium (CHROME=<path> to choose).

import { spawn, execFileSync } from 'node:child_process';
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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
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
if (!/^#random · /.test(title0)) fail(`the tab title does not name the room and workspace: ${title0}`);
ok('the tab title names the room and the workspace');

await api(bob, 'POST', '/channels/general/messages', { body: 'news in general' });
await waitFor('the #general badge to show 1', async () => (await a1.eval(badgeOf('/c/general'))) === '1');
ok('a new message in another channel updates its badge live');
await waitFor('the title to count it', async () => /^\(1\) #random/.test(await a1.eval('document.title')));
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
await waitFor('the hidden tab’s title to count it', async () => /^\(1\) #general/.test(await a2.eval('document.title')));
if (!(await api(alice, 'GET', '/unread')).rooms.some((r) => r.url === '/c/general')) fail('a hidden tab reported a message read');
ok('a hidden tab counts what arrives in its own room, in its title');
await a2.eval(
  "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); true"
);
await waitFor('the returning tab’s title to clear', async () => /^#general/.test(await a2.eval('document.title')));
await waitFor('the server to hear it was read', async () => !(await api(alice, 'GET', '/unread')).rooms.some((r) => r.url === '/c/general'));
ok('coming back to the tab reads it, and clears the title');

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
