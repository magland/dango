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

// ---- the composer ----
// Enter sends, Shift+Enter is a newline; the textarea grows with its content.
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, window.innerHeight * 0.4) + 'px';
}
document.addEventListener('input', function (e) {
  if (e.target.matches && e.target.matches('.composer textarea')) autosize(e.target);
});
document.addEventListener('keydown', function (e) {
  if (!e.target.matches || !e.target.matches('.composer textarea')) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    var form = e.target.closest('form');
    if (form) sendComposer(form);
  }
});
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
