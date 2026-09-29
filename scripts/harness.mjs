// What the browser checks share: a fresh workspace served by the compiled
// server, headless Chrome driven over the DevTools protocol (Node's built-in
// WebSocket; no dependencies), and the few helpers a check is written in.
// scripts/browser.mjs checks the page script; scripts/phones.mjs checks the
// layout on the screens of phones.

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dango-browser-'));
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

export function ok(what) {
  checks++;
  console.log(`ok: ${what}`);
}
export function passed() {
  return checks;
}
export function fail(what) {
  console.log(`FAIL: ${what}`);
  const log = path.join(tmp, 'server.log');
  if (fs.existsSync(log)) console.log('--- server log\n' + fs.readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'));
  process.exit(1);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function waitFor(what, fn, ms = 5000) {
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

/** A fresh workspace with the given config.json, served by the compiled server; signed in with the owner token. */
export async function serveWorkspace(config) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify(config));
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
  return { base, workspace, owner, api, sessionCookie };
}

// ---- a browser, driven ----

/** Headless Chrome, and a way to open pages in it against the workspace at base. */
export async function launchChrome(base) {
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
      // even when headless, so the pushes in the checks would pop up on the
      // screen of whoever runs them. Its built-in notifications stay inside
      // the browser, and the checks read them through the service worker
      // either way.
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

  return { send, listeners, openPage, close: () => ws.close() };
}
