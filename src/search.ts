import { AuthResult } from '../../mochiforge/src/vault';
import { listChannels } from './channels';
import { dmTitle, listDmsFor } from './dms';
import { Message, lastMessageId, readMessage, readMessages, threadRoomDir } from './messages';
import { canSeeChannel } from './perms';
import { channelDir, dmDir } from './workspace';

// Search is a walk over the files, the way mochiforge's repository search is
// a git grep: the messages are already on disk in a shape made for reading,
// so the index is the directory tree and the query runs when it is asked.
// Case-insensitive substring match, newest first, capped. On a workspace
// whose history outgrows this there is room for an index later; the walk is
// the version whose answers are trivially correct.

export interface SearchHit {
  /** The page the hit is read on: the room, or the thread it sits in. */
  url: string;
  /** How that place is named for this viewer: "#general", "alice, bob". */
  where: string;
  message: Message;
}

const MAX_HITS = 100;
const SCAN_LIMIT = 5000;

function matches(m: Message, needle: string): boolean {
  return !m.deleted && m.body.toLowerCase().includes(needle);
}

function scanRoom(
  dir: string,
  url: string,
  where: string,
  needle: string,
  out: SearchHit[],
  withThreads: boolean
): void {
  const messages = readMessages(dir, { limit: SCAN_LIMIT });
  for (const m of messages) {
    if (matches(m, needle)) out.push({ url: `${url}#msg-${m.id}`, where, message: m });
    if (withThreads && m.replyCount > 0) {
      const tdir = threadRoomDir(dir, m.id);
      if (lastMessageId(tdir) > 0) {
        for (const r of readMessages(tdir, { limit: SCAN_LIMIT })) {
          if (matches(r, needle)) {
            out.push({ url: `${url}/t/${m.id}#msg-${r.id}`, where: `${where} (thread)`, message: r });
          }
        }
      }
    }
  }
}

export function searchMessages(root: string, auth: AuthResult, query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const out: SearchHit[] = [];
  for (const c of listChannels(root)) {
    if (!canSeeChannel(auth, c)) continue;
    scanRoom(channelDir(root, c.name), `/c/${encodeURIComponent(c.name)}`, `#${c.name}`, needle, out, true);
  }
  for (const dm of listDmsFor(root, auth.username)) {
    scanRoom(dmDir(root, dm.id), `/d/${dm.id}`, dmTitle(dm, auth.username), needle, out, true);
  }
  out.sort((a, b) => b.message.created.localeCompare(a.message.created));
  return out.slice(0, MAX_HITS);
}

/** For completeness with readMessage's shape elsewhere. */
export function findMessage(dir: string, id: number): Message | null {
  return readMessage(dir, id);
}
