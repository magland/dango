import { createHash } from 'crypto';

// The one script every dango page loads, on the same terms as mochiforge's
// /assets/page.js: served from its own URL so the pages carry no inline
// script and the CSP can say script-src 'self', the same bytes for every
// workspace and theme, and cached for good under a hash of its body.
// Everything page-specific reaches it through data attributes.
//
// It is written to be unnecessary: every form here posts and every page
// renders without it. What it adds is the live half of a chat: the event
// stream that appends messages as they arrive, Enter sending the composer,
// reactions posting without a page reload, the theme applied before first
// paint, and turning notifications on for a device, which only script can do.

const PAGE_JS = `
// ---- appearance (the pattern from mochiforge, under dango's own key) ----
var dangoRoot = document.documentElement;
// Said before first paint, for the sheet: on a screen with no hover a
// message's tools wait for a tap when script is here to take it, and are
// simply shown when it is not.
dangoRoot.classList.add('js');
var dangoTheme = {
  vault: dangoRoot.getAttribute('data-theme-vault') || 'paper',
  dark: dangoRoot.getAttribute('data-theme-dark') || 'midnight',
};
function applyTheme() {
  var pick = null;
  try { pick = localStorage.getItem('dango.theme'); } catch (e) {}
  var auto = !pick || pick === 'auto';
  if (auto) pick = matchMedia('(prefers-color-scheme: dark)').matches ? dangoTheme.dark : dangoTheme.vault;
  document.documentElement.setAttribute('data-theme', pick);
  var items = document.querySelectorAll('[data-theme-name]');
  for (var i = 0; i < items.length; i++) {
    var n = items[i].getAttribute('data-theme-name');
    items[i].setAttribute('aria-checked', String(auto ? n === 'auto' : n === pick));
  }
}
function setTheme(name) {
  try { localStorage.setItem('dango.theme', name); } catch (e) {}
  applyTheme();
  closeMenus(null);
}
applyTheme();
document.addEventListener('DOMContentLoaded', applyTheme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---- menus: <details class="dropdown"> close on outside click and Escape ----
function closeMenus(except) {
  var open = document.querySelectorAll('details.dropdown[open]');
  for (var i = 0; i < open.length; i++) {
    if (!except || !open[i].contains(except)) open[i].open = false;
  }
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(null); });

function closestOf(el, selector) {
  while (el && el !== document) {
    if (el.matches && el.matches(selector)) return el;
    el = el.parentNode;
  }
  return null;
}

// ---- invite links ----
// An invite link is /invite#token=<token>. The fragment never reaches the
// server; this moves it into the form and then out of the address bar and
// the history, so the token is not left where the next person at the machine
// could read it. Nothing is submitted: the person presses the button.
document.addEventListener('DOMContentLoaded', function () {
  var box = document.querySelector('[data-invite]');
  if (!box) return;
  var m = /(?:^#|&)token=([^&]+)/.exec(location.hash || '');
  if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
  var field = box.querySelector('#token');
  if (m && field) {
    var token = m[1];
    try { token = decodeURIComponent(token); } catch (e) {}
    field.value = token;
    box.querySelector('[data-invite-ready]').hidden = false;
    var button = box.querySelector('button[type="submit"]');
    if (button) button.focus();
  } else {
    box.querySelector('[data-invite-missing]').hidden = false;
    if (field) field.focus();
  }
});

// ---- copying ----
function copyText(btn, text) {
  function done() {
    var label = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(function () { btn.textContent = label; }, 1400);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () {});
  } else {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    ta.remove();
  }
}

// ---- the message list ----
function msgList() { return document.getElementById('msg-list'); }
function scrollPane() { return document.querySelector('.msgs'); }
function nearBottom(pane) {
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
}
function scrollToBottom() {
  var pane = scrollPane();
  if (pane) pane.scrollTop = pane.scrollHeight;
}
// Rooms open at the newest message, which is where the conversation is, and
// the view stays there while the reader does, whatever changes its height:
// an image arriving after the page, a message repainted, the composer
// growing, or a phone's keyboard opening under it.
var stuckToBottom = true;
document.addEventListener('DOMContentLoaded', function () {
  var pane = scrollPane();
  var list = msgList();
  if (!pane || !list) return;
  scrollToBottom();
  pane.addEventListener('scroll', function () { stuckToBottom = nearBottom(pane); }, { passive: true });
  if (window.ResizeObserver) {
    var watch = new ResizeObserver(function () { if (stuckToBottom) scrollToBottom(); });
    watch.observe(pane);
    watch.observe(list);
  }
});

// One EventSource per open room page. The stream sends {type, id, html};
// an element already on the page is replaced in place, a new one is appended,
// and the view follows the bottom only if the reader was already there.
function openStream(list) {
  var url = list.getAttribute('data-stream');
  if (!url || !window.EventSource) return;
  var after = list.getAttribute('data-last') || '0';
  var es = new EventSource(url + '?after=' + encodeURIComponent(after));
  es.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    var existing = document.getElementById('msg-' + msg.id);
    var pane = scrollPane();
    var follow = pane ? nearBottom(pane) : false;
    // A pin or an unpin carries the room's new count, for the header.
    if (typeof msg.pins === 'number') {
      var pinCount = document.querySelector('[data-pin-count]');
      if (pinCount) pinCount.textContent = msg.pins ? String(msg.pins) : '';
    }
    if (existing) {
      existing.outerHTML = msg.html;
    } else if (msg.type === 'message') {
      list.insertAdjacentHTML('beforeend', msg.html);
      list.setAttribute('data-last', String(msg.id));
      if (follow) scrollToBottom();
      // Seen, if someone is at the page (see attended()); otherwise it waits
      // for them to come back.
      if (attended()) markReadHere(msg.id);
    }
  };
  // The browser retries a dropped stream by itself, but gives up for good
  // when a retry is answered with an error status, which is what a proxy says
  // while the server restarts for a deploy. So a stream the browser has closed
  // is reopened here, after a pause, from the newest message on the page:
  // the server replays everything after it, and anything already shown is
  // replaced rather than repeated.
  es.onerror = function () {
    var items = list.querySelectorAll('[data-mid]');
    if (items.length) list.setAttribute('data-last', items[items.length - 1].getAttribute('data-mid'));
    if (es.readyState === 2) {
      setTimeout(function () { openStream(list); }, 5000);
    }
  };
}
document.addEventListener('DOMContentLoaded', function () {
  var list = msgList();
  if (list) openStream(list);
});

// ---- unread counts ----
// Every signed-in page holds one stream of the viewer's counts (/events),
// which keeps the sidebar's badges, the tab title, and the favicon current.
// The room on screen is the exception while someone is at the page: what
// arrives there is being read, so it is reported read instead of counted,
// which is what moves the marker for every other device (and what keeps their
// phone from being notified of it). While nobody is, it counts like any
// other room, so the title says something arrived.
//
// This script runs in <head>, before the body exists, so everything about the
// page is looked up once it has loaded (frame() below), never at load time.
var frameInfo = null;
function frame() {
  if (frameInfo) return frameInfo;
  var app = document.querySelector('.app');
  if (!app) return null;
  var t = document.querySelector('title');
  var link = document.querySelector('link[rel="icon"]');
  frameInfo = {
    app: app,
    room: app.getAttribute('data-current-room') || '',
    viewer: app.getAttribute('data-viewer') || '',
    csrf: app.getAttribute('data-csrf') || '',
    title: t ? t.getAttribute('data-title') || t.textContent : document.title,
    icon: link,
    iconBase: link ? link.getAttribute('href').replace(/&unread=[a-z]+/, '') : ''
  };
  return frameInfo;
}
var counts = {};
var urgent = {};
// A direct message is addressed to you by being one, so its count is marked
// the way a mention is.
function isUrgent(url, mentions) {
  return mentions > 0 || url.indexOf('/d/') === 0;
}
function applyBadge(url, count, mentions) {
  var links = document.querySelectorAll('[data-room="' + url + '"]');
  for (var i = 0; i < links.length; i++) {
    var b = links[i].querySelector('[data-room-badge]');
    if (!b) continue;
    if (count > 0) {
      b.textContent = count > 99 ? '99+' : String(count);
      b.className = 'badge' + (isUrgent(url, mentions) ? ' mention' : '');
      b.hidden = false;
      links[i].classList.add('unread');
    } else {
      b.hidden = true;
      links[i].classList.remove('unread');
    }
  }
}
function applyTitle() {
  var f = frame();
  if (!f) return;
  var total = 0;
  var anyUrgent = false;
  for (var k in counts) {
    if (!counts[k]) continue;
    total += counts[k];
    if (urgent[k]) anyUrgent = true;
  }
  document.title = total > 0 ? '(' + (total > 99 ? '99+' : total) + ') ' + f.title : f.title;
  if (f.icon) {
    var href = f.iconBase + (total > 0 ? '&unread=' + (anyUrgent ? 'urgent' : 'some') : '');
    if (f.icon.getAttribute('href') !== href) f.icon.setAttribute('href', href);
  }
  // The same total on the app's icon, where the workspace is installed as an
  // app (the home screen on iOS, the dock or taskbar elsewhere). A browser tab
  // has no such icon, and the call is refused there, quietly.
  setAppBadge(total);
}
function setAppBadge(total) {
  if (!navigator.setAppBadge) return;
  try {
    var p = total > 0 ? navigator.setAppBadge(total) : navigator.clearAppBadge();
    if (p && p.catch) p.catch(function () {});
  } catch (e) {}
}
function setCount(url, count, mentions) {
  counts[url] = count;
  urgent[url] = count > 0 && isUrgent(url, mentions);
  applyBadge(url, count, mentions);
  applyTitle();
}
// The counts the page was rendered with, read off the sidebar's badges.
function seedCounts() {
  var links = document.querySelectorAll('.side-rooms [data-room]');
  for (var i = 0; i < links.length; i++) {
    var b = links[i].querySelector('[data-room-badge]');
    var url = links[i].getAttribute('data-room');
    if (b && !b.hidden) {
      counts[url] = parseInt(b.textContent, 10) || 0;
      urgent[url] = b.classList.contains('mention') || url.indexOf('/d/') === 0;
    }
  }
  applyTitle();
}
// The room whose messages are on screen: the list's own stream says, which
// on a thread page is the thread rather than the room the sidebar marks.
function markReadHere(id) {
  var f = frame();
  if (!f || !f.room || !window.fetch) return;
  var list = msgList();
  var stream = list ? list.getAttribute('data-stream') || '' : '';
  var room = stream.slice(-7) === '/events' ? stream.slice(0, -7) : f.room;
  var body = new FormData();
  body.append('csrf', f.csrf);
  body.append('id', String(id));
  fetch(room + '/read', { method: 'POST', body: body });
}
function openUserStream() {
  var f = frame();
  if (!f || !window.EventSource) return;
  var es = new EventSource('/events');
  es.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type !== 'unread') return;
    if (msg.url === f.room && attended()) return;
    setCount(msg.url, msg.count, msg.mentions);
  };
  es.onerror = function () {
    if (es.readyState === 2) setTimeout(openUserStream, 5000);
  };
}
document.addEventListener('DOMContentLoaded', function () {
  seedCounts();
  openUserStream();
});

// ---- whether anyone is at the page ----
// A visible page is not proof of a reader: a room left open on a desktop
// nobody is sitting at is visible all night, and if it reported everything
// read, the phone in its owner's pocket would never hear of any of it. So the
// page counts as attended only while it is visible and has been used lately:
// a key, a click or tap, a scroll, or the pointer moving over it, within the
// last five minutes if the window has the focus, or two if it does not (a
// second monitor, say). Someone who watches a busy room for longer than that
// without touching anything is notified of what they saw, which is the
// cheaper of the two mistakes. Browsers offer no idle signal of their own
// that works everywhere without a permission prompt; this is the one that
// does.
var lastActive = Date.now();
var IDLE_FOCUSED_MS = 5 * 60 * 1000;
var IDLE_UNFOCUSED_MS = 2 * 60 * 1000;
function attended() {
  if (document.visibilityState !== 'visible') return false;
  return Date.now() - lastActive < (document.hasFocus() ? IDLE_FOCUSED_MS : IDLE_UNFOCUSED_MS);
}
// Coming back reads what arrived in the room while nobody was there.
function catchUp() {
  var f = frame();
  var list = msgList();
  if (!f || !f.room || !list) return;
  var last = parseInt(list.getAttribute('data-last') || '0', 10);
  if (last > 0) markReadHere(last);
  setCount(f.room, 0, 0);
}
function noteActivity() {
  var away = !attended();
  lastActive = Date.now();
  if (away && attended()) catchUp();
}
['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel', 'scroll'].forEach(function (type) {
  document.addEventListener(type, noteActivity, { capture: true, passive: true });
});
window.addEventListener('focus', noteActivity);
// Returning to a tab is itself someone arriving, however briefly they were
// gone: what came while it was hidden was counted, and is read now.
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  lastActive = Date.now();
  catchUp();
});

// ---- notifications ----
// The service worker is registered on every signed-in page: it is what shows
// a push, and what makes the workspace installable. It does nothing else (see
// src/sw.ts), so registering it changes nothing about how pages load.
document.addEventListener('DOMContentLoaded', function () {
  if (frame() && navigator.serviceWorker && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
  var box = document.querySelector('[data-push]');
  if (box) pushSetup(box);
  // Quiet hours are kept in the person's own time zone, which the browser
  // knows; an empty field is filled with it, and a filled one is left alone.
  var tz = document.querySelector('[data-tz-fill]');
  if (tz && !tz.value && window.Intl) {
    try { tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  }
});
function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
}
function pushSupported() {
  return window.isSecureContext && navigator.serviceWorker && window.PushManager && window.Notification;
}
function keyBytes(b64) {
  var s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
// Whether a subscription was made under this workspace's key. One made under
// other keys (the workspace's were replaced) cannot be pushed to, and has to
// be dropped before subscribing again.
function sameKey(sub, want) {
  var have = sub.options && sub.options.applicationServerKey;
  if (!have) return true;
  have = new Uint8Array(have);
  if (have.length !== want.length) return false;
  for (var i = 0; i < want.length; i++) if (have[i] !== want[i]) return false;
  return true;
}
function pushPost(path, payload) {
  var f = frame();
  payload.csrf = f ? f.csrf : '';
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) throw new Error(d.error || 'the workspace answered ' + r.status + '.');
      return d;
    });
  });
}
function currentSubscription() {
  return navigator.serviceWorker.getRegistration('/').then(function (reg) {
    return reg ? reg.pushManager.getSubscription() : null;
  });
}
function pushSetup(box) {
  var status = box.querySelector('[data-push-status]');
  var on = box.querySelector('[data-push-on]');
  var off = box.querySelector('[data-push-off]');
  var test = box.querySelector('[data-push-test]');
  var key = keyBytes(box.getAttribute('data-vapid') || '');
  function show(text, state) {
    status.textContent = text;
    on.hidden = state !== 'off';
    off.hidden = state !== 'on';
    test.hidden = state !== 'on';
  }
  if (!pushSupported()) {
    if (isIos() && !isStandalone()) {
      show('On iPhone and iPad, notifications come to the workspace as a Home Screen app. In Safari, tap Share, then Add to Home Screen; open the workspace from its new icon, sign in there, and come back to this page.', '');
    } else if (!window.isSecureContext) {
      show('Notifications need the workspace to be served over HTTPS.', '');
    } else {
      show('This browser cannot receive notifications from a web page.', '');
    }
    return;
  }
  function refresh() {
    if (Notification.permission === 'denied') {
      show('Notifications are blocked for this workspace in this browser. Click the icon at the left of the address bar, set Notifications to Allow, and reload this page. (In Safari on a Mac: Safari, Settings, Websites, Notifications.)', '');
      return;
    }
    currentSubscription().then(function (sub) {
      if (sub && sameKey(sub, key)) {
        show('Notifications are on for this device.', 'on');
        // Offered again on each visit, which keeps the workspace's copy of
        // the keys current and restores a device removed from another one.
        pushPost('/account/push/subscribe', { subscription: sub.toJSON() }).catch(function () {});
      } else {
        show('Notifications are off for this device.', 'off');
      }
    }, function () { show('Notifications are off for this device.', 'off'); });
  }
  on.addEventListener('click', function () {
    on.disabled = true;
    // Asked from the press itself: Safari grants the prompt only to a gesture.
    Promise.resolve(Notification.requestPermission()).then(function (permission) {
      if (permission !== 'granted') { on.disabled = false; refresh(); return; }
      return navigator.serviceWorker.register('/sw.js')
        .then(function () { return navigator.serviceWorker.ready; })
        .then(function (reg) {
          return reg.pushManager.getSubscription().then(function (old) {
            if (old && !sameKey(old, key)) return old.unsubscribe().then(function () { return null; });
            return old;
          }).then(function (sub) {
            return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          });
        })
        .then(function (sub) { return pushPost('/account/push/subscribe', { subscription: sub.toJSON() }); })
        .then(function () { location.reload(); });
    }).catch(function (e) {
      on.disabled = false;
      show('Notifications could not be turned on: ' + (e && e.message ? e.message : e), 'off');
    });
  });
  off.addEventListener('click', function () {
    off.disabled = true;
    currentSubscription().then(function (sub) {
      if (!sub) return;
      return pushPost('/account/push/remove', { endpoint: sub.endpoint }).catch(function () {}).then(function () { return sub.unsubscribe(); });
    }).then(function () { location.reload(); }, function (e) {
      off.disabled = false;
      show('Notifications could not be turned off: ' + (e && e.message ? e.message : e), 'on');
    });
  });
  test.addEventListener('click', function () {
    test.disabled = true;
    currentSubscription().then(function (sub) {
      return pushPost('/account/push/test', { endpoint: sub ? sub.endpoint : '' });
    }).then(function (r) {
      if (r.sent) show('Sent. It should appear in a moment; if it does not, check that the system allows notifications from this browser.', 'on');
      else if (r.gone) show("The push service says this browser's subscription has ended. Turn notifications on again.", 'off');
      else show('The push service refused it' + (r.failed && r.failed[0] ? ' (' + r.failed[0].status + (r.failed[0].detail ? ': ' + r.failed[0].detail : '') + ')' : '') + '.', 'on');
    }, function (e) {
      show('The test was not sent: ' + (e && e.message ? e.message : e), 'on');
    }).then(function () { test.disabled = false; });
  });
  refresh();
}
// ---- the chime ----
// When a notification arrives and a workspace tab is open, the service worker
// asks a tab to play a chime (see src/sw.ts), since the system's own sound is
// often off and a page cannot choose it. Browsers let a page make sound only
// after someone has clicked or typed in it, so the audio is started on the
// first such press and kept; a tab nobody has touched answers that it could
// not, and the worker asks the next one or leaves the sound to the system.
// The chime is drawn here rather than loaded: two soft sine tones a fifth
// apart, E5 then B5, each with a quiet octave above it for a bell's shimmer,
// swelling in over 15ms and dying away over about a second.
var audio = null;
function startAudio() {
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!audio) {
    try { audio = new AC(); } catch (e) { return; }
  }
  if (audio.state === 'suspended' && audio.resume) audio.resume().catch(function () {});
}
['pointerdown', 'keydown', 'touchend'].forEach(function (type) {
  document.addEventListener(type, startAudio, { capture: true, passive: true });
});
function chimeWanted() {
  try { return localStorage.getItem('dango.chime') !== 'off'; } catch (e) { return true; }
}
var chimes = 0;
function bellTone(freq, at, length, peak) {
  var out = audio.createGain();
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(peak, at + 0.015);
  out.gain.exponentialRampToValueAtTime(0.0001, at + length);
  out.connect(audio.destination);
  [[freq, 1], [freq * 2, 0.22]].forEach(function (partial) {
    var level = audio.createGain();
    level.gain.value = partial[1];
    level.connect(out);
    var osc = audio.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = partial[0];
    osc.connect(level);
    osc.start(at);
    osc.stop(at + length + 0.05);
  });
}
function playChime() {
  if (!audio || audio.state !== 'running') return false;
  var t = audio.currentTime + 0.02;
  bellTone(659.25, t, 0.9, 0.08);
  bellTone(987.77, t + 0.13, 1.2, 0.065);
  chimes++;
  return true;
}
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'chime') return;
    var played = chimeWanted() && playChime();
    if (e.ports && e.ports[0]) e.ports[0].postMessage({ played: played });
  });
  if (navigator.serviceWorker.startMessages) navigator.serviceWorker.startMessages();
}
// The account page's switch for it, kept per browser, and a button to hear it.
document.addEventListener('DOMContentLoaded', function () {
  var box = document.querySelector('[data-chime]');
  if (!box) return;
  box.hidden = false;
  var toggle = box.querySelector('input[type="checkbox"]');
  toggle.checked = chimeWanted();
  toggle.addEventListener('change', function () {
    try { localStorage.setItem('dango.chime', toggle.checked ? 'on' : 'off'); } catch (e) {}
  });
  box.querySelector('[data-chime-play]').addEventListener('click', function () {
    startAudio();
    // A context started by this very press may still be starting.
    if (!playChime() && audio && audio.resume) audio.resume().then(playChime, function () {});
  });
});

// Signing out drops this browser's subscription and tells the workspace, so
// a shared computer stops showing the notifications of whoever left it. The
// form still posts if any of this fails or takes too long.
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (!form.matches || !form.matches('form[action="/logout"]') || form.getAttribute('data-leaving')) return;
  if (!pushSupported()) return;
  e.preventDefault();
  form.setAttribute('data-leaving', '1');
  var sent = false;
  function go() { if (sent) return; sent = true; setAppBadge(0); form.submit(); }
  setTimeout(go, 2000);
  currentSubscription().then(function (sub) {
    if (!sub) return;
    var field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'push';
    field.value = sub.endpoint;
    form.appendChild(field);
    return sub.unsubscribe();
  }).then(go, go);
});

// ---- the composer ----
// Enter sends, Shift+Enter is a newline; the textarea grows with its content.
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, window.innerHeight * 0.4) + 'px';
}
document.addEventListener('input', function (e) {
  if (e.target.matches && e.target.matches('.composer textarea')) {
    autosize(e.target);
    mentionInput(e.target);
  }
});
document.addEventListener('keydown', function (e) {
  if (!e.target.matches || !e.target.matches('.composer textarea')) return;
  if (mentionKey(e, e.target)) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    var form = e.target.closest('form');
    if (form) sendComposer(form);
  }
});

// ---- completing an @ ----
// Typing @ and some letters in the composer offers the members whose names
// start that way; Up and Down choose, Enter or Tab takes the choice, Escape
// closes. The member list is fetched once per page, on the first @, from
// /assets/users.json, which says no more than the new-conversation page does.
var members = null;
var mentionState = { open: false, start: -1, pick: 0, items: [] };
function loadMembers(then) {
  if (members) { then(members); return; }
  if (!window.fetch) return;
  fetch('/assets/users.json').then(function (r) { return r.json(); }).then(function (list) {
    members = list;
    then(members);
  }, function () {});
}
function mentionListFor(ta) {
  var form = ta.closest('form');
  return form ? form.querySelector('[data-mention-list]') : null;
}
function closeMentions(ta) {
  var box = mentionListFor(ta);
  if (box) { box.hidden = true; box.innerHTML = ''; }
  mentionState.open = false;
  mentionState.items = [];
}
// The @word the caret is in, if the caret is in one: an @ at a word start,
// then name characters, then the caret.
function mentionAtCaret(ta) {
  var upto = ta.value.slice(0, ta.selectionStart);
  var m = /(^|[^\\w@.-])@([A-Za-z0-9][A-Za-z0-9._-]*)?$/.exec(upto);
  if (!m) return null;
  return { start: upto.length - (m[2] || '').length - 1, query: (m[2] || '').toLowerCase() };
}
function renderMentions(ta) {
  var box = mentionListFor(ta);
  if (!box) return;
  var out = '';
  for (var i = 0; i < mentionState.items.length; i++) {
    var u = mentionState.items[i];
    out += '<button type="button" data-mention="' + u.name + '"' + (i === mentionState.pick ? ' class="picked"' : '') + '>@' + u.name +
      (u.display ? '<span class="muted">' + escapeHtml(u.display) + '</span>' : '') + '</button>';
  }
  box.innerHTML = out;
  box.hidden = out === '';
  mentionState.open = out !== '';
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function mentionInput(ta) {
  var at = mentionAtCaret(ta);
  if (!at) { closeMentions(ta); return; }
  loadMembers(function (list) {
    var me = frame() ? frame().viewer : '';
    var items = [];
    for (var i = 0; i < list.length && items.length < 8; i++) {
      var u = list[i];
      if (u.name === me) continue;
      if (u.name.toLowerCase().indexOf(at.query) === 0 || (u.display && u.display.toLowerCase().indexOf(at.query) === 0)) items.push(u);
    }
    mentionState.start = at.start;
    mentionState.pick = 0;
    mentionState.items = items;
    renderMentions(ta);
  });
}
function takeMention(ta, name) {
  var end = ta.selectionStart;
  ta.value = ta.value.slice(0, mentionState.start) + '@' + name + ' ' + ta.value.slice(end);
  var caret = mentionState.start + name.length + 2;
  ta.setSelectionRange(caret, caret);
  closeMentions(ta);
  autosize(ta);
  ta.focus();
}
function mentionKey(e, ta) {
  if (!mentionState.open) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    var n = mentionState.items.length;
    mentionState.pick = (mentionState.pick + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderMentions(ta);
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    takeMention(ta, mentionState.items[mentionState.pick].name);
    return true;
  }
  if (e.key === 'Escape') {
    closeMentions(ta);
    return true;
  }
  return false;
}
// Sending. The form is sent with XMLHttpRequest rather than fetch, for the one
// thing fetch cannot say: how much of an upload has gone. While a send is in
// flight the composer is locked (the button, the text, the file picker) so
// that a second press, a second Enter, or an edit cannot make a second
// message. If the send fails, for whatever reason, nothing is lost: the text
// and the files stay where they were, the reason is shown beside them, and
// Send tries again.
//
// Each message carries a nonce, made when it is first sent and kept until it
// succeeds. A retry sends the same nonce, and the server answers a nonce it
// has already seen with the message it already made; so a send whose upload
// arrived but whose answer was lost, and is then sent again, still makes one
// message.
function sendStatus(form, kind, text) {
  var el = form.querySelector('[data-send-status]');
  if (!el) return;
  el.className = 'send-status' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
  el.hidden = !text;
}
function sendProgress(form, fraction) {
  var bar = form.querySelector('[data-send-progress]');
  if (!bar) return;
  if (fraction === null) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.firstElementChild.style.width = Math.round(Math.max(0.03, Math.min(1, fraction)) * 100) + '%';
}
function lockComposer(form, locked) {
  var controls = form.querySelectorAll('textarea, input[type="file"], button[type="submit"]');
  for (var i = 0; i < controls.length; i++) {
    if (controls[i].tagName === 'TEXTAREA') controls[i].readOnly = locked;
    else controls[i].disabled = locked;
  }
  if (locked) form.setAttribute('data-busy', '1');
  else form.removeAttribute('data-busy');
}
function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function selectedBytes(form) {
  var file = form.querySelector('input[type="file"]');
  var total = 0;
  if (file && file.files) for (var i = 0; i < file.files.length; i++) total += file.files[i].size;
  return total;
}
function newNonce() {
  var bytes = new Uint8Array(12);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
  return out;
}
function sendComposer(form) {
  // Already sending: this press is ignored, never turned into a second send.
  if (form.getAttribute('data-busy')) return;
  if (!window.XMLHttpRequest || !window.FormData) { form.submit(); return; }
  var ta = form.querySelector('textarea');
  var file = form.querySelector('input[type="file"]');
  var bytes = selectedBytes(form);
  var hasFiles = bytes > 0 || (file && file.files && file.files.length > 0);
  if ((!ta || ta.value.trim() === '') && !hasFiles) return;
  var max = parseInt(form.getAttribute('data-max-bytes') || '0', 10);
  if (max && bytes > max) {
    sendStatus(form, 'error', 'Not sent: attachments may come to at most ' + humanSize(max) + ', and these are ' + humanSize(bytes) + '. Remove some and send again.');
    return;
  }
  var nonceField = form.querySelector('input[name="nonce"]');
  if (nonceField && !nonceField.value) nonceField.value = newNonce();
  // Read the form before locking it: a disabled field is left out of FormData.
  var data = new FormData(form);
  lockComposer(form, true);
  sendStatus(form, 'pending', hasFiles ? 'Uploading ' + humanSize(bytes) + '…' : 'Sending…');
  sendProgress(form, hasFiles ? 0 : null);
  var xhr = new XMLHttpRequest();
  xhr.open('POST', form.getAttribute('action'));
  xhr.setRequestHeader('Accept', 'application/json');
  if (hasFiles) {
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      sendProgress(form, e.loaded / e.total);
      sendStatus(form, 'pending', e.loaded >= e.total
        ? 'Uploaded; saving…'
        : 'Uploading ' + humanSize(e.loaded) + ' of ' + humanSize(e.total) + '…');
    };
  }
  function failed(reason) {
    lockComposer(form, false);
    sendProgress(form, null);
    sendStatus(form, 'error', 'Not sent: ' + reason + ' Your message is still here; press Send to try again.');
  }
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      lockComposer(form, false);
      sendProgress(form, null);
      sendStatus(form, '', '');
      if (ta) { ta.value = ''; autosize(ta); }
      if (file) file.value = '';
      if (nonceField) nonceField.value = '';
      showFileTotal(form);
      scrollToBottom();
      if (ta) ta.focus();
      return;
    }
    var reason = '';
    try { reason = JSON.parse(xhr.responseText).error || ''; } catch (e) {}
    if (!reason) reason = xhr.status === 413 ? 'the attachments are too large.' : 'the server answered ' + xhr.status + '.';
    if (!/[.!?]$/.test(reason)) reason += '.';
    // A refusal is final for this content (too large, empty, rate limited):
    // a new nonce, so that sending it again once fixed is a new attempt.
    if (xhr.status === 400 || xhr.status === 413 || xhr.status === 429) {
      if (nonceField) nonceField.value = '';
    }
    failed(reason);
  };
  xhr.onerror = function () {
    failed('the connection to the workspace failed.');
  };
  xhr.onabort = function () {
    failed('the send was interrupted.');
  };
  xhr.send(data);
}
// What was chosen, quietly, beside the picker: the file's name, or how many
// there are, and their total size. The picker itself is a paperclip, which
// says nothing about what it holds.
function showFileTotal(form) {
  var el = form.querySelector('[data-file-total]');
  if (!el) return;
  var file = form.querySelector('input[type="file"]');
  var n = file && file.files ? file.files.length : 0;
  var bytes = selectedBytes(form);
  var max = parseInt(form.getAttribute('data-max-bytes') || '0', 10);
  var what = n === 1 ? file.files[0].name + ', ' : n + ' files, ';
  el.textContent = n > 0 ? what + humanSize(bytes) + (max && bytes > max ? ' (over the ' + humanSize(max) + ' limit)' : '') : '';
  el.className = 'file-size' + (max && bytes > max ? ' over' : '');
}
document.addEventListener('change', function (e) {
  var t = e.target;
  if (t.matches && t.matches('form[data-composer] input[type="file"]')) {
    var form = t.closest('form');
    showFileTotal(form);
    sendStatus(form, '', '');
  }
});
// Leaving the page mid-send would drop the upload; the browser asks first.
window.addEventListener('beforeunload', function (e) {
  if (document.querySelector('form[data-composer][data-busy]')) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (!form.matches) return;
  if (form.matches('form[data-composer]')) {
    e.preventDefault();
    sendComposer(form);
    return;
  }
  // Forms that destroy something say what, and are asked about first.
  var question = form.getAttribute('data-confirm');
  if (question && !window.confirm(question)) e.preventDefault();
});

// Deleting a message asks first, then deletes without leaving the room; the
// event stream repaints the message as deleted. Without script the trash
// button is a link to a page that asks the same question.
function deleteMessage(link) {
  if (!window.confirm('Delete this message? It will read "This message was deleted." for everyone, and its attachments are removed. There is no undo.')) return;
  var f = frame();
  var body = new FormData();
  body.append('csrf', f ? f.csrf : '');
  fetch(link.getAttribute('href'), { method: 'POST', body: body, headers: { Accept: 'application/json' } })
    .then(function (r) {
      if (r.ok) return;
      return r.json().then(function (d) { window.alert('The message was not deleted: ' + (d.error || 'the server answered ' + r.status)); },
        function () { window.alert('The message was not deleted: the server answered ' + r.status); });
    }, function () {
      window.alert('The message was not deleted: the connection to the workspace failed.');
    });
}

// ---- clicks, delegated ----
// Reactions and pins post through fetch and let the event stream repaint the
// message; without script the same elements are buttons in forms and the
// page reloads. A refusal (going too fast, most likely) is said, not dropped.
// Where nothing hovers, tapping a message shows its tools, and tapping it
// again, or another message, puts them away. A tap on a link or control in
// the message does what it would anyway, and one inside the tools uses them.
var noHover = matchMedia('(hover: none)');
function pickMessage(t) {
  if (!noHover.matches) return;
  var msg = closestOf(t, '.msg');
  if (msg && (closestOf(t, '.msg-tools') || closestOf(t, 'a, button, summary, input, textarea, audio, video'))) return;
  var picked = document.querySelectorAll('.msg.picked');
  for (var i = 0; i < picked.length; i++) if (picked[i] !== msg) picked[i].classList.remove('picked');
  if (msg && msg.querySelector('.msg-tools')) msg.classList.toggle('picked');
}
document.addEventListener('click', function (e) {
  var t = e.target;
  pickMessage(t);
  var theme = closestOf(t, '[data-theme-name]');
  if (theme) { setTheme(theme.getAttribute('data-theme-name')); return; }
  var del = closestOf(t, 'a[data-delete-message]');
  if (del && window.fetch) {
    e.preventDefault();
    deleteMessage(del);
    return;
  }
  var copy = closestOf(t, '[data-copy]');
  if (copy) { copyText(copy, copy.getAttribute('data-copy')); return; }
  var mention = closestOf(t, '[data-mention]');
  if (mention) {
    var ta = mention.closest('form').querySelector('textarea');
    takeMention(ta, mention.getAttribute('data-mention'));
    return;
  }
  var quiet = closestOf(t, 'form[data-quiet] button');
  if (quiet && window.fetch) {
    var form = quiet.closest('form');
    e.preventDefault();
    closeMenus(null);
    fetch(form.getAttribute('action'), { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.ok) return;
        return r.json().then(function (d) { window.alert(d.error || 'That did not work: the server answered ' + r.status + '.'); },
          function () { window.alert('That did not work: the server answered ' + r.status + '.'); });
      }, function () {
        window.alert('That did not work: the connection to the workspace failed.');
      });
    return;
  }
  closeMenus(t);
});
`;

let made: { body: string; tag: string } | null = null;

export function pageScript(): { body: string; tag: string } {
  if (!made) {
    made = { body: PAGE_JS, tag: createHash('sha256').update(PAGE_JS).digest('hex').slice(0, 12) };
  }
  return made;
}
