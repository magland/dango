import { createHash } from 'crypto';
import { CSS } from '../../mochiforge/src/style';
import { Theme, allThemeVarsCss } from '../../mochiforge/src/themes';

// Dango's stylesheet is mochiforge's sheet with a chat layout appended: the
// themes, the control vocabulary (buttons, fields, menus, flashes), and the
// markdown styles are exactly the forge's, so the two applications read as
// siblings, and everything below is only what a chat page has that a
// repository page does not. The unused forge rules ride along; the sheet is
// served once, cached for good, and a smaller sheet is not worth a second
// vocabulary.

const CHAT_CSS = `
/* --- the app frame ---

   A chat is one screen, not a scrolling document: the sidebar and the room
   header stay put and the message list is the only thing that moves. So the
   frame is a grid pinned to the viewport, and the column that scrolls is
   inside it. The one row is held to the frame's height, so nothing in it can
   make the frame taller than the screen and push the composer off the
   bottom. The page script sets the height from what is actually visible,
   which not every phone browser agrees 100dvh is. */
.app { display: grid; grid-template-columns: 250px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 100vh; height: 100dvh; }
.app-side {
  display: flex; flex-direction: column; min-height: 0;
  background: var(--surface); border-right: 1px solid var(--border);
}
.app-main { display: flex; flex-direction: column; min-height: 0; }

/* --- the sidebar --- */
.side-head {
  display: flex; align-items: center; gap: var(--s2);
  padding: 0 var(--s4); height: 52px; flex: none;
  border-bottom: 1px solid var(--border-soft);
}
.side-head .brand { display: flex; align-items: center; gap: 8px; color: var(--fg); font-weight: 700; font-size: var(--t-lg); }
.side-head .brand svg { display: block; height: 22px; width: auto; }
.side-head .brand:hover { text-decoration: none; }
.side-rooms { flex: 1; overflow-y: auto; padding: var(--s3) 0 var(--s4); }
.side-cap {
  display: flex; align-items: baseline; justify-content: space-between;
  margin: var(--s3) var(--s4) var(--s1);
  font-size: var(--t-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--fg-subtle);
}
.side-cap a { color: var(--fg-subtle); font-size: var(--t-base); line-height: 1; }
.side-cap a:hover { color: var(--accent); text-decoration: none; }
.side-rooms ul { list-style: none; margin: 0; padding: 0; }
.side-rooms li a {
  display: flex; align-items: center; gap: 6px;
  padding: 3px var(--s4); color: var(--fg-muted); font-size: var(--t-sm);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.side-rooms li a:hover { background: var(--surface-hover); color: var(--fg); text-decoration: none; }
.side-rooms li a.current { background: var(--chip-bg); color: var(--fg); font-weight: 600; }
.side-rooms .room-glyph { color: var(--fg-subtle); flex: none; width: 18px; display: flex; justify-content: center; }
.side-foot {
  flex: none; display: flex; align-items: center; gap: var(--s2);
  padding: var(--s2) var(--s3) var(--s2) var(--s2); border-top: 1px solid var(--border-soft);
  font-size: var(--t-sm);
}
/* The account menu's button is the viewer's face and name, the width of the
   foot, and the menu opens upward from it: the foot is the bottom of the
   viewport, and a menu opening downward from there is a menu nobody sees. */
.side-foot .user-menu { flex: 1; min-width: 0; }
.side-user {
  display: flex; align-items: center; gap: var(--s2);
  padding: 4px var(--s2); border-radius: var(--radius); min-height: var(--touch);
}
.side-user:hover { background: var(--surface-hover); }
.side-user .whoami { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--fg); }
.side-user > svg:last-child { color: var(--fg-subtle); flex: none; }
.dropdown-menu.dd-up { top: auto; bottom: calc(100% + 6px); margin-top: 0; width: 240px; }

/* Unread counts: a filled rectangle at the end of the room's row, in the
   sheet's own corner radius, and stronger when a mention is waiting. A room
   with news is set in the text colour and bold, so it reads even without
   the number. */
.badge {
  margin-left: auto; flex: none; min-width: 20px; padding: 0 6px; text-align: center;
  border: none; border-radius: var(--radius); font-size: var(--t-xs); font-weight: 700; line-height: 18px;
  background: var(--fg-muted); color: var(--bg);
}
.badge.mention { background: var(--danger); color: var(--on-danger); }
.side-rooms li a.unread { color: var(--fg); font-weight: 600; }
.side-rooms li a .room-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.doc a .badge { display: inline-block; vertical-align: middle; margin-left: 4px; }

/* A value to hand to someone: the field shows it whole and selectable, the
   button beside it copies it. */
.copy-row { display: flex; gap: var(--s2); max-width: 720px; margin-bottom: var(--s4); }
.copy-row input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--t-sm); }

/* --- the room --- */
.room-head {
  flex: none; display: flex; align-items: center; gap: var(--s3);
  padding: 0 var(--s4); height: 52px;
  border-bottom: 1px solid var(--border);
}
/* The room's name and topic, beside each other here and one above the other
   on a phone. The name gives way to an ellipsis only after the topic has. */
.room-title { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--s3); }
.room-head h1 {
  margin: 0; font-size: var(--t-lg); font-family: var(--font-ui);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.room-topic {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--fg-muted); font-size: var(--t-sm);
  border-left: 1px solid var(--border-soft); padding-left: var(--s3);
}
.room-tools { margin-left: auto; flex: none; display: flex; align-items: center; gap: var(--s2); }
/* A document page's bar leads back to where it belongs. A page of a room's
   own (its settings, its pins) carries it everywhere, the room's header in
   its place; any other page only on the phone, where no sidebar leads back. */
.doc-head { display: none; }
.doc-head.for-room { display: flex; }
.doc-back { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: var(--touch); color: var(--fg-muted); font-weight: 600; }
.doc-back span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-back:hover { color: var(--fg); text-decoration: none; }

/* --- messages ---

   A message is a row, not a card: avatar in the gutter, name and time on one
   line, the body under them, hover revealing the tools. The list scrolls; the
   composer below it does not. */
.msgs { flex: 1; overflow-y: auto; padding: var(--s4) var(--s4) var(--s2); }
.msgs > ul { list-style: none; margin: 0; padding: 0; max-width: 920px; }
.msg { display: flex; gap: var(--s3); padding: 6px var(--s2); border-radius: var(--radius); position: relative; }
.msg:hover { background: var(--surface); }
.msg > .avatar { margin-top: 2px; }
.msg-main { flex: 1; min-width: 0; }
.msg-head { display: flex; align-items: baseline; gap: var(--s2); }
.msg-head .author { font-weight: 700; color: var(--fg); }
.msg-head time { font-size: var(--t-xs); }
.msg-body { overflow-wrap: anywhere; }
/* A table or a line of code keeps its shape and scrolls sideways in a
   narrow column, rather than breaking every word to fit. */
.msg-body table, .msg-body pre { overflow-wrap: normal; }
.msg-body .katex-display { overflow-x: auto; overflow-y: hidden; }
.msg-body.markdown-body > :first-child { margin-top: 0; }
.msg-body.markdown-body > :last-child { margin-bottom: 0; }
.msg-deleted { color: var(--fg-subtle); font-style: italic; }
/* A deleted message keeps its place in the gutter, and draws nothing there. */
.avatar-gap { width: 32px; flex: none; }
/* A code block's copy button sits at its foot in a message, clear of the
   message's tools, which float over the message's top edge. */
.msg-body .code-block .copy-btn { top: auto; bottom: 8px; }

/* The message a link opened the room at: marked, and the mark fading. */
@keyframes msg-target { from { background: var(--line-mark); } to { background: transparent; } }
.msg.target { animation: msg-target 2.5s ease-out; }

/* Editing in place: the text where the message's body was, and its buttons
   under it. */
.msg-edit { margin-top: 2px; }
.msg-edit textarea {
  display: block; width: 100%; min-height: 60px; max-height: 40vh; resize: vertical;
  padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--fg); font: inherit;
}
.msg-edit textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.msg-edit-row { display: flex; align-items: center; justify-content: flex-end; gap: var(--s2); margin-top: 6px; }
.msg-edit-row .hint { color: var(--fg-subtle); font-size: var(--t-xs); margin-right: auto; }
.msg.editing .msg-tools { display: none !important; }

/* The page's own question or notice, over a dimmed page. */
dialog.ask {
  max-width: min(440px, calc(100vw - 32px)); padding: var(--s4); border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--bg); color: var(--fg); box-shadow: 0 8px 28px var(--shadow);
}
dialog.ask::backdrop { background: rgba(0, 0, 0, 0.35); }
dialog.ask p { margin: 0 0 var(--s4); }
.ask-row { display: flex; justify-content: flex-end; gap: var(--s2); flex-wrap: wrap; }

/* A continuation: the same person again within a few minutes, drawn as more
   of what they were saying. The avatar keeps its column but is not drawn,
   the name stays for a screen reader only, and the time sits in the gutter,
   shown when the message is pointed at or tapped. It keeps a message's
   padding below, so every message in a run is as far from the next as the
   first is from the second. */
.msg-cont { padding-top: 1px; padding-bottom: 6px; }
.msg-cont > .avatar { visibility: hidden; max-height: 0; margin-top: 0; }
.msg-cont .msg-head .author {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
}
.msg-cont .msg-head time {
  position: absolute; left: 0; top: 1px; width: 52px; text-align: center;
  font-size: 11px; line-height: 23px; white-space: nowrap; visibility: hidden;
}
.msg-cont:hover .msg-head time, .msg-cont.picked .msg-head time { visibility: visible; }

/* Where what the viewer has not read begins: a rule in the colour a mention
   is marked in, with the word at its end. */
.new-rule { display: flex; align-items: center; gap: var(--s2); margin: var(--s2) 0; color: var(--danger); font-size: var(--t-xs); font-weight: 700; }
.new-rule::before { content: ""; flex: 1; border-top: 1px solid var(--danger); }

/* Back to the newest message, floating over the foot of the list while the
   reader is scrolled away from it. */
.jump-newest-wrap { position: relative; height: 0; flex: none; }
.jump-newest {
  position: absolute; bottom: var(--s2); left: 50%; transform: translateX(-50%); z-index: 10;
  display: inline-flex; align-items: center; gap: 6px; min-height: var(--touch); padding: 4px var(--s3);
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--fg);
  font: inherit; font-size: var(--t-sm); white-space: nowrap; cursor: pointer; box-shadow: 0 4px 12px var(--shadow);
}
.jump-newest:hover { background: var(--surface-hover); }
.msg-edited { font-size: var(--t-xs); color: var(--fg-subtle); }

/* Over the top of the page once its streams find it signed out. */
.signed-out {
  position: fixed; top: var(--s2); left: 50%; transform: translateX(-50%); z-index: 100;
  max-width: calc(100vw - 32px); padding: var(--s2) var(--s3);
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--fg);
  font-size: var(--t-sm); box-shadow: 0 4px 12px var(--shadow);
}

/* Someone waiting to be let in to a meeting: a notice over the page, one row
   a guest, above the composer's height so it covers no send button. */
.lobby-notice {
  position: fixed; top: var(--s2); right: var(--s2); z-index: 90;
  display: flex; flex-direction: column; gap: var(--s2); max-width: min(440px, calc(100vw - 16px));
  padding: var(--s2) var(--s3); border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--fg); font-size: var(--t-sm); box-shadow: 0 4px 12px var(--shadow);
}
.lobby-row { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.lobby-row > span { flex: 1 1 180px; min-width: 0; }

/* A meeting: what it says of itself before anything is said in it. */
.meeting-intro { flex: none; max-width: 720px; margin: var(--s3) var(--s4) 0; padding: var(--s3); border: 1px solid var(--border-soft); border-radius: var(--radius); background: var(--surface); font-size: var(--t-sm); }
.meeting-intro p { margin: 0 0 var(--s2); }
.meeting-intro .copy-row { margin-bottom: 0; }
.room-tools .guest-link-btn { white-space: nowrap; }
.call-button:disabled { opacity: 0.5; cursor: default; }

/* A guest's frame is the meeting alone: no sidebar beside it, so the column
   of messages is centred rather than left against an empty side. */
.app.guest-app { grid-template-columns: minmax(0, 1fr); }
@media (min-width: 761px) {
  .guest-app .msgs, .guest-app .composer { padding-left: max(var(--s4), calc((100% - 920px) / 2)); padding-right: max(var(--s4), calc((100% - 920px) / 2)); }
  .guest-app .typing { left: max(var(--s4), calc((100% - 920px) / 2)); }
  .guest-app .meeting-intro { margin-left: max(var(--s4), calc((100% - 920px) / 2)); }
}

/* The tools sit in a small bordered strip that appears on hover, the shape a
   control always has in this vocabulary. */
.msg-tools {
  position: absolute; top: -10px; right: var(--s2); z-index: 5; display: none; align-items: center;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 2px 8px var(--shadow);
}
.msg:hover .msg-tools, .msg:focus-within .msg-tools { display: inline-flex; }
.msg-tools form { margin: 0; display: flex; }
.msg-tools button, .msg-tools a, .msg-tools summary {
  display: flex; align-items: center; justify-content: center;
  min-width: 30px; height: 28px; padding: 0 6px;
  border: none; background: none; color: var(--fg-muted); font: inherit; font-size: var(--t-sm); cursor: pointer;
}
.msg-tools button:hover, .msg-tools a:hover, .msg-tools summary:hover { background: var(--surface-hover); color: var(--fg); text-decoration: none; }

/* Reacting: the quick reactions in one row, opening from the strip's right
   edge rather than from the plus, so on a narrow screen the row stays on it. */
.msg-tools .react-menu { position: static; }
.react-menu .dropdown-menu { top: 100%; right: -1px; width: auto; margin-top: 4px; display: grid; grid-template-columns: repeat(6, auto); }
.react-menu .dropdown-menu form { display: flex; }
.react-menu .dropdown-menu button.dd-item {
  width: auto; min-width: 40px; height: 40px; min-height: 0; padding: 0 8px; justify-content: center;
  border: none; font-size: var(--t-lg);
}
/* Under the quick ones, any other emoji, pasted or named as :tada:. */
.react-menu .dropdown-menu form.react-other { grid-column: 1 / -1; gap: 6px; padding: 6px; border-top: 1px solid var(--border); }
.react-other input { flex: 1; min-width: 0; width: 10em; }
.msg-tools .react-other button { color: var(--fg); min-width: 0; height: auto; padding: 4px 10px; border: 1px solid var(--border); }

/* Where nothing hovers, a tap on a message shows its tools, larger, for a
   thumb (the page script keeps the tapped message marked). Without script
   there is nothing to take the tap, so the tools are simply shown, under the
   message they belong to. */
@media (hover: none) {
  .msg:hover { background: none; }
  .msg:hover .msg-tools, .msg:focus-within .msg-tools { display: none; }
  .js .msg.picked { background: var(--surface); }
  .js .msg.picked .msg-tools { display: inline-flex; }
  .msg-tools { top: -20px; }
  .msg-tools button, .msg-tools a, .msg-tools summary { min-width: 40px; height: 38px; }
  html:not(.js) .msg { flex-wrap: wrap; }
  html:not(.js) .msg-main { flex-basis: calc(100% - 44px); }
  html:not(.js) .msg .msg-tools { display: inline-flex; position: static; box-shadow: none; margin: 4px 0 0 44px; }
}

/* Reactions and the thread link: pills under the body, bordered because they
   are controls. The one the viewer has pressed is filled. */
.msg-below { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; align-items: center; }
.react-pill {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); padding: 1px 8px; font: inherit; font-size: var(--t-sm); cursor: pointer;
  color: var(--fg-muted);
}
.react-pill:hover { border-color: var(--accent-soft); }
.react-pill.mine { background: var(--chip-bg); border-color: var(--accent-soft); color: var(--fg); }
.thread-link { font-size: var(--t-sm); }

/* Attached files: one bordered row per file, the icon in the gutter. */
.msg-files { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.msg-files a {
  display: inline-flex; align-items: center; gap: 8px;
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 4px 10px; color: var(--fg-muted); font-size: var(--t-sm);
}
.msg-files a:hover { border-color: var(--accent-soft); color: var(--fg); text-decoration: none; }
.msg-img { max-width: min(420px, 100%); max-height: 320px; border-radius: var(--radius); border: 1px solid var(--border-soft); display: block; margin-top: 6px; }
/* A playable attachment: its name above, the browser's own controls below. */
.msg-media { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.msg-media audio { width: min(420px, 100%); display: block; }
.msg-video { max-width: min(560px, 100%); max-height: 400px; border-radius: var(--radius); border: 1px solid var(--border-soft); display: block; background: #000; }

/* A message naming the viewer carries a rule down its left side, the way a
   flagged line does everywhere else in this vocabulary. */
.msg.mentions-me { border-left: 3px solid var(--danger); padding-left: calc(var(--s2) - 3px); background: var(--err-bg); }

/* The day rule: a line with the date resting on it, dividing one day's
   messages from the next the way a section rule divides a page. */
.day-rule { display: flex; align-items: center; gap: var(--s3); margin: var(--s4) 0 var(--s2); color: var(--fg-subtle); font-size: var(--t-xs); font-weight: 600; }
.day-rule::before, .day-rule::after { content: ""; flex: 1; border-top: 1px solid var(--border-soft); }

/* The thread page pins the message the thread hangs from above its replies. */
.thread-anchor { border-bottom: 2px solid var(--border); padding-bottom: var(--s3); margin-bottom: var(--s3); }

/* --- the composer --- */
.composer { flex: none; padding: var(--s2) var(--s4) var(--s4); }
.composer form { max-width: 920px; }
.composer-box {
  display: flex; flex-direction: column;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg);
}
.composer-box:focus-within { border-color: var(--accent); }
/* Sending: a thin bar along the top of the box for an upload's progress, and
   a line under the text saying what is happening, or, in the error colour,
   why a message was not sent. A locked box is dimmed so it reads as busy. */
.send-progress { height: 3px; background: var(--border-soft); border-radius: var(--radius) var(--radius) 0 0; overflow: hidden; }
.send-progress > div { height: 100%; width: 0; background: var(--accent); transition: width 0.2s; }
.send-status { padding: 2px 12px 4px; font-size: var(--t-sm); color: var(--fg-muted); }
.send-status.error { color: var(--danger); }
form[data-busy] textarea { color: var(--fg-muted); }
/* Files held over a room, ready to be dropped into its composer. */
.app-main.drop-ready { position: relative; }
.app-main.drop-ready::after {
  content: "Drop to attach"; position: absolute; inset: var(--s2); z-index: 30; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  border: 2px dashed var(--accent); border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg) 88%, transparent); color: var(--accent);
  font-size: var(--t-lg); font-weight: 600;
}
/* Who else is typing, in the composer's foot padding, so that it coming and
   going moves nothing; on a phone, where that padding is thin, it takes a
   line of its own while it has something to say. */
.composer { position: relative; }
.typing {
  position: absolute; left: var(--s4); right: var(--s4); bottom: 0; max-width: 920px;
  height: var(--s4); line-height: var(--s4); font-size: var(--t-xs); color: var(--fg-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.typing b { font-weight: 600; color: var(--fg); }
.typing-dots { display: inline-flex; gap: 2px; margin-right: 6px; vertical-align: middle; }
.typing-dots i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: typing-dot 1.2s infinite ease-in-out; }
.typing-dots i:nth-child(2) { animation-delay: 0.15s; }
.typing-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes typing-dot { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .typing-dots i { animation: none; opacity: 0.6; } }
form[data-busy] button[type="submit"] { opacity: 0.6; cursor: progress; }

/* Pinned messages: a quiet line above the message saying who pinned it, and
   the pin tool filled in the accent when the message is pinned. The header's
   pin link carries the room's count beside it. */
.pinned-by { display: flex; align-items: center; gap: 4px; font-size: var(--t-xs); color: var(--fg-muted); margin-bottom: 2px; }
.pinned-by .glyph { color: var(--accent); }
.msg-tools button.is-pinned { color: var(--accent); }
.pins-link { width: auto; gap: 4px; padding: 0 8px; font-size: var(--t-sm); }

/* Muting: the bell in the header is a button in a form, drawn as the other
   header icons are, in the accent while the room is muted; a muted room's
   name in the sidebar is quieter, with the struck bell beside it. */
.mute-form { display: contents; }
.room-tools button.topbar-icon { border: none; background: none; padding: 0; cursor: pointer; font: inherit; }
.room-tools button.topbar-icon:hover { background: var(--surface-hover); color: var(--fg); }
.room-tools button.topbar-icon.is-muted { color: var(--accent); }
.side-rooms li a.muted-room .room-name { opacity: 0.65; }
.room-muted { display: flex; flex: none; color: var(--fg-subtle); }
.room-tools button.topbar-icon .glyph, .room-muted .glyph { color: inherit; }

/* Sizes: an attachment's, beside its name, and the files chosen in the
   composer, beside the picker. Quiet, in the subtle colour. */
.file-size { color: var(--fg-subtle); font-size: var(--t-xs); }
.file-size.over { color: var(--danger); }
.file-caption { display: flex; gap: 6px; max-width: min(420px, 100%); font-size: var(--t-xs); color: var(--fg-muted); }
/* A camera names a picture with a long run of digits: one line of it is
   enough, and the whole name is in the picture's alt text and its link. */
.file-caption .file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Completing an @: a list above the text, in the dropdown's clothes, with
   the chosen row filled as a hovered one would be. */
.composer-box { position: relative; }
.mention-list {
  position: absolute; left: 8px; bottom: calc(100% + 4px); z-index: 20; width: 280px; max-height: 240px; overflow-y: auto;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 24px var(--shadow);
}
.mention-list button {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px; text-align: left;
  border: none; border-top: 1px solid var(--border-soft); background: none; font: inherit; font-size: var(--t-sm); color: var(--fg); cursor: pointer;
}
.mention-list button:first-child { border-top: none; }
.mention-list button:hover, .mention-list button.picked { background: var(--surface); }
.mention-list .muted { margin-left: auto; font-size: var(--t-xs); }
.composer textarea {
  border: none; background: none; resize: none; min-height: 42px; max-height: 40vh;
  padding: 10px 12px; font: inherit; font-size: var(--t-base); color: var(--fg); width: 100%;
}
.composer textarea:focus { outline: none; }
/* A room's name can be long, and a placeholder that wrapped would spill out
   of a box one line high; it shortens instead. */
.composer textarea::placeholder { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.composer-row { display: flex; align-items: center; gap: var(--s2); padding: 4px 8px 6px; }
.composer-row .hint { color: var(--fg-subtle); font-size: var(--t-xs); margin-left: auto; text-align: right; }
.composer-row [data-file-total] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The files about to be sent, under the text: a chip for each, an image as a
   small picture of itself, with a button that takes that one out. */
.file-list { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0 8px 4px; }
.file-list[hidden] { display: none; }
.file-chip {
  display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 280px; padding: 3px 3px 3px 8px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); font-size: var(--t-xs);
}
.file-chip:has(img) { padding-left: 3px; }
.file-chip img { flex: none; width: 28px; height: 28px; object-fit: cover; border-radius: 3px; }
.file-chip .file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
.file-chip .file-size { flex: none; }
.file-remove { flex: none; display: flex; border: none; background: none; padding: 3px; border-radius: 3px; color: var(--fg-subtle); cursor: pointer; }
.file-remove:hover { background: var(--surface-hover); color: var(--fg); }
.file-remove:disabled { opacity: 0.5; cursor: progress; }
.file-remove .glyph { color: inherit; }
/* The file picker is a paperclip. The input inside it is the real control,
   kept for the keyboard and the form but not drawn, so the browser's own
   "Choose Files" button does not sit in the composer. */
.attach { position: relative; flex: none; cursor: pointer; }
.attach input { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; clip: rect(0 0 0 0); }
.attach:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.attach:has(input:disabled) { opacity: 0.5; cursor: progress; }

/* The people to start a conversation with: a box, a face, a name. */
.field label.person-pick { display: flex; align-items: center; gap: var(--s2); margin-bottom: var(--s1); }
[data-people-filter] { margin-bottom: var(--s2); }

/* The mark over a signed-out page's form. */
.signin-mark { display: flex; justify-content: center; margin-bottom: var(--s4); color: var(--fg); }
.signin-mark svg { display: block; width: 44px; height: 44px; }

/* --- pages that are documents rather than rooms (login, admin, account,
       search, profiles) reuse the forge's document styles inside the frame. */
.doc { flex: 1; overflow-y: auto; padding: var(--s5) var(--s5) var(--s6); }
.doc > .inner { max-width: 920px; }
.search-result { border-left: 3px solid var(--border); padding: 2px 0 2px var(--s3); margin-bottom: var(--s4); max-width: var(--measure); }
.js .search-result { cursor: pointer; border-radius: 0 var(--radius) var(--radius) 0; }
.js .search-result:hover { background: var(--surface); border-left-color: var(--accent); }
.search-result .where > a:first-child { display: inline-flex; align-items: center; gap: 4px; }
.search-result .result-time { color: var(--fg-muted); }
.search-result .where { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--s2); font-size: var(--t-sm); margin-bottom: 2px; }
.search-result .who { display: inline-flex; align-items: center; gap: 4px; color: var(--fg-muted); }
.search-result .markdown-body { overflow-wrap: anywhere; }
[data-highlight] mark { background: var(--line-mark); color: inherit; border-radius: 2px; }
.this-device { margin-left: 6px; }

/* The admin's list of people: a name, its tokens, and what can be done. */
table.people { max-width: 720px; }
table.people td { vertical-align: middle; }
table.people td.person .avatar { vertical-align: middle; margin-right: 4px; }
table.people td.tokens, table.people td.seen { white-space: nowrap; }
table.people td.actions { text-align: right; white-space: nowrap; }

/* --- calls ---

   The call buttons exist only for script (html.can-call says the browser can
   make a call), so without it they are not drawn at all. The header's is a
   camera, in the accent with a count while a call is on, and filled while
   this page is in it; the sidebar marks a room with a call the same way. */
.call-button, .call-join { display: none; }
.can-call .room-tools .call-button { display: inline-flex; width: auto; gap: 4px; padding: 0 8px; font-size: var(--t-sm); }
.can-call .call-join { display: inline-flex; }
.room-tools .call-button.live { color: var(--accent); font-weight: 700; }
.room-tools .call-button.joined { background: var(--chip-bg); color: var(--accent); }
.room-call { display: flex; flex: none; color: var(--accent); }
.room-call[hidden] { display: none; }
.room-call .glyph { color: inherit; }
html.loading-page { cursor: progress; }

/* A call's entry in the timeline: a bordered card under the author's line,
   in the accent while the call goes on, with who is in it. */
.call-entry {
  display: flex; align-items: center; gap: var(--s3); margin-top: 4px; padding: var(--s2) var(--s3);
  max-width: 460px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
}
.call-entry.live { border-color: var(--accent); }
.call-entry-icon { display: flex; color: var(--fg-muted); }
.call-entry.live .call-entry-icon { color: var(--accent); }
.call-entry-text { flex: 1; min-width: 0; }
.call-entry-people { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
.call-entry-people .avatar { display: block; }
.msg-call .msg-head .muted { font-size: var(--t-sm); }

/* The dock: the call on screen. It is dark whatever the theme, as video is
   watched against, and takes one of three shapes. As a strip under the
   room's header its tiles run in a row with the controls beneath; floating,
   it is small, in the corner, with room for one tile; full page, it covers
   the frame, its tiles in a grid, and a tile pressed fills it. */
.call-dock {
  --call-bg: #15171b; --call-fg: #eceef2; --call-muted: #a3a8b3; --call-ctl: rgba(255, 255, 255, 0.12);
  display: grid; gap: 6px; background: var(--call-bg); color: var(--call-fg); font-size: var(--t-sm);
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "notice notice" "tiles tiles" "settings settings" "bar controls";
}
.call-bar { grid-area: bar; display: flex; align-items: center; gap: var(--s2); min-width: 0; }
.call-where { color: var(--call-fg); font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.call-where:hover { color: var(--call-fg); }
.call-status { color: var(--call-muted); white-space: nowrap; }
.call-size { margin-left: auto; }
.call-notice { grid-area: notice; display: flex; align-items: flex-start; gap: var(--s2); padding: 6px 10px; border-radius: var(--radius); background: #4a3712; color: #fbe7b5; }
.call-notice[hidden] { display: none; }
.call-notice span { flex: 1; }
.call-tiles { grid-area: tiles; min-width: 0; min-height: 0; }
.call-controls { grid-area: controls; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.call-ctl {
  display: inline-flex; align-items: center; justify-content: center; flex: none; width: 36px; height: 36px; padding: 0;
  border: none; border-radius: 50%; background: var(--call-ctl); color: var(--call-fg); cursor: pointer;
}
.call-ctl:hover { background: rgba(255, 255, 255, 0.22); }
.call-ctl:disabled { opacity: 0.45; cursor: default; }
.call-ctl.off { background: #b8322a; }
.call-ctl.active { background: var(--accent); color: var(--on-accent, #fff); }
.call-leave {
  display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px;
  border: none; border-radius: 18px; background: #c62f26; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
}
.call-leave:hover { background: #a82820; }
.call-settings { grid-area: settings; display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); padding: var(--s2) var(--s3); border-radius: var(--radius); background: rgba(255, 255, 255, 0.06); }
.call-settings[hidden] { display: none; }
.call-settings label { display: flex; flex-direction: column; gap: 2px; color: var(--call-muted); font-size: var(--t-xs); }
.call-settings select { max-width: 240px; font-size: var(--t-sm); }
.call-settings p { flex-basis: 100%; margin: 0; color: var(--call-muted); font-size: var(--t-xs); }

.call-tile { position: relative; overflow: hidden; border-radius: 8px; background: #000; aspect-ratio: 16 / 9; }
.call-tile video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.call-tile.mirror video { transform: scaleX(-1); }
.call-tile.screen video { object-fit: contain; }
.call-face { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: #262a31; }
.call-tile.video-off .call-face { display: flex; }
.call-face .avatar { width: min(64px, 42%) !important; height: auto !important; aspect-ratio: 1 / 1; border-radius: 50%; overflow: hidden; }
.call-face svg { display: block; width: 100%; height: 100%; }
.call-label {
  position: absolute; left: 6px; bottom: 6px; max-width: calc(100% - 12px); display: flex; align-items: center; gap: 4px;
  padding: 1px 6px; border-radius: 4px; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 12px; line-height: 18px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.call-muted { display: flex; color: #ff8a80; }
.call-muted svg { width: 12px; height: 12px; }
.call-wait { position: absolute; top: 6px; left: 6px; display: none; color: var(--call-muted); font-size: 12px; }
.call-tile.connecting .call-wait { display: block; }
.call-tile.speaking::after { content: ""; position: absolute; inset: 0; border: 3px solid #43d17a; border-radius: inherit; pointer-events: none; }

.call-dock.strip { flex: none; padding: var(--s2) var(--s4); border-bottom: 1px solid var(--border); }
.call-dock.strip .call-where { display: none; }
.call-dock.strip .call-tiles { display: flex; gap: 8px; height: 132px; overflow-x: auto; }
.call-dock.strip .call-tile { flex: none; height: 100%; }

.call-dock.mini {
  position: fixed; right: 16px; bottom: 16px; z-index: 60; width: 320px; padding: 8px; border-radius: 12px;
  grid-template-columns: minmax(0, 1fr); grid-template-areas: "bar" "notice" "tiles" "settings" "controls";
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}
.call-dock.mini .call-bar { cursor: move; touch-action: none; }
.call-dock.mini .call-tile:not(.featured) { display: none; }
.call-dock.mini .call-controls { justify-content: center; }
.call-dock.mini .call-leave span { display: none; }
.call-dock.mini .call-leave { width: 36px; padding: 0; justify-content: center; }

.call-dock.full {
  position: fixed; inset: 0; z-index: 60; padding: var(--s3);
  grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr) auto auto;
  grid-template-areas: "bar" "notice" "tiles" "settings" "controls";
}
.call-dock.full .call-controls { justify-content: center; }
.call-dock.full .call-tiles {
  display: grid; gap: 8px; overflow: auto;
  grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); grid-auto-rows: minmax(160px, 1fr);
}
.call-dock.full .call-tile { aspect-ratio: auto; cursor: pointer; }
.call-dock.full.spot .call-tiles { display: flex; flex-wrap: wrap; align-content: flex-start; }
.call-dock.full.spot .call-tile { flex: none; height: 96px; aspect-ratio: 16 / 9; }
.call-dock.full.spot .call-tile.spotlit { order: -1; flex: 1 1 100%; height: calc(100% - 104px); aspect-ratio: auto; }
.call-dock.full.spot .call-tile.spotlit video { object-fit: contain; }

/* The connections in the call's panel: one line each, the copy button
   plainly a control. */
.call-diag { flex-basis: 100%; font-size: var(--t-xs); color: var(--call-muted); }
.call-diag strong { color: var(--call-fg); }
.call-diag ul { margin: 4px 0 6px; padding-left: 18px; }
.call-diag li { margin-bottom: 2px; overflow-wrap: anywhere; }
.call-copy { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: var(--radius); background: none; color: var(--call-fg); font: inherit; padding: 2px 8px; cursor: pointer; }
.call-copy:hover { background: rgba(255, 255, 255, 0.1); }

/* The admin page's test of how calls connect, each result marked as passed
   or failed, and the log of connections, a failure in the error colour. */
.relay-results { list-style: none; padding: 0; margin: var(--s2) 0; }
.relay-results li { position: relative; padding-left: 22px; margin-bottom: 4px; overflow-wrap: anywhere; }
.relay-results li::before { position: absolute; left: 0; font-weight: 700; }
.relay-results li.ok::before { content: "✓"; color: var(--success, #2e7d32); }
.relay-results li.fail::before { content: "✗"; color: var(--danger); }
.relay-results li.info::before { content: "–"; color: var(--fg-subtle); }
table.call-log { max-width: 920px; font-size: var(--t-sm); }
table.call-log td { vertical-align: top; }
table.call-log tr.failed td:nth-child(4), table.call-log tr.dropped td:nth-child(4) { color: var(--danger); }
table.call-log td .muted { font-size: var(--t-xs); }

/* --- touch ---

   A field set under 16px is one iOS zooms the page into on focus, and does
   not zoom back out of; at 16px it stays put. Rows in the room list grow to
   a thumb's size, as every other control does under a coarse pointer. */
@media (pointer: coarse) {
  input[type="text"], input[type="password"], input[type="time"], select, textarea, .composer textarea { font-size: 16px; }
  input[type="checkbox"], input[type="radio"] { width: 20px; height: 20px; }
  .field label.person-pick { min-height: var(--touch); }
  .side-rooms li a { min-height: var(--touch); font-size: var(--t-base); }
  .side-cap { align-items: center; }
  .side-cap a { display: flex; align-items: center; justify-content: center; width: var(--touch); height: var(--touch); margin: -12px -12px -12px 0; }
  .mention-list button { min-height: var(--touch); }
}

/* --- phones ---

   The sidebar gives way rather than squeezing: below 760px the room list is
   its own page (/), which every room page links back to from its header,
   and every other page from a bar of its own. What stays is spaced for a
   narrow screen: less gutter, and the topic under the room's name. */
.back-link { display: none; }
@media (max-width: 760px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .app-side { display: none; }
  .app.rooms-page .app-side { display: flex; border-right: none; }
  .app.rooms-page .app-main { display: none; }
  .back-link { display: flex; }
  .doc-head { display: flex; }

  .room-head { padding: 0 var(--s2); gap: var(--s1); }
  .room-title { flex-direction: column; align-items: flex-start; gap: 0; }
  .room-head h1 { max-width: 100%; font-size: var(--t-base); line-height: 1.3; }
  .room-topic { max-width: 100%; border-left: none; padding-left: 0; font-size: var(--t-xs); line-height: 1.3; }
  .room-tools { gap: 0; }
  .doc-head { padding-left: var(--s3); }

  .msgs { padding: var(--s3) var(--s2) var(--s2); }
  .msg { gap: var(--s2); padding: 6px; }
  .msg-cont { padding-top: 1px; padding-bottom: 6px; }
  .msg-cont .msg-head time { width: 46px; }
  .msg-img { max-height: 260px; }


  /* A call keeps to a thumb's reach: a floating dock narrower and clear of
     the composer. */
  .call-dock.mini { width: 190px; right: 8px; bottom: 84px; }
  .call-dock.mini .call-ctl, .call-dock.mini .call-leave { width: 32px; height: 32px; }
  .call-dock.mini .call-controls { gap: 4px; }
  .call-dock.full { padding: var(--s2); }
  .call-entry { max-width: 100%; }

  .doc { padding: var(--s4) var(--s4) var(--s6); }
  /* The people list becomes a name and its count on one line, and what can
     be done with them on the next. */
  table.people tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; border-top: 1px solid var(--border-soft); }
  table.people tr:first-child { border-top: none; }
  table.people td { border-top: none; padding: 6px 4px; }
  table.people td.person, table.people td.actions { grid-column: 1 / -1; }
  table.people td.seen, table.people td.tokens, table.people td.actions { padding-top: 0; }
  table.people td.actions { text-align: left; white-space: normal; }
}

/* --- small screens ---

   A room on a small screen, narrow as a phone held upright or short as one
   on its side, gives the messages what height it can: the composer is one
   row, paperclip, text, and Send, and a call's strip is shorter. A phone on
   its side is wide enough for the sidebar but not tall enough for the
   desktop's composer and strip under the header together. */
@media (max-width: 760px), (max-height: 500px) {
  .composer { padding: var(--s1) var(--s2) var(--s2); }
  .typing { position: static; padding: 2px var(--s2) 0; height: auto; }
  .typing:empty { display: none; }
  .composer-box { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: end; }
  .composer-box > * { grid-column: 1 / -1; }
  .composer-row { display: contents; }
  .send-progress { grid-row: 1; }
  .composer textarea { grid-row: 2; grid-column: 2; padding: 9px 4px; min-height: 0; }
  .composer .attach { grid-row: 2; grid-column: 1; margin: 4px 0 4px 4px; }
  .composer button[type="submit"] { grid-row: 2; grid-column: 3; margin: 4px 4px 4px 0; }
  .file-list { grid-row: 3; padding: 0 6px 6px; }
  .file-chip { max-width: 100%; }
  .file-remove { padding: 7px; }
  .send-status { grid-row: 4; }
  .composer-row [data-file-total] { grid-row: 5; grid-column: 1 / -1; padding: 0 12px 6px; }
  .composer-row [data-file-total]:empty { display: none; }
  .composer-row .hint { display: none; }
  .mention-list { left: 0; right: 0; width: auto; }
  .call-dock.strip { padding: var(--s2); }
  .call-dock.strip .call-tiles { height: 96px; }
}

/* --- the phone's own edges ---

   A phone's screen is not a rectangle. Its corners are rounded, a camera cuts
   into the top, and the status bar and the home indicator sit over the top
   and bottom edges; a Home Screen app, and Safari with its toolbar floating
   over the page, draw the page under all of them. The viewport tag asks for
   that (viewport-fit=cover), which is what makes iOS say how much of each
   edge is covered, in env(safe-area-inset-*), and each part of the frame
   moves itself clear by that much: each column from the top, the composer
   and the sidebar's foot from the bottom, the columns from the sides in
   landscape. The padding is the column's own background, so what shows
   under the status bar and around the home indicator is the page, not a band
   of another colour. Where nothing is covered (a desktop, most phones' browsers
   with their bars shown) the insets are 0 and nothing moves.

   With the keyboard up the home indicator is under the keyboard, but iOS
   goes on reporting its inset; the composer then has focus, and sits on the
   keyboard. scripts/phones.mjs checks all of this on emulated phones. */
.app-side { padding-top: env(safe-area-inset-top); padding-left: env(safe-area-inset-left); }
.app-main { padding-top: env(safe-area-inset-top); padding-right: env(safe-area-inset-right); }
.guest-app .app-main { padding-left: env(safe-area-inset-left); }
.side-foot { padding-bottom: max(var(--s2), env(safe-area-inset-bottom)); }
.composer { padding-bottom: max(var(--s4), env(safe-area-inset-bottom)); }
.doc { padding-bottom: calc(var(--s6) + env(safe-area-inset-bottom)); }
body > main.container {
  padding-left: max(var(--s4), env(safe-area-inset-left)); padding-right: max(var(--s4), env(safe-area-inset-right));
  padding-bottom: calc(var(--s6) + env(safe-area-inset-bottom));
}
.signed-out { top: calc(var(--s2) + env(safe-area-inset-top)); }
.lobby-notice { top: calc(var(--s2) + env(safe-area-inset-top)); right: calc(var(--s2) + env(safe-area-inset-right)); }
.call-dock.mini { right: calc(16px + env(safe-area-inset-right)); bottom: calc(16px + env(safe-area-inset-bottom)); }
.call-dock.full {
  padding: max(var(--s3), env(safe-area-inset-top)) max(var(--s3), env(safe-area-inset-right))
    max(var(--s3), env(safe-area-inset-bottom)) max(var(--s3), env(safe-area-inset-left));
}
@media (max-width: 760px), (max-height: 500px) {
  .composer { padding-bottom: max(var(--s2), env(safe-area-inset-bottom)); }
}
@media (max-width: 760px) {
  .app-side, .app-main { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
  body > main.container { padding-left: max(var(--s3), env(safe-area-inset-left)); padding-right: max(var(--s3), env(safe-area-inset-right)); }
  .call-dock.mini { right: calc(8px + env(safe-area-inset-right)); bottom: calc(84px + env(safe-area-inset-bottom)); }
  .call-dock.full {
    padding: max(var(--s2), env(safe-area-inset-top)) max(var(--s2), env(safe-area-inset-right))
      max(var(--s2), env(safe-area-inset-bottom)) max(var(--s2), env(safe-area-inset-left));
  }
}
@media (hover: none) and (pointer: coarse) {
  .composer:focus-within { padding-bottom: var(--s2); }
  /* The hint is the desktop's keys; on a touch keyboard Enter is a new line.
     Send keeps to the right without it. */
  .composer-row .hint { display: none; }
  .composer-row button[type="submit"] { margin-left: auto; }
}
`;

const sheets = new Map<string, { body: string; tag: string }>();

export function styleSheet(theme: Theme): { body: string; tag: string } {
  const made = sheets.get(theme.name);
  if (made) return made;
  const body = allThemeVarsCss(theme) + CSS + CHAT_CSS;
  const sheet = { body, tag: createHash('sha256').update(body).digest('hex').slice(0, 12) };
  sheets.set(theme.name, sheet);
  return sheet;
}
