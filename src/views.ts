import * as fs from 'fs';
import * as path from 'path';
import { avatar } from '../../mochiforge/src/avatar';
import { Html, html, joinHtml, raw } from '../../mochiforge/src/html';
import { IconName, icon } from '../../mochiforge/src/icons';
import { renderMarkdown } from '../../mochiforge/src/markdown';
import { formatDay, formatSize, timeTag } from '../../mochiforge/src/render';
import { Viewer } from '../../mochiforge/src/session';
import { THEMES, activeTheme, darkFor } from '../../mochiforge/src/themes';
import { UserProfile, Vault, loadVault, userExists } from '../../mochiforge/src/vault';
import { ChannelInfo, listChannels } from './channels';
import { loadConfig } from './config';
import { DmInfo, dmTitle } from './dms';
import { MARK } from './logo';
import { Device, NotifyPrefs, isMuted, readPrefs } from './notify';
import { Attachment, MAX_ATTACHMENTS_BYTES, Message } from './messages';
import { pageScript } from './pagescript';
import { canDeleteMessage, canEditMessage, canSeeChannel, isSiteAdmin } from './perms';
import { Pin, pinOf, readPins } from './pins';
import { READ_FILE, RoomUnread, UNREAD_CAP, isNewsFor, mentionsUser, readKey, unreadRooms } from './reads';
import { Room } from './rooms';
import { parseQuery } from './search';
import { styleSheet } from './style';
import { userDir } from './workspace';

// Every page the interface serves, rendered the way mochiforge renders its
// own: html`` templates escaping by type, no client framework, and controls a
// viewer cannot use simply not shown. The chrome differs from a forge's
// because a chat is one screen rather than a document: the frame is a
// sidebar and a room, and pages that are documents (login, admin, search)
// render inside the same frame as a scrolling column.

export interface PageOpts {
  viewer: Viewer | null;
  root: string;
  /** The room URL the sidebar should mark as current. */
  active?: string;
  /** Marks / so the sidebar is the page on a phone. */
  roomsPage?: boolean;
  /** Where a document page's back link leads on a phone; the room list when unset. */
  back?: { url: string; label: string };
}

export function csrfField(viewer: Viewer): Html {
  return html`<input type="hidden" name="csrf" value="${viewer.csrf}">`;
}

// ---- the frame ----

function themeMenu(): Html {
  const items = [
    html`<button type="button" class="dd-item theme-item" role="menuitemradio" aria-checked="false" data-theme-name="auto"><span class="theme-check">${icon('check')}</span><span>Follow the system</span></button>`,
    ...THEMES.map(
      (t) =>
        html`<button type="button" class="dd-item theme-item" role="menuitemradio" aria-checked="false" data-theme-name="${t.name}"><span class="theme-check">${icon('check')}</span><span>${t.label}</span></button>`
    ),
  ];
  return joinHtml(items);
}

/**
 * The account menu. Its button is the viewer's own name and face at the foot
 * of the sidebar, and it opens upward: the foot sits at the bottom of the
 * viewport, so a menu opening downward from it would be off the screen.
 */
function userMenu(opts: PageOpts): Html {
  const viewer = opts.viewer!;
  const admin = isSiteAdmin(viewer.auth);
  return html`<details class="dropdown user-menu"><summary class="side-user" aria-label="Account menu">${avatar(viewer.auth.username, 24)}<span class="whoami">${viewer.auth.username}</span>${icon('kebab')}</summary><div class="dropdown-menu dd-up" role="menu">
<a class="dd-item" href="/${encodeURIComponent(viewer.auth.username)}">${icon('person')} Profile</a>
<a class="dd-item" href="/account">${icon('sliders')} Account</a>
${admin ? html`<a class="dd-item" href="/admin">${icon('server')} Admin</a>` : ''}
<div class="dd-section">Appearance</div>
${themeMenu()}
<form method="post" action="/logout">${csrfField(viewer)}<button class="dd-item" type="submit">Sign out</button></form>
</div></details>`;
}

/** The count beside a room, or nothing; marked when a mention is among what is unread. */
export function badge(u: { url: string; count: number; mentions: number }): Html {
  if (u.count === 0) return html`<span class="badge" data-room-badge hidden></span>`;
  const text = u.count > UNREAD_CAP ? `${UNREAD_CAP}+` : String(u.count);
  return html`<span class="badge ${isUrgent(u) ? 'mention' : ''}" data-room-badge title="${u.count} unread${u.mentions ? `, ${u.mentions} mentioning you` : ''}">${text}</span>`;
}

/**
 * Whether what is unread is addressed to the viewer: a mention, or anything
 * in a direct conversation, which is addressed to them by being one. The
 * page script applies the same rule to live counts.
 */
function isUrgent(u: { url: string; count: number; mentions: number }): boolean {
  return u.count > 0 && (u.mentions > 0 || u.url.startsWith('/d/'));
}

/**
 * The tab's title and icon for what is unread: "(3) #general · workspace1",
 * so a tab left in the background shows that something arrived, and a dot
 * on the favicon, red when a mention or a direct message is among it, which
 * is visible even where tabs are too narrow for their titles.
 */
function unreadSummary(rooms: RoomUnread[]): { total: number; urgent: boolean } {
  let total = 0;
  let urgent = false;
  for (const r of rooms) {
    total += r.count;
    if (isUrgent(r)) urgent = true;
  }
  return { total, urgent };
}

function roomLink(u: RoomUnread, glyph: Html | string, active?: string, muted = false): Html {
  const cls = [u.url === active ? 'current' : '', u.count ? 'unread' : '', muted ? 'muted-room' : ''].join(' ');
  const label = u.kind === 'channel' ? u.title.slice(1) : u.title;
  return html`<li><a class="${cls}" href="${u.url}" data-room="${u.url}"><span class="room-glyph">${glyph}</span><span class="room-name">${label}</span>${
    muted ? html`<span class="room-muted" title="Notifications muted">${BELL_OFF_ICON}</span>` : ''
  }${badge(u)}</a></li>`;
}

function sidebar(opts: PageOpts, rooms: RoomUnread[]): Html {
  const root = opts.root;
  const privateNames = new Set(listChannels(root).filter((c) => c.private).map((c) => `/c/${encodeURIComponent(c.name)}`));
  const wsName = loadConfig(root).name;
  const prefs = readPrefs(root, opts.viewer!.auth.username);
  return html`<nav class="app-side">
<div class="side-head"><a class="brand" href="/">${raw(MARK)}<span>${wsName}</span></a></div>
<div class="side-rooms">
<div class="side-cap"><span>Channels</span><a href="/new" title="New channel">${icon('plus')}</a></div>
<ul>${joinHtml(
    rooms.filter((r) => r.kind === 'channel').map((r) => roomLink(r, privateNames.has(r.url) ? icon('lock') : '#', opts.active, isMuted(prefs, r.url)))
  )}</ul>
<div class="side-cap"><span>Direct messages</span><a href="/d/new" title="New conversation">${icon('plus')}</a></div>
<ul>${joinHtml(
    rooms
      .filter((r) => r.kind === 'dm')
      .map((r) => roomLink(r, r.with && r.with.length === 1 ? avatar(r.with[0], 18) : icon('people'), opts.active, isMuted(prefs, r.url)))
  )}</ul>
</div>
<div class="side-foot">${userMenu(opts)}<a class="topbar-icon" href="/search" aria-label="Search">${icon('search')}</a></div>
</nav>`;
}

export function layout(title: string, main: Html, opts: PageOpts): string {
  const theme = activeTheme().name;
  const sheet = styleSheet(activeTheme()).tag;
  const script = pageScript().tag;
  const rooms = opts.viewer ? unreadRooms(opts.root, opts.viewer.auth) : [];
  const unread = unreadSummary(rooms);
  // The workspace's name, not the page's: a tab is a workspace, and the room
  // in view changes too often to be what a tab is known by.
  const baseTitle = opts.viewer ? loadConfig(opts.root).name : title;
  const fullTitle = unread.total > 0 ? `(${unread.total > UNREAD_CAP ? `${UNREAD_CAP}+` : unread.total}) ${baseTitle}` : baseTitle;
  const iconHref =
    `/favicon.svg?t=${encodeURIComponent(theme)}` + (unread.total > 0 ? `&unread=${unread.urgent ? 'urgent' : 'some'}` : '');
  // The frame says which room it shows and who is looking, for the page
  // script: the count stream marks the current room read as messages arrive,
  // and the composer's @-completion needs to know whom not to suggest.
  const body = opts.viewer
    ? html`<div class="app ${opts.roomsPage ? 'rooms-page' : ''}" data-viewer="${opts.viewer.auth.username}" data-current-room="${opts.active ?? ''}" data-csrf="${opts.viewer.csrf}">${sidebar(opts, rooms)}<div class="app-main">${main}</div></div>`
    : html`<main class="container" style="padding-top: 48px">${main}</main>`;
  return html`<!doctype html>
<html lang="en" data-theme-vault="${theme}" data-theme-dark="${darkFor(activeTheme())}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title data-title="${baseTitle}">${fullTitle}</title>
<link rel="stylesheet" href="/assets/style.css?t=${encodeURIComponent(theme)}&amp;v=${sheet}">
<link rel="stylesheet" href="/assets/katex/katex.css">
<link rel="icon" href="${iconHref}" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon/180.png?t=${encodeURIComponent(theme)}">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
${opts.viewer ? html`<meta name="apple-mobile-web-app-title" content="${baseTitle}">
` : ''}<script src="/assets/page.js?v=${script}"></script>
</head>
<body>
${body}
</body>
</html>`.text;
}

/**
 * A document page inside the frame: a scrolling column with a measure. On a
 * phone the sidebar is not beside it, so the page carries a bar with the way
 * back, to the room it belongs to or else to the room list.
 */
function doc(title: string, content: Html, opts: PageOpts): string {
  const back = opts.back ?? { url: '/', label: opts.viewer ? loadConfig(opts.root).name : 'Back' };
  const head = opts.viewer
    ? html`<header class="room-head doc-head ${opts.back ? 'for-room' : ''}"><a class="doc-back" href="${back.url}">${BACK_ICON}<span>${back.label}</span></a></header>`
    : '';
  return layout(title, html`${head}<div class="doc"><div class="inner">${content}</div></div>`, opts);
}

// ---- messages ----

// What the browser can show or play by itself. Anything else is a link, and
// a PDF is one too: attachments are served under a sandbox policy, and a
// sandboxed document cannot run the PDF viewer, so opening one inline would
// show a blank page rather than the document.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const AUDIO_RE = /\.(wav|mp3|ogg|oga|opus|flac|m4a|aac|weba)$/i;
const VIDEO_RE = /\.(mp4|m4v|webm|ogv|mov)$/i;

/**
 * A message's text as HTML: markdown, @names of people linked to them, and
 * #names of channels the reader can see linked to the channel. A private
 * channel the reader is not in stays plain text, as a channel that does not
 * exist does, so a message does not tell them it is there.
 */
function bodyHtml(root: string, body: string, viewer: Viewer): Html {
  let visible: Set<string> | null = null;
  return raw(
    externalLinksInNewTab(
      renderMarkdown(body, {
        rawBase: '',
        blobBase: '',
        mentions: (name) => userExists(root, name),
        channels: (name) => {
          visible ??= new Set(listChannels(root).filter((c) => canSeeChannel(viewer.auth, c)).map((c) => c.name));
          return visible.has(name) ? `/c/${encodeURIComponent(name)}` : null;
        },
      })
    )
  );
}

/**
 * A link out of the workspace opens in a new tab, so following one does not
 * leave the conversation; a link within it (an @mention, a room) opens in
 * place. The renderer's output is sanitized, with every attribute quoted, so
 * a pattern over its <a> tags is exact; a target the message's own HTML set
 * is replaced rather than kept. The renderer already gives these links
 * rel="noopener noreferrer", which is what makes a new tab safe to open.
 */
export function externalLinksInNewTab(rendered: string): string {
  return rendered.replace(/<a (href="https?:\/\/[^"]*"[^>]*)>/gi, (_m, attrs: string) => `<a ${attrs.replace(/\s+target="[^"]*"/gi, '')} target="_blank">`);
}

/** A pushpin, drawn in the icon set's manner: a 16px box, currentColor, one stroke weight. */
const PIN_ICON = raw(
  '<svg class="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h4M7 2v4L4.5 9h7L9 6V2M8 9v5"/></svg>'
);

/** A bell, and a bell struck through, in the pushpin's manner: whether a room is notified. */
const BELL_ICON = raw(
  '<svg class="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5V7a4 4 0 0 1 8 0v3.5l1.5 1.5h-11zM6.5 14a1.5 1.5 0 0 0 3 0"/></svg>'
);
/** The way back, and a paperclip for attaching files, in the same manner. */
const BACK_ICON = raw(
  '<svg class="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>'
);
const PAPERCLIP_ICON = raw(
  '<svg class="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 7.5l-5.6 5.6a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.2 1.2 0 0 1-1.7-1.7l5.5-5.5"/></svg>'
);
const BELL_OFF_ICON = raw(
  '<svg class="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5V7a4 4 0 0 1 8 0v3.5l1.5 1.5h-11zM6.5 14a1.5 1.5 0 0 0 3 0M2 2l12 12"/></svg>'
);

function fileRows(roomUrl: string, id: number, files: Attachment[]): Html | '' {
  if (!files.length) return '';
  const rows = files.map((f) => {
    const href = `${roomUrl}/files/${id}/${encodeURIComponent(f.name)}`;
    // The approximate size, quietly, so a large file is known before it is opened.
    const size = html`<span class="file-size">${formatSize(f.size)}</span>`;
    if (IMAGE_RE.test(f.name)) {
      return html`<li class="msg-media"><a href="${href}" target="_blank" rel="noopener"><img class="msg-img" src="${href}" alt="${f.name}" loading="lazy" decoding="async"></a><span class="file-caption"><span class="file-name">${f.name}</span> ${size}</span></li>`;
    }
    // The name links to the file above its player, so it can still be saved.
    // Audio is not fetched until played; a video fetches enough for a poster.
    if (AUDIO_RE.test(f.name)) {
      return html`<li class="msg-media"><a href="${href}" target="_blank" rel="noopener">${icon('file')} ${f.name} ${size}</a><audio controls preload="none" src="${href}"></audio></li>`;
    }
    if (VIDEO_RE.test(f.name)) {
      return html`<li class="msg-media"><a href="${href}" target="_blank" rel="noopener">${icon('file')} ${f.name} ${size}</a><video class="msg-video" controls preload="metadata" src="${href}"></video></li>`;
    }
    return html`<li><a href="${href}" target="_blank" rel="noopener">${icon('file')} ${f.name} ${size}</a></li>`;
  });
  return html`<ul class="msg-files">${joinHtml(rows)}</ul>`;
}

const QUICK_REACTIONS = ['\u{1F44D}', '✅', '\u{1F440}', '\u{1F389}', '❤️', '\u{1F604}'];

function reactForm(roomUrl: string, id: number, emoji: string, viewer: Viewer, mine: boolean, count?: number): Html {
  return html`<form data-quiet method="post" action="${roomUrl}/m/${id}/react">${csrfField(viewer)}<input type="hidden" name="emoji" value="${emoji}"><button class="${count === undefined ? 'dd-item' : `react-pill ${mine ? 'mine' : ''}`}" type="submit" title="${mine ? 'Remove your reaction' : 'React'}">${emoji}${count !== undefined ? html` <span>${count}</span>` : ''}</button></form>`;
}

function msgTools(room: Room, m: Message, viewer: Viewer): Html {
  const parts: Html[] = [];
  parts.push(
    html`<details class="dropdown react-menu"><summary aria-label="React" title="React">${icon('plus')}</summary><div class="dropdown-menu dd-right" role="menu">${joinHtml(
      QUICK_REACTIONS.map((e) => reactForm(room.url, m.id, e, viewer, (m.reactions[e] ?? []).includes(viewer.auth.username)))
    )}</div></details>`
  );
  if (room.kind !== 'thread') {
    parts.push(html`<a href="${room.url}/t/${m.id}" title="Reply in thread">${icon('comment')}</a>`);
    const pinned = pinOf(room.dir, m.id) !== null;
    parts.push(
      html`<form data-quiet method="post" action="${room.url}/m/${m.id}/${pinned ? 'unpin' : 'pin'}">${csrfField(viewer)}<button type="submit" title="${pinned ? 'Unpin' : 'Pin to the room'}" class="${pinned ? 'is-pinned' : ''}">${PIN_ICON}</button></form>`
    );
  }
  if (canEditMessage(viewer.auth, m)) {
    parts.push(html`<a href="${room.url}/m/${m.id}/edit" title="Edit">${icon('pencil')}</a>`);
  }
  // A link to a page that asks first. With script, the page script asks in a
  // dialog instead and deletes without leaving the room.
  if (canDeleteMessage(viewer.auth, m.author)) {
    parts.push(html`<a href="${room.url}/m/${m.id}/delete" data-delete-message title="Delete">${icon('trash')}</a>`);
  }
  return html`<span class="msg-tools">${joinHtml(parts)}</span>`;
}

/**
 * One message as a list item. This is what the page renders and what the
 * event stream sends, so a message looks the same however it arrived. Its
 * author and time ride on the item, so the page script can tell, as the
 * list changes, which messages continue the one before (see messageItems).
 */
export function messageHtml(root: string, room: Room, m: Message, viewer: Viewer, cont = false): Html {
  if (m.deleted) {
    return html`<li class="msg" id="msg-${m.id}" data-mid="${m.id}" data-created="${m.created}"><span class="avatar" style="width:32px"></span><div class="msg-main"><span class="msg-deleted">This message was deleted.</span>${
      m.replyCount > 0 && room.kind !== 'thread'
        ? html`<div class="msg-below"><a class="thread-link" href="${room.url}/t/${m.id}">${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}</a></div>`
        : ''
    }</div></li>`;
  }
  const reactions = Object.entries(m.reactions).map(([emoji, users]) =>
    reactForm(room.url, m.id, emoji, viewer, users.includes(viewer.auth.username), users.length)
  );
  const thread =
    room.kind !== 'thread' && m.replyCount > 0
      ? html`<a class="thread-link" href="${room.url}/t/${m.id}">${icon('comment')} ${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}</a>`
      : '';
  const below = reactions.length || thread ? html`<div class="msg-below">${joinHtml(reactions)}${thread}</div>` : '';
  // A message that names the viewer is marked down its left side, so it can be
  // found in a scroll the way a flagged line can be found on a page.
  const mine = mentionsUser(m.body, viewer.auth.username) ? 'mentions-me' : '';
  const pin = room.kind === 'thread' ? null : pinOf(room.dir, m.id);
  return html`<li class="msg ${mine} ${pin ? 'pinned' : ''} ${cont ? 'msg-cont' : ''}" id="msg-${m.id}" data-mid="${m.id}" data-author="${m.author}" data-created="${m.created}">${avatar(m.author, 32)}<div class="msg-main">
${pin ? html`<div class="pinned-by">${PIN_ICON} Pinned by ${pin.by}</div>` : ''}<div class="msg-head"><a class="author" href="/${encodeURIComponent(m.author)}">${m.author}</a>${timeTag(m.created)}${m.edited ? html`<span class="msg-edited">(edited)</span>` : ''}</div>
<div class="msg-body markdown-body">${bodyHtml(root, m.body, viewer)}</div>
${fileRows(room.url, m.id, m.files)}${below}
</div>${msgTools(room, m, viewer)}</li>`;
}

function dayRule(iso: string): Html {
  return html`<li class="day-rule" role="separator">${formatDay(iso)}</li>`;
}

/**
 * How long after a message the same person's next one still continues it,
 * drawn without the avatar and name again. The page script uses the same
 * figure for what arrives live.
 */
const CONTINUE_MS = 5 * 60 * 1000;

/**
 * A run of messages as list items: a rule where the day changes, a rule
 * where what the viewer has not read begins, and a message that follows
 * its author's last within a few minutes drawn as a continuation. The page
 * script redraws the day rules in the viewer's own time zone and applies
 * the same grouping as the list changes; this is the first paint, and what
 * a page without script keeps.
 */
function messageItems(root: string, room: Room, messages: Message[], viewer: Viewer, readUpTo?: number, startDay = ''): Html[] {
  const items: Html[] = [];
  let lastDay = startDay;
  let prev: Message | null = null;
  let marked = readUpTo === undefined;
  messages.forEach((m, i) => {
    const day = m.created.slice(0, 10);
    if (day !== lastDay) {
      items.push(dayRule(m.created));
      lastDay = day;
      prev = null;
    }
    // Not above the first message on the page: everything shown is new
    // then, and a rule at the top says nothing.
    if (!marked && m.id > readUpTo! && isNewsFor(m, viewer.auth.username)) {
      marked = true;
      if (i > 0) {
        items.push(html`<li class="new-rule" role="separator">New</li>`);
        prev = null;
      }
    }
    const cont =
      prev !== null &&
      !prev.deleted &&
      !m.deleted &&
      prev.author === m.author &&
      Date.parse(m.created) - Date.parse(prev.created) < CONTINUE_MS;
    items.push(messageHtml(root, room, m, viewer, cont));
    prev = m;
  });
  return items;
}

/**
 * The scrolling list, and a button over its foot that brings the reader
 * back to the newest message when they have scrolled away from it or
 * something has arrived below them; the page script shows it.
 */
function messageList(root: string, room: Room, messages: Message[], viewer: Viewer, readUpTo?: number): Html {
  const items = messageItems(root, room, messages, viewer, readUpTo);
  const last = messages.length ? messages[messages.length - 1].id : 0;
  return html`<div class="msgs"><ul id="msg-list" data-stream="${room.url}/events" data-last="${last}">${joinHtml(items)}</ul></div>${JUMP_NEWEST}`;
}

const JUMP_NEWEST = html`<div class="jump-newest-wrap"><button class="jump-newest" type="button" data-jump-newest hidden>Jump to newest ${raw(
  '<svg class="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3.5 8.5L8 13l4.5-4.5"/></svg>'
)}</button></div>`;

/**
 * The composer. data-max-bytes is the attachments' cap, so the page script
 * can refuse an oversized send before uploading any of it; the nonce is
 * filled by the page script, once per message, and sent again on a retry so
 * the server can tell a retry from a second message.
 */
function composer(room: Room, viewer: Viewer, placeholder: string): Html {
  return html`<div class="composer"><form data-composer data-max-bytes="${MAX_ATTACHMENTS_BYTES}" method="post" action="${room.url}/messages" enctype="multipart/form-data">${csrfField(viewer)}<input type="hidden" name="nonce" value=""><div class="composer-box">
<div class="mention-list" data-mention-list hidden role="listbox"></div>
<div class="send-progress" data-send-progress hidden><div></div></div>
<textarea name="body" rows="1" placeholder="${placeholder}" aria-label="${placeholder}"></textarea>
<ul class="file-list" data-file-list hidden></ul>
<div class="send-status" data-send-status role="status" aria-live="polite" hidden></div>
<div class="composer-row"><label class="attach topbar-icon" title="Attach files">${PAPERCLIP_ICON}<input type="file" name="files" multiple aria-label="Attach files"></label><span class="file-size" data-file-total></span><span class="hint">Enter sends, Shift+Enter is a new line, markdown works</span><button class="btn btn-primary" type="submit">Send</button></div>
</div></form></div>`;
}

// ---- room pages ----

/**
 * The bell in a room's header, which mutes or unmutes the room's
 * notifications for the viewer. It shows the room's state, and pressing it
 * changes it; the label says which way.
 */
function muteButton(root: string, room: Room, viewer: Viewer): Html {
  const muted = isMuted(readPrefs(root, viewer.auth.username), room.url);
  const label = muted ? `Unmute ${room.title}: notify me of it again` : `Mute ${room.title}: no notifications from it`;
  return html`<form method="post" action="${room.url}/mute" class="mute-form">${csrfField(viewer)}<input type="hidden" name="muted" value="${muted ? '0' : '1'}"><button class="topbar-icon ${muted ? 'is-muted' : ''}" type="submit" title="${label}" aria-label="${label}" aria-pressed="${muted ? 'true' : 'false'}">${muted ? BELL_OFF_ICON : BELL_ICON}</button></form>`;
}

function roomHead(root: string, room: Room, viewer: Viewer, tools: Html | '' = ''): Html {
  const topic = room.channel?.topic;
  const pins = readPins(room.dir).length;
  const pinsLink = html`<a class="topbar-icon pins-link" href="${room.url}/pins" title="Pinned messages" aria-label="Pinned messages, ${pins}">${PIN_ICON}<span data-pin-count>${pins || ''}</span></a>`;
  return html`<header class="room-head"><a class="back-link topbar-icon" href="/" aria-label="All rooms">${BACK_ICON}</a><div class="room-title"><h1>${room.title}</h1>${
    topic ? html`<span class="room-topic">${topic}</span>` : ''
  }</div><div class="room-tools">${pinsLink}${muteButton(root, room, viewer)}${tools}</div></header>`;
}

/** A room's pinned messages, most recently pinned first, each whole. */
export function pinsPage(root: string, room: Room, pinned: { pin: Pin; message: Message }[], viewer: Viewer): string {
  const content = html`<h1>Pinned in ${room.title}</h1>
${pinned.length === 0 ? html`<p class="muted">Nothing is pinned here yet. Pin a message from its tools, the pushpin that appears when you point at it.</p>` : ''}
<ul class="pins-list" style="list-style:none;margin:0;padding:0" data-pins>${joinHtml(pinned.map(({ message }) => messageHtml(root, room, message, viewer)))}</ul>`;
  return doc(`Pinned in ${room.title}`, content, { viewer, root, active: room.url, back: { url: room.url, label: room.title } });
}

/** readUpTo is where the viewer's read marker stood before this page, for the "New" rule. */
export function channelPage(root: string, room: Room, messages: Message[], viewer: Viewer, readUpTo?: number): string {
  const tools = html`<a class="topbar-icon" href="${room.url}/settings" aria-label="Channel settings" title="Channel settings">${icon('sliders')}</a>`;
  const main = html`${roomHead(root, room, viewer, tools)}${messageList(root, room, messages, viewer, readUpTo)}${composer(room, viewer, `Message ${room.title}`)}`;
  return layout(`${room.title}`, main, { viewer, root, active: room.url });
}

export function dmPage(root: string, room: Room, messages: Message[], viewer: Viewer, readUpTo?: number): string {
  const main = html`${roomHead(root, room, viewer)}${messageList(root, room, messages, viewer, readUpTo)}${composer(room, viewer, `Message ${room.title}`)}`;
  return layout(room.title, main, { viewer, root, active: room.url });
}

export function threadPage(root: string, room: Room, anchor: Message, replies: Message[], viewer: Viewer): string {
  const parent = room.parent!;
  const head = html`<header class="room-head"><a class="topbar-icon" href="${parent.url}" aria-label="Back to ${parent.title}">${BACK_ICON}</a><div class="room-title"><h1>Thread</h1><span class="room-topic">in <a href="${parent.url}">${parent.title}</a></span></div><div class="room-tools"></div></header>`;
  // The parent carries the day it was said, and the replies take theirs from
  // it, so a reply the same day is not set under a rule of its own.
  const anchorHtml = html`<ul class="thread-anchor" style="list-style:none;margin:0;padding:0">${dayRule(anchor.created)}${messageHtml(root, parent, anchor, viewer)}</ul>`;
  const items = messageItems(root, room, replies, viewer, undefined, anchor.created.slice(0, 10));
  const last = replies.length ? replies[replies.length - 1].id : 0;
  const list = html`<div class="msgs">${anchorHtml}<ul id="msg-list" data-stream="${room.url}/events" data-last="${last}">${joinHtml(items)}</ul></div>${JUMP_NEWEST}`;
  const main = html`${head}${list}${composer(room, viewer, 'Reply in thread')}`;
  return layout(`Thread in ${parent.title}`, main, { viewer, root, active: parent.url });
}

// ---- document pages ----

export function homePage(root: string, viewer: Viewer): string {
  const channels = listChannels(root).filter((c) => canSeeChannel(viewer.auth, c));
  const unread = new Map(unreadRooms(root, viewer.auth).map((r) => [r.url, r]));
  const wsName = loadConfig(root).name;
  const rows = channels.map((c) => {
    const url = `/c/${encodeURIComponent(c.name)}`;
    const u = unread.get(url) ?? { url, count: 0, mentions: 0 };
    return html`<li style="margin-bottom:6px"><a href="${url}" data-room="${url}">${c.private ? icon('lock') : '#'} ${c.name} ${badge(u)}</a>${
      c.topic ? html` <span class="muted">- ${c.topic}</span>` : ''
    }</li>`;
  });
  const waiting = [...unread.values()].filter((r) => r.count > 0);
  const content = html`<h1>${wsName}</h1>
<p class="muted">Pick a channel, or start a <a href="/d/new">direct conversation</a>.</p>
${
    waiting.length
      ? html`<p>Unread: ${joinHtml(
          waiting.map((r) => html`<a href="${r.url}" data-room="${r.url}">${r.title} ${badge(r)}</a>`),
          ', '
        )}</p>`
      : ''
  }
<ul style="list-style:none;padding:0">${joinHtml(rows)}</ul>
<p><a class="btn" href="/new">${icon('plus')} New channel</a></p>`;
  return doc(wsName, content, { viewer, root, roomsPage: true });
}

/**
 * The mark above a signed-out page's form. Only the mark: a workspace says
 * nothing about itself, its name included, to someone not signed in.
 */
const SIGNIN_MARK = html`<div class="signin-mark" aria-hidden="true">${raw(MARK)}</div>`;

export function loginPage(next: string, error?: string): string {
  const content = html`${SIGNIN_MARK}<div class="form-box" style="margin:0 auto">
<h1>Sign in</h1>
${error ? html`<div class="form-error">${error}</div>` : ''}
<form method="post" action="/login">
<input type="hidden" name="next" value="${next}">
<div class="field"><label for="token">Token</label><input type="password" id="token" name="token" autocomplete="current-password" autofocus required>
<p class="muted">Paste the token an administrator gave you. It identifies you; there is no separate username.</p></div>
<button class="btn btn-primary" type="submit">Sign in</button>
</form></div>`;
  return layout('Sign in', content, { viewer: null, root: '' });
}

export function errorPage(status: number, message: string, opts: PageOpts): string {
  const content = html`<h1>${status}</h1><p>${message}</p><p><a href="/">Back to the workspace</a></p>`;
  return opts.viewer ? doc(`${status}`, content, opts) : layout(`${status}`, content, opts);
}

export function newChannelPage(root: string, viewer: Viewer, error?: string): string {
  const content = html`<div class="form-box">
<h1>New channel</h1>
${error ? html`<div class="form-error">${error}</div>` : ''}
<form method="post" action="/new">${csrfField(viewer)}
<div class="field"><label for="name">Name</label><input type="text" id="name" name="name" required pattern="[a-z0-9][a-z0-9-]*" autofocus>
<p class="muted">Lowercase letters, digits, and hyphens: what fits after a #.</p></div>
<div class="field"><label for="topic">Topic</label><input type="text" id="topic" name="topic"></div>
<div class="field"><label class="checkbox"><input type="checkbox" name="private" value="1"> Private: visible only to people added to it, and that cannot be undone later.</label></div>
<button class="btn btn-primary" type="submit">Create channel</button>
</form></div>`;
  return doc('New channel', content, { viewer, root });
}

export function channelSettingsPage(
  root: string,
  room: Room,
  viewer: Viewer,
  opts: { error?: string; flash?: string } = {}
): string {
  const c = room.channel!;
  const admin = isSiteAdmin(viewer.auth);
  const memberRows = c.private
    ? joinHtml(
        c.members.map(
          (m) => html`<li style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${avatar(m, 20)} <a href="/${encodeURIComponent(m)}">${m}</a>
<form method="post" action="${room.url}/members/remove" style="margin-left:auto" data-confirm="${m === viewer.auth.username ? `Leave #${c.name}? You will need to be added back.` : `Remove ${m} from #${c.name}?`}">${csrfField(viewer)}<input type="hidden" name="user" value="${m}"><button class="btn-link" type="submit">${m === viewer.auth.username ? 'Leave' : 'Remove'}</button></form></li>`
        )
      )
    : '';
  const membersSection = c.private
    ? html`<h2>Members</h2>
<ul style="list-style:none;padding:0;max-width:420px">${memberRows}</ul>
<form method="post" action="${room.url}/members/add">${csrfField(viewer)}
<div class="field"><label for="user">Add someone</label><input type="text" id="user" name="user" placeholder="username"></div>
<button class="btn" type="submit">Add</button>
</form>`
    : html`<p class="muted">#${c.name} is public: every member of the workspace can read and post in it.</p>`;
  const danger = admin
    ? html`<div class="danger-zone"><h3>Delete this channel</h3>
<p>Everything said in it goes with it. There is no undo.</p>
<form method="post" action="${room.url}/delete" data-confirm="Delete #${c.name} and everything said in it? There is no undo.">${csrfField(viewer)}<button class="btn btn-danger" type="submit">Delete #${c.name}</button></form></div>`
    : '';
  const content = html`<h1>${room.title} settings</h1>
${opts.error ? html`<div class="form-error">${opts.error}</div>` : ''}${opts.flash ? html`<div class="flash">${opts.flash}</div>` : ''}
<form method="post" action="${room.url}/settings">${csrfField(viewer)}
<div class="field" style="max-width:520px"><label for="topic">Topic</label><input type="text" id="topic" name="topic" value="${c.topic}"></div>
<button class="btn btn-primary" type="submit">Save</button>
</form>
${membersSection}
${danger}`;
  return doc(`${room.title} settings`, content, { viewer, root, active: room.url, back: { url: room.url, label: room.title } });
}

export function newDmPage(root: string, viewer: Viewer, error?: string): string {
  const state = loadVault(root);
  const users = state.status === 'ok' ? Object.keys(state.vault.users).filter((u) => u !== viewer.auth.username).sort() : [];
  const boxes = users.map(
    (u) => html`<label class="checkbox person-pick"><input type="checkbox" name="user" value="${u}">${avatar(u, 20)} ${u}</label>`
  );
  const content = html`<div class="form-box">
<h1>New conversation</h1>
${error ? html`<div class="form-error">${error}</div>` : ''}
<form method="post" action="/d/new">${csrfField(viewer)}
<div class="field"><label>With</label>${joinHtml(boxes)}</div>
<button class="btn btn-primary" type="submit">Start</button>
</form></div>`;
  return doc('New conversation', content, { viewer, root });
}

export interface SearchHit {
  /** Where it was said: the room's URL and title. */
  url: string;
  where: string;
  message: Message;
  /** The room the hit renders against, for tools-free display. */
  root: string;
}

export function searchPage(root: string, viewer: Viewer, query: string, hits: { url: string; where: string; message: Message }[]): string {
  const rows = hits.map(
    (h) => html`<div class="search-result">
<div class="where"><a href="${h.url}">${h.where}</a><span class="who">${avatar(h.message.author, 16)} ${h.message.author}</span>${timeTag(h.message.created)}</div>
<div class="markdown-body">${bodyHtml(root, h.message.body, viewer)}</div>
</div>`
  );
  // The words found are marked in each result by the page script.
  const content = html`<h1>Search</h1>
<form method="get" action="/search" style="margin-bottom:24px;max-width:520px"><div class="field"><input type="text" name="q" value="${query}" placeholder="Search messages" autofocus aria-label="Search messages">
<p class="muted">Narrow it with <code>from:alice</code> or <code>in:#general</code>.</p></div></form>
${query === '' ? '' : html`<p class="muted">${hits.length === 0 ? 'Nothing matched.' : `${hits.length} ${hits.length === 1 ? 'message matches' : 'messages match'}.`}</p>`}
<div data-highlight="${parseQuery(query).text}">${joinHtml(rows)}</div>`;
  return doc('Search', content, { viewer, root });
}

export function profilePage(root: string, viewer: Viewer, username: string, profile: UserProfile | undefined): string {
  const content = html`<div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">${avatar(username, 64)}<div>
<h1 style="margin:0">${profile?.name ?? username}</h1>
${profile?.name ? html`<p class="muted" style="margin:0">${username}</p>` : ''}
</div></div>
${profile?.bio ? html`<p>${profile.bio}</p>` : ''}
${
    username === viewer.auth.username
      ? html`<p><a class="btn" href="/account">Edit profile</a></p>`
      : html`<form method="post" action="/d/new">${csrfField(viewer)}<input type="hidden" name="user" value="${username}"><button class="btn btn-primary" type="submit">Message ${username}</button></form>`
  }`;
  return doc(username, content, { viewer, root });
}

export interface AccountNotifications {
  prefs: NotifyPrefs;
  devices: Device[];
  /** The workspace's VAPID public key, which a browser subscribes under. */
  vapidKey: string;
}

export function accountPage(root: string, viewer: Viewer, notify: AccountNotifications, opts: { flash?: string; error?: string } = {}): string {
  const profile = viewer.auth.user.profile;
  const content = html`<h1>Account</h1>
${opts.error ? html`<div class="form-error">${opts.error}</div>` : ''}${opts.flash ? html`<div class="flash">${opts.flash}</div>` : ''}
<form method="post" action="/account" style="max-width:520px">${csrfField(viewer)}
<div class="field"><label for="name">Display name</label><input type="text" id="name" name="name" value="${profile?.name ?? ''}"></div>
<div class="field"><label for="bio">Bio</label><input type="text" id="bio" name="bio" value="${profile?.bio ?? ''}"></div>
<button class="btn btn-primary" type="submit">Save</button>
</form>
${notificationsSection(root, viewer, notify)}
<p class="muted" style="margin-top:24px">Signed in as <strong>${viewer.auth.username}</strong>. Tokens are minted by an administrator; ask one for a new token if you need to sign in elsewhere or use the API.</p>`;
  return doc('Account', content, { viewer, root });
}

/**
 * Notifications, in two parts. This device: turning them on is the browser's
 * business (a permission, then a push subscription), so it is done by the
 * page script, which fills in the status line and shows the buttons that
 * apply; without script the section says so. Then what to be told about,
 * which is an ordinary form and applies to every device at once.
 */
function notificationsSection(root: string, viewer: Viewer, notify: AccountNotifications): Html {
  const { prefs, devices } = notify;
  const quiet = prefs.quiet;
  const rooms = unreadRooms(root, viewer.auth);
  const level = (value: string, label: string, hint: string) =>
    html`<label class="checkbox" style="display:block;margin-bottom:6px"><input type="radio" name="level" value="${value}" ${prefs.level === value ? raw('checked') : ''}> ${label}<br><span class="muted">${hint}</span></label>`;
  const muteBox = (r: RoomUnread) =>
    html`<label class="checkbox" style="display:block;margin-bottom:4px"><input type="checkbox" name="mute" value="${readKey(r.url)}" ${prefs.muted.includes(readKey(r.url)) ? raw('checked') : ''}> ${r.title}</label>`;
  const deviceRows = devices.map(
    (d) => html`<li style="display:flex;align-items:center;gap:8px;margin-bottom:4px" data-device="${d.id}"><span>${d.label}</span>${d.created ? html`<span class="muted">added ${timeTag(d.created)}</span>` : ''}
<form method="post" action="/account/push/remove" style="margin-left:auto">${csrfField(viewer)}<input type="hidden" name="id" value="${d.id}"><button class="btn-link" type="submit">Remove</button></form></li>`
  );
  return html`<h2 id="notifications">Notifications</h2>
<div class="push-device" data-push data-vapid="${notify.vapidKey}" style="max-width:520px">
<p data-push-status>Turning notifications on for a device needs script.</p>
<p><button class="btn btn-primary" type="button" data-push-on hidden>Turn on in this browser</button> <button class="btn" type="button" data-push-off hidden>Turn off in this browser</button> <button class="btn" type="button" data-push-test hidden>Send a test notification</button></p>
<div data-chime hidden><label class="checkbox"><input type="checkbox"> Play a chime in an open workspace tab when a notification arrives</label> <button class="btn-link" type="button" data-chime-play>Hear it</button>
<p class="muted">The system's own notification sound is often off, and a web page cannot choose it. The chime plays in a tab you have clicked or typed in since it opened; this setting is for this browser only.</p></div>
</div>
${
    devices.length
      ? html`<h3>Devices that receive them</h3><ul style="list-style:none;padding:0;max-width:520px">${joinHtml(deviceRows)}</ul>`
      : html`<p class="muted">No device receives your notifications yet.</p>`
  }
<form method="post" action="/account/notifications" style="max-width:520px">${csrfField(viewer)}
<h3>What to be told about</h3>
${level('direct', 'Direct messages, mentions, and replies in my threads', 'Messages addressed to you: your direct conversations, messages that @mention you, and replies in threads you started or replied in.')}
${level('all', 'Everything', 'All of the above, and every message in every channel you can read.')}
${level('none', 'Nothing', 'No notifications on any device. Unread counts still show in the sidebar.')}
<label class="checkbox" style="display:block;margin:12px 0"><input type="checkbox" name="preview" value="1" ${prefs.preview ? raw('checked') : ''}> Show who wrote what<br><span class="muted">Otherwise a notification only says that something arrived. The text is encrypted for your device on its way through your browser's push service (Google, Apple, Mozilla, or Microsoft), which sees when a notification is sent but not what it says; it does show on your lock screen.</span></label>
<h3>Quiet hours</h3>
<label class="checkbox" style="display:block;margin-bottom:8px"><input type="checkbox" name="quiet" value="1" ${quiet ? raw('checked') : ''}> Send no notifications between</label>
<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px"><input type="time" name="quiet_start" value="${quiet?.start ?? '22:00'}" aria-label="Quiet from"> and <input type="time" name="quiet_end" value="${quiet?.end ?? '07:00'}" aria-label="Quiet until"></div>
<div class="field"><label for="tz">Time zone</label><input type="text" id="tz" name="tz" value="${quiet?.tz ?? ''}" placeholder="UTC" data-tz-fill>
<p class="muted">What arrives in those hours is not notified later; it waits in the unread counts. The time zone is this browser's unless you change it.</p></div>
${
    rooms.length
      ? html`<h3>Muted rooms</h3><p class="muted">Nothing from a muted room is notified, mentions included; its unread count still shows. The bell in a room's header does the same.</p>${joinHtml(rooms.map(muteBox))}`
      : ''
  }
<div style="margin-top:12px"><button class="btn btn-primary" type="submit">Save</button></div>
</form>`;
}

// ---- admin ----

/**
 * When someone was last in the workspace. Reading and posting both move a
 * person's read markers, so the file that keeps them is touched whenever
 * they use a room, and its time says when that last was; nothing else is
 * recorded for it.
 */
function lastActive(root: string, username: string): Html {
  try {
    return html`active ${timeTag(fs.statSync(path.join(userDir(root, username), READ_FILE)).mtime.toISOString(), '')}`;
  } catch {
    return html`not seen yet`;
  }
}

export function adminPage(root: string, viewer: Viewer, vault: Vault, opts: { flash?: string; error?: string } = {}): string {
  const config = loadConfig(root);
  const users = Object.entries(vault.users).sort(([a], [b]) => a.localeCompare(b));
  const rows = users.map(([name, u]) => {
    const isSelf = name === viewer.auth.username;
    return html`<tr>
<td class="person">${avatar(name, 20)} <a href="/${encodeURIComponent(name)}">${name}</a>${u.profile?.name ? html` <span class="muted">${u.profile.name}</span>` : ''}${u.siteAdmin ? html` <span class="muted">(admin)</span>` : ''}</td>
<td class="muted seen">${lastActive(root, name)}</td>
<td class="muted tokens">${u.tokens.length} ${u.tokens.length === 1 ? 'token' : 'tokens'}</td>
<td class="actions">
<form method="post" action="/admin/users/token" style="display:inline">${csrfField(viewer)}<input type="hidden" name="user" value="${name}"><button class="btn-link" type="submit">New token</button></form>
${isSelf ? '' : html` · <form method="post" action="/admin/users/admin" style="display:inline">${csrfField(viewer)}<input type="hidden" name="user" value="${name}"><input type="hidden" name="value" value="${u.siteAdmin ? '0' : '1'}"><button class="btn-link" type="submit">${u.siteAdmin ? 'Revoke admin' : 'Make admin'}</button></form> · <form method="post" action="/admin/users/remove" style="display:inline" data-confirm="Remove ${name} and every token they hold?">${csrfField(viewer)}<input type="hidden" name="user" value="${name}"><button class="btn-link" type="submit">Remove</button></form>`}
</td></tr>`;
  });
  const content = html`<h1>Admin</h1>
${opts.error ? html`<div class="form-error">${opts.error}</div>` : ''}${opts.flash ? html`<div class="flash">${opts.flash}</div>` : ''}
<h2>People</h2>
<table class="listing people"><tbody>${joinHtml(rows)}</tbody></table>
<form method="post" action="/admin/users/add" style="margin-top:12px;max-width:520px">${csrfField(viewer)}
<div class="field"><label for="username">Add someone</label><input type="text" id="username" name="username" placeholder="username" required>
<p class="muted">Creates the account and mints its first token, shown once for you to hand over.</p></div>
<label class="checkbox"><input type="checkbox" name="admin" value="1"> Site admin</label>
<div style="margin-top:10px"><button class="btn btn-primary" type="submit">Add user</button></div>
</form>
<h2>Workspace</h2>
<form method="post" action="/admin/settings" style="max-width:520px">${csrfField(viewer)}
<div class="field"><label for="wsname">Name</label><input type="text" id="wsname" name="name" value="${config.name}"></div>
<div class="field"><label for="theme">Theme</label><select id="theme" name="theme">${joinHtml(
    THEMES.map((t) => html`<option value="${t.name}" ${t.name === config.theme ? raw('selected') : ''}>${t.label}</option>`)
  )}</select>
<p class="muted">The workspace's own look; each person can still pick their own from the account menu.</p></div>
<button class="btn btn-primary" type="submit">Save</button>
</form>`;
  return doc('Admin', content, { viewer, root });
}

/**
 * Where an invite link points: /invite with the token in the fragment. A
 * fragment is never sent to the server, so the token stays out of access
 * logs, proxies, and Referer headers; the page script moves it into the
 * sign-in form and clears it from the address bar.
 */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/invite#token=${token}`;
}

export function tokenPage(root: string, viewer: Viewer, username: string, token: string, created: boolean, origin: string): string {
  const link = inviteLink(origin, token);
  const content = html`<h1>${created ? `${username} was added` : `A new token for ${username}`}</h1>
<p>This is shown once; the workspace keeps only a hash of the token. Send ${username} the invite link, which signs them in with one click:</p>
<div class="copy-row"><input type="text" readonly value="${link}" aria-label="Invite link"><button class="btn" type="button" data-copy="${link}">Copy link</button></div>
<p class="muted">The link carries the token itself, so anyone holding it can sign in as ${username} until the token is revoked: send it privately, the way you would send a password.</p>
<p>Or hand over the token alone, for the sign-in page or the CLI (<code>dango login</code>):</p>
<div class="copy-row"><input type="text" readonly value="${token}" aria-label="Token"><button class="btn" type="button" data-copy="${token}">Copy token</button></div>
<p><a class="btn" href="/admin">Back to admin</a></p>`;
  return doc('Token', content, { viewer, root });
}

/**
 * What an invite link opens. It is its own page rather than /login, because
 * /login sends a signed-in visitor straight on, and a redirect would carry
 * the fragment, token and all, into the address bar of wherever it landed.
 * Here the page script fills the form from the fragment and the person
 * presses one button; nothing signs anyone in without that press, so a
 * link cannot quietly swap a visitor into someone else's account.
 */
export function invitePage(signedInAs: string | null): string {
  const content = html`${SIGNIN_MARK}<div class="form-box" style="margin:0 auto" data-invite>
<h1>You're invited</h1>
${signedInAs ? html`<div class="flash">This browser is signed in as <strong>${signedInAs}</strong>. Accepting the invite switches it to the invited account.</div>` : ''}
<p data-invite-ready hidden>Your invite link filled in your sign-in token. Press the button to join the workspace.</p>
<div class="form-error" data-invite-missing hidden>This invite link has no token in it. It may have been cut short when it was copied; ask for it again, or paste your token below.</div>
<form method="post" action="/login">
<input type="hidden" name="next" value="/">
<div class="field"><label for="token">Token</label><input type="password" id="token" name="token" autocomplete="current-password" required></div>
<button class="btn btn-primary" type="submit">Join the workspace</button>
</form></div>`;
  return layout('Invite', content, { viewer: null, root: '' });
}

export function deleteMessagePage(root: string, room: Room, m: Message, viewer: Viewer): string {
  const content = html`<h1>Delete this message?</h1>
<ul class="thread-anchor" style="list-style:none;margin:0 0 16px;padding:0">${messageHtml(root, room, m, viewer)}</ul>
<p>It will read "This message was deleted." for everyone, and its attachments are removed. There is no undo.</p>
<form method="post" action="${room.url}/m/${m.id}/delete">${csrfField(viewer)}
<button class="btn btn-danger" type="submit">Delete message</button>
<a class="btn" href="${room.url}">Cancel</a>
</form>`;
  return doc('Delete message', content, { viewer, root, active: room.parent?.url ?? room.url, back: { url: room.url, label: room.title } });
}

export function editMessagePage(root: string, room: Room, m: Message, viewer: Viewer, error?: string): string {
  const content = html`<h1>Edit message</h1>
${error ? html`<div class="form-error">${error}</div>` : ''}
<form method="post" action="${room.url}/m/${m.id}/edit" style="max-width:720px">${csrfField(viewer)}
<div class="field"><textarea name="body" rows="8" autofocus>${m.body}</textarea></div>
<button class="btn btn-primary" type="submit">Save</button>
<a class="btn" href="${room.url}">Cancel</a>
</form>`;
  return doc('Edit message', content, { viewer, root, active: room.url, back: { url: room.url, label: room.title } });
}

export function aboutIcon(name: IconName): Html {
  return icon(name);
}

/** How a channel or DM presents itself in search results. */
export function roomLabel(room: { kind: string; channel?: ChannelInfo; dm?: DmInfo }, viewer: string): string {
  if (room.channel) return `#${room.channel.name}`;
  if (room.dm) return dmTitle(room.dm, viewer);
  return 'somewhere';
}
