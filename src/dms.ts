import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../../mochiforge/src/atomic';
import { OpError } from '../../mochiforge/src/ops';
import { dmDir, dmsDir } from './workspace';

// Direct conversations: numbered directories under dms/, each holding a
// conversation.json naming its participants and the same messages/ threads/
// files/ layout a channel has. A conversation is visible to its participants
// and to nobody else, the site admin included.
//
// Numbered directories rather than participant-named ones, because usernames
// may contain any separator we might pick; finding the conversation for a set
// of people is a scan, which is the read-the-disk bargain everything else
// here makes too.

export const CONVERSATION_FILE = 'conversation.json';
export const MAX_PARTICIPANTS = 9;

export interface DmInfo {
  id: number;
  participants: string[];
  created?: string;
}

function conversationFile(root: string, id: number): string {
  return path.join(dmDir(root, id), CONVERSATION_FILE);
}

export function readDm(root: string, id: number): DmInfo | null {
  if (!Number.isInteger(id) || id < 1) return null;
  let text: string;
  try {
    text = fs.readFileSync(conversationFile(root, id), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const participants = Array.isArray(parsed.participants)
      ? parsed.participants.filter((p): p is string => typeof p === 'string')
      : [];
    if (participants.length < 2) return null;
    return {
      id,
      participants: [...participants].sort(),
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
 * real but harmless, since both work and both are listed.
 */
export function openDm(root: string, participants: string[]): DmInfo {
  const set = [...new Set(participants)].sort();
  if (set.length < 2) throw new OpError('A conversation needs someone besides you in it.');
  if (set.length > MAX_PARTICIPANTS) {
    throw new OpError(`A conversation holds at most ${MAX_PARTICIPANTS} people; a channel holds everyone.`);
  }
  for (const id of dmIds(root)) {
    const dm = readDm(root, id);
    if (dm && sameSet(dm.participants, set)) return dm;
  }
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

/** How a conversation is titled for one of its participants: the other people. */
export function dmTitle(dm: DmInfo, viewer: string): string {
  const others = dm.participants.filter((p) => p !== viewer);
  return others.length ? others.join(', ') : viewer;
}
