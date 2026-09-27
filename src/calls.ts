import { randomBytes } from 'crypto';
import { avatar } from '../../mochiforge/src/avatar';
import { OpError } from '../../mochiforge/src/ops';
import { loadVault } from '../../mochiforge/src/vault';
import { readChannel } from './channels';
import { loadConfig } from './config';
import { readDm } from './dms';
import { clientOwner, listeningUsers, publish, publishToUser, sendToClient, watchClients } from './events';
import { currentGuests, isCurrentGuest, personLabel, readMeeting } from './meetings';
import { Message, readMessage, readMessages, updateCallRecord } from './messages';
import { postMessage } from './post';
import { audienceOf } from './reads';
import { Room, channelRoom, dmRoom, meetingRoom } from './rooms';
import { isGuestName } from './workspace';

// Calls: who is in each room's call, and the signaling that lets their
// browsers connect to each other.
//
// A call's audio and video never pass through here. Each browser in a call
// connects directly to every other (a full mesh, the arrangement commonroom
// uses), with a TURN relay where the workspace has one and a pair cannot
// connect directly (see src/ice.ts). What the workspace does is what a
// signaling server does: it keeps the roster, tells every page in the call
// who else is in it, and passes each page's WebRTC offers, answers, and ICE
// candidates to the page they are addressed to, over that page's own event
// stream. Being in a room is what lets a person join its call, and every
// request is checked against the room as any other is.
//
// A call is held in memory, like the event streams, and a restart loses the
// roster but not the call: the browsers stay connected to each other, and
// each page, finding its stream reopened, joins again under the same call id,
// which picks up the same entry in the timeline.
//
// A call is between pages, not people. Somebody with the workspace open in a
// tab on their laptop and in another on their phone can have both in a call;
// each is its own participant, with its own connections.
//
// A meeting's call can also hold its guests (see src/meetings.ts). A guest
// joins a call that a member started and never starts one, and a call left
// with guests alone ends a little later (MEMBERLESS_MS), so that a meeting's
// link is a way for outsiders to talk with the workspace's members and not
// a free way for strangers to reach each other through its server and relay.

/**
 * The most pages in one call. In a mesh every participant sends its video to
 * every other, so each one's upload grows with the call; eight is about where
 * a home connection stops keeping up, and beyond it a call would need a media
 * server, which is what this design does without.
 */
export const MAX_IN_CALL = 8;
/**
 * How many of the places in one call a person may hold: a call connects
 * pages, and someone on a laptop and a phone at once is two, but without a
 * bound one person with eight tabs would fill a call and keep everyone else
 * out of it.
 */
export const MAX_PAGES_PER_PERSON = 2;

/**
 * How long a page whose event stream closed stays in its call, waiting for it
 * to reopen. A stream drops through a proxy's restart or a phone changing
 * networks and comes back within seconds; a page that was closed does not,
 * and leaves the call when this runs out (or at once, when its closing sent
 * the leave itself).
 */
export const CLIENT_GRACE_MS = 20000;

/** The most signals one request may carry: an offer or answer and a burst of candidates. */
export const MAX_SIGNALS = 64;

/**
 * How long a call goes on with only guests in it before it ends for them.
 * Long enough for a member to reload their page, or for the members' pages
 * to find their way back after the workspace restarts; short enough that
 * guests left behind are not kept talking through the workspace for long.
 */
export const MEMBERLESS_MS = 45000;

export const NOT_STARTED = 'The call has not started yet. It starts when someone from the workspace joins it.';

interface Participant {
  peer: string;
  user: string;
  /** How the others see them named: a member's username, or a guest's name marked as a guest's. */
  name: string;
  joined: number;
}

interface LiveCall {
  id: string;
  root: string;
  room: Room;
  started: number;
  /** The message that is the call's entry in the timeline. */
  messageId: number;
  participants: Map<string, Participant>;
}

const calls = new Map<string, LiveCall>();
const graceTimers = new Map<string, NodeJS.Timeout>();
const memberlessTimers = new Map<string, NodeJS.Timeout>();

/** The people in a room's call right now, each once, in the order they joined. */
function peopleOf(call: LiveCall): string[] {
  return [...new Set([...call.participants.values()].map((p) => p.user))];
}

/** The same, as they are named to others. */
function namesOf(call: LiveCall): string[] {
  const seen = new Map<string, string>();
  for (const p of call.participants.values()) if (!seen.has(p.user)) seen.set(p.user, p.name);
  return [...seen.values()];
}

/** A room's call, if one is going on: its id, who is in it (and how they are named), and its entry. */
export function liveCall(roomUrl: string): { id: string; people: string[]; names: string[]; messageId: number; started: number } | null {
  const call = calls.get(roomUrl);
  return call ? { id: call.id, people: peopleOf(call), names: namesOf(call), messageId: call.messageId, started: call.started } : null;
}

/** Every call going on, by room, with who is in it as they are named, for the sidebar. */
export function liveCallsByRoom(): Map<string, string[]> {
  return new Map([...calls.entries()].map(([url, call]) => [url, namesOf(call)]));
}

/** For tests: forget every call. */
export function resetCalls(): void {
  for (const t of graceTimers.values()) clearTimeout(t);
  for (const t of memberlessTimers.values()) clearTimeout(t);
  graceTimers.clear();
  memberlessTimers.clear();
  calls.clear();
}

function everyone(root: string): string[] {
  const state = loadVault(root);
  return state.status === 'ok' ? Object.keys(state.vault.users) : [];
}

/**
 * Tell everyone who can see the room, and has a page open, who is in its
 * call now, and repaint the call's entry in the timeline for the room's open
 * pages. An empty list says the call ended.
 */
function announce(call: LiveCall, message?: Message | null): void {
  const people = namesOf(call);
  // Who can see the room now, not when the call started.
  if (call.room.channel) call.room.channel = readChannel(call.root, call.room.channel.name) ?? call.room.channel;
  if (call.room.dm) call.room.dm = readDm(call.root, call.room.dm.id) ?? call.room.dm;
  if (call.room.meeting) call.room.meeting = readMeeting(call.root, call.room.meeting.id) ?? call.room.meeting;
  const listening = new Set(listeningUsers());
  // A meeting's guests are told too: their page's call button is how they join.
  const guests = call.room.meeting ? currentGuests(call.room.meeting) : [];
  for (const username of [...audienceOf(call.room, () => everyone(call.root)), ...guests]) {
    if (listening.has(username)) publishToUser(username, { type: 'call', url: call.room.url, people });
  }
  const m = message ?? readMessage(call.room.dir, call.messageId);
  if (m) publish(call.room.url, { type: 'update', message: m });
}

/** Tell each page in the call who is in it, which is what it connects to. */
function sendRoster(call: LiveCall): void {
  const peers = [...call.participants.values()].map((p) => ({ peer: p.peer, user: p.user, name: p.name, face: avatar(p.user, 64).text }));
  for (const p of call.participants.values()) {
    sendToClient(p.peer, { type: 'call-roster', url: call.room.url, call: call.id, peers });
  }
}

/**
 * The call's entry to pick up again after a restart: the message recording
 * the call with this id, among the room's recent ones, if it has not ended.
 */
function resumable(room: Room, callId: string): Message | null {
  for (const m of readMessages(room.dir, { limit: 200 }).reverse()) {
    if (m.call?.id === callId) return m.call.ended ? null : m;
  }
  return null;
}

/**
 * Put a page into the room's call, starting the call if there is none. The
 * page must be the viewer's own open page. `resume` is the id of the call
 * the page was in before its stream dropped, so that a call carried on
 * through a restart of the workspace keeps its entry. `charge` is called when
 * a new call is to post its entry: a call started is a message in the room,
 * and in a direct conversation a notification, so starting calls is held to
 * the limits on sending, lest joining and leaving over and over become a way
 * around them. A meeting's guest may join a call going on, or pick up one
 * the workspace forgot in a restart, but not start one. Returns the call's id.
 */
export function joinCall(root: string, room: Room, user: string, peer: string, resume?: string, charge?: () => void): string {
  if (room.kind === 'thread') throw new OpError('A call belongs to a channel or a conversation, not a thread.');
  const guest = isGuestName(user);
  if (guest && !room.meeting) throw new OpError('Only a meeting has guests.');
  if (clientOwner(peer) !== user) {
    throw new OpError('This page has lost its connection to the workspace. Wait a moment and try again, or reload the page.', 'conflict');
  }
  let call = calls.get(room.url);
  const held = call?.participants.get(peer);
  if (held && held.user !== user) throw new OpError('That page is someone else’s.', 'conflict');
  if (call && !held && call.participants.size >= MAX_IN_CALL) {
    throw new OpError(`The call is full: up to ${MAX_IN_CALL} can be in a call at once.`, 'conflict');
  }
  if (call && !held && [...call.participants.values()].filter((p) => p.user === user).length >= MAX_PAGES_PER_PERSON) {
    throw new OpError(`You are already in this call from ${MAX_PAGES_PER_PERSON} other pages; leave it on one of them first.`, 'conflict');
  }
  let entry: Message | null = null;
  if (!call) {
    const earlier = resume ? resumable(room, resume) : null;
    if (guest && !earlier) throw new OpError(NOT_STARTED, 'conflict');
    if (earlier) {
      call = { id: earlier.call!.id, root, room, started: Date.parse(earlier.created) || Date.now(), messageId: earlier.id, participants: new Map() };
    } else {
      const id = randomBytes(8).toString('hex');
      // The entry is posted before the call is registered, and a refusal to
      // post (the room's limits, a full disk) is a refusal to start the call.
      entry = postMessage(root, room, { author: user, body: 'started a call', call: { id, people: [user] } }, { charge });
      call = { id, root, room, started: Date.now(), messageId: entry.id, participants: new Map() };
    }
    calls.set(room.url, call);
  }
  const timer = graceTimers.get(peer);
  if (timer) {
    clearTimeout(timer);
    graceTimers.delete(peer);
  }
  // A page in another room's call leaves it: a page is in one call at a time.
  for (const other of calls.values()) {
    if (other !== call && other.participants.has(peer)) leaveCall(other.room.url, peer);
  }
  call.participants.set(peer, call.participants.get(peer) ?? { peer, user, name: personLabel(room.meeting, user), joined: Date.now() });
  if (!entry) {
    entry = updateCallRecord(room.dir, call.messageId, (rec) => (rec.people.includes(user) ? rec : { ...rec, people: [...rec.people, user] }));
  }
  watchMembers(call);
  sendRoster(call);
  announce(call, entry);
  return call.id;
}

/**
 * Keep an eye on whether a call still has a member in it. One that has only
 * guests left is given MEMBERLESS_MS for a member to come back, and then ends
 * for the guests, who are told why.
 */
function watchMembers(call: LiveCall): void {
  const url = call.room.url;
  const hasMember = [...call.participants.values()].some((p) => !isGuestName(p.user));
  const timer = memberlessTimers.get(url);
  if (hasMember || call.participants.size === 0) {
    if (timer) {
      clearTimeout(timer);
      memberlessTimers.delete(url);
    }
    return;
  }
  if (timer) return;
  const t = setTimeout(() => {
    memberlessTimers.delete(url);
    const now = calls.get(url);
    if (now !== call || [...call.participants.values()].some((p) => !isGuestName(p.user))) return;
    for (const p of [...call.participants.values()]) {
      sendToClient(p.peer, { type: 'call-gone', url, reason: 'Everyone from the workspace has left, so the call has ended.' });
      leaveCall(url, p.peer);
    }
  }, MEMBERLESS_MS);
  t.unref?.();
  memberlessTimers.set(url, t);
}

/** Take a page out of a room's call, ending the call when it was the last. */
export function leaveCall(roomUrl: string, peer: string): void {
  const call = calls.get(roomUrl);
  if (!call || !call.participants.delete(peer)) return;
  const timer = graceTimers.get(peer);
  if (timer) {
    clearTimeout(timer);
    graceTimers.delete(peer);
  }
  if (call.participants.size === 0) {
    calls.delete(roomUrl);
    watchMembers(call);
    const ended = updateCallRecord(call.room.dir, call.messageId, (rec) => ({ ...rec, ended: new Date().toISOString() }));
    announce(call, ended);
    return;
  }
  watchMembers(call);
  sendRoster(call);
  announce(call);
}

/**
 * Pass one page's signals to another in the same call. Both must be in it;
 * anything else is refused, so the relay cannot be used to reach a page that
 * did not join.
 */
export function relaySignals(roomUrl: string, from: string, to: string, signals: unknown[]): void {
  const call = calls.get(roomUrl);
  if (!call || !call.participants.has(from)) throw new OpError('This page is not in the call.', 'conflict');
  if (!call.participants.has(to)) throw new OpError('That page is not in the call.', 'notfound');
  if (signals.length > MAX_SIGNALS) throw new OpError(`At most ${MAX_SIGNALS} signals at a time.`);
  sendToClient(to, { type: 'call-signal', url: roomUrl, from, signals });
}

/**
 * Take out of every call the people who can no longer see its room: removed
 * from a private channel, a meeting, or the workspace, or the room deleted,
 * and a meeting's guests whose link was reset, who were taken out, or whom
 * the workspace no longer allows. Their pages are told, and the others drop
 * them with the new roster. Called by every route that takes access away.
 */
export function pruneCalls(root: string): void {
  const state = loadVault(root);
  const guestsOn = loadConfig(root).calls.guests;
  for (const call of [...calls.values()]) {
    const canSee = (user: string): boolean => {
      if (isGuestName(user)) {
        const meeting = call.room.meeting ? readMeeting(root, call.room.meeting.id) : null;
        return guestsOn && meeting !== null && isCurrentGuest(meeting, user);
      }
      const u = state.status === 'ok' ? state.vault.users[user] : undefined;
      if (!u) return false;
      const auth = { username: user, user: u, token: { hash: '' } } as Parameters<typeof channelRoom>[2];
      if (call.room.meeting) return meetingRoom(root, call.room.meeting.id, auth) !== null;
      return call.room.dm ? dmRoom(root, call.room.dm.id, auth) !== null : channelRoom(root, call.room.channel!.name, auth) !== null;
    };
    for (const p of [...call.participants.values()]) {
      if (canSee(p.user)) continue;
      const reason = isGuestName(p.user) ? 'You are no longer a guest in this meeting, so you have left its call.' : 'You can no longer see this room, so you have left its call.';
      sendToClient(p.peer, { type: 'call-gone', url: call.room.url, reason });
      leaveCall(call.room.url, p.peer);
    }
  }
}

/** Whose page a participant is, or null when the page is not in the room's call. */
export function participantUser(roomUrl: string, peer: string): string | null {
  return calls.get(roomUrl)?.participants.get(peer)?.user ?? null;
}

// A page whose stream closed is given a while to come back before it leaves
// its calls; one whose stream reopens in time stays in them.
watchClients((peer, open) => {
  const timer = graceTimers.get(peer);
  if (open) {
    if (timer) {
      clearTimeout(timer);
      graceTimers.delete(peer);
    }
    return;
  }
  const rooms = [...calls.values()].filter((c) => c.participants.has(peer)).map((c) => c.room.url);
  if (!rooms.length || timer) return;
  const t = setTimeout(() => {
    graceTimers.delete(peer);
    for (const url of rooms) leaveCall(url, peer);
  }, CLIENT_GRACE_MS);
  t.unref?.();
  graceTimers.set(peer, t);
});
