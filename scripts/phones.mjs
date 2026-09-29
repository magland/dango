// Phone checks: the layout on the screens of phones, in headless Chrome.
//
// A phone's screen is not the rectangle a desktop browser's device mode
// draws. Its corners are rounded, a camera cuts into the top (a notch, an
// island, a hole), the status bar sits over the top edge and the home
// indicator over the bottom one, and a page drawn edge to edge (a Home Screen
// app, or Safari with its toolbar floating over the page) is drawn under all
// of them. The browser says how much of each edge is covered through the
// safe-area insets, env(safe-area-inset-*), and a page is only clear of
// those parts of the screen if it pads itself by them.
//
// This emulates each phone below at its size and pixel density, with its
// insets set through the DevTools protocol, and checks every control on the
// main pages: nothing a person reads or taps (links, buttons, fields,
// headings) may sit under the status bar or the camera, under the home
// indicator, or outside the rounded corners, and no page may scroll
// sideways. Each phone is tried as a Home Screen app in portrait, with the
// keyboard up, and in landscape.
//
// What it models, and what it does not:
// - The phones' sizes, insets, corner radii, and cameras are taken from
//   Apple's and Google's published figures, rounded; a corner is drawn as a
//   circular arc, where the real one is a smoother curve a little inside it.
// - iOS reports the insets only to a page that asks to be drawn under them
//   (viewport-fit=cover in its viewport tag); Chrome reports them to any
//   page. So a page without it is checked with no insets reported but the
//   whole screen to fill, which is the edge-to-edge case the check is for.
// - The keyboard is modeled as the screen made shorter by its height, as iOS
//   shows it to the page, which goes on reporting the home indicator's inset
//   although the keyboard now covers it; the composer is expected to sit on
//   the keyboard rather than that far above it. Safari's own toolbars are
//   not drawn.
// It catches a layout that ignores the phone's edges, on every build. It is
// not Safari: WebKit's own rendering, and how its toolbars come and go, are
// still for the iOS Simulator or a phone to show.
//
// Run from the repository root after a build: node scripts/phones.mjs
//   --shots <dir>      also write a screenshot of each case, the phone's
//                      corners, camera, status bar, and home indicator drawn
//                      over it, and an index.html to look through them
//   --device <text>    only the phones whose name contains the text
// Needs Node 22 or newer, and Chrome or Chromium (CHROME=<path> to choose).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, passed, sleep, waitFor, serveWorkspace, launchChrome } from './harness.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const shots = argOf('--shots');
const only = argOf('--device');

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

// Sizes in CSS pixels, portrait. The insets are what the phone reports to a
// page drawn under its edges: in portrait the status bar (with the camera in
// it) and the home indicator, in landscape the camera's side, the side
// opposite it, and the home indicator. The keyboard's height includes its
// row of suggestions.
const PHONES = [
  { name: 'iPhone SE', w: 375, h: 667, dpr: 2, radius: 0, camera: null, portrait: { top: 20, bottom: 0 }, landscape: { left: 0, right: 0, bottom: 0 }, keyboard: 260, ua: IOS_UA },
  { name: 'iPhone 13 mini', w: 375, h: 812, dpr: 3, radius: 44, camera: { kind: 'notch', w: 162, h: 32, y: 0 }, portrait: { top: 50, bottom: 34 }, landscape: { left: 50, right: 50, bottom: 21 }, keyboard: 336, ua: IOS_UA },
  { name: 'iPhone 14', w: 390, h: 844, dpr: 3, radius: 47, camera: { kind: 'notch', w: 162, h: 34, y: 0 }, portrait: { top: 47, bottom: 34 }, landscape: { left: 47, right: 47, bottom: 21 }, keyboard: 336, ua: IOS_UA },
  { name: 'iPhone 16', w: 393, h: 852, dpr: 3, radius: 55, camera: { kind: 'island', w: 126, h: 37, y: 11 }, portrait: { top: 59, bottom: 34 }, landscape: { left: 59, right: 59, bottom: 21 }, keyboard: 336, ua: IOS_UA },
  { name: 'iPhone 17 Pro Max', w: 440, h: 956, dpr: 3, radius: 62, camera: { kind: 'island', w: 126, h: 37, y: 14 }, portrait: { top: 62, bottom: 34 }, landscape: { left: 62, right: 62, bottom: 21 }, keyboard: 346, ua: IOS_UA },
  { name: 'Pixel 8', w: 412, h: 915, dpr: 2.625, radius: 40, camera: { kind: 'hole', w: 24, h: 24, y: 14 }, portrait: { top: 48, bottom: 24 }, landscape: { left: 48, right: 0, bottom: 24 }, keyboard: 320, ua: ANDROID_UA },
].filter((p) => !only || p.name.toLowerCase().includes(only.toLowerCase()));

// ---- a workspace with something in it ----

const { base, owner, api, sessionCookie } = await serveWorkspace({ calls: { stun: [] }, limits: { messagesPerMinute: 0, messagesPerHour: 0, actionsPerMinute: 0 } });
const alice = (await api(owner, 'POST', '/users', { username: 'alice' })).token;
const bob = (await api(owner, 'POST', '/users', { username: 'bob' })).token;
await api(owner, 'POST', '/channels', { name: 'general', topic: 'Plans, questions, and the occasional photo of lunch' });
await api(owner, 'POST', '/channels', { name: 'random' });
await api(owner, 'POST', '/channels', { name: 'a-channel-with-a-rather-long-name-indeed' });
const lines = [
  'Morning. Is the review still on for Thursday?',
  'Yes, 10am. I will send the agenda this afternoon.',
  'The new build is up on staging if anyone wants to try it before then; the upload bug from last week should be gone, and the search page is faster on large rooms.',
  'Here is the command I used:\n\n```\nnpm run build && node dist/dango/src/index.js serve example-root --port 3000\n```',
  'A link that does not break nicely: https://example.com/a/very/long/path/that/goes/on/and/on/without/any/spaces/at/all/index.html',
  'Lunch?',
  'Sure. 12:30 at the usual place.',
];
let first;
for (let i = 0; i < 28; i++) {
  const m = await api(i % 2 ? bob : alice, 'POST', '/channels/general/messages', { body: lines[i % lines.length] });
  first ??= m.id;
}
for (const body of ['Replying in a thread.', 'And again, a little longer this time, so the reply wraps onto a second line on a phone.']) {
  await api(bob, 'POST', `/channels/general/threads/${first}/messages`, { body });
}
const dm = await api(bob, 'POST', '/dms', { users: ['alice'] });
await api(bob, 'POST', `/dms/${dm.id}/messages`, { body: 'Do you have a minute to talk about the review?' });
await api(alice, 'POST', `/dms/${dm.id}/messages`, { body: 'In ten minutes, yes.' });
const aliceCookie = await sessionCookie(alice);

// The pages checked in portrait. A page may pass through states, each
// checked in turn: a call started in a room is a strip under its header,
// floats in a corner once another room is open,
// then fills the screen. With the keyboard up the
// room is what matters, its composer focused; in landscape a phone is wide
// enough for the sidebar beside the room.
const click = (sel) => (page) => page.eval(`document.querySelector('${sel}').click(); true`);
const until = (what, expr) => (page) => waitFor(what, () => page.eval(expr), 10000);
const CALL = [
  { name: 'call', steps: [click('[data-call-start]'), until('the call to start', "!!document.querySelector('.call-dock.strip .call-tile')")] },
  { name: 'call-mini', steps: [click('.side-rooms a[href="/c/general"]'), until('the call to float in the corner', "location.pathname === '/c/general' && !!document.querySelector('.call-dock.mini')")] },
  { name: 'call-full', steps: [click('.call-dock [data-call-act="size"]'), until('the call to fill the screen', "!!document.querySelector('.call-dock.full')")] },
];
const leaveCall = [click('.call-dock [data-call-act="leave"]'), until('the call to end', "!document.querySelector('.call-dock')")];
const PAGES = [
  { name: 'sign-in', path: '/login', signedOut: true },
  { name: 'rooms', path: '/' },
  { name: 'channel', path: '/c/general', room: true },
  { name: 'thread', path: `/c/general/t/${first}`, room: true },
  { name: 'dm', path: `/d/${dm.id}`, room: true },
  { name: 'account', path: '/account' },
  { name: 'search', path: '/search?q=lunch' },
  { name: 'channel', path: '/c/random', states: CALL, after: leaveCall },
];
const MODES = [
  { name: 'app', pages: PAGES },
  { name: 'keyboard', pages: PAGES.filter((p) => p.path === '/c/general') },
  { name: 'landscape', pages: PAGES.filter((p) => ['/c/general', '/account', '/c/random'].includes(p.path)) },
];

/**
 * The screen as the page sees it in a mode: its size, what covers each edge
 * (top, bottom, left, right), what the phone reports as covered (reported,
 * which with the keyboard up still counts the home indicator under it), and
 * where the camera is.
 */
function geometry(phone, mode) {
  const cam = phone.camera;
  if (mode === 'landscape') {
    const { left, right, bottom } = phone.landscape;
    const insets = { top: 0, left, right, bottom };
    return {
      w: phone.h, h: phone.w, ...insets, reported: insets, radius: phone.radius, cornersBelow: true,
      camera: cam && { kind: cam.kind, x: cam.y, y: (phone.w - cam.w) / 2, w: cam.h, h: cam.w },
    };
  }
  const keyboard = mode === 'keyboard';
  const { top, bottom } = phone.portrait;
  return {
    w: phone.w, h: keyboard ? phone.h - phone.keyboard : phone.h,
    top, bottom: keyboard ? 0 : bottom, left: 0, right: 0, reported: { top, bottom, left: 0, right: 0 },
    radius: phone.radius, cornersBelow: !keyboard, keyboard,
    camera: cam && { kind: cam.kind, x: (phone.w - cam.w) / 2, y: cam.y, w: cam.w, h: cam.h },
  };
}

// Run in the page: every control a person reads or taps, the part of it that
// is on screen (inside whatever scrolls it, and inside the viewport), tested
// against the parts of the screen that are covered or cut away. Content may
// pass under an edge while it can still be scrolled out from under it, as a
// list scrolls under the home indicator; the end of it may not. A corner is
// tested against a control's middle, a few pixels in from its box, since
// the box's own corner is only the edge of where a tap lands.
const CHECK = (geo) => {
  const problems = [];
  const W = innerWidth, H = innerHeight, R = geo.radius, e = 0.5;
  const de = document.documentElement;
  if (de.scrollWidth > W + 1) problems.push(`the page scrolls sideways, ${de.scrollWidth}px wide on a ${W}px screen`);
  const inCorner = (x, y) => {
    const cx = x < R ? R : x > W - R ? W - R : null;
    const cy = y < R ? R : y > H - R ? (geo.cornersBelow ? H - R : null) : null;
    return cx !== null && cy !== null && Math.hypot(x - cx, y - cy) > R + e;
  };
  const name = (el) => {
    const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || '').trim().replace(/\s+/g, ' ');
    const cls = el.classList[0] ? '.' + el.classList[0] : '';
    return `${el.tagName.toLowerCase()}${cls}${t ? ` "${t.slice(0, 32)}"` : ''}`;
  };
  const sel = 'a[href], button, input:not([type=hidden]):not([type=file]), textarea, select, summary, h1';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    // A closed menu's items are laid out but not drawn.
    if (r.width <= 1 || r.height <= 1 || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    let moreAbove = false, moreBelow = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const q = p.getBoundingClientRect();
        x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom);
        if (/auto|scroll/.test(s.overflowY)) {
          moreAbove ||= p.scrollTop > 0;
          moreBelow ||= p.scrollTop + p.clientHeight < p.scrollHeight - 1;
        }
      }
      if (s.position === 'fixed') break;
    }
    x0 = Math.max(x0, 0); y0 = Math.max(y0, 0); x1 = Math.min(x1, W); y1 = Math.min(y1, H);
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    const where = [];
    const c = geo.camera;
    if (!moreAbove && c && x0 < c.x + c.w && x1 > c.x && y0 < c.y + c.h && y1 > c.y) where.push('under the camera');
    else if (!moreAbove && y0 < geo.top - e) where.push('under the status bar');
    if (!moreBelow && y1 > H - geo.bottom + e) where.push('under the home indicator');
    if (x0 < geo.left - e || x1 > W - geo.right + e) where.push('in the landscape margin');
    const k = Math.min(6, (x1 - x0) / 4, (y1 - y0) / 4);
    const corners = [[x0 + k, y0 + k], [x1 - k, y0 + k], [x0 + k, y1 - k], [x1 - k, y1 - k]].filter(([, y]) => (y < H / 2 ? !moreAbove : !moreBelow));
    if (corners.some(([x, y]) => inCorner(x, y))) where.push('cut off by a rounded corner');
    if (where.length) problems.push(`${name(el)} at (${Math.round(x0)}, ${Math.round(y0)})–(${Math.round(x1)}, ${Math.round(y1)}) is ${where.join(', ')}`);
  }
  const box = document.querySelector('.composer-box');
  if (geo.keyboard && box) {
    const gap = Math.round(H - box.getBoundingClientRect().bottom);
    if (gap > 12) problems.push(`the composer stands ${gap}px above the keyboard`);
  }
  return problems;
};

// Run in the page before a screenshot: the phone drawn over it, the parts of
// the screen that are not there in black, the status bar's time and the home
// indicator in the page's own text colour, as iOS draws them.
const DRAW = (geo) => {
  const W = innerWidth, H = innerHeight, R = geo.radius;
  const fg = getComputedStyle(document.body).color;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.id = 'phone-frame';
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const add = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text) n.textContent = text;
    svg.appendChild(n);
  };
  const Rb = geo.cornersBelow ? R : 0;
  add('path', {
    'fill-rule': 'evenodd', fill: '#000',
    d: `M0 0H${W}V${H}H0Z M${R} 0H${W - R}A${R} ${R} 0 0 1 ${W} ${R}V${H - Rb}A${Rb} ${Rb} 0 0 1 ${W - Rb} ${H}H${Rb}A${Rb} ${Rb} 0 0 1 0 ${H - Rb}V${R}A${R} ${R} 0 0 1 ${R} 0Z`,
  });
  const c = geo.camera;
  if (c) {
    const rr = c.kind === 'notch' ? 12 : Math.min(c.w, c.h) / 2;
    add('rect', { x: c.x, y: c.kind === 'notch' ? -rr : c.y, width: c.w, height: c.kind === 'notch' ? c.h + rr : c.h, rx: rr, fill: '#000' });
  }
  if (geo.top > 0) {
    const left = c ? c.x / 2 : 40;
    add('text', { x: left, y: geo.top / 2 + 6, 'text-anchor': 'middle', fill: fg, 'font-family': '-apple-system, system-ui, sans-serif', 'font-size': 16, 'font-weight': 600 }, '9:41');
    const right = c ? (W + c.x + c.w) / 2 : W - 40;
    add('rect', { x: right - 12, y: geo.top / 2 - 6, width: 24, height: 12, rx: 3.5, fill: 'none', stroke: fg, 'stroke-opacity': 0.5 });
    add('rect', { x: right - 10, y: geo.top / 2 - 4, width: 17, height: 8, rx: 2, fill: fg });
  }
  if (geo.bottom > 0) {
    const iw = W > H ? 200 : 134;
    add('rect', { x: (W - iw) / 2, y: H - 8 - 5, width: iw, height: 5, rx: 2.5, fill: fg });
  }
  document.body.appendChild(svg);
  return true;
};

// ---- each phone, each mode, each page ----

const { send, openPage, close } = await launchChrome(base);
const failures = [];
const gallery = [];
if (shots) fs.mkdirSync(shots, { recursive: true });

for (const phone of PHONES) {
  for (const mode of MODES) {
    const geo = geometry(phone, mode.name);
    const pages = new Map();
    /** The mode's page for a visitor signed in or out, opened once and emulating the phone. */
    const pageFor = async (signedOut) => {
      if (pages.has(signedOut)) return pages.get(signedOut);
      const page = await openPage(signedOut ? null : aliceCookie);
      const s = page.sessionId;
      await send('Emulation.setUserAgentOverride', { userAgent: phone.ua, platform: phone.ua === IOS_UA ? 'iPhone' : 'Linux armv8l' }, s);
      await send('Emulation.setDeviceMetricsOverride', {
        width: geo.w, height: geo.h, deviceScaleFactor: phone.dpr, mobile: true,
        screenOrientation: mode.name === 'landscape' ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
      }, s);
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, s);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] }, s);
      pages.set(signedOut, page);
      return page;
    };
    for (const pg of mode.pages) {
      const page = await pageFor(!!pg.signedOut);
      const s = page.sessionId;
      // Insets are reported only to a page drawn under the edges, as iOS
      // reports them; the page is loaded once to see whether it asks.
      await send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } }, s);
      await page.go(pg.path);
      const covers = await page.eval(`/viewport-fit\\s*=\\s*cover/.test(document.querySelector('meta[name=viewport]')?.content ?? '')`);
      if (covers) {
        await send('Emulation.setSafeAreaInsetsOverride', { insets: geo.reported }, s);
        await page.go(pg.path);
      }
      if (geo.keyboard) await page.eval("document.querySelector('.composer textarea').focus(); true");
      for (const state of pg.states ?? [{ name: pg.name, steps: [] }]) {
        for (const step of state.steps) await step(page);
        await sleep(state.steps.length ? 300 : 0);
        const label = `${phone.name}, ${mode.name}, ${state.name}`;
        const problems = [];
        if (pg.room && !(await page.eval("!!document.querySelector('.room-head') && !!document.querySelector('.composer-box')"))) problems.push('the room did not draw its header and composer');
        problems.push(...(await page.eval(`(${CHECK})(${JSON.stringify(geo)})`)));
        if (shots) {
          await page.eval(`(${DRAW})(${JSON.stringify(geo)})`);
          const { data } = await send('Page.captureScreenshot', { format: 'png' }, s);
          await page.eval("document.getElementById('phone-frame').remove(); true");
          const file = `${phone.name}-${mode.name}-${state.name}.png`.replace(/\s+/g, '-').toLowerCase();
          fs.writeFileSync(path.join(shots, file), Buffer.from(data, 'base64'));
          gallery.push({ phone: phone.name, label: `${mode.name}, ${state.name}`, file, w: geo.w, problems });
        }
        // Scrolled to the end, a page's last control must be clear of the bottom as well.
        if (!pg.states) {
          await page.eval("document.querySelectorAll('*').forEach((el) => { if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight; }); true");
          for (const p of await page.eval(`(${CHECK})(${JSON.stringify(geo)})`)) if (!problems.includes(p)) problems.push(`${p} (scrolled to the end)`);
        }
        if (problems.length) {
          failures.push(label);
          console.log(`FAIL: ${label}`);
          for (const p of problems) console.log(`  - ${p}`);
        } else ok(label);
      }
      for (const step of pg.after ?? []) await step(page);
    }
    for (const page of pages.values()) await send('Target.disposeBrowserContext', { browserContextId: page.contextId });
  }
}

if (shots) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const byPhone = Map.groupBy(gallery, (g) => g.phone);
  const sections = [...byPhone].map(([name, items]) => `<h2>${esc(name)}</h2><div class="row">${items.map((g) => `<figure><img src="${esc(g.file)}" width="${Math.round(g.w * 0.6)}" alt=""><figcaption>${esc(g.label)}${g.problems.length ? `<ul>${g.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</figcaption></figure>`).join('')}</div>`).join('\n');
  fs.writeFileSync(path.join(shots, 'index.html'), `<!doctype html><meta charset="utf-8"><title>dango on phones</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;background:#f4f4f5;color:#18181b}.row{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}figure{margin:0;max-width:280px}img{display:block;height:auto;border-radius:12px;box-shadow:0 2px 8px #0003;background:#000}figcaption{margin-top:6px}ul{color:#b91c1c;padding-left:18px;font-size:12px}</style>
<h1>dango on phones</h1><p>Generated by scripts/phones.mjs. Red notes are what the check found.</p>
${sections}`);
  console.log(`\nScreenshots in ${shots}/index.html`);
}

close();
console.log('');
if (failures.length) {
  console.log(`${failures.length} of ${failures.length + passed()} phone checks failed.`);
  process.exit(1);
}
console.log(`All ${passed()} phone checks passed.`);
process.exit(0);
