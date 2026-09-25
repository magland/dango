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
   inside it. */
.app { display: grid; grid-template-columns: 250px minmax(0, 1fr); height: 100vh; height: 100dvh; }
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
.side-rooms .room-glyph { color: var(--fg-subtle); flex: none; width: 1em; text-align: center; }
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
  border-radius: var(--radius); font-size: var(--t-xs); font-weight: 700; line-height: 18px;
  background: var(--fg-muted); color: var(--bg);
}
.badge.mention { background: var(--danger); color: var(--on-danger); }
.side-rooms li a.unread { color: var(--fg); font-weight: 600; }
.side-rooms li a .room-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.doc a .badge { display: inline-block; vertical-align: middle; margin-left: 4px; }

/* --- the room --- */
.room-head {
  flex: none; display: flex; align-items: center; gap: var(--s3);
  padding: 0 var(--s4); height: 52px;
  border-bottom: 1px solid var(--border);
}
.room-head h1 { margin: 0; font-size: var(--t-lg); font-family: var(--font-ui); white-space: nowrap; }
.room-topic {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--fg-muted); font-size: var(--t-sm);
  border-left: 1px solid var(--border-soft); padding-left: var(--s3);
}
.room-tools { margin-left: auto; display: flex; align-items: center; gap: var(--s2); }

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
.msg-body.markdown-body > :first-child { margin-top: 0; }
.msg-body.markdown-body > :last-child { margin-bottom: 0; }
.msg-deleted { color: var(--fg-subtle); font-style: italic; }
.msg-edited { font-size: var(--t-xs); color: var(--fg-subtle); }

/* The tools sit in a small bordered strip that appears on hover, the shape a
   control always has in this vocabulary. On a coarse pointer there is no
   hover, so they are simply always shown. */
.msg-tools {
  position: absolute; top: -10px; right: var(--s2); display: none; align-items: center;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 2px 8px var(--shadow);
}
.msg:hover .msg-tools, .msg:focus-within .msg-tools { display: inline-flex; }
@media (pointer: coarse) { .msg-tools { display: inline-flex; position: static; box-shadow: none; margin-top: 4px; } }
.msg-tools form { margin: 0; display: flex; }
.msg-tools button, .msg-tools a {
  display: flex; align-items: center; justify-content: center;
  min-width: 30px; height: 28px; padding: 0 6px;
  border: none; background: none; color: var(--fg-muted); font: inherit; font-size: var(--t-sm); cursor: pointer;
}
.msg-tools button:hover, .msg-tools a:hover { background: var(--surface-hover); color: var(--fg); text-decoration: none; }

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
.composer-row { display: flex; align-items: center; gap: var(--s2); padding: 4px 8px 6px; }
.composer-row .hint { color: var(--fg-subtle); font-size: var(--t-xs); margin-left: auto; }
.composer-row input[type="file"] { font-size: var(--t-xs); color: var(--fg-muted); max-width: 50%; }

/* --- pages that are documents rather than rooms (login, admin, account,
       search, profiles) reuse the forge's document styles inside the frame. */
.doc { flex: 1; overflow-y: auto; padding: var(--s5) var(--s5) var(--s6); }
.doc > .inner { max-width: 920px; }
.search-hit { border-left: 3px solid var(--border); padding: 2px 0 2px var(--s3); margin-bottom: var(--s4); }
.search-hit .where { font-size: var(--t-sm); margin-bottom: 2px; }

/* --- phones ---

   The sidebar gives way rather than squeezing: below 760px the room list is
   its own page (/), which every room page links back to from its header. */
.back-link { display: none; }
@media (max-width: 760px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .app-side { display: none; }
  .app.rooms-page .app-side { display: flex; border-right: none; }
  .app.rooms-page .app-main { display: none; }
  .back-link { display: flex; }
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
