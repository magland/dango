import { AuthResult } from '../../mochiforge/src/vault';
import { listChannels } from './channels';
import { dmTitle, listDmsFor } from './dms';
import { Message, ROOM_PAGE, THREAD_PAGE, lastMessageId, readMessage, readMessages, threadRoomDir } from './messages';
import { canSeeChannel } from './perms';
import { channelDir, dmDir } from './workspace';

// Search is a walk over the files, the way mochiforge's repository search is
// a git grep: the messages are already on disk in a shape made for reading,
// so the index is the directory tree and the query runs when it is asked.
// Case-insensitive substring match, newest first, capped. On a workspace
// whose history outgrows this there is room for an index later; the walk is
// the version whose answers are trivially correct.
//
// A query can be narrowed, the way Slack's can: from:alice keeps what alice
// wrote, and in:#general (or in:general) keeps one channel, or in:alice the
// conversations alice is in. What is left of the query is the text to find,
// and a query of filters alone lists everything they allow.

export interface SearchHit {
  /**
   * The message on the page it is read on: the room, or the thread it sits
   * in, at #msg-<id>. A message older than the newest ROOM_PAGE of its room
   * is not on the room's page, so it is linked as the head of its thread,
   * where it is shown whatever its age.
   */
  url: string;
  /** That page alone. */
  room: string;
  /** How that place is named for this viewer: "#general", "alice, bob". */
  where: string;
  /** Whether it was said in a channel or a direct conversation. */
  kind: 'channel' | 'dm';
  message: Message;
}

export const MAX_HITS = 100;
export const SCAN_LIMIT = 5000;

export interface SearchQuery {
  /** The text to find, lowercased; empty when the query is filters alone. */
  text: string;
  /** from:name, the author, without an @. */
  from?: string;
  /** in:name, a channel's name without its #, or a person a conversation is with. */
  in?: string;
}

export function parseQuery(query: string): SearchQuery {
  const out: SearchQuery = { text: '' };
  const words: string[] = [];
  for (const word of query.trim().split(/\s+/)) {
    const f = /^from:@?(.+)$/i.exec(word);
    const i = /^in:#?(.+)$/i.exec(word);
    if (f) out.from = f[1];
    else if (i) out.in = i[1].toLowerCase();
    else if (word) words.push(word);
  }
  out.text = words.join(' ').toLowerCase();
  return out;
}

function matches(m: Message, q: SearchQuery): boolean {
  if (m.deleted) return false;
  if (q.from !== undefined && m.author.toLowerCase() !== q.from.toLowerCase()) return false;
  return q.text === '' || m.body.toLowerCase().includes(q.text);
}

function scanRoom(
  dir: string,
  url: string,
  where: string,
  kind: SearchHit['kind'],
  needle: SearchQuery,
  out: SearchHit[],
  withThreads: boolean,
  info: SearchInfo
): void {
  const last = lastMessageId(dir);
  if (last > SCAN_LIMIT) info.partial = true;
  const messages = readMessages(dir, { limit: SCAN_LIMIT });
  for (const m of messages) {
    if (matches(m, needle)) {
      const shown = m.id > last - ROOM_PAGE;
      out.push({ url: shown ? `${url}#msg-${m.id}` : `${url}/t/${m.id}`, room: url, where, kind, message: m });
    }
    if (withThreads && m.replyCount > 0) {
      const tdir = threadRoomDir(dir, m.id);
      const replies = lastMessageId(tdir);
      if (replies > SCAN_LIMIT) info.partial = true;
      if (replies > 0) {
        for (const r of readMessages(tdir, { limit: SCAN_LIMIT })) {
          if (matches(r, needle)) {
            const thread = `${url}/t/${m.id}`;
            out.push({ url: r.id > replies - THREAD_PAGE ? `${thread}#msg-${r.id}` : thread, room: thread, where: `${where} (thread)`, kind, message: r });
          }
        }
      }
    }
  }
}

/**
 * What a search says about itself beside its hits: whether some room was
 * longer than the walk reads (SCAN_LIMIT), so that its older messages were
 * not searched. The page says so rather than letting "nothing matched" stand
 * for "nothing in what was read matched".
 */
export interface SearchInfo {
  partial: boolean;
}

export function searchMessages(root: string, auth: AuthResult, query: string, info: SearchInfo = { partial: false }): SearchHit[] {
  const needle = parseQuery(query);
  if (needle.text === '' && needle.from === undefined && needle.in === undefined) return [];
  const out: SearchHit[] = [];
  for (const c of listChannels(root)) {
    if (!canSeeChannel(auth, c)) continue;
    if (needle.in !== undefined && c.name !== needle.in) continue;
    scanRoom(channelDir(root, c.name), `/c/${encodeURIComponent(c.name)}`, `#${c.name}`, 'channel', needle, out, true, info);
    keepNewest(out);
  }
  for (const dm of listDmsFor(root, auth.username)) {
    if (needle.in !== undefined && !dm.participants.some((p) => p !== auth.username && p.toLowerCase() === needle.in)) continue;
    scanRoom(dmDir(root, dm.id), `/d/${dm.id}`, dmTitle(dm, auth.username), 'dm', needle, out, true, info);
    keepNewest(out);
  }
  return out;
}

/**
 * Cut the hits so far to the newest MAX_HITS, after each room, so that what
 * a broad query holds is one room's matches and a hundred, not every match
 * in the workspace until the end.
 */
function keepNewest(out: SearchHit[]): void {
  out.sort((a, b) => b.message.created.localeCompare(a.message.created));
  out.length = Math.min(out.length, MAX_HITS);
}

/** For completeness with readMessage's shape elsewhere. */
export function findMessage(dir: string, id: number): Message | null {
  return readMessage(dir, id);
}
