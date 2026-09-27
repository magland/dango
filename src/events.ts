import { Response } from 'express';
import { Message } from './messages';

// Live delivery, in process. Every write to a room publishes an event keyed
// by the room's URL, and every open room page holds a server-sent-events
// response subscribed to that key. One process serves the workspace (the same
// arrangement mochiforge runs under), so there is nothing to coordinate
// beyond a map of listeners; a second server on the same directory would
// serve correct pages but not push each other's messages, which is the same
// bargain the file cache already strikes.
//
// What is published is the message itself, not rendered HTML: a message
// renders differently for different viewers (the edit and delete controls are
// shown only to who may use them, the rule the whole interface follows), so
// each subscriber renders the event against its own viewer and sends the
// result down its own stream. The client's whole job is then
// insertAdjacentHTML and replaceWith, keyed by the ids the renderer stamps.

export interface RoomEvent {
  /** 'message' is a new one; 'update' re-renders one in place (edits,
   * reactions, deletions-as-tombstones, and reply counts are all this). */
  type: 'message' | 'update';
  message: Message;
  /** The room's pinned count, when this update pinned or unpinned the message. */
  pins?: number;
}

type Listener = (event: RoomEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function publish(roomUrl: string, event: RoomEvent): void {
  const set = listeners.get(roomUrl);
  if (!set) return;
  for (const fn of set) fn(event);
}

export function subscribe(roomUrl: string, fn: Listener): () => void {
  let set = listeners.get(roomUrl);
  if (!set) {
    set = new Set();
    listeners.set(roomUrl, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(roomUrl);
  };
}

/**
 * What every page of one person's is told, whichever room it shows: a room's
 * unread count changed, because somebody wrote there or because a page of
 * theirs elsewhere read it. Keyed by username, so a person with three tabs
 * and two devices open holds several listeners under one key.
 */
export type UserEvent =
  | {
      type: 'unread';
      url: string;
      title: string;
      count: number;
      mentions: number;
    }
  /** Who is in a room's call now; an empty list when it has ended. */
  | { type: 'call'; url: string; people: string[] };

/**
 * What only one page is told: a call's roster and the signals another page
 * addressed to this one (see src/calls.ts). A person with the workspace open
 * in two tabs is two pages, and a call connects pages, not people.
 */
export type ClientEvent =
  | { type: 'call-roster'; url: string; call: string; peers: { peer: string; user: string; face: string }[] }
  | { type: 'call-signal'; url: string; from: string; signals: unknown[] }
  /** This page was taken out of the room's call by the workspace. */
  | { type: 'call-gone'; url: string; reason: string };

type UserListener = (event: UserEvent) => void;

const userListeners = new Map<string, Set<UserListener>>();

export function publishToUser(username: string, event: UserEvent): void {
  const set = userListeners.get(username);
  if (!set) return;
  for (const fn of set) fn(event);
}

/** Who has a page open right now, which is who a change of counts can reach. */
export function listeningUsers(): string[] {
  return [...userListeners.keys()];
}

export function subscribeUser(username: string, fn: UserListener): () => void {
  let set = userListeners.get(username);
  if (!set) {
    set = new Set();
    userListeners.set(username, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) userListeners.delete(username);
  };
}

/**
 * The pages that are open, by the id each page made for itself when it
 * loaded. A page presents the id when it opens its stream of the viewer's
 * events, and presents it again on every call request, where the server
 * checks it belongs to whoever is signed in; so one person cannot stand in
 * for another's page, and the ids are long and random enough that nobody
 * learns another's by guessing.
 */
interface ClientEntry {
  username: string;
  send: (event: ClientEvent) => void;
}

const clients = new Map<string, ClientEntry>();
/**
 * Whose each page id has been, kept for a while after its stream closes. A
 * call hands every page the ids of the others, so an id is not secret from
 * the people in a call; what stops one of them opening a stream under
 * another's id while that page is reconnecting is that the id stays bound to
 * its person well past any call's grace period.
 */
const OWNER_HOLD_MS = 60 * 60 * 1000;
const owners = new Map<string, { username: string; closedAt: number | null }>();

function mayHold(clientId: string, username: string): boolean {
  const now = Date.now();
  for (const [id, o] of owners) if (o.closedAt !== null && now - o.closedAt > OWNER_HOLD_MS) owners.delete(id);
  const o = owners.get(clientId);
  return !o || o.username === username;
}
const clientWatchers: ((clientId: string, open: boolean) => void)[] = [];

export function isClientId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
}

/** Whose page this is, while the page has its stream open. */
export function clientOwner(clientId: string): string | null {
  return clients.get(clientId)?.username ?? null;
}

export function sendToClient(clientId: string, event: ClientEvent): boolean {
  const c = clients.get(clientId);
  if (!c) return false;
  c.send(event);
  return true;
}

/** Be told when a page's stream opens and closes (a call keeps a closed page for a while). */
export function watchClients(fn: (clientId: string, open: boolean) => void): void {
  clientWatchers.push(fn);
}

function openStream(res: Response): {
  write: (id: string, payload: unknown) => void;
  close: (fn: () => void) => void;
  end: () => void;
} {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  // A comment heartbeat, so a proxy does not reap the idle connection.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  return {
    write: (id, payload) => res.write(`id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`),
    close: (fn) => {
      res.on('close', () => {
        clearInterval(heartbeat);
        fn();
      });
    },
    // Ending the response closes it, and the close handler above then
    // unsubscribes, so a stream ended from inside a listener is let go of the
    // same way as one the browser dropped.
    end: () => res.end(),
  };
}

/**
 * Serve one room's event stream. The caller has already resolved the room
 * and the viewer, and hands in the render that personalizes a message for
 * them; what remains is the SSE mechanics.
 *
 * A stream outlives the check that opened it: its viewer may be taken out of
 * a private channel, or out of the workspace, or the channel deleted and a
 * private one made under the same name, all while the page stays open. So
 * the caller also hands in `allowed`, which asks again, and every event is
 * sent only after it says yes; the first no ends the stream. The page's
 * reconnect then meets the same check as any new request.
 */
export function serveEvents(
  res: Response,
  roomUrl: string,
  catchUp: RoomEvent[],
  render: (event: RoomEvent) => string,
  allowed: () => boolean
): void {
  const stream = openStream(res);
  const send = (event: RoomEvent) => {
    if (!allowed()) {
      stream.end();
      return;
    }
    stream.write(String(event.message.id), {
      type: event.type,
      id: event.message.id,
      html: render(event),
      ...(event.pins !== undefined ? { pins: event.pins } : {}),
    });
  };
  // Catch-up first: messages that arrived between the page render and this
  // stream opening. The client replaces any element it already has, so a
  // message seen both ways renders once.
  for (const event of catchUp) send(event);
  stream.close(subscribe(roomUrl, send));
}

/**
 * Serve one person's stream of count changes, for the sidebar on every page,
 * and, when the page names itself, what is addressed to that page alone. An
 * id already held by someone else's page is not taken over; a page opening
 * its stream again (after a drop) replaces its own earlier one.
 */
export function serveUserEvents(res: Response, username: string, allowed: () => boolean, clientId?: string): void {
  const stream = openStream(res);
  // Asked again before every event, as a room's stream is (see serveEvents):
  // a person removed, or whose tokens were revoked, stops hearing at once.
  const write = (event: UserEvent | ClientEvent) => {
    if (!allowed()) stream.end();
    else stream.write('0', event);
  };
  const unsubscribe = subscribeUser(username, write);
  let entry: ClientEntry | null = null;
  if (clientId && mayHold(clientId, username)) {
    entry = { username, send: write };
    clients.set(clientId, entry);
    owners.set(clientId, { username, closedAt: null });
    for (const fn of clientWatchers) fn(clientId, true);
  }
  stream.close(() => {
    unsubscribe();
    if (entry && clientId && clients.get(clientId) === entry) {
      clients.delete(clientId);
      owners.set(clientId, { username, closedAt: Date.now() });
      for (const fn of clientWatchers) fn(clientId, false);
    }
  });
}
