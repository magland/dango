import { loadVault } from '../../mochiforge/src/vault';
import { listeningUsers, publish, publishToUser } from './events';
import { Attachment, Message, addMessage, findByNonce, readMessage } from './messages';
import { Room } from './rooms';
import { audienceOf, isNewsFor, markRead, unreadIn } from './reads';

// Sending a message, whichever door it came through. The web and the JSON
// API both did the same four things after writing the file, and one of them
// was bound to forget the fourth: the file, the read marker for the author
// (you have seen what you just said), the event to the room's open pages,
// and the count change to everyone the room reaches.

export function postMessage(
  root: string,
  room: Room,
  input: { author: string; body: string; files?: Attachment[]; nonce?: string },
  opts: {
    /** Charge the sender's rate limits; throws when they are spent. A retry found by its nonce is not charged. */
    charge?: () => void;
    /** Work to do with the new id before anyone is told: writing the attachments. */
    settle?: (id: number) => void;
  } = {}
): Message {
  // A retry of a send that already arrived answers with the message it made,
  // and nothing is written or announced again. The look and the write below
  // are one synchronous stretch, so two copies of one request racing in this
  // process cannot both miss and both write.
  if (input.nonce) {
    const earlier = findByNonce(room.dir, input.author, input.nonce);
    if (earlier) return earlier;
  }
  opts.charge?.();
  const m = addMessage(room.dir, input);
  opts.settle?.(m.id);
  markRead(root, input.author, room.url, m.id);
  publish(room.url, { type: 'message', message: m });
  if (room.kind === 'thread') {
    // The parent message's reply count changed, so the parent room repaints it.
    const parent = readMessage(room.parent!.dir, room.threadOf!);
    if (parent) publish(room.parent!.url, { type: 'update', message: parent });
    // A reply is not counted against the room: the sidebar counts what
    // arrives in a room, and a thread is read from inside its message.
    return m;
  }
  notifyUnread(root, room, m);
  return m;
}

/**
 * Tell everyone the room reaches, who has a page open, what their count is
 * now. Computed per person, since each has their own marker; only the people
 * currently listening are computed for, which is what keeps a message to a
 * hundred-person channel from reading a hundred files.
 */
function notifyUnread(root: string, room: Room, m: Message): void {
  const listening = new Set(listeningUsers());
  if (listening.size === 0) return;
  const everyone = () => {
    const state = loadVault(root);
    return state.status === 'ok' ? Object.keys(state.vault.users) : [];
  };
  for (const username of audienceOf(room, everyone)) {
    if (!listening.has(username) || !isNewsFor(m, username)) continue;
    publishToUser(username, { type: 'unread', url: room.url, title: room.title, ...unreadIn(root, username, room.url, room.dir) });
  }
}

/** A person read a room up to a message: their other pages learn the count is now zero. */
export function noteRead(root: string, username: string, room: Room, id: number): void {
  if (!markRead(root, username, room.url, id)) return;
  if (room.kind === 'thread') return;
  publishToUser(username, { type: 'unread', url: room.url, title: room.title, ...unreadIn(root, username, room.url, room.dir) });
}
