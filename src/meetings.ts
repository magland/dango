import { createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from '../../mochiforge/src/atomic';
import { fileCache } from '../../mochiforge/src/filecache';
import { OpError } from '../../mochiforge/src/ops';
import { getSecret } from '../../mochiforge/src/session';
import { isGuestName, meetingDir, meetingsDir } from './workspace';

// Meetings: rooms made around a call, for calls with people outside the
// workspace. A meeting is a numbered directory under meetings/, holding a
// meeting.json beside the same messages/ threads/ files/ a channel has, so
// that everything a room does (the timeline, the call and its entry, threads,
// reactions, search) a meeting does too.
//
// Its members are workspace members, listed by name, and it is visible to
// them and to nobody else, the site admin included, as a private channel is.
// What a meeting adds is a guest link. Whoever opens it gives a name and asks
// to be let in (or, where the meeting says so, comes straight in), and a
// guest who is let in can take part in the meeting's call and read and write
// its timeline, and reach nothing else in the workspace. A guest is not a
// user: they have no entry in workspace.json and no directory under users/,
// only a signed cookie naming them and this meeting (see src/guests.ts) and
// a line in this file giving the name they chose.
//
// The link is a key made from the workspace's .secret, the meeting's number,
// and the link's generation, so it is never stored and can be shown again
// whenever a member wants to copy it. Resetting the link moves the generation
// on: the old link stops working, and so does every guest let in under it.

export const MEETING_FILE = 'meeting.json';
export const MAX_TITLE = 120;
/** The longest name a guest may give; it is shown on tiles and beside messages. */
export const MAX_GUEST_NAME = 40;
/**
 * How many guests one meeting keeps. Each is a line in meeting.json, kept so
 * that what they wrote still says who wrote it after they have gone, and
 * without a bound anyone holding a link that lets guests straight in could
 * make the file grow without end.
 */
export const MAX_GUESTS = 500;

export interface GuestRecord {
  name: string;
  /** When they were let in. */
  since: string;
  /** The link generation they were let in under; an earlier one no longer admits. */
  gen: number;
  /** Set when a member took them out of the meeting. */
  removed?: true;
}

export interface MeetingInfo {
  id: number;
  title: string;
  /** The workspace members who can see it. */
  members: string[];
  /** Members since removed from the workspace, kept for naming, as a conversation keeps them. */
  former?: string[];
  createdBy: string;
  created?: string;
  /** Whether a guest waits for a member to let them in (the default), or enters on the link alone. */
  lobby: boolean;
  /** The guest link's generation, moved on when the link is reset. */
  gen: number;
  /** Everyone let in as a guest, by the name they go by inside the workspace (see isGuestName). */
  guests: Record<string, GuestRecord>;
}

function meetingFile(root: string, id: number): string {
  return path.join(meetingDir(root, id), MEETING_FILE);
}

function names(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && !isGuestName(p)) : [];
}

function parseGuests(v: unknown): Record<string, GuestRecord> {
  const out = new Map<string, GuestRecord>();
  if (typeof v !== 'object' || v === null) return {};
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isGuestName(id) || typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.gen !== 'number') continue;
    out.set(id, { name: r.name, since: typeof r.since === 'string' ? r.since : '', gen: r.gen, ...(r.removed === true ? { removed: true as const } : {}) });
  }
  // Keys are guest names, which cannot be __proto__, and fromEntries defines
  // rather than assigns in any case.
  return Object.fromEntries(out);
}

function parseMeeting(text: string): MeetingInfo | null {
  try {
    const rec = JSON.parse(text) as Record<string, unknown>;
    const members = names(rec.members);
    const former = names(rec.former).filter((p) => !members.includes(p));
    if (typeof rec.title !== 'string' || (members.length === 0 && former.length === 0)) return null;
    return {
      id: 0,
      title: rec.title,
      members,
      ...(former.length ? { former } : {}),
      createdBy: typeof rec.createdBy === 'string' ? rec.createdBy : '',
      ...(typeof rec.created === 'string' ? { created: rec.created } : {}),
      lobby: rec.lobby !== false,
      gen: typeof rec.gen === 'number' && Number.isInteger(rec.gen) && rec.gen >= 0 ? rec.gen : 0,
      guests: parseGuests(rec.guests),
    };
  } catch {
    return null;
  }
}

/**
 * Every page's sidebar lists the viewer's meetings, and every request of a
 * guest's reads their meeting, so the files are kept parsed and read again
 * only when their stat changes, as conversations are.
 */
const meetingCache = fileCache<MeetingInfo | null>({
  read: (file) => {
    try {
      return parseMeeting(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  },
  missing: () => null,
});

export function readMeeting(root: string, id: number): MeetingInfo | null {
  if (!Number.isInteger(id) || id < 1) return null;
  const m = meetingCache.get(meetingFile(root, id));
  return m && { ...m, id };
}

function meetingIds(root: string): number[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(meetingsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^[1-9][0-9]*$/.test(e.name))
    .map((e) => parseInt(e.name, 10))
    .sort((a, b) => a - b);
}

/** Every meeting this member is in. */
export function listMeetingsFor(root: string, user: string): MeetingInfo[] {
  const out: MeetingInfo[] = [];
  for (const id of meetingIds(root)) {
    const m = readMeeting(root, id);
    if (m && m.members.includes(user)) out.push(m);
  }
  return out;
}

/** A title as it is kept: one line, its spaces collapsed. */
export function cleanTitle(raw: string): string {
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === '') throw new OpError('A meeting needs a title.');
  if (t.length > MAX_TITLE) throw new OpError(`A meeting's title may be at most ${MAX_TITLE} characters.`);
  return t;
}

/** The name a guest gave, as it is kept, or null when it cannot be one. */
export function cleanGuestName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return n !== '' && n.length <= MAX_GUEST_NAME ? n : null;
}

function writeMeeting(root: string, info: MeetingInfo): void {
  const { id, ...rest } = info;
  writeFileAtomic(meetingFile(root, id), JSON.stringify(rest, null, 2) + '\n', { mode: 0o600 });
  meetingCache.invalidate(meetingFile(root, id));
}

/**
 * Make a meeting. `charge` is called before anything is written, so a
 * refusal by the limits makes nothing, as with channels and conversations.
 */
export function createMeeting(
  root: string,
  opts: { title: string; createdBy: string; members?: string[]; lobby?: boolean; charge?: () => void }
): MeetingInfo {
  const title = cleanTitle(opts.title);
  const members = [...new Set([opts.createdBy, ...(opts.members ?? [])])].filter((u) => !isGuestName(u));
  opts.charge?.();
  fs.mkdirSync(meetingsDir(root), { recursive: true });
  let id = (meetingIds(root).pop() ?? 0) + 1;
  for (let attempt = 0; attempt < 50; attempt++, id++) {
    // mkdir is the allocation, as everywhere else numbers are handed out.
    try {
      fs.mkdirSync(meetingDir(root, id));
    } catch {
      continue;
    }
    fs.mkdirSync(path.join(meetingDir(root, id), 'messages'), { recursive: true });
    const info: MeetingInfo = {
      id,
      title,
      members,
      createdBy: opts.createdBy,
      created: new Date().toISOString(),
      lobby: opts.lobby !== false,
      gen: 0,
      guests: {},
    };
    writeMeeting(root, info);
    return info;
  }
  throw new OpError('Could not allocate a meeting; try again.', 'conflict');
}

/** Every edit to meeting.json is a read, a change, and a write, under one lock. */
function editMeeting(root: string, id: number, fn: (info: MeetingInfo) => void): MeetingInfo {
  return withFileLock(`${meetingFile(root, id)}.lock`, () => {
    let info: MeetingInfo | null = null;
    try {
      const parsed = parseMeeting(fs.readFileSync(meetingFile(root, id), 'utf8'));
      info = parsed && { ...parsed, id };
    } catch {
      info = null;
    }
    if (!info) throw new OpError('That meeting does not exist.', 'notfound');
    fn(info);
    writeMeeting(root, info);
    return info;
  });
}

export function setMeetingTitle(root: string, id: number, title: string): MeetingInfo {
  const t = cleanTitle(title);
  return editMeeting(root, id, (info) => {
    info.title = t;
  });
}

export function setLobby(root: string, id: number, lobby: boolean): MeetingInfo {
  return editMeeting(root, id, (info) => {
    info.lobby = lobby;
  });
}

export function addMeetingMember(root: string, id: number, user: string): MeetingInfo {
  if (isGuestName(user)) throw new OpError('Only a member of the workspace can be added to a meeting.');
  return editMeeting(root, id, (info) => {
    if (!info.members.includes(user)) info.members.push(user);
    if (info.former) info.former = info.former.filter((f) => f !== user);
  });
}

export function removeMeetingMember(root: string, id: number, user: string): MeetingInfo {
  return editMeeting(root, id, (info) => {
    if (info.members.length === 1 && info.members[0] === user) {
      throw new OpError('A meeting keeps its last member; delete the meeting instead.');
    }
    info.members = info.members.filter((m) => m !== user);
  });
}

/** A new guest link: the old one, and every guest let in under it, stop working. */
export function resetGuestLink(root: string, id: number): MeetingInfo {
  return editMeeting(root, id, (info) => {
    info.gen += 1;
  });
}

/** Let a guest in under the link's current generation, keeping the name they gave. */
export function admitGuest(root: string, id: number, guest: string, name: string): MeetingInfo {
  if (!isGuestName(guest)) throw new OpError('That is not a guest.');
  return editMeeting(root, id, (info) => {
    if (!info.guests[guest] && Object.keys(info.guests).length >= MAX_GUESTS) {
      throw new OpError(`This meeting has let in the most guests one meeting keeps (${MAX_GUESTS}). Make a new meeting for more.`, 'conflict');
    }
    info.guests = { ...info.guests, [guest]: { name, since: new Date().toISOString(), gen: info.gen } };
  });
}

/** Take a guest out of the meeting. Their name stays, beside what they wrote. */
export function removeGuest(root: string, id: number, guest: string): MeetingInfo {
  return editMeeting(root, id, (info) => {
    const g = info.guests[guest];
    if (!g) throw new OpError('That guest is not in this meeting.', 'notfound');
    info.guests = { ...info.guests, [guest]: { ...g, removed: true } };
  });
}

/** Whether a guest is in the meeting now: let in under the current link, and not taken out since. */
export function isCurrentGuest(meeting: MeetingInfo, guest: string): boolean {
  const g = isGuestName(guest) ? meeting.guests[guest] : undefined;
  return !!g && !g.removed && g.gen === meeting.gen;
}

/** The guests in the meeting now. */
export function currentGuests(meeting: MeetingInfo): string[] {
  return Object.keys(meeting.guests).filter((g) => isCurrentGuest(meeting, g));
}

/**
 * How a person in a meeting is named to others: a member by their username,
 * a guest by the name they gave, marked as a guest so that nobody takes a
 * guest who calls themselves "alice" for alice.
 */
export function personLabel(meeting: MeetingInfo | undefined, name: string): string {
  if (!isGuestName(name)) return name;
  const g = meeting?.guests[name];
  return `${g ? g.name : 'A guest'} (guest)`;
}

/**
 * Take a person removed from the workspace out of every meeting, keeping
 * their name as a former member. A meeting left with no members is seen by
 * nobody, and its guests can no longer be let in by anyone.
 */
export function leaveAllMeetings(root: string, user: string): void {
  for (const id of meetingIds(root)) {
    const m = readMeeting(root, id);
    if (!m || !m.members.includes(user)) continue;
    editMeeting(root, id, (info) => {
      info.members = info.members.filter((x) => x !== user);
      info.former = [...new Set([...(info.former ?? []), user])];
    });
  }
}

/** Remove a meeting and everything in it. The caller checks who may. */
export function deleteMeeting(root: string, id: number): void {
  if (!readMeeting(root, id)) throw new OpError('That meeting does not exist.', 'notfound');
  fs.rmSync(meetingDir(root, id), { recursive: true, force: true });
  meetingCache.invalidate(meetingFile(root, id));
}

/**
 * Who may delete a meeting: whoever made it, or, when they are no longer in
 * it, any member, so that a meeting does not outlive everyone's ability to
 * remove it.
 */
export function mayDeleteMeeting(meeting: MeetingInfo, user: string): boolean {
  if (!meeting.members.includes(user)) return false;
  return user === meeting.createdBy || !meeting.members.includes(meeting.createdBy);
}

/** The key in a meeting's guest link, for its current generation. */
export function guestKey(root: string, meeting: { id: number; gen: number }): string {
  return createHmac('sha256', getSecret(root)).update(`dango-meeting:${meeting.id}:${meeting.gen}`).digest('base64url').slice(0, 24);
}

export function guestKeyMatches(root: string, meeting: { id: number; gen: number }, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(guestKey(root, meeting));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The guest link, with its key in the fragment as an invite link carries its
 * token: a fragment is never sent to the server, so the key stays out of
 * access logs, proxies, and Referer headers.
 */
export function guestLink(root: string, origin: string, meeting: { id: number; gen: number }): string {
  return `${origin}/m/${meeting.id}/join#k=${guestKey(root, meeting)}`;
}
