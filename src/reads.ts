import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from '../../mochiforge/src/atomic';
import { fileCache } from '../../mochiforge/src/filecache';
import { AuthResult } from '../../mochiforge/src/vault';
import { ChannelInfo, listChannels } from './channels';
import { DmInfo, dmTitle, listDmsFor } from './dms';
import { Message, readMessages } from './messages';
import { canSeeChannel } from './perms';
import { channelDir, dmDir, userDir } from './workspace';

// What each person has read, kept on the server so that every device agrees.
//
// One file per user, users/<name>/read.json, mapping a room to the id of the
// newest message they have seen there: viewing a room moves the marker to its
// newest message, and sending one moves it too. A room's unread count is
// then the messages after the marker, and the count is the same on a phone
// and a laptop because the marker is in the workspace rather than in either
// browser. It is a file like everything else: backed up with the rest, and
// readable with cat.
//
// Mentions are counted beside the plain count, since a message that names you
// is the one worth noticing first, and the sidebar marks a room differently
// when one is waiting.

export const READ_FILE = 'read.json';

/** A room's key in read.json: its URL without the leading slash. */
export function readKey(roomUrl: string): string {
  return roomUrl.replace(/^\//, '');
}

function readFile(root: string, username: string): string {
  return path.join(userDir(root, username), READ_FILE);
}

function normalize(parsed: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof parsed !== 'object' || parsed === null) return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

const cache = fileCache<Record<string, number>>({
  read: (file) => {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return {};
    }
  },
  missing: () => ({}),
});

export function readMarkers(root: string, username: string): Record<string, number> {
  return cache.get(readFile(root, username));
}

/**
 * Record that a user has seen a room up to a message. Only ever forward: a
 * page that renders an older slice of history must not unread what a newer
 * page already read.
 */
export function markRead(root: string, username: string, roomUrl: string, id: number): boolean {
  if (!Number.isInteger(id) || id < 1) return false;
  const file = readFile(root, username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    let markers: Record<string, number> = {};
    try {
      markers = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      markers = {};
    }
    const key = readKey(roomUrl);
    if ((markers[key] ?? 0) >= id) return false;
    markers[key] = id;
    writeFileAtomic(file, JSON.stringify(markers, null, 2) + '\n', { mode: 0o600 });
    return true;
  });
}

/** Whether a message body names a user, by the rule the markdown renderer links mentions with. */
export function mentionsUser(body: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w@.-])@${escaped}(?![\\w-])`, 'i').test(body);
}

export interface Unread {
  count: number;
  mentions: number;
}

/** The count is capped at what a badge can say; past it, "99+" is the whole truth anyone needs. */
export const UNREAD_CAP = 99;

/**
 * What is unread in one room for one user: the messages after their marker
 * that somebody else wrote and did not delete.
 */
export function unreadIn(root: string, username: string, roomUrl: string, roomDir: string): Unread {
  const after = readMarkers(root, username)[readKey(roomUrl)] ?? 0;
  const messages = readMessages(roomDir, { after, limit: UNREAD_CAP + 1 });
  let count = 0;
  let mentions = 0;
  for (const m of messages) {
    if (m.deleted || m.author === username) continue;
    count++;
    if (mentionsUser(m.body, username)) mentions++;
  }
  return { count, mentions };
}

/** Whether one message counts as unread news for a user, for a live update. */
export function isNewsFor(m: Message, username: string): boolean {
  return !m.deleted && m.author !== username;
}

export interface RoomUnread extends Unread {
  url: string;
  title: string;
  kind: 'channel' | 'dm';
}

/** Every room the user can see, with what is unread in it, in sidebar order. */
export function unreadRooms(root: string, auth: AuthResult): RoomUnread[] {
  const out: RoomUnread[] = [];
  for (const c of listChannels(root)) {
    if (!canSeeChannel(auth, c)) continue;
    const url = `/c/${encodeURIComponent(c.name)}`;
    out.push({ url, title: `#${c.name}`, kind: 'channel', ...unreadIn(root, auth.username, url, channelDir(root, c.name)) });
  }
  for (const d of listDmsFor(root, auth.username)) {
    const url = `/d/${d.id}`;
    out.push({ url, title: dmTitle(d, auth.username), kind: 'dm', ...unreadIn(root, auth.username, url, dmDir(root, d.id)) });
  }
  return out;
}

/** The people a room's news reaches: everyone in the workspace for a public channel, or its members. */
export function audienceOf(room: { channel?: ChannelInfo; dm?: DmInfo }, everyone: () => string[]): string[] {
  if (room.dm) return room.dm.participants;
  if (room.channel?.private) return room.channel.members;
  return everyone();
}
