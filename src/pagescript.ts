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
// reactions posting without a page reload, and the theme applied before
// first paint.

const PAGE_JS = `
// ---- appearance (the pattern from mochiforge, under dango's own key) ----
var dangoRoot = document.documentElement;
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
// Rooms open at the newest message, which is where the conversation is.
document.addEventListener('DOMContentLoaded', function () {
  if (msgList()) scrollToBottom();
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
    if (existing) {
      existing.outerHTML = msg.html;
    } else if (msg.type === 'message') {
      list.insertAdjacentHTML('beforeend', msg.html);
      list.setAttribute('data-last', String(msg.id));
      if (follow) scrollToBottom();
      // Seen, if anyone is looking; otherwise it waits for the tab to return.
      if (document.visibilityState === 'visible') markReadHere(msg.id);
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
// The room on screen is the exception while the tab is visible: what arrives
// there is being read, so it is reported read instead of counted, which is
// what moves the marker for every other device. While the tab is hidden it
// counts like any other room, so the title says something arrived.
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
function markReadHere(id) {
  var f = frame();
  if (!f || !f.room || !window.fetch) return;
  var body = new FormData();
  body.append('csrf', f.csrf);
  body.append('id', String(id));
  fetch(f.room + '/read', { method: 'POST', body: body });
}
function openUserStream() {
  var f = frame();
  if (!f || !window.EventSource) return;
  var es = new EventSource('/events');
  es.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type !== 'unread') return;
    if (msg.url === f.room && document.visibilityState === 'visible') return;
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
// Coming back to a tab reads what arrived in its room while it was away.
document.addEventListener('visibilitychange', function () {
  var f = frame();
  if (document.visibilityState !== 'visible' || !f || !f.room) return;
  var list = msgList();
  if (!list) return;
  var last = parseInt(list.getAttribute('data-last') || '0', 10);
  if (last > 0) markReadHere(last);
  setCount(f.room, 0, 0);
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
// Posting through fetch keeps the page: the message comes back through the
// event stream. The form still posts normally where fetch is missing or the
// send fails, so nothing is lost with the script.
function sendComposer(form) {
  if (!window.fetch || form.getAttribute('data-busy')) { form.submit(); return; }
  var ta = form.querySelector('textarea');
  var file = form.querySelector('input[type="file"]');
  var hasFiles = file && file.files && file.files.length > 0;
  if ((!ta || ta.value.trim() === '') && !hasFiles) return;
  form.setAttribute('data-busy', '1');
  fetch(form.getAttribute('action'), { method: 'POST', body: new FormData(form) })
    .then(function (r) {
      form.removeAttribute('data-busy');
      if (!r.ok) { form.submit(); return; }
      if (ta) { ta.value = ''; autosize(ta); }
      if (file) file.value = '';
      scrollToBottom();
    })
    .catch(function () { form.removeAttribute('data-busy'); form.submit(); });
}
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (form.matches && form.matches('form[data-composer]')) {
    e.preventDefault();
    sendComposer(form);
  }
});

// ---- clicks, delegated ----
// Reaction pills and the quick-react menu post through fetch and let the
// event stream repaint the message; without script the same elements are
// buttons in forms and the page reloads.
document.addEventListener('click', function (e) {
  var t = e.target;
  var theme = closestOf(t, '[data-theme-name]');
  if (theme) { setTheme(theme.getAttribute('data-theme-name')); return; }
  var copy = closestOf(t, '[data-copy]');
  if (copy) { copyText(copy, copy.getAttribute('data-copy')); return; }
  var mention = closestOf(t, '[data-mention]');
  if (mention) {
    var ta = mention.closest('form').querySelector('textarea');
    takeMention(ta, mention.getAttribute('data-mention'));
    return;
  }
  var react = closestOf(t, 'form[data-react] button');
  if (react && window.fetch) {
    var form = react.closest('form');
    e.preventDefault();
    closeMenus(null);
    fetch(form.getAttribute('action'), { method: 'POST', body: new FormData(form) });
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
