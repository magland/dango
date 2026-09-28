import { createLimiter } from '../../mochiforge/src/limit';
import { publish } from './events';

// Who is typing in a room, as Slack shows it under the composer. A page says
// so while its composer has text being written in it, every few seconds
// (TYPING_PING_MS in the page script), and the room's open pages are told
// who is typing whenever that changes. Nothing is written to disk: it is
// true for seconds and means nothing after a restart.
//
// A person stops typing when they send (postMessage clears them), when their
// page says the composer was emptied, or when TYPING_TTL_MS passes without
// word from them, which is what ends it for a page that was closed or lost
// its connection mid-sentence.
//
// Keyed by room URL, so a thread is its own room and typing a reply shows on
// the thread's page, not the channel's.

/** How long one word from a page keeps its person shown as typing. */
export const TYPING_TTL_MS = 7000;

/**
 * How many times a minute one person may change what a room shows: starting
 * or stopping. Each change is sent to every page open on the room, so without
 * a bound a script flipping start and stop could make the server write to
 * everyone's streams as fast as it can post. Refreshing an entry that is
 * already shown changes nothing and is not counted.
 */
export const TYPING_CHANGES_PER_MINUTE = 30;

const rooms = new Map<string, Map<string, number>>();
const timers = new Map<string, NodeJS.Timeout>();
const changes = createLimiter({ limit: TYPING_CHANGES_PER_MINUTE, windowMs: 60_000, maxKeys: 100000 });

/** Who is typing in a room now, oldest first, by username (a guest by their id). */
export function typingIn(roomUrl: string): string[] {
  const set = rooms.get(roomUrl);
  return set ? [...set.keys()] : [];
}

function announce(roomUrl: string): void {
  publish(roomUrl, { type: 'typing', people: typingIn(roomUrl) });
}

function timerKey(roomUrl: string, person: string): string {
  return `${roomUrl}\x00${person}`;
}

function drop(roomUrl: string, person: string): boolean {
  const set = rooms.get(roomUrl);
  if (!set || !set.delete(person)) return false;
  if (set.size === 0) rooms.delete(roomUrl);
  const key = timerKey(roomUrl, person);
  clearTimeout(timers.get(key));
  timers.delete(key);
  return true;
}

/** Run out a person's entry once its time has passed, however often it was refreshed meanwhile. */
function expireLater(roomUrl: string, person: string, ms: number): void {
  const key = timerKey(roomUrl, person);
  const t = setTimeout(() => {
    timers.delete(key);
    const until = rooms.get(roomUrl)?.get(person);
    if (until === undefined) return;
    const left = until - Date.now();
    if (left > 0) expireLater(roomUrl, person, left);
    else if (drop(roomUrl, person)) announce(roomUrl);
  }, ms);
  t.unref();
  timers.set(key, t);
}

/** A person is typing in a room: shown for TYPING_TTL_MS more. */
export function noteTyping(roomUrl: string, person: string): void {
  const set = rooms.get(roomUrl);
  if (set?.has(person)) {
    set.set(person, Date.now() + TYPING_TTL_MS);
    return;
  }
  if (!changes.hit(person).ok) return;
  if (set) set.set(person, Date.now() + TYPING_TTL_MS);
  else rooms.set(roomUrl, new Map([[person, Date.now() + TYPING_TTL_MS]]));
  expireLater(roomUrl, person, TYPING_TTL_MS);
  announce(roomUrl);
}

/** A person is no longer typing in a room: they sent, or emptied the composer. */
export function stopTyping(roomUrl: string, person: string): void {
  if (drop(roomUrl, person)) announce(roomUrl);
}
