import * as fs from 'fs';
import * as path from 'path';
import { withFileLock } from '../../mochiforge/src/atomic';
import { readDoc, str, writeDoc } from '../../mochiforge/src/discussion';
import MarkdownIt from 'markdown-it';
import { full as emojiPlugin } from 'markdown-it-emoji';
import { OpError } from '../../mochiforge/src/ops';

// Message storage, shared by channels, direct conversations, and threads.
//
// A "room" here is any directory that holds a `messages/` subdirectory of
// numbered markdown files: a channel, a DM conversation, or one message's
// thread. Storing all three the same way is the decision mochiforge made for
// issues and pull requests, for the same reason: the shape is the storage's
// business, not the caller's, and one implementation cannot drift into three.
//
// Each message is one file, `messages/<n>.md`, markdown with a YAML
// frontmatter header carrying the author, timestamps, reactions, and attached
// file names. The body is the message. A deleted message becomes a tombstone
// (deleted: true, empty body) rather than a missing number, so a thread hung
// off it keeps its anchor and history keeps its shape.
//
// Number allocation is exclusive-create, exactly as discussion.ts allocates
// comment ids: whoever creates the file owns the number, the filesystem
// decides that, and a racing writer moves to the next one.

export const MAX_MESSAGE = 16 * 1024;

/**
 * The most one message's attachments may come to, together. The server holds
 * a whole upload in memory while it arrives, so this bounds what one send can
 * cost a small machine, and it caps any single file at the same size.
 */
export const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
/**
 * How many files one message may carry. The byte cap alone would let a
 * message hold hundreds of thousands of tiny files, every one of them named in
 * its frontmatter and so read back on every view of the room.
 */
export const MAX_ATTACHMENTS = 50;
/**
 * The longest an attachment's name may be, in bytes of UTF-8: under the 255
 * that Linux and most filesystems allow a file name, with room for the "2-"
 * that tells two files of one name apart.
 */
export const MAX_FILE_NAME_BYTES = 200;

/**
 * How far back a send's nonce is looked for among its author's messages. A
 * retry arrives within seconds of the attempt it repeats, so a short look
 * back finds it, and a nonce that is not found is simply a new message.
 */
const NONCE_LOOKBACK = 50;

/** What a client may send as a nonce: an opaque id of its own making. */
export function isValidNonce(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
}
export const MAX_REACTION = 32;
/**
 * How many different reactions one message may gather, as Slack allows
 * fifty. Each is kept in the message's frontmatter and drawn on every view of
 * the room, so without a bound one person could hang thousands on a message.
 * Joining a reaction already there is always possible.
 */
export const MAX_REACTIONS = 50;
/** How many of a room's newest messages its page shows, and a thread's page its replies. */
export const ROOM_PAGE = 100;
export const THREAD_PAGE = 200;

export interface Attachment {
  name: string;
  size: number;
}

/**
 * A call, as the timeline keeps it: the message that says a call started is
 * the call's entry, and it is rewritten as people join and when it ends, so
 * the history says who was in it and for how long.
 */
export interface CallRecord {
  id: string;
  /** Everyone who was in it at some point, in the order they joined. */
  people: string[];
  ended?: string;
}

export interface Message {
  id: number;
  author: string;
  created: string;
  edited?: string;
  deleted?: boolean;
  body: string;
  /** Emoji -> the users who reacted with it, in the order they did. */
  reactions: Record<string, string[]>;
  files: Attachment[];
  /** Replies in this message's thread; 0 when it has none. */
  replyCount: number;
  /** Set on the message a call started with. */
  call?: CallRecord;
}

export function messagesDir(room: string): string {
  return path.join(room, 'messages');
}

/** The room a message's thread is: a directory holding its own messages/. */
export function threadRoomDir(room: string, id: number): string {
  return path.join(room, 'threads', String(id));
}

/** Where a message's uploads live: <room>/files/<id>/<name>. */
export function filesDir(room: string, id: number): string {
  return path.join(room, 'files', String(id));
}

function messageFile(room: string, id: number): string {
  return path.join(messagesDir(room), `${id}.md`);
}

/**
 * A room's message ids, oldest first, as its directory lists them. Listing
 * and sorting a room of twenty thousand messages takes some milliseconds, and
 * one send asks several times (and once more for each person with the room
 * open), so the list is kept per directory and listed again only when the
 * directory's modification time moves, which creating or removing a file in
 * it does.
 *
 * This process's own creations and removals forget the list outright (see
 * forgetIds), which is what keeps it right for every message the workspace
 * writes. The modification time is for what arrives some other way, a file
 * written by hand or restored from a backup; and file times are coarse (a
 * few milliseconds on Linux), so a file created just after a listing can
 * leave the time where it was. A list made within RACY_MS of the directory's
 * last change is therefore trusted for RACY_MS and then made again, the way
 * git treats an index entry as racy, so such a file shows within that long.
 * Callers must not modify the array they are given.
 */
const idCache = new Map<string, { mtimeMs: number; listedAt: number; ids: number[] }>();
const RACY_MS = 2000;

function messageIds(room: string): number[] {
  const dir = messagesDir(room);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    idCache.delete(dir);
    return [];
  }
  const hit = idCache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs && (hit.listedAt - mtimeMs >= RACY_MS || Date.now() - hit.listedAt < RACY_MS)) return hit.ids;
  const listedAt = Date.now();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ids = files
    .filter((f) => /^[1-9][0-9]*\.md$/.test(f))
    .map((f) => parseInt(f, 10))
    .sort((a, b) => a - b);
  idCache.set(dir, { mtimeMs, listedAt, ids });
  return ids;
}

function forgetIds(room: string): void {
  idCache.delete(messagesDir(room));
}

/**
 * A message's reactions, each the people who gave it. Built through a Map and
 * Object.fromEntries, which define keys rather than assign them, so that a
 * reaction spelled __proto__ is a key like any other instead of reaching the
 * object's prototype.
 */
function parseReactions(v: unknown): Record<string, string[]> {
  return Object.fromEntries(reactionMap(v));
}

function reactionMap(v: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (typeof v !== 'object' || v === null) return out;
  for (const [emoji, users] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(users)) {
      const names = users.filter((u): u is string => typeof u === 'string');
      if (names.length) out.set(emoji, names);
    }
  }
  return out;
}

function parseCall(v: unknown): CallRecord | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const rec = v as Record<string, unknown>;
  if (typeof rec.id !== 'string') return undefined;
  const people = Array.isArray(rec.people) ? rec.people.filter((p): p is string => typeof p === 'string') : [];
  return { id: rec.id, people, ...(typeof rec.ended === 'string' ? { ended: rec.ended } : {}) };
}

function parseFiles(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  const out: Attachment[] = [];
  for (const f of v) {
    if (typeof f === 'object' && f !== null && typeof (f as Record<string, unknown>).name === 'string') {
      const rec = f as Record<string, unknown>;
      out.push({ name: rec.name as string, size: typeof rec.size === 'number' ? rec.size : 0 });
    }
  }
  return out;
}

export function replyCount(room: string, id: number): number {
  return messageIds(threadRoomDir(room, id)).length;
}

export function readMessage(room: string, id: number): Message | null {
  if (!Number.isInteger(id) || id < 1) return null;
  const doc = readDoc(messageFile(room, id));
  if (!doc) return null;
  return {
    id,
    author: str(doc.meta.author, 'unknown'),
    created: str(doc.meta.created),
    ...(str(doc.meta.edited) ? { edited: str(doc.meta.edited) } : {}),
    ...(doc.meta.deleted === true ? { deleted: true } : {}),
    // writeDoc ends the file with one newline; it is the file's, not the message's.
    body: doc.meta.deleted === true ? '' : doc.body.replace(/\n$/, ''),
    reactions: parseReactions(doc.meta.reactions),
    files: parseFiles(doc.meta.files),
    replyCount: replyCount(room, id),
    ...(doc.meta.deleted !== true && parseCall(doc.meta.call) ? { call: parseCall(doc.meta.call) } : {}),
  };
}

/**
 * Messages in the room, oldest first. `before` reads the page ending just
 * short of that id (for older history); `after` reads everything newer (which
 * is how a reconnecting event stream catches up).
 */
export function readMessages(
  room: string,
  opts: { limit?: number; before?: number; after?: number } = {}
): Message[] {
  let ids = messageIds(room);
  if (opts.before !== undefined) ids = ids.filter((n) => n < opts.before!);
  if (opts.after !== undefined) ids = ids.filter((n) => n > opts.after!);
  const limit = opts.limit ?? 50;
  if (ids.length > limit) ids = ids.slice(ids.length - limit);
  const out: Message[] = [];
  for (const id of ids) {
    const m = readMessage(room, id);
    if (m) out.push(m);
  }
  return out;
}

/** How many messages came after this one. */
export function countAfter(room: string, after: number): number {
  return messageIds(room).filter((n) => n > after).length;
}

/**
 * Among the newest `limit` messages up to `upTo`, those changed after
 * `sinceMs`: edited, reacted to, deleted, pinned, or replied to (a reply
 * changes its thread's directory, not the message's own file). What a page
 * that lost its stream for a while needs repainted, beside what is new.
 */
export function changedSince(room: string, upTo: number, sinceMs: number, limit = 200): Message[] {
  const out: Message[] = [];
  for (const id of messageIds(room).filter((n) => n <= upTo).slice(-limit)) {
    let changed = 0;
    for (const f of [messageFile(room, id), messagesDir(threadRoomDir(room, id))]) {
      try {
        changed = Math.max(changed, fs.statSync(f).mtimeMs);
      } catch {
        // No thread, or a file gone since the listing.
      }
    }
    if (changed <= sinceMs) continue;
    const m = readMessage(room, id);
    if (m) out.push(m);
  }
  return out;
}

/** The id of the newest message, or 0 in an empty room. */
export function lastMessageId(room: string): number {
  const ids = messageIds(room);
  return ids.length ? ids[ids.length - 1] : 0;
}

export function checkBody(body: string): string {
  const b = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (b.length > MAX_MESSAGE) throw new OpError(`A message may be at most ${MAX_MESSAGE} characters.`);
  return b;
}

/**
 * The message this author already sent with this nonce, if there is one. A
 * client sends the same nonce again when it retries a send whose outcome it
 * could not see (the upload arrived, the answer was lost), and that retry has
 * to find the first message rather than post a second.
 */
export function findByNonce(room: string, author: string, nonce: string): Message | null {
  const ids = messageIds(room).slice(-NONCE_LOOKBACK).reverse();
  for (const id of ids) {
    const doc = readDoc(messageFile(room, id));
    if (doc && doc.meta.nonce === nonce && doc.meta.author === author) return readMessage(room, id);
  }
  return null;
}

export function addMessage(
  room: string,
  input: { author: string; body: string; files?: Attachment[]; nonce?: string; call?: CallRecord }
): Message {
  const body = checkBody(input.body);
  if (body.trim() === '' && !(input.files ?? []).length) {
    throw new OpError('A message needs something in it.');
  }
  if ((input.files ?? []).length > MAX_ATTACHMENTS) {
    throw new OpError(`A message may carry at most ${MAX_ATTACHMENTS} files.`);
  }
  const total = (input.files ?? []).reduce((n, f) => n + f.size, 0);
  if (total > MAX_ATTACHMENTS_BYTES) {
    throw new OpError(`Attachments may come to at most ${MAX_ATTACHMENTS_BYTES / (1024 * 1024)} MB per message.`);
  }
  const dir = messagesDir(room);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  let id = lastMessageId(room) + 1;
  for (let attempt = 0; attempt < 50; attempt++, id++) {
    const file = path.join(dir, `${id}.md`);
    // Exclusive create is the allocation; see the header comment.
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
    } catch {
      continue;
    } finally {
      forgetIds(room);
    }
    const meta: Record<string, unknown> = { author: input.author, created: now };
    if (input.files?.length) meta.files = input.files;
    if (input.nonce) meta.nonce = input.nonce;
    if (input.call) meta.call = input.call;
    writeDoc(file, meta, body);
    return {
      id,
      author: input.author,
      created: now,
      body,
      reactions: {},
      files: input.files ?? [],
      replyCount: 0,
      ...(input.call ? { call: input.call } : {}),
    };
  }
  throw new OpError('Could not allocate a message number; try again.', 'conflict');
}

/**
 * Take back a message nobody has been told about yet, with any of its files
 * already written: what a send does when writing its attachments fails, so
 * that it leaves no message naming files that are not there. The number is
 * free again, which is harmless, since nothing has linked to it.
 */
export function unsendMessage(room: string, id: number): void {
  fs.rmSync(filesDir(room, id), { recursive: true, force: true });
  fs.rmSync(messageFile(room, id), { force: true });
  forgetIds(room);
}

/**
 * Rewrite one message's file under a lock. Reactions arrive concurrently from
 * different people, and two read-modify-writes without the lock would keep
 * one reaction and silently drop the other.
 */
function editMessageFile(room: string, id: number, fn: (meta: Record<string, unknown>, body: string) => { meta: Record<string, unknown>; body: string }): Message {
  const file = messageFile(room, id);
  return withFileLock(`${file}.lock`, () => {
    const doc = readDoc(file);
    if (!doc) throw new OpError(`Message ${id} does not exist.`, 'notfound');
    const next = fn(doc.meta, doc.body);
    writeDoc(file, next.meta, next.body);
    const m = readMessage(room, id);
    if (!m) throw new OpError(`Message ${id} does not exist.`, 'notfound');
    return m;
  });
}

export function editMessage(room: string, id: number, body: string): Message {
  const b = checkBody(body);
  if (b.trim() === '') throw new OpError('A message needs something in it.');
  return editMessageFile(room, id, (meta) => {
    if (meta.deleted === true) throw new OpError('This message was deleted.', 'nochange');
    return { meta: { ...meta, edited: new Date().toISOString() }, body: b };
  });
}

/**
 * Delete a message: the file becomes a tombstone rather than disappearing, so
 * the number stays allocated and a thread hung off it keeps its anchor. The
 * uploads attached to it are removed outright, since a deleted message's
 * files should stop being served.
 */
export function deleteMessage(room: string, id: number): Message {
  const m = editMessageFile(room, id, (meta) => ({
    meta: { author: meta.author, created: meta.created, deleted: true },
    body: '',
  }));
  fs.rmSync(filesDir(room, id), { recursive: true, force: true });
  return m;
}

/**
 * Rewrite the call a message records. Returns null when the message is gone
 * or deleted, or was not a call's: a deleted entry stays deleted, and the
 * call goes on without one.
 */
export function updateCallRecord(room: string, id: number, fn: (call: CallRecord) => CallRecord): Message | null {
  const current = readMessage(room, id);
  if (!current || current.deleted || !current.call) return null;
  try {
    return editMessageFile(room, id, (meta, body) => {
      const call = parseCall(meta.call);
      if (meta.deleted === true || !call) throw new OpError('This message was deleted.', 'nochange');
      return { meta: { ...meta, call: fn(call) }, body };
    });
  } catch (e) {
    if (e instanceof OpError) return null;
    throw e;
  }
}

/** Toggle one user's reaction. Adding an existing one removes it, as in Slack. */
// The emoji shortcodes messages understand (:tada:), for a reaction written
// as one: the same table, through a parser that does nothing else.
const SHORTCODES = new MarkdownIt('zero').use(emojiPlugin);

/**
 * A reaction as it is kept: the emoji itself, with a shortcode such as
 * :tada: turned into the emoji it names, so that the menu's 🎉 and a typed
 * :tada: are one reaction. A shortcode that names no emoji is refused rather
 * than kept as text.
 */
export function reactionEmoji(input: string): string {
  const e = input.trim();
  if (!/^:[A-Za-z0-9_+-]+:$/.test(e)) return e;
  const out = SHORTCODES.renderInline(e);
  if (out === e) throw new OpError(`No emoji is called ${e}.`);
  return out;
}

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Whether a string is one emoji: a single grapheme, made only of what emoji
 * are made of (pictographs, and the joiners, selectors, skin tones, keycaps,
 * and flag letters that combine with them), with at least one pictograph,
 * flag letter, or keycap in it, so that a bare digit or # is not one. A
 * reaction is a mark of assent, not a second channel for words.
 */
export function isOneEmoji(e: string): boolean {
  if (!/^[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u.test(e)) return false;
  if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(e)) return false;
  // Flag letters come in pairs; one alone is a letter in a box.
  if ((e.match(/\p{Regional_Indicator}/gu)?.length ?? 0) % 2 === 1) return false;
  let n = 0;
  for (const _ of GRAPHEMES.segment(e)) if (++n > 1) return false;
  return n === 1;
}

export function toggleReaction(room: string, id: number, emoji: string, user: string): Message {
  const e = reactionEmoji(emoji);
  if (e.length > MAX_REACTION || !isOneEmoji(e)) {
    throw new OpError('A reaction is one emoji.');
  }
  return editMessageFile(room, id, (meta, body) => {
    if (meta.deleted === true) throw new OpError('This message was deleted.', 'nochange');
    const reactions = reactionMap(meta.reactions);
    if (!reactions.has(e) && reactions.size >= MAX_REACTIONS) {
      throw new OpError(`A message may have at most ${MAX_REACTIONS} different reactions; add one of those it has.`);
    }
    const users = reactions.get(e) ?? [];
    const next = users.includes(user) ? users.filter((u) => u !== user) : [...users, user];
    if (next.length) reactions.set(e, next);
    else reactions.delete(e);
    const out = { ...meta };
    if (reactions.size) out.reactions = Object.fromEntries(reactions);
    else delete out.reactions;
    return { meta: out, body };
  });
}
