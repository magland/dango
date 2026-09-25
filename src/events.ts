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
export interface UserEvent {
  type: 'unread';
  url: string;
  title: string;
  count: number;
  mentions: number;
}

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

function openStream(res: Response): { write: (id: string, payload: unknown) => void; close: (fn: () => void) => void } {
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
  };
}

/**
 * Serve one room's event stream. The caller has already resolved the room
 * and the viewer, and hands in the render that personalizes a message for
 * them; what remains is the SSE mechanics.
 */
export function serveEvents(
  res: Response,
  roomUrl: string,
  catchUp: RoomEvent[],
  render: (event: RoomEvent) => string
): void {
  const stream = openStream(res);
  const send = (event: RoomEvent) => {
    stream.write(String(event.message.id), { type: event.type, id: event.message.id, html: render(event) });
  };
  // Catch-up first: messages that arrived between the page render and this
  // stream opening. The client replaces any element it already has, so a
  // message seen both ways renders once.
  for (const event of catchUp) send(event);
  stream.close(subscribe(roomUrl, send));
}

/** Serve one person's stream of count changes, for the sidebar on every page. */
export function serveUserEvents(res: Response, username: string): void {
  const stream = openStream(res);
  stream.close(subscribeUser(username, (event) => stream.write('0', event)));
}
