import * as fs from 'fs';
import * as path from 'path';
import { avatar } from '../../mochiforge/src/avatar';
import { Html, html, joinHtml, raw } from '../../mochiforge/src/html';
import { IconName, icon } from '../../mochiforge/src/icons';
import { renderMarkdown } from '../../mochiforge/src/markdown';
import { formatDay, formatSize, timeTag } from '../../mochiforge/src/render';
import { Viewer } from '../../mochiforge/src/session';
import { THEMES, activeTheme, darkFor } from '../../mochiforge/src/themes';
import { UserProfile, Vault, loadVault, tokenId, userExists } from '../../mochiforge/src/vault';
import { ConnectionReport, describeReport, readReports } from './calllog';
import { liveCall, liveCallsByRoom } from './calls';
import { callScript } from './callscript';
import { ChannelInfo, listChannels } from './channels';
import { CallsConfig, DEFAULT_STUN, loadConfig } from './config';
import { DmInfo, dmTitle, isSelfDm } from './dms';
import { lobbiesFor } from './guests';
import { MARK } from './logo';
import { MAX_GUEST_NAME, MAX_TITLE, MeetingInfo, currentGuests, guestLink, listMeetingsFor, mayDeleteMeeting, personLabel, readMeeting } from './meetings';
import { Device, NotifyPrefs, isMuted, readPrefs } from './notify';
import { Attachment, MAX_ATTACHMENTS_BYTES, MAX_REACTION, Message } from './messages';
import { pageScript } from './pagescript';
import { canDeleteMessage, canEditMessage, canSeeChannel, isGuest, isSiteAdmin } from './perms';
import { Pin, pinOf, readPins } from './pins';
import { READ_FILE, RoomUnread, UNREAD_CAP, isNewsFor, mentionsUser, readKey, unreadRooms } from './reads';
import { Room, channelRoom, dmRoom, meetingRoom } from './rooms';
import { MAX_HITS, SCAN_LIMIT, parseQuery } from './search';
import { styleSheet } from './style';
import { isGuestName, userDir } from './workspace';

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

/**
 * The camera beside a room with a call going on, saying who is in it. It is
 * always there, hidden when there is no call, so the page script can show it
 * as calls start and end.
 */
function callMarker(people: string[] | undefined): Html {
  return html`<span class="room-call" data-room-call title="${people?.length ? `In a call: ${people.join(', ')}` : ''}" ${people?.length ? '' : raw('hidden')}>${CALL_ICON}</span>`;
}

function roomLink(u: RoomUnread, glyph: Html | string, active?: string, muted = false, call?: string[]): Html {
  const cls = [u.url === active ? 'current' : '', u.count ? 'unread' : '', muted ? 'muted-room' : ''].join(' ');
  const label = u.kind === 'channel' ? u.title.slice(1) : u.title;
  return html`<li><a class="${cls}" href="${u.url}" data-room="${u.url}"><span class="room-glyph">${glyph}</span><span class="room-name">${label}</span>${
    muted ? html`<span class="room-muted" title="Notifications muted">${BELL_OFF_ICON}</span>` : ''
  }${callMarker(call)}${badge(u)}</a></li>`;
}

function sidebar(opts: PageOpts, rooms: RoomUnread[]): Html {
  const root = opts.root;
  const privateNames = new Set(listChannels(root).filter((c) => c.private).map((c) => `/c/${encodeURIComponent(c.name)}`));
  const wsName = loadConfig(root).name;
  const prefs = readPrefs(root, opts.viewer!.auth.username);
  const calls = liveCallsByRoom();
  return html`<nav class="app-side">
<div class="side-head"><a class="brand" href="/">${raw(MARK)}<span>${wsName}</span></a></div>
<div class="side-rooms">
<div class="side-cap"><span>Channels</span><a href="/new" title="New channel">${icon('plus')}</a></div>
<ul>${joinHtml(
    rooms.filter((r) => r.kind === 'channel').map((r) => roomLink(r, privateNames.has(r.url) ? icon('lock') : '#', opts.active, isMuted(prefs, r.url), calls.get(r.url)))
  )}</ul>
<div class="side-cap"><span>Direct messages</span><a href="/d/new" title="New conversation">${icon('plus')}</a></div>
<ul>${joinHtml(
    rooms
      .filter((r) => r.kind === 'dm')
      .map((r) => roomLink(r, r.with && r.with.length === 1 ? avatar(r.with[0], 18) : icon('people'), opts.active, isMuted(prefs, r.url), calls.get(r.url)))
  )}</ul>
<div class="side-cap"><span>Meetings</span><a href="/m/new" title="New meeting">${icon('plus')}</a></div>
<ul>${joinHtml(rooms.filter((r) => r.kind === 'meeting').map((r) => roomLink(r, CALL_ICON, opts.active, isMuted(prefs, r.url), calls.get(r.url))))}</ul>
</div>
<div class="side-foot">${userMenu(opts)}<a class="topbar-icon" href="/search" aria-label="Search">${icon('search')}</a></div>
</nav>`;
}

export function layout(title: string, main: Html, opts: PageOpts): string {
  const theme = activeTheme().name;
  const sheet = styleSheet(activeTheme()).tag;
  const script = pageScript().tag;
  // A meeting's guest has a frame too, for the page script's sake, but not
  // the workspace's: no sidebar, no counts, and nothing that names a room
  // other than their meeting.
  const guest = opts.viewer !== null && isGuest(opts.viewer.auth);
  const member = opts.viewer !== null && !guest;
  const rooms = member ? unreadRooms(opts.root, opts.viewer!.auth) : [];
  const unread = unreadSummary(rooms);
  // The workspace's name, not the page's: a tab is a workspace, and the room
  // in view changes too often to be what a tab is known by. A guest's tab is
  // their meeting.
  const baseTitle = member ? loadConfig(opts.root).name : title;
  const fullTitle = unread.total > 0 ? `(${unread.total > UNREAD_CAP ? `${UNREAD_CAP}+` : unread.total}) ${baseTitle}` : baseTitle;
  const iconHref =
    `/favicon.svg?t=${encodeURIComponent(theme)}` + (unread.total > 0 ? `&unread=${unread.urgent ? 'urgent' : 'some'}` : '');
  // The frame says which room it shows and who is looking, for the page
  // script: the count stream marks the current room read as messages arrive,
  // and the composer's @-completion needs to know whom not to suggest. It
  // also says where the call script is, which is loaded on the first call,
  // and who is waiting to be let in to the viewer's meetings.
  const lobby = member ? JSON.stringify(lobbiesFor(listMeetingsFor(opts.root, opts.viewer!.auth.username))) : '[]';
  const body = member
    ? html`<div class="app ${opts.roomsPage ? 'rooms-page' : ''}" data-viewer="${opts.viewer!.auth.username}" data-current-room="${opts.active ?? ''}" data-csrf="${opts.viewer!.csrf}" data-call-script="/assets/call.js?v=${callScript().tag}" data-lobby="${lobby}">${sidebar(opts, rooms)}<div class="app-main">${main}</div></div>`
    : guest
      ? html`<div class="app guest-app" data-viewer="${opts.viewer!.auth.username}" data-guest="1" data-current-room="${opts.active ?? ''}" data-csrf="${opts.viewer!.csrf}" data-call-script="/assets/call.js?v=${callScript().tag}" data-lobby="[]"><div class="app-main">${main}</div></div>`
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
${guest ? '' : html`<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
`}${member ? html`<meta name="apple-mobile-web-app-title" content="${baseTitle}">
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
        showRefusedHtml: true,
        // A guest cannot open a member's profile, so a mention is not a link for them.
        mentions: (name) => !isGuest(viewer.auth) && userExists(root, name),
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
/** A video camera, in the same manner: calls. */
export const CALL_ICON = raw(
  '<svg class="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="4" width="9" height="8" rx="1.5"/><path d="M10.5 7.2L14.5 5v6l-4-2.2"/></svg>'
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

const QUICK_REACTIONS = [
  '\u{1F44D}', '✅', '\u{1F440}', '\u{1F389}', '❤️', '\u{1F604}',
  '\u{1F602}', '\u{1F64F}', '\u{1F525}', '\u{1F44F}', '\u{1F914}', '\u{1F62E}',
];

function reactForm(roomUrl: string, id: number, emoji: string, viewer: Viewer, mine: boolean, count?: number): Html {
  return html`<form data-quiet method="post" action="${roomUrl}/m/${id}/react">${csrfField(viewer)}<input type="hidden" name="emoji" value="${emoji}"><button class="${count === undefined ? 'dd-item' : `react-pill ${mine ? 'mine' : ''}`}" type="submit" title="${mine ? 'Remove your reaction' : 'React'}">${emoji}${count !== undefined ? html` <span>${count}</span>` : ''}</button></form>`;
}

/**
 * Who wrote a message, as its head names them. A member is a link to their
 * profile, except for a guest, who cannot open one; a guest is the name they
 * gave, marked as a guest's, and links nowhere.
 */
function authorHtml(room: Room, author: string, viewer: Viewer): Html {
  if (isGuestName(author)) return html`<span class="author guest-author">${personLabel(room.meeting, author)}</span>`;
  if (isGuest(viewer.auth)) return html`<span class="author">${author}</span>`;
  return html`<a class="author" href="/${encodeURIComponent(author)}">${author}</a>`;
}

function msgTools(room: Room, m: Message, viewer: Viewer): Html {
  const parts: Html[] = [];
  parts.push(
    html`<details class="dropdown react-menu"><summary aria-label="React" title="React">${icon('plus')}</summary><div class="dropdown-menu dd-right" role="menu">${joinHtml(
      QUICK_REACTIONS.map((e) => reactForm(room.url, m.id, e, viewer, (m.reactions[e] ?? []).includes(viewer.auth.username)))
    )}<form data-quiet class="react-other" method="post" action="${room.url}/m/${m.id}/react">${csrfField(viewer)}<input type="text" name="emoji" maxlength="${MAX_REACTION}" placeholder="Any emoji, or :name:" aria-label="React with any emoji, or its :name:" autocomplete="off" data-1p-ignore required><button class="btn" type="submit">React</button></form></div></details>`
  );
  if (room.kind !== 'thread') {
    parts.push(html`<a href="${room.url}/t/${m.id}" title="Reply in thread">${icon('comment')}</a>`);
  }
  // Pinning arranges the room for its members; a guest's visit is shorter.
  if (room.kind !== 'thread' && !isGuest(viewer.auth)) {
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
export function messageHtml(root: string, room: Room, m: Message, viewer: Viewer, cont = false, idPrefix = 'msg-'): Html {
  if (m.deleted) {
    return html`<li class="msg msg-gone" id="${idPrefix}${m.id}" data-mid="${m.id}" data-created="${m.created}"><span class="avatar-gap" aria-hidden="true"></span><div class="msg-main"><span class="msg-deleted">This message was deleted.</span>${
      m.replyCount > 0 && room.kind !== 'thread'
        ? html`<div class="msg-below"><a class="thread-link" href="${room.url}/t/${m.id}">${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}</a></div>`
        : ''
    }</div></li>`;
  }
  if (m.call) return callEntryHtml(room, m, viewer, cont, idPrefix);
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
  return html`<li class="msg ${mine} ${pin ? 'pinned' : ''} ${cont ? 'msg-cont' : ''}" id="${idPrefix}${m.id}" data-mid="${m.id}" data-author="${m.author}" data-created="${m.created}">${avatar(m.author, 32)}<div class="msg-main">
${pin ? html`<div class="pinned-by">${PIN_ICON} Pinned by ${pin.by}</div>` : ''}<div class="msg-head">${authorHtml(room, m.author, viewer)}${timeTag(m.created)}${m.edited ? html`<span class="msg-edited">(edited)</span>` : ''}</div>
<div class="msg-body markdown-body">${bodyHtml(root, m.body, viewer)}</div>
${fileRows(room.url, m.id, m.files)}${below}
</div>${msgTools(room, m, viewer)}</li>`;
}

/** How long a call lasted, in words: "under a minute", "23 minutes", "1 hour 5 minutes". */
export function callLength(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  return h ? (m ? `${part(h, 'hour')} ${part(m, 'minute')}` : part(h, 'hour')) : part(m, 'minute');
}

/**
 * A call's entry in the timeline. While the call goes on it says who is in
 * it and offers to join (the button is the page script's, shown where the
 * browser can make calls); afterwards it says who was in it and for how
 * long. An entry whose call is not going on, and never recorded its end, is
 * one the workspace was restarted under while nobody was left to resume it.
 */
function callEntryHtml(room: Room, m: Message, viewer: Viewer, cont: boolean, idPrefix: string): Html {
  const rec = m.call!;
  const live = liveCall(room.url);
  const isLive = live !== null && live.id === rec.id;
  const people = isLive ? live!.people : rec.people;
  const faces = joinHtml(people.map((p) => html`<span title="${personLabel(room.meeting, p)}">${avatar(p, 20)}</span>`));
  const status = isLive
    ? `${people.length} in the call`
    : rec.ended
      ? `lasted ${callLength(Date.parse(rec.ended) - Date.parse(m.created))}`
      : 'ended';
  const card = html`<div class="call-entry ${isLive ? 'live' : ''}" data-call-entry="${rec.id}"><span class="call-entry-icon">${CALL_ICON}</span><div class="call-entry-text"><div><strong>${
    isLive ? 'Call in progress' : 'Call'
  }</strong> <span class="muted">${status}</span></div><div class="call-entry-people">${faces}</div></div>${
    isLive ? html`<button class="btn btn-primary call-join" type="button" data-call-join="${room.url}" data-call-title="${room.title}">Join</button>` : ''
  }</div>`;
  const reactions = Object.entries(m.reactions).map(([emoji, users]) =>
    reactForm(room.url, m.id, emoji, viewer, users.includes(viewer.auth.username), users.length)
  );
  const thread =
    room.kind !== 'thread' && m.replyCount > 0
      ? html`<a class="thread-link" href="${room.url}/t/${m.id}">${icon('comment')} ${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}</a>`
      : '';
  const below = reactions.length || thread ? html`<div class="msg-below">${joinHtml(reactions)}${thread}</div>` : '';
  const pin = room.kind === 'thread' ? null : pinOf(room.dir, m.id);
  return html`<li class="msg msg-call ${pin ? 'pinned' : ''} ${cont ? 'msg-cont' : ''}" id="${idPrefix}${m.id}" data-mid="${m.id}" data-author="${m.author}" data-created="${m.created}">${avatar(m.author, 32)}<div class="msg-main">
${pin ? html`<div class="pinned-by">${PIN_ICON} Pinned by ${pin.by}</div>` : ''}<div class="msg-head">${authorHtml(room, m.author, viewer)}${timeTag(m.created)}<span class="muted">started a call</span></div>
${card}${below}
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
  return html`<div class="msgs"><ul id="msg-list" data-stream="${room.url}/events" data-last="${last}" data-at="${String(Date.now())}">${joinHtml(items)}</ul></div>${JUMP_NEWEST}`;
}

const JUMP_NEWEST = html`<div class="jump-newest-wrap"><button class="jump-newest" type="button" data-jump-newest hidden>Jump to newest ${raw(
  '<svg class="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3.5 8.5L8 13l4.5-4.5"/></svg>'
)}</button></div>`;

/**
 * The composer. data-max-bytes is the attachments' cap, so the page script
 * can refuse an oversized send before uploading any of it; the nonce is
 * filled by the page script, once per message, and sent again on a retry so
 * the server can tell a retry from a second message. Under it, who else is
 * typing, filled by the page script from the room's stream.
 */
function composer(room: Room, viewer: Viewer, placeholder: string): Html {
  // A guest writes but does not attach: anyone with a link that lets guests
  // straight in could otherwise fill the workspace's disk.
  const attach = isGuest(viewer.auth)
    ? ''
    : html`<label class="attach topbar-icon" title="Attach files">${PAPERCLIP_ICON}<input type="file" name="files" multiple aria-label="Attach files"></label><span class="file-size" data-file-total></span>`;
  return html`<div class="composer"><form data-composer data-max-bytes="${MAX_ATTACHMENTS_BYTES}" method="post" action="${room.url}/messages" enctype="multipart/form-data">${csrfField(viewer)}<input type="hidden" name="nonce" value=""><div class="composer-box">
<div class="mention-list" data-mention-list hidden role="listbox"></div>
<div class="send-progress" data-send-progress hidden><div></div></div>
<textarea name="body" rows="1" placeholder="${placeholder}" aria-label="${placeholder}"></textarea>
<ul class="file-list" data-file-list hidden></ul>
<div class="send-status" data-send-status role="status" aria-live="polite" hidden></div>
<div class="composer-row">${attach}<span class="hint">Enter sends, Shift+Enter is a new line, markdown works</span><button class="btn btn-primary" type="submit">Send</button></div>
</div></form><div class="typing" data-typing></div></div>`;
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

/**
 * The header's call button: starts a call, or joins the one going on, and
 * says so. Only the page script can make a call, so the sheet shows it only
 * where script has said the browser can.
 */
function callButton(room: Room, viewer: Viewer): Html {
  const live = liveCall(room.url);
  // A guest joins a call a member has started; until then the button waits.
  const waiting = !live && isGuest(viewer.auth);
  const label = live ? `Join the call (${live.names.join(', ')})` : waiting ? 'The call starts when someone from the workspace joins it' : 'Start a call';
  return html`<button class="topbar-icon call-button ${live ? 'live' : ''}" type="button" data-call-start="${room.url}" data-call-title="${room.title}" title="${label}" aria-label="${label}" ${waiting ? raw('disabled') : ''}>${CALL_ICON}<span data-call-count>${live ? String(live.people.length) : ''}</span></button>`;
}

function roomHead(root: string, room: Room, viewer: Viewer, tools: Html | '' = '', topicOverride?: string): Html {
  const topic = topicOverride ?? room.channel?.topic;
  const title = html`<div class="room-title"><h1>${room.title}</h1>${topic ? html`<span class="room-topic">${topic}</span>` : ''}</div>`;
  // A guest's header is their meeting's: the call, and the way out.
  if (isGuest(viewer.auth)) {
    return html`<header class="room-head">${title}<div class="room-tools">${room.kind !== 'thread' ? callButton(room, viewer) : ''}${tools}</div></header>`;
  }
  // Notes to self have nobody to call and nothing to be notified of.
  const solo = room.dm !== undefined && isSelfDm(room.dm);
  const pins = readPins(room.dir).length;
  const pinsLink = html`<a class="topbar-icon pins-link" href="${room.url}/pins" title="Pinned messages" aria-label="Pinned messages, ${pins}">${PIN_ICON}<span data-pin-count>${pins || ''}</span></a>`;
  return html`<header class="room-head"><a class="back-link topbar-icon" href="/" aria-label="All rooms">${BACK_ICON}</a>${title}<div class="room-tools">${room.kind !== 'thread' && !solo ? callButton(room, viewer) : ''}${pinsLink}${solo ? '' : muteButton(root, room, viewer)}${tools}</div></header>`;
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
  const topic = isSelfDm(room.dm!) ? 'Notes to self. Only you can see this conversation.' : undefined;
  const main = html`${roomHead(root, room, viewer, '', topic)}${messageList(root, room, messages, viewer, readUpTo)}${composer(room, viewer, `Message ${room.title}`)}`;
  return layout(room.title, main, { viewer, root, active: room.url });
}

/**
 * A meeting's page. For a member it is a room like any other, with the
 * guest link at hand in its header; for a guest it is the whole of what
 * they see of the workspace. `origin` makes the guest link, which is shown
 * only where the workspace allows guests.
 */
export function meetingPage(root: string, room: Room, messages: Message[], viewer: Viewer, origin: string, readUpTo?: number): string {
  const meeting = room.meeting!;
  const guest = isGuest(viewer.auth);
  const guestsOn = loadConfig(root).calls.guests;
  const tools = guest
    ? html`<form method="post" action="${room.url}/guest/leave" data-full-page data-confirm="Leave ${meeting.title}? To come back you will need the link, and to be let in again.">${csrfField(viewer)}<button class="btn" type="submit">Leave</button></form>`
    : html`${guestsOn ? html`<button class="btn guest-link-btn" type="button" data-copy="${guestLink(root, origin, meeting)}" title="Copy the link that lets people outside the workspace join">Guest link</button>` : ''}<a class="topbar-icon" href="${room.url}/settings" aria-label="Meeting settings" title="Meeting settings">${icon('sliders')}</a>`;
  const guests = currentGuests(meeting).length;
  const topic = guest
    ? `A meeting in ${loadConfig(root).name}`
    : `${meeting.members.length} ${meeting.members.length === 1 ? 'member' : 'members'}${guests ? `, ${guests} ${guests === 1 ? 'guest' : 'guests'}` : ''}`;
  const main = html`${roomHead(root, room, viewer, tools, topic)}${meetingIntro(root, room, viewer, messages.length === 0, origin)}${messageList(root, room, messages, viewer, readUpTo)}${composer(room, viewer, `Message ${meeting.title}`)}`;
  return layout(meeting.title, main, { viewer, root, active: room.url });
}

/**
 * What a meeting says about itself above its timeline, until something has
 * been said in it: for a member, how guests come in; for a guest, what they
 * can and cannot do here.
 */
function meetingIntro(root: string, room: Room, viewer: Viewer, empty: boolean, origin: string): Html | '' {
  if (!empty) return '';
  const meeting = room.meeting!;
  if (isGuest(viewer.auth)) {
    return html`<div class="meeting-intro"><p>You are a guest in <strong>${meeting.title}</strong>. You can join its call when someone from the workspace starts it, and read and write here; the people in the meeting see what you write, under the name you gave.</p></div>`;
  }
  if (!loadConfig(root).calls.guests) {
    return html`<div class="meeting-intro"><p>A meeting is a room for a call. This workspace does not let meetings have guests, so only its members can join.</p></div>`;
  }
  const link = guestLink(root, origin, meeting);
  return html`<div class="meeting-intro"><p>A meeting is a room for a call, with a link for people outside the workspace. Send them this link; ${
    meeting.lobby ? 'each asks to join, and anyone here can let them in.' : 'anyone who has it joins without being let in.'
  } Guests can join the call and read and write in this room, and see nothing else in the workspace.</p>
<div class="copy-row"><input type="text" readonly value="${link}" aria-label="Guest link"><button class="btn" type="button" data-copy="${link}">Copy link</button></div></div>`;
}

export function threadPage(root: string, room: Room, anchor: Message, replies: Message[], viewer: Viewer): string {
  const parent = room.parent!;
  const head = html`<header class="room-head"><a class="topbar-icon" href="${parent.url}" aria-label="Back to ${parent.title}">${BACK_ICON}</a><div class="room-title"><h1>Thread</h1><span class="room-topic">in <a href="${parent.url}">${parent.title}</a></span></div><div class="room-tools"></div></header>`;
  // The parent carries the day it was said, and the replies take theirs from
  // it, so a reply the same day is not set under a rule of its own. Its id is
  // not msg-<id>: that is the replies' own, numbered from 1 in the thread, and
  // the parent is often message 1 of its room too, so the first reply would
  // otherwise be taken for it and drawn in its place.
  const anchorHtml = html`<ul class="thread-anchor" style="list-style:none;margin:0;padding:0">${dayRule(anchor.created)}${messageHtml(root, parent, anchor, viewer, false, 'parent-')}</ul>`;
  const items = messageItems(root, room, replies, viewer, undefined, anchor.created.slice(0, 10));
  const last = replies.length ? replies[replies.length - 1].id : 0;
  const list = html`<div class="msgs">${anchorHtml}<ul id="msg-list" data-stream="${room.url}/events" data-last="${last}" data-at="${String(Date.now())}">${joinHtml(items)}</ul></div>${JUMP_NEWEST}`;
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
<p class="muted">Pick a channel, start a <a href="/d/new">direct conversation</a>, or set up a <a href="/m/new">meeting</a> for a call with people outside the workspace.</p>
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
  const content = html`<h1>${status}</h1><p>${message}</p><p><a href="${opts.back?.url ?? '/'}">${opts.back?.label ?? 'Back to the workspace'}</a></p>`;
  return opts.viewer ? doc(`${status}`, content, opts) : layout(`${status}`, content, opts);
}

/** What the new-channel form held when it was sent back, so a refusal does not empty it. */
export interface NewChannelForm {
  name: string;
  topic: string;
  private: boolean;
}

export function newChannelPage(root: string, viewer: Viewer, error?: string, form?: NewChannelForm): string {
  const content = html`<div class="form-box">
<h1>New channel</h1>
${error ? html`<div class="form-error">${error}</div>` : ''}
<form method="post" action="/new">${csrfField(viewer)}
<div class="field"><label for="name">Name</label><input type="text" id="name" name="name" value="${form?.name ?? ''}" required maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*" autocomplete="off" data-1p-ignore data-channel-name autofocus>
<p class="muted">Lowercase letters, digits, and single hyphens: what fits after a #. Spaces become hyphens as you type.</p></div>
<div class="field"><label for="topic">Topic</label><input type="text" id="topic" name="topic" value="${form?.topic ?? ''}" autocomplete="off" data-1p-ignore></div>
<div class="field"><label class="checkbox"><input type="checkbox" name="private" value="1" ${form?.private ? raw('checked') : ''}> Private: visible only to people added to it, and that cannot be undone later.</label></div>
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
<div class="field"><label for="user">Add someone</label><input type="text" id="user" name="user" placeholder="username" autocomplete="off" data-1p-ignore></div>
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
<div class="field" style="max-width:520px"><label for="topic">Topic</label><input type="text" id="topic" name="topic" value="${c.topic}" autocomplete="off" data-1p-ignore></div>
<button class="btn btn-primary" type="submit">Save</button>
</form>
${membersSection}
${danger}`;
  return doc(`${room.title} settings`, content, { viewer, root, active: room.url, back: { url: room.url, label: room.title } });
}

export function newDmPage(root: string, viewer: Viewer, error?: string): string {
  const state = loadVault(root);
  const me = viewer.auth.username;
  // The viewer first, chosen alone for notes to self; with others, they are
  // in the conversation either way.
  const users = state.status === 'ok' ? [me, ...Object.keys(state.vault.users).filter((u) => u !== me).sort()] : [];
  const boxes = users.map(
    (u) => html`<label class="checkbox person-pick" data-person="${[u, state.status === 'ok' ? state.vault.users[u]?.profile?.name ?? '' : '', u === me ? 'you notes self' : ''].join(' ').toLowerCase()}"><input type="checkbox" name="user" value="${u}">${avatar(u, 20)} ${u}${
      u === me ? html` <span class="muted">(you, for notes to self)</span>` : state.status === 'ok' && state.vault.users[u]?.profile?.name ? html` <span class="muted">${state.vault.users[u].profile!.name}</span>` : ''
    }</label>`
  );
  const content = html`<div class="form-box">
<h1>New conversation</h1>
${error ? html`<div class="form-error">${error}</div>` : ''}
<form method="post" action="/d/new">${csrfField(viewer)}
<div class="field"><label for="people-filter">With</label><input type="text" id="people-filter" placeholder="Find someone" autocomplete="off" data-1p-ignore data-people-filter hidden autofocus>
<div data-people>${joinHtml(boxes)}</div><p class="muted" data-people-none hidden>Nobody by that name.</p></div>
<button class="btn btn-primary" type="submit">Start</button>
</form></div>`;
  return doc('New conversation', content, { viewer, root });
}

/** The people a new meeting or a meeting's settings can add: every member of the workspace but these. */
function peopleBoxes(root: string, except: string[]): Html[] {
  const state = loadVault(root);
  const users = state.status === 'ok' ? Object.keys(state.vault.users).filter((u) => !except.includes(u)).sort() : [];
  return users.map((u) => {
    const display = state.status === 'ok' ? state.vault.users[u]?.profile?.name ?? '' : '';
    return html`<label class="checkbox person-pick" data-person="${[u, display].join(' ').toLowerCase()}"><input type="checkbox" name="user" value="${u}">${avatar(u, 20)} ${u}${
      display ? html` <span class="muted">${display}</span>` : ''
    }</label>`;
  });
}

export interface NewMeetingForm {
  title: string;
  users: string[];
  lobby: boolean;
}

export function newMeetingPage(root: string, viewer: Viewer, error?: string, form?: NewMeetingForm): string {
  const guestsOn = loadConfig(root).calls.guests;
  const boxes = peopleBoxes(root, [viewer.auth.username]);
  const content = html`<div class="form-box">
<h1>New meeting</h1>
<p class="muted">A room for a call${guestsOn ? ', with a link that lets people outside the workspace join it' : ''}. It is visible to the members you add and to nobody else.</p>
${error ? html`<div class="form-error">${error}</div>` : ''}
<form method="post" action="/m/new">${csrfField(viewer)}
<div class="field"><label for="title">Title</label><input type="text" id="title" name="title" value="${form?.title ?? ''}" required maxlength="${String(MAX_TITLE)}" autocomplete="off" data-1p-ignore autofocus></div>
<div class="field"><label for="people-filter">Members from the workspace</label><input type="text" id="people-filter" placeholder="Find someone" autocomplete="off" data-1p-ignore data-people-filter hidden>
<div data-people>${joinHtml(boxes)}</div><p class="muted" data-people-none hidden>Nobody by that name.</p><p class="muted">You are a member already. Members can be added later too.</p></div>
${
    guestsOn
      ? html`<div class="field"><label class="checkbox"><input type="checkbox" name="lobby" value="1" ${form === undefined || form.lobby ? raw('checked') : ''}> Guests wait to be let in<br><span class="muted">Each guest asks to join, and a member lets them in. Without this, anyone who has the link joins at once.</span></label></div>`
      : ''
  }
<button class="btn btn-primary" type="submit">Create meeting</button>
</form></div>`;
  return doc('New meeting', content, { viewer, root });
}

export function meetingSettingsPage(root: string, room: Room, viewer: Viewer, origin: string, opts: { error?: string; flash?: string } = {}): string {
  const m = room.meeting!;
  const guestsOn = loadConfig(root).calls.guests;
  const me = viewer.auth.username;
  const memberRows = joinHtml(
    m.members.map(
      (u) => html`<li style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${avatar(u, 20)} <a href="/${encodeURIComponent(u)}">${u}</a>${u === m.createdBy ? html` <span class="muted">(made the meeting)</span>` : ''}
<form method="post" action="${room.url}/members/remove" style="margin-left:auto" data-confirm="${u === me ? `Leave ${m.title}? You will need to be added back.` : `Remove ${u} from ${m.title}?`}">${csrfField(viewer)}<input type="hidden" name="user" value="${u}"><button class="btn-link" type="submit">${u === me ? 'Leave' : 'Remove'}</button></form></li>`
    )
  );
  const guests = currentGuests(m);
  const guestRows = joinHtml(
    guests.map(
      (g) => html`<li style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${avatar(g, 20)} ${m.guests[g].name} <span class="muted">let in ${timeTag(m.guests[g].since)}</span>
<form method="post" action="${room.url}/guests/remove" style="margin-left:auto" data-confirm="Take ${m.guests[g].name} out of ${m.title}? They leave its call, and would have to ask to join again.">${csrfField(viewer)}<input type="hidden" name="guest" value="${g}"><button class="btn-link" type="submit">Remove</button></form></li>`
    )
  );
  const link = guestLink(root, origin, m);
  const guestSection = guestsOn
    ? html`<h2>Guests</h2>
<p class="muted">Anyone with the guest link can ${m.lobby ? 'ask to join' : 'join'} this meeting. A guest can join its call and read and write here, and sees nothing else in the workspace. A guest cannot attach files.</p>
<div class="copy-row"><input type="text" readonly value="${link}" aria-label="Guest link"><button class="btn" type="button" data-copy="${link}">Copy link</button></div>
<form method="post" action="${room.url}/settings">${csrfField(viewer)}<input type="hidden" name="what" value="lobby">
<label class="checkbox"><input type="checkbox" name="lobby" value="1" ${m.lobby ? raw('checked') : ''}> Guests wait to be let in</label>
<div style="margin-top:8px"><button class="btn" type="submit">Save</button></div></form>
${guests.length ? html`<h3>In the meeting now</h3><ul style="list-style:none;padding:0;max-width:520px">${guestRows}</ul>` : html`<p class="muted">No guest is in the meeting.</p>`}
<form method="post" action="${room.url}/link/reset" data-confirm="Make a new guest link? The old one stops working, and every guest let in with it is taken out of the meeting.">${csrfField(viewer)}<button class="btn" type="submit">Make a new link</button> <span class="muted">The old link stops working, and the guests let in with it are taken out.</span></form>`
    : html`<h2>Guests</h2><p class="muted">This workspace does not let meetings have guests; a site admin can change that on the Admin page.</p>`;
  const danger = mayDeleteMeeting(m, me)
    ? html`<div class="danger-zone"><h3>Delete this meeting</h3>
<p>Everything said in it goes with it, and its guest link stops working. There is no undo.</p>
<form method="post" action="${room.url}/delete" data-confirm="Delete ${m.title} and everything said in it? There is no undo.">${csrfField(viewer)}<button class="btn btn-danger" type="submit">Delete meeting</button></form></div>`
    : '';
  const content = html`<h1>${m.title} settings</h1>
${opts.error ? html`<div class="form-error">${opts.error}</div>` : ''}${opts.flash ? html`<div class="flash">${opts.flash}</div>` : ''}
<form method="post" action="${room.url}/settings">${csrfField(viewer)}<input type="hidden" name="what" value="title">
<div class="field" style="max-width:520px"><label for="title">Title</label><input type="text" id="title" name="title" value="${m.title}" maxlength="${String(MAX_TITLE)}" autocomplete="off" data-1p-ignore></div>
<button class="btn btn-primary" type="submit">Save</button>
</form>
<h2>Members</h2>
<ul style="list-style:none;padding:0;max-width:420px">${memberRows}</ul>
<form method="post" action="${room.url}/members/add">${csrfField(viewer)}
<div class="field"><label for="user">Add someone from the workspace</label><input type="text" id="user" name="user" placeholder="username" autocomplete="off" data-1p-ignore></div>
<button class="btn" type="submit">Add</button>
</form>
${guestSection}
${danger}`;
  return doc(`${m.title} settings`, content, { viewer, root, active: room.url, back: { url: room.url, label: m.title } });
}

/**
 * What a guest link opens. The key is in the fragment, which the server
 * never sees, and the page script moves it into the form, as the invite page
 * does with a token. The page names nothing, the meeting's title included,
 * until the key has been checked: a meeting's number is easily guessed.
 * Someone signed in to the workspace joins as themselves.
 */
export function meetingJoinPage(meetingId: number, signedInAs: string | null, opts: { error?: string; name?: string } = {}): string {
  const action = `/m/${meetingId}/join`;
  const form = signedInAs
    ? html`<p>This browser is signed in to the workspace as <strong>${signedInAs}</strong>, so you join as yourself: the meeting is added to your sidebar.</p>
<form method="post" action="${action}"><input type="hidden" name="k" value="" data-meeting-key>
<button class="btn btn-primary" type="submit">Join as ${signedInAs}</button></form>`
    : html`<form method="post" action="${action}"><input type="hidden" name="k" value="" data-meeting-key>
<div class="field"><label for="guest-name">Your name</label><input type="text" id="guest-name" name="name" value="${opts.name ?? ''}" required maxlength="${String(MAX_GUEST_NAME)}" autocomplete="name" autofocus>
<p class="muted">What the people in the meeting will see you as.</p></div>
<button class="btn btn-primary" type="submit">Ask to join</button></form>`;
  const content = html`${SIGNIN_MARK}<div class="form-box" style="margin:0 auto" data-meeting-join>
<h1>Join a meeting</h1>
${opts.error ? html`<div class="form-error">${opts.error}</div>` : ''}
<div class="form-error" data-meeting-key-missing hidden>This link has no key in it. It may have been cut short when it was copied; ask for it again.</div>
${form}</div>`;
  return layout('Join a meeting', content, { viewer: null, root: '' });
}

/**
 * Where a guest waits to be let in. The page script asks after them every
 * few seconds, which is also what keeps them in the lobby, and goes on to
 * the meeting once they are let in.
 */
export function meetingLobbyPage(meetingId: number, title: string, name: string, csrf: string): string {
  const url = `/m/${meetingId}`;
  const content = html`${SIGNIN_MARK}<div class="form-box" style="margin:0 auto" data-lobby-wait="${url}/lobby/state" data-lobby-room="${url}">
<h1>${title}</h1>
<p data-lobby-status>You have asked to join as <strong>${name}</strong>. Someone in the meeting will let you in; this page goes on by itself when they do.</p>
<p class="muted" data-lobby-noscript>Waiting needs script. Reload the page to see whether you have been let in.</p>
<form method="post" action="${url}/guest/leave"><input type="hidden" name="csrf" value="${csrf}"><button class="btn" type="submit">Stop waiting</button></form>
</div>`;
  return layout(title, content, { viewer: null, root: '' });
}

/** What a guest sees after leaving a meeting, or when their link no longer works. */
export function guestGonePage(message: string): string {
  const content = html`${SIGNIN_MARK}<div class="form-box" style="margin:0 auto"><h1>Meeting</h1><p>${message}</p></div>`;
  return layout('Meeting', content, { viewer: null, root: '' });
}

export interface SearchHit {
  /** Where it was said: the room's URL and title. */
  url: string;
  where: string;
  message: Message;
  /** The room the hit renders against, for tools-free display. */
  root: string;
}

/** What the search page says of its hits: how many, and what the walk left out. */
function searchSummary(n: number, partial: boolean): string {
  const found =
    n === 0 ? 'Nothing matched.' : n >= MAX_HITS ? `The newest ${MAX_HITS} matches.` : `${n} ${n === 1 ? 'message matches' : 'messages match'}.`;
  return partial
    ? `${found} Rooms with more than ${SCAN_LIMIT.toLocaleString('en-US')} messages were searched in their newest ${SCAN_LIMIT.toLocaleString('en-US')} only.`
    : found;
}

export function searchPage(
  root: string,
  viewer: Viewer,
  query: string,
  hits: { url: string; room: string; where: string; kind: 'channel' | 'dm' | 'meeting'; message: Message }[],
  partial = false
): string {
  // Each result is a link to the message, where it is marked; the room's
  // name beside it is a link to the room. The whole result takes the click
  // with script, and its time is the link without.
  const rows = hits.map(
    (h) => html`<div class="search-result" data-href="${h.url}">
<div class="where"><a href="${h.room}">${h.kind === 'dm' ? html`${icon('people')} Conversation with ${h.where}` : h.kind === 'meeting' ? html`${CALL_ICON} ${h.where}` : h.where}</a><span class="who">${avatar(h.message.author, 16)} ${isGuestName(h.message.author) ? `${searchGuestName(root, h.room, h.message.author)}` : h.message.author}</span><a class="result-time" href="${h.url}" title="Show this message">${timeTag(h.message.created, '')}</a></div>
<div class="markdown-body">${bodyHtml(root, h.message.body, viewer)}</div>
</div>`
  );
  // The words found are marked in each result by the page script.
  const content = html`<h1>Search</h1>
<form method="get" action="/search" style="margin-bottom:24px;max-width:520px"><div class="field"><input type="text" name="q" value="${query}" placeholder="Search messages" autofocus aria-label="Search messages" autocomplete="off" data-1p-ignore>
<p class="muted">Narrow it with <code>from:alice</code> or <code>in:#general</code>.</p></div></form>
${query === '' ? '' : html`<p class="muted">${searchSummary(hits.length, partial)}</p>`}
<div data-highlight="${parseQuery(query).text}">${joinHtml(rows)}</div>`;
  return doc('Search', content, { viewer, root });
}

/** A guest's name in a search result, from the meeting the result is in. */
function searchGuestName(root: string, roomUrl: string, guest: string): string {
  const m = /^\/m\/([0-9]+)/.exec(roomUrl);
  return personLabel(m ? readMeeting(root, parseInt(m[1], 10)) ?? undefined : undefined, guest);
}

export function profilePage(root: string, viewer: Viewer, username: string, profile: UserProfile | undefined): string {
  const content = html`<div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">${avatar(username, 64)}<div>
<h1 style="margin:0">${profile?.name ?? username}</h1>
${profile?.name ? html`<p class="muted" style="margin:0">${username}</p>` : ''}
</div></div>
${profile?.bio ? html`<p>${profile.bio}</p>` : ''}
${
    username === viewer.auth.username
      ? html`<form method="post" action="/d/new" style="display:flex;gap:8px">${csrfField(viewer)}<input type="hidden" name="user" value="${username}"><a class="btn" href="/account">Edit profile</a><button class="btn" type="submit">Notes to self</button></form>`
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

/**
 * The viewer's own tokens, each with when it was made and, where an
 * administrator made it, by whom. A token is a complete way to sign in as its
 * holder, and a site admin can mint one for anyone, so this is where someone
 * sees whether that has happened and can revoke a token they did not ask
 * for. The one this browser signed in with is not offered: revoking it would
 * sign them out with no way back but a new token from an administrator.
 */
function tokensSection(viewer: Viewer): Html {
  const current = tokenId(viewer.auth.token);
  const rows = viewer.auth.user.tokens.map((t) => {
    const id = tokenId(t);
    const made = t.created ? html`made ${timeTag(t.created)}` : html`made before this was recorded`;
    return html`<tr>
<td><code>${id}</code></td>
<td class="muted">${made}${t.by ? html` by ${t.by}` : ''}</td>
<td class="actions">${
      id === current
        ? html`<span class="muted">this browser</span>`
        : html`<form method="post" action="/account/tokens/revoke" style="display:inline" data-confirm="Revoke token ${id}? Whatever signed in with it is signed out.">${csrfField(viewer)}<input type="hidden" name="id" value="${id}"><button class="btn-link" type="submit">Revoke</button></form>`
    }</td></tr>`;
  });
  return html`<h2>Sign-in tokens</h2>
<p class="muted">Each is a way to sign in as you. One you do not recognise, or did not ask an administrator for, can be revoked here.</p>
<table class="listing people"><tbody>${joinHtml(rows)}</tbody></table>`;
}

export function accountPage(root: string, viewer: Viewer, notify: AccountNotifications, opts: { flash?: string; error?: string } = {}): string {
  const profile = viewer.auth.user.profile;
  const content = html`<h1>Account</h1>
${opts.error ? html`<div class="form-error">${opts.error}</div>` : ''}${opts.flash ? html`<div class="flash">${opts.flash}</div>` : ''}
<form method="post" action="/account" style="max-width:520px">${csrfField(viewer)}
<div class="field"><label for="name">Display name</label><input type="text" id="name" name="name" value="${profile?.name ?? ''}" autocomplete="off" data-1p-ignore></div>
<div class="field"><label for="bio">Bio</label><input type="text" id="bio" name="bio" value="${profile?.bio ?? ''}" autocomplete="off" data-1p-ignore></div>
<button class="btn btn-primary" type="submit">Save</button>
</form>
${notificationsSection(root, viewer, notify)}
${tokensSection(viewer)}
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

export function adminPage(root: string, viewer: Viewer, vault: Vault, opts: { flash?: string; error?: string; calls?: CallsConfig } = {}): string {
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
<div class="field"><label for="username">Add someone</label><input type="text" id="username" name="username" placeholder="username" required autocomplete="off" data-1p-ignore>
<p class="muted">Creates the account and mints its first token, shown once for you to hand over.</p></div>
<label class="checkbox"><input type="checkbox" name="admin" value="1"> Site admin</label>
<div style="margin-top:10px"><button class="btn btn-primary" type="submit">Add user</button></div>
</form>
<h2>Workspace</h2>
<form method="post" action="/admin/settings" style="max-width:520px">${csrfField(viewer)}
<div class="field"><label for="wsname">Name</label><input type="text" id="wsname" name="name" value="${config.name}" autocomplete="off" data-1p-ignore></div>
<div class="field"><label for="theme">Theme</label><select id="theme" name="theme">${joinHtml(
    THEMES.map((t) => html`<option value="${t.name}" ${t.name === config.theme ? raw('selected') : ''}>${t.label}</option>`)
  )}</select>
<p class="muted">The workspace's own look; each person can still pick their own from the account menu.</p></div>
<button class="btn btn-primary" type="submit">Save</button>
</form>
${callsSection(viewer, opts.calls ?? config.calls, reportsFor(root, viewer))}
${connectionLog(root, viewer, reportsFor(root, viewer))}`;
  return doc('Admin', content, { viewer, root });
}

/** A connection report as the admin page shows it; `hidden` when its room is not the admin's to see. */
type AdminReport = ConnectionReport & { hidden?: true };

/** Where a report's call was, as a room the viewer can see, or null. */
function reportRoom(root: string, viewer: Viewer, url: string): Room | null {
  const m = /^\/(c|d|m)\/([^/]+)$/.exec(url);
  if (!m) return null;
  if (m[1] === 'm') return meetingRoom(root, parseInt(m[2], 10), viewer.auth);
  return m[1] === 'c' ? channelRoom(root, decodeURIComponent(m[2]), viewer.auth) : dmRoom(root, parseInt(m[2], 10), viewer.auth);
}

/**
 * The call log as an admin may read it. A call in a room the admin cannot
 * see keeps its outcome, its path, and its devices, which is what diagnosing
 * a relay needs, but not who was in it: that a given pair spoke in a private
 * conversation, and when, is itself something the room keeps from the admin.
 */
function reportsFor(root: string, viewer: Viewer): AdminReport[] {
  return readReports(root).map((r) => (reportRoom(root, viewer, r.room) ? r : { ...r, user: 'someone', with: 'someone', hidden: true as const }));
}

/** Whether a connection report says the relay carried it. */
function relayed(r: ConnectionReport): boolean {
  return r.outcome === 'connected' && !!r.path && (r.path.local === 'relay' || r.path.remote === 'relay');
}

/**
 * Whether the relay works: a test the page script runs from the admin's own
 * browser (see test in src/callscript.ts), and when a real call last went
 * through the relay, from the connection log.
 */
function relayCheck(calls: CallsConfig, reports: AdminReport[]): Html {
  const last = [...reports].reverse().find(relayed);
  return html`<div class="relay-test" data-relay-test style="max-width:720px">
<h3>Does it work?</h3>
<p class="muted">A test from this browser, on the network it is on now, with the settings as saved: each STUN server is asked for this browser's public address, and a test connection is sent through each TURN server and back. Someone on another network can see a different result; the connections listed below are what people's browsers actually found.</p>
<ul class="relay-results" data-relay-results><li class="info">The test needs script, and a browser that can make calls.</li></ul>
<p><button class="btn" type="button" data-relay-run hidden>Test again</button></p>
<p class="muted">${
    calls.turn.mode === 'none'
      ? 'No relay is set.'
      : last
        ? last.hidden
          ? html`A call last went through the relay ${timeTag(last.at)}.`
          : html`A call last went through the relay ${timeTag(last.at)}: ${last.user} and ${last.with}.`
        : 'No call has gone through the relay yet, among the connections listed below.'
  }</p>
</div>`;
}

/**
 * The newest connections in calls, as the browsers in them reported them.
 * A room the admin cannot see is not named, nor who was in it (see
 * reportsFor), since an admin does not see other people's private rooms.
 */
function connectionLog(root: string, viewer: Viewer, reports: AdminReport[]): Html {
  if (!reports.length) {
    return html`<h3 id="call-log">Recent connections</h3><p class="muted">No call has connected anyone yet. Each browser in a call reports how each of its connections went, and they will be listed here.</p>`;
  }
  const where = (url: string): string => reportRoom(root, viewer, url)?.title ?? 'a room you cannot see';
  const week = reports.filter((r) => Date.now() - Date.parse(r.at) < 7 * 86400000);
  const count = (f: (r: ConnectionReport) => boolean) => week.filter(f).length;
  const summary = `In the last week: ${count((r) => r.outcome === 'connected' && !relayed(r))} connected directly, ${count(relayed)} through a relay, ${count((r) => r.outcome === 'failed')} failed attempts, ${count((r) => r.outcome === 'dropped')} dropped.`;
  const rows = [...reports].reverse().slice(0, 60).map((r) => {
    const details = [
      r.gathered.length ? `found ${r.gathered.join(', ')}` : 'found no candidates',
      r.relayOffered ? '' : 'no relay offered',
      ...r.errors.map((e) => `${e.code}${e.text ? ` ${e.text}` : ''} from ${e.url || 'an ICE server'}`),
    ].filter((x) => x !== '');
    return html`<tr class="${r.outcome}"><td class="muted">${timeTag(r.at)}</td><td>${where(r.room)}</td><td>${r.hidden ? html`<span class="muted">(${r.device})</span>` : html`${r.user} <span class="muted">(${r.device})</span> to ${r.with}`}</td><td>${describeReport(r)}${
      r.path?.rtt !== undefined ? html` <span class="muted">${Math.round(r.path.rtt * 1000)} ms round trip</span>` : ''
    }<div class="muted">${details.join('; ')}</div></td></tr>`;
  });
  return html`<h3 id="call-log">Recent connections</h3>
<p class="muted" style="max-width:720px">${summary} Each browser reports its own side of each connection: when it opens, when an attempt fails, and when an open one drops. A failed attempt is retried, so one failure followed by a connection is a slow start rather than a failure. The kinds of address a browser found say why: <em>host</em> is its own, <em>srflx</em> its public address from STUN, <em>relay</em> an address on the TURN server.</p>
<table class="listing call-log"><tbody>${joinHtml(rows)}</tbody></table>`;
}

/**
 * How calls connect. A secret is never written back into the page: its
 * field is blank, says whether one is saved, and a blank field keeps it.
 */
function callsSection(viewer: Viewer, calls: CallsConfig, reports: AdminReport[]): Html {
  const t = calls.turn;
  const mode = (value: string, label: string, hint: string) =>
    html`<label class="checkbox" style="display:block;margin-bottom:6px"><input type="radio" name="turn_mode" value="${value}" ${t.mode === value ? raw('checked') : ''}> ${label}<br><span class="muted">${hint}</span></label>`;
  const saved = (has: string, what: string) => (has ? `A ${what} is saved; leave this blank to keep it.` : `No ${what} is saved.`);
  return html`<h2 id="calls">Calls</h2>
<p class="muted" style="max-width:720px">A call's audio and video go directly between the browsers in it; the workspace only introduces them to each other. To find a path, each browser asks a STUN server for its public address, which is enough on most networks. Where two people cannot reach each other directly (both behind strict firewalls, for instance), the call needs a TURN server to relay their media, and that relay carries the whole call for them.</p>
${relayCheck(calls, reports)}
<h3>Settings</h3>
<form method="post" action="/admin/calls" style="max-width:520px">${csrfField(viewer)}
<div class="field"><label for="stun">STUN servers</label><textarea id="stun" name="stun" rows="3" placeholder="stun:stun.example.org:3478">${calls.stun.join('\n')}</textarea>
<p class="muted">One per line. The defaults (${DEFAULT_STUN.join(', ')}) are public servers run by Google and Cloudflare, which see the address of each person who joins a call. Leave this empty to contact no outside server; calls then connect only where the browsers can reach each other directly.</p></div>
<h3>TURN relay</h3>
${mode('none', 'None', 'Calls connect directly or not at all.')}
${mode('static', 'A TURN server with a fixed username and password', 'Any provider can give you these. They are handed to every member who joins a call.')}
${mode('coturn', 'coturn, with a shared secret', "coturn's use-auth-secret. The secret stays on this server, which gives each member a credential that expires after 2 hours.")}
${mode('cloudflare', 'Cloudflare Realtime TURN', 'A TURN key from the Cloudflare dashboard. The API token stays on this server, which asks Cloudflare for a credential for each member who joins.')}
<div class="field"><label for="turn_urls">TURN server URLs</label><textarea id="turn_urls" name="turn_urls" rows="3" placeholder="turn:turn.example.org:3478&#10;turns:turn.example.org:5349">${t.urls.join('\n')}</textarea>
<p class="muted">For a fixed password or coturn. One per line; listing both a turn: URL and a turns: URL on port 443 helps members on networks that allow little else.</p></div>
<div class="field"><label for="turn_username">Username</label><input type="text" id="turn_username" name="turn_username" value="${t.username}" autocomplete="off"></div>
<div class="field"><label for="turn_credential">Password</label><input type="password" id="turn_credential" name="turn_credential" autocomplete="new-password"><p class="muted">${saved(t.credential, 'password')}</p></div>
<div class="field"><label for="turn_secret">coturn shared secret</label><input type="password" id="turn_secret" name="turn_secret" autocomplete="new-password"><p class="muted">${saved(t.secret, 'secret')}</p></div>
<div class="field"><label for="cf_key_id">Cloudflare TURN key id</label><input type="text" id="cf_key_id" name="cf_key_id" value="${t.keyId}" autocomplete="off"></div>
<div class="field"><label for="cf_api_token">Cloudflare API token</label><input type="password" id="cf_api_token" name="cf_api_token" autocomplete="new-password"><p class="muted">${saved(t.apiToken, 'token')}</p></div>
<h3>Guests</h3>
<label class="checkbox" style="display:block;margin-bottom:12px"><input type="checkbox" name="guests" value="1" ${calls.guests ? raw('checked') : ''}> Meetings may have guest links<br><span class="muted">A meeting's guest link lets people outside the workspace join its call and read and write in the meeting, and nothing else. Guests join calls that a member has started, are given the relay's credentials as members are (except a fixed password, which is kept from them), and cannot attach files. Turned off, every guest link stops working and every guest leaves.</span></label>
<button class="btn btn-primary" type="submit">Save</button>
</form>`;
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
<div class="field"><textarea name="body" rows="8" autofocus data-edit-body>${m.body}</textarea></div>
<button class="btn btn-primary" type="submit">Save</button>
<a class="btn" href="${room.url}">Cancel</a>
</form>`;
  return doc('Edit message', content, { viewer, root, active: room.url, back: { url: room.url, label: room.title } });
}

export function aboutIcon(name: IconName): Html {
  return icon(name);
}

/** How a channel or DM presents itself in search results. */
export function roomLabel(room: { kind: string; channel?: ChannelInfo; dm?: DmInfo; meeting?: MeetingInfo }, viewer: string): string {
  if (room.channel) return `#${room.channel.name}`;
  if (room.dm) return dmTitle(room.dm, viewer);
  if (room.meeting) return room.meeting.title;
  return 'somewhere';
}
