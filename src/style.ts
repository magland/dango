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
/* A document page's bar exists only for the phone, where no sidebar leads
   back; it says where it goes. */
.doc-head { display: none; }
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

/* A continuation: the same person again within a few minutes, drawn as more
   of what they were saying. The avatar keeps its column but is not drawn,
   the name stays for a screen reader only, and the time sits in the gutter,
   shown when the message is pointed at or tapped. */
.msg-cont { padding-top: 1px; padding-bottom: 1px; }
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
.react-menu .dropdown-menu { top: 100%; right: -1px; width: auto; margin-top: 4px; display: flex; }
.react-menu .dropdown-menu form { display: flex; }
.react-menu .dropdown-menu button.dd-item {
  width: auto; min-width: 40px; height: 40px; min-height: 0; padding: 0 8px; justify-content: center;
  border: none; font-size: var(--t-lg);
}

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
.file-caption { font-size: var(--t-xs); color: var(--fg-muted); }

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
/* The file picker is a paperclip. The input inside it is the real control,
   kept for the keyboard and the form but not drawn, so the browser's own
   "Choose Files" button does not sit in the composer. */
.attach { position: relative; flex: none; cursor: pointer; }
.attach input { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; clip: rect(0 0 0 0); }
.attach:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.attach:has(input:disabled) { opacity: 0.5; cursor: progress; }

/* The people to start a conversation with: a box, a face, a name. */
.field label.person-pick { display: flex; align-items: center; gap: var(--s2); margin-bottom: var(--s1); }

/* The mark over a signed-out page's form. */
.signin-mark { display: flex; justify-content: center; margin-bottom: var(--s4); color: var(--fg); }
.signin-mark svg { display: block; width: 44px; height: 44px; }

/* --- pages that are documents rather than rooms (login, admin, account,
       search, profiles) reuse the forge's document styles inside the frame. */
.doc { flex: 1; overflow-y: auto; padding: var(--s5) var(--s5) var(--s6); }
.doc > .inner { max-width: 920px; }
.search-result { border-left: 3px solid var(--border); padding: 2px 0 2px var(--s3); margin-bottom: var(--s4); max-width: var(--measure); }
.search-result .where { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--s2); font-size: var(--t-sm); margin-bottom: 2px; }
.search-result .who { display: inline-flex; align-items: center; gap: 4px; color: var(--fg-muted); }
.search-result .markdown-body { overflow-wrap: anywhere; }

/* The admin's list of people: a name, its tokens, and what can be done. */
table.people { max-width: 720px; }
table.people td { vertical-align: middle; }
table.people td.person .avatar { vertical-align: middle; margin-right: 4px; }
table.people td.tokens { white-space: nowrap; }
table.people td.actions { text-align: right; white-space: nowrap; }

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
   narrow screen: less gutter, the topic under the room's name, and the
   composer one row, paperclip, text, and Send. */
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
  .msg-cont { padding-top: 1px; padding-bottom: 1px; }
  .msg-cont .msg-head time { width: 46px; }
  .msg-img { max-height: 260px; }

  .composer { padding: var(--s1) var(--s2) var(--s2); }
  .composer-box { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: end; }
  .composer-box > * { grid-column: 1 / -1; }
  .composer-row { display: contents; }
  .send-progress { grid-row: 1; }
  .composer textarea { grid-row: 2; grid-column: 2; padding: 9px 4px; min-height: 0; }
  .composer .attach { grid-row: 2; grid-column: 1; margin: 4px 0 4px 4px; }
  .composer button[type="submit"] { grid-row: 2; grid-column: 3; margin: 4px 4px 4px 0; }
  .send-status { grid-row: 3; }
  .composer-row [data-file-total] { grid-row: 4; padding: 0 12px 6px; }
  .composer-row [data-file-total]:empty { display: none; }
  .composer-row .hint { display: none; }
  .mention-list { left: 0; right: 0; width: auto; }

  .doc { padding: var(--s4) var(--s4) var(--s6); }
  /* The people list becomes a name and its count on one line, and what can
     be done with them on the next. */
  table.people tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; border-top: 1px solid var(--border-soft); }
  table.people tr:first-child { border-top: none; }
  table.people td { border-top: none; padding: 6px 4px; }
  table.people td.actions { grid-column: 1 / -1; text-align: left; white-space: normal; padding-top: 0; }
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
