import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from '../../mochiforge/src/atomic';
import { fileCache } from '../../mochiforge/src/filecache';
import { OpError } from '../../mochiforge/src/ops';
import { dmDir, dmsDir } from './workspace';

// Direct conversations: numbered directories under dms/, each holding a
// conversation.json naming its participants and the same messages/ threads/
// files/ layout a channel has. A conversation is visible to its participants
// and to nobody else, the site admin included. A conversation of one is a
// person's notes to themselves, as Slack has them: the same room, between
// nobody else.
//
// Numbered directories rather than participant-named ones, because usernames
// may contain any separator we might pick; finding the conversation for a set
// of people is a scan, which is the read-the-disk bargain everything else
// here makes too.

export const CONVERSATION_FILE = 'conversation.json';
export const MAX_PARTICIPANTS = 9;

export interface DmInfo {
  id: number;
  /** Who can read and write it now. */
  participants: string[];
  /**
   * Who was in it and has since been removed from the workspace. They still
   * name the conversation and its messages, but no longer see it, so a new
   * person given a removed person's name does not inherit what was theirs.
   */
  former?: string[];
  created?: string;
}

/** Everyone a conversation is between, for naming it: its participants and its former ones. */
export function dmPeople(dm: DmInfo): string[] {
  return [...dm.participants, ...(dm.former ?? [])];
}

function conversationFile(root: string, id: number): string {
  return path.join(dmDir(root, id), CONVERSATION_FILE);
}

export function readDm(root: string, id: number): DmInfo | null {
  if (!Number.isInteger(id) || id < 1) return null;
  const dm = dmCache.get(conversationFile(root, id));
  return dm && { ...dm, id };
}

/**
 * Every page's sidebar lists the viewer's conversations, which is a read of
 * every conversation.json in the workspace; kept parsed, and read again only
 * when a file's stat changes (the forge's file cache). The id is filled in
 * by readDm, since it is the directory's name rather than the file's content.
 */
const dmCache = fileCache<DmInfo | null>({
  read: (file) => {
    try {
      return parseDm(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  },
  missing: () => null,
});

function parseDm(text: string): DmInfo | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const names = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
    const participants = names(parsed.participants);
    const former = names(parsed.former).filter((p) => !participants.includes(p));
    if (participants.length < 1) return null;
    return {
      id: 0,
      participants: [...participants].sort(),
      ...(former.length ? { former: [...former].sort() } : {}),
      ...(typeof parsed.created === 'string' ? { created: parsed.created } : {}),
    };
  } catch {
    return null;
  }
}

function dmIds(root: string): number[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dmsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^[1-9][0-9]*$/.test(e.name))
    .map((e) => parseInt(e.name, 10))
    .sort((a, b) => a - b);
}

/** Every conversation this user is in. */
export function listDmsFor(root: string, user: string): DmInfo[] {
  const out: DmInfo[] = [];
  for (const id of dmIds(root)) {
    const dm = readDm(root, id);
    if (dm && dm.participants.includes(user)) out.push(dm);
  }
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The conversation among exactly these people, created if it does not exist.
 * One conversation per set of participants, found by scanning; the window in
 * which two people simultaneously start the same conversation and get two is
 * real but harmless, since both work and both are listed. `charge` is called
 * only when a conversation is to be made, so opening one that exists costs
 * its opener nothing against their limits.
 */
export function openDm(root: string, participants: string[], opts: { charge?: () => void } = {}): DmInfo {
  const set = [...new Set(participants)].sort();
  if (set.length < 1) throw new OpError('A conversation needs someone in it.');
  if (set.length > MAX_PARTICIPANTS) {
    throw new OpError(`A conversation holds at most ${MAX_PARTICIPANTS} people; a channel holds everyone.`);
  }
  // A conversation someone has been removed from is not reused: its history
  // was among more people than the ones now asking for it.
  for (const id of dmIds(root)) {
    const dm = readDm(root, id);
    if (dm && !dm.former && sameSet(dm.participants, set)) return dm;
  }
  opts.charge?.();
  fs.mkdirSync(dmsDir(root), { recursive: true });
  let id = (dmIds(root).pop() ?? 0) + 1;
  for (let attempt = 0; attempt < 50; attempt++, id++) {
    const dir = dmDir(root, id);
    // mkdir is the allocation, as everywhere else numbers are handed out.
    try {
      fs.mkdirSync(dir);
    } catch {
      continue;
    }
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    const info: DmInfo = { id, participants: set, created: new Date().toISOString() };
    writeFileAtomic(
      conversationFile(root, id),
      JSON.stringify({ participants: set, created: info.created }, null, 2) + '\n',
      { mode: 0o600 }
    );
    return info;
  }
  throw new OpError('Could not allocate a conversation; try again.', 'conflict');
}

/** Whether a conversation is one person's notes to themselves. */
export function isSelfDm(dm: DmInfo): boolean {
  return dmPeople(dm).length === 1;
}

/** How a conversation is titled for one of its participants: the other people, or themselves marked as such. */
export function dmTitle(dm: DmInfo, viewer: string): string {
  const others = dmPeople(dm).filter((p) => p !== viewer);
  return others.length ? others.join(', ') : `${viewer} (you)`;
}

/**
 * Take a person removed from the workspace out of every conversation they
 * were in, keeping their name as a former participant. Each file is
 * rewritten under its own lock, as every other edit to shared state is.
 */
export function leaveAllDms(root: string, user: string): void {
  for (const id of dmIds(root)) {
    const file = conversationFile(root, id);
    withFileLock(`${file}.lock`, () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      const participants = Array.isArray(parsed.participants) ? parsed.participants : [];
      if (!participants.includes(user)) return;
      const former = Array.isArray(parsed.former) ? parsed.former : [];
      const next = {
        ...parsed,
        participants: participants.filter((p) => p !== user),
        former: [...new Set([...former, user])],
      };
      writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      dmCache.invalidate(file);
    });
  }
}
