import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from '../../mochiforge/src/atomic';
import { fileCache } from '../../mochiforge/src/filecache';
import { AuthResult, loadVault } from '../../mochiforge/src/vault';
import { readChannel } from './channels';
import { dmTitle, readDm } from './dms';
import { Message, readMessage, readMessages } from './messages';
import { canSeeChannel, canSeeDm } from './perms';
import { PushTarget, isPushEndpoint, sendPush } from './push';
import { Room } from './rooms';
import { audienceOf, mentionsUser, readKey, readMarkers, unreadRooms } from './reads';
import { userDir } from './workspace';

// Notifications: who is told about a message when they have no page open to
// see it arrive, and on which of their devices.
//
// Two files per person, beside read.json:
//
//   users/<name>/push.json     the devices that have turned notifications on:
//                              each browser's push subscription, a label for
//                              it, and when it was added
//   users/<name>/notify.json   what they want to hear about: a level, whether
//                              a notification shows the message's text, and
//                              the rooms they have muted
//
// A message is not pushed the moment it is sent. Each person's pushes for a
// room wait a few seconds, gathered, and are sent only if the person's read
// marker has not passed them by then: someone with the room open on a screen
// has read the message, and the page has said so, so their phone stays quiet.
// Several messages inside the wait become one notification saying how many.
// The wait lives in this process and is lost on a restart, which costs at
// most the notifications of the last few seconds.

export const PUSH_FILE = 'push.json';
export const NOTIFY_FILE = 'notify.json';

/** How long a push waits for the person to read the message some other way. */
export const NOTIFY_DELAY_MS = 8000;

/** Devices per person; subscribing another past this drops the one added longest ago. */
const MAX_DEVICES = 20;

// ---- preferences ----

/**
 * What a person hears about. `direct` is the default: messages in their
 * direct conversations, messages that @mention them, and replies in threads
 * they started or replied in. `all` adds every other message in every
 * channel they can read. `none` is silence.
 */
export type NotifyLevel = 'all' | 'direct' | 'none';

export interface NotifyPrefs {
  level: NotifyLevel;
  /** Whether a notification shows who said what, or only that something arrived. */
  preview: boolean;
  /** Rooms nothing is pushed from, as read.json keys them ("c/general", "d/3"). */
  muted: string[];
}

export const DEFAULT_PREFS: NotifyPrefs = { level: 'direct', preview: true, muted: [] };

function normalizePrefs(parsed: unknown): NotifyPrefs {
  const out: NotifyPrefs = { ...DEFAULT_PREFS, muted: [] };
  if (typeof parsed !== 'object' || parsed === null) return out;
  const rec = parsed as Record<string, unknown>;
  if (rec.level === 'all' || rec.level === 'direct' || rec.level === 'none') out.level = rec.level;
  if (typeof rec.preview === 'boolean') out.preview = rec.preview;
  if (Array.isArray(rec.muted)) out.muted = [...new Set(rec.muted.filter((k): k is string => typeof k === 'string'))];
  return out;
}

const prefsCache = fileCache<NotifyPrefs>({
  read: (file) => {
    try {
      return normalizePrefs(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return { ...DEFAULT_PREFS, muted: [] };
    }
  },
  missing: () => ({ ...DEFAULT_PREFS, muted: [] }),
});

export function readPrefs(root: string, username: string): NotifyPrefs {
  return prefsCache.get(path.join(userDir(root, username), NOTIFY_FILE));
}

export function writePrefs(root: string, username: string, prefs: NotifyPrefs): NotifyPrefs {
  const clean = normalizePrefs(prefs);
  const file = path.join(userDir(root, username), NOTIFY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  prefsCache.invalidate(file);
  return clean;
}

// ---- devices ----

export interface Device extends PushTarget {
  /** A short, stable handle for the interface, so forms need not carry the endpoint. */
  id: string;
  /** What the device said it was when it subscribed: "Chrome on Android". */
  label: string;
  created: string;
}

export function deviceId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

function normalizeDevices(parsed: unknown): Device[] {
  if (!Array.isArray(parsed)) return [];
  const out: Device[] = [];
  for (const d of parsed) {
    if (typeof d !== 'object' || d === null) continue;
    const r = d as Record<string, unknown>;
    const keys = r.keys as Record<string, unknown> | undefined;
    if (!isPushEndpoint(r.endpoint) || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') continue;
    out.push({
      id: deviceId(r.endpoint),
      endpoint: r.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      origin: typeof r.origin === 'string' ? r.origin : '',
      label: typeof r.label === 'string' ? r.label : 'A browser',
      created: typeof r.created === 'string' ? r.created : '',
    });
  }
  return out;
}

const devicesCache = fileCache<Device[]>({
  read: (file) => {
    try {
      return normalizeDevices(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  },
  missing: () => [],
});

function devicesFile(root: string, username: string): string {
  return path.join(userDir(root, username), PUSH_FILE);
}

export function readDevices(root: string, username: string): Device[] {
  return devicesCache.get(devicesFile(root, username));
}

function updateDevices(root: string, username: string, fn: (devices: Device[]) => Device[]): Device[] {
  const file = devicesFile(root, username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    let current: Device[] = [];
    try {
      current = normalizeDevices(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      current = [];
    }
    const next = fn(current);
    // The id is derived, so it is not stored.
    const stored = next.map(({ id: _id, ...rest }) => rest);
    writeFileAtomic(file, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
    devicesCache.invalidate(file);
    return next;
  });
}

/**
 * The subscription a browser handed over, checked: an endpoint at a push
 * service this workspace will send to (see isPushEndpoint), and the two keys
 * the payload is encrypted with, of the lengths they must be.
 */
export function parseSubscription(raw: unknown): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const keys = r.keys as Record<string, unknown> | undefined;
  if (!isPushEndpoint(r.endpoint)) return null;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return null;
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length < 16) return null;
  return { endpoint: r.endpoint, keys: { p256dh, auth } };
}

/** Add a device, or refresh it if this endpoint is already one of the person's. */
export function addDevice(
  root: string,
  username: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  info: { origin: string; label: string }
): Device {
  // One endpoint belongs to one person: a browser that was signed in as
  // someone else when it subscribed stops receiving their notifications.
  forgetEndpointEverywhere(root, sub.endpoint, username);
  let device: Device | null = null;
  updateDevices(root, username, (devices) => {
    // The page offers its subscription again each time the account page
    // opens, which keeps the keys current without resetting when it was added.
    const earlier = devices.find((d) => d.endpoint === sub.endpoint);
    device = {
      id: deviceId(sub.endpoint),
      endpoint: sub.endpoint,
      keys: sub.keys,
      origin: info.origin,
      label: info.label.slice(0, 80),
      created: earlier?.created || new Date().toISOString(),
    };
    const others = devices.filter((d) => d.endpoint !== sub.endpoint);
    return [...others, device].slice(-MAX_DEVICES);
  });
  return device!;
}

export function removeDevice(root: string, username: string, id: string): boolean {
  let removed = false;
  updateDevices(root, username, (devices) => {
    const kept = devices.filter((d) => d.id !== id);
    removed = kept.length !== devices.length;
    return kept;
  });
  return removed;
}

function everyone(root: string): string[] {
  const state = loadVault(root);
  return state.status === 'ok' ? Object.keys(state.vault.users) : [];
}

/** Remove an endpoint from whoever holds it, other than `keep`. */
function forgetEndpointEverywhere(root: string, endpoint: string, keep?: string): void {
  for (const username of everyone(root)) {
    if (username === keep) continue;
    if (readDevices(root, username).some((d) => d.endpoint === endpoint)) {
      updateDevices(root, username, (devices) => devices.filter((d) => d.endpoint !== endpoint));
    }
  }
}

/**
 * A browser replaced its subscription by itself (the service worker hears
 * this as pushsubscriptionchange) and says so without a session: the old
 * subscription's auth secret, which only that browser and this workspace
 * know, is what shows the request came from it.
 */
export function renewDevice(
  root: string,
  old: { endpoint: string; auth: string },
  next: { endpoint: string; keys: { p256dh: string; auth: string } }
): boolean {
  for (const username of everyone(root)) {
    const found = readDevices(root, username).find((d) => d.endpoint === old.endpoint && d.keys.auth === old.auth);
    if (!found) continue;
    updateDevices(root, username, (devices) => [
      ...devices.filter((d) => d.endpoint !== old.endpoint && d.endpoint !== next.endpoint),
      { ...found, id: deviceId(next.endpoint), endpoint: next.endpoint, keys: next.keys },
    ]);
    return true;
  }
  return false;
}

/** "Chrome on Android", "Safari on iPhone", from a User-Agent header, for the device list. */
export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'A browser';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---- deciding ----

/** The room nothing is pushed from when muted: a thread's own room is its parent's. */
function baseRoom(room: Room): Room {
  return room.parent ?? room;
}

/** Who has taken part in a thread: its anchor's author and everyone who replied. */
function threadPeople(room: Room): Set<string> {
  const people = new Set<string>();
  if (room.kind !== 'thread') return people;
  const anchor = readMessage(room.parent!.dir, room.threadOf!);
  if (anchor) people.add(anchor.author);
  for (const m of readMessages(room.dir, { limit: 500 })) people.add(m.author);
  return people;
}

/**
 * Whether a message is one this person asked to hear about. Addressed to
 * them means a direct conversation, a mention, or a reply in a thread they
 * are part of; `all` adds the rest of what is said in channels, though not
 * every reply in every thread, which would make a busy workspace unbearable.
 */
export function wantsPush(
  prefs: NotifyPrefs,
  room: Room,
  m: Message,
  username: string,
  inThread: () => Set<string>
): boolean {
  if (m.deleted || m.author === username || prefs.level === 'none') return false;
  if (prefs.muted.includes(readKey(baseRoom(room).url))) return false;
  const addressed = room.dm !== undefined || mentionsUser(m.body, username) || (room.kind === 'thread' && inThread().has(username));
  if (addressed) return true;
  return prefs.level === 'all' && room.kind !== 'thread';
}

/**
 * Plain text for a notification: markdown's punctuation taken out, code
 * blocks summarized, and cut short, since a lock screen shows a line or two.
 */
export function previewText(body: string, max = 180): string {
  const text = body
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

export interface Notification {
  title: string;
  body: string;
  /** Notifications from one room replace each other on a device. */
  tag: string;
  url: string;
  /** The person's unread total, for the app icon's badge where there is one. */
  unread: number;
  time: number;
}

function displayName(root: string, username: string): string {
  const state = loadVault(root);
  return (state.status === 'ok' && state.vault.users[username]?.profile?.name) || username;
}

function authFor(root: string, username: string): AuthResult | null {
  const state = loadVault(root);
  if (state.status !== 'ok' || !state.vault.users[username]) return null;
  return { username, user: state.vault.users[username], token: { hash: '' } } as AuthResult;
}

/** What one person is shown for the newest of `messages`, all from one room. */
export function composeNotification(root: string, room: Room, messages: Message[], username: string, prefs: NotifyPrefs): Notification {
  const newest = messages[messages.length - 1];
  const base = baseRoom(room);
  const where = base.dm ? dmTitle(base.dm, username) : base.title;
  const title = room.kind === 'thread' ? `Thread in ${where}` : where;
  const who = displayName(root, newest.author);
  let body: string;
  if (prefs.preview) {
    const text = previewText(newest.body) || (newest.files.length ? `sent ${newest.files.length === 1 ? 'a file' : `${newest.files.length} files`}` : '');
    body = `${who}: ${text}`;
    if (messages.length > 1) body = `${messages.length} new messages. ${body}`;
  } else {
    body = messages.length > 1 ? `${messages.length} new messages` : `New message from ${who}`;
  }
  const auth = authFor(root, username);
  const unread = auth ? unreadRooms(root, auth).reduce((n, r) => n + r.count, 0) : 0;
  return { title, body, tag: room.url, url: room.url, unread, time: Date.parse(newest.created) || Date.now() };
}

/** Send to every device a person has, forgetting the ones their push service says are gone. */
export async function pushToUser(
  root: string,
  username: string,
  payload: unknown,
  opts: { urgency?: 'normal' | 'high'; topic?: string; only?: string } = {}
): Promise<{ sent: number; gone: number; failed: { label: string; status: number; detail?: string }[] }> {
  const result = { sent: 0, gone: 0, failed: [] as { label: string; status: number; detail?: string }[] };
  const devices = readDevices(root, username).filter((d) => !opts.only || d.id === opts.only);
  await Promise.all(
    devices.map(async (d) => {
      const r = await sendPush(root, d, payload, { urgency: opts.urgency, topic: opts.topic });
      if (r.outcome === 'sent') result.sent++;
      else if (r.outcome === 'gone') {
        result.gone++;
        removeDevice(root, username, d.id);
      } else {
        result.failed.push({ label: d.label, status: r.status, detail: r.detail });
        console.error(`push to ${username} (${d.label}) failed: ${r.status} ${r.detail ?? ''}`.trim());
      }
    })
  );
  return result;
}

// ---- the wait ----

interface Pending {
  timer: NodeJS.Timeout;
  room: Room;
  ids: number[];
}

const pending = new Map<string, Pending>();

/**
 * Called for every new message. Works out, for each person the room reaches
 * who has a device to reach them on, whether they want to hear of it, and
 * queues it for them; the queue for a person and a room fires once, a few
 * seconds after its first message, and does not restart with each later
 * one, so a steady conversation still gets through.
 */
export function queueNotifications(root: string, room: Room, m: Message, delayMs = NOTIFY_DELAY_MS): void {
  if (m.deleted) return;
  let people: Set<string> | null = null;
  const inThread = () => (people ??= threadPeople(room));
  for (const username of audienceOf(baseRoom(room), () => everyone(root))) {
    if (username === m.author || readDevices(root, username).length === 0) continue;
    if (!wantsPush(readPrefs(root, username), room, m, username, inThread)) continue;
    const key = `${username}\n${room.url}`;
    const waiting = pending.get(key);
    if (waiting) {
      waiting.ids.push(m.id);
      continue;
    }
    const entry: Pending = {
      room,
      ids: [m.id],
      timer: setTimeout(() => {
        pending.delete(key);
        deliver(root, username, entry).catch((e) => console.error(e));
      }, delayMs),
    };
    entry.timer.unref?.();
    pending.set(key, entry);
  }
}

async function deliver(root: string, username: string, entry: Pending): Promise<void> {
  // Still a member, and still able to see the room, as the files say now: a
  // person removed from a private channel inside the wait hears nothing more
  // from it.
  const auth = authFor(root, username);
  if (!auth) return;
  const base = baseRoom(entry.room);
  const room = base.dm ? readDm(root, base.dm.id) : readChannel(root, base.channel!.name);
  if (!room) return;
  if ('participants' in room ? !canSeeDm(auth, room) : !canSeeChannel(auth, room)) return;
  // Read in the meantime, on some other screen, or deleted, or muted since:
  // not news.
  const prefs = readPrefs(root, username);
  const marker = readMarkers(root, username)[readKey(entry.room.url)] ?? 0;
  let people: Set<string> | null = null;
  const inThread = () => (people ??= threadPeople(entry.room));
  const messages = entry.ids
    .filter((id) => id > marker)
    .map((id) => readMessage(entry.room.dir, id))
    .filter((x): x is Message => x !== null && wantsPush(prefs, entry.room, x, username, inThread));
  if (!messages.length) return;
  const note = composeNotification(root, entry.room, messages, username, prefs);
  const urgent = entry.room.dm !== undefined || messages.some((x) => mentionsUser(x.body, username));
  await pushToUser(root, username, note, { urgency: urgent ? 'high' : 'normal', topic: entry.room.url });
}

/** For tests: whether anything is waiting, and a way to stop it. */
export function pendingCount(): number {
  return pending.size;
}

export function cancelPending(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
}
