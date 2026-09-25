import * as fs from 'fs';
import * as path from 'path';
import { withFileLock } from '../../mochiforge/src/atomic';
import { readDoc, str, writeDoc } from '../../mochiforge/src/discussion';
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

export interface Attachment {
  name: string;
  size: number;
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

function messageIds(room: string): number[] {
  let files: string[];
  try {
    files = fs.readdirSync(messagesDir(room));
  } catch {
    return [];
  }
  return files
    .filter((f) => /^[1-9][0-9]*\.md$/.test(f))
    .map((f) => parseInt(f, 10))
    .sort((a, b) => a - b);
}

function parseReactions(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof v !== 'object' || v === null) return out;
  for (const [emoji, users] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(users)) {
      const names = users.filter((u): u is string => typeof u === 'string');
      if (names.length) out[emoji] = names;
    }
  }
  return out;
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
  input: { author: string; body: string; files?: Attachment[]; nonce?: string }
): Message {
  const body = checkBody(input.body);
  if (body.trim() === '' && !(input.files ?? []).length) {
    throw new OpError('A message needs something in it.');
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
    }
    const meta: Record<string, unknown> = { author: input.author, created: now };
    if (input.files?.length) meta.files = input.files;
    if (input.nonce) meta.nonce = input.nonce;
    writeDoc(file, meta, body);
    return {
      id,
      author: input.author,
      created: now,
      body,
      reactions: {},
      files: input.files ?? [],
      replyCount: 0,
    };
  }
  throw new OpError('Could not allocate a message number; try again.', 'conflict');
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

/** Toggle one user's reaction. Adding an existing one removes it, as in Slack. */
export function toggleReaction(room: string, id: number, emoji: string, user: string): Message {
  const e = emoji.trim();
  if (e === '' || e.length > MAX_REACTION || /[\n\r]/.test(e)) {
    throw new OpError('That is not usable as a reaction.');
  }
  return editMessageFile(room, id, (meta, body) => {
    if (meta.deleted === true) throw new OpError('This message was deleted.', 'nochange');
    const reactions = parseReactions(meta.reactions);
    const users = reactions[e] ?? [];
    const next = users.includes(user) ? users.filter((u) => u !== user) : [...users, user];
    if (next.length) reactions[e] = next;
    else delete reactions[e];
    const out = { ...meta };
    if (Object.keys(reactions).length) out.reactions = reactions;
    else delete out.reactions;
    return { meta: out, body };
  });
}
