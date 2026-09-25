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
 * Serve one event stream. The caller has already resolved the room and the
 * viewer, and hands in the render that personalizes a message for them; what
 * remains is the SSE mechanics: headers, a comment heartbeat so proxies do
 * not reap the idle connection, and cleanup when the client goes.
 */
export function serveEvents(
  res: Response,
  roomUrl: string,
  catchUp: RoomEvent[],
  render: (event: RoomEvent) => string
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  const send = (event: RoomEvent) => {
    const payload = { type: event.type, id: event.message.id, html: render(event) };
    res.write(`id: ${event.message.id}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  // Catch-up first: messages that arrived between the page render and this
  // stream opening. The client replaces any element it already has, so a
  // message seen both ways renders once.
  for (const event of catchUp) send(event);
  const unsubscribe = subscribe(roomUrl, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
