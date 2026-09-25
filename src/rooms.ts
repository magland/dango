import { AuthResult } from '../../mochiforge/src/vault';
import { ChannelInfo, readChannel } from './channels';
import { DmInfo, dmTitle, readDm } from './dms';
import { readMessage, threadRoomDir } from './messages';
import { canSeeChannel, canSeeDm } from './perms';
import { channelDir, dmDir } from './workspace';

// One description of "the place a message lives", resolved from a URL and
// already checked against the viewer. Channels, conversations, and threads
// all hold messages the same way on disk (see src/messages.ts); a Room is the
// directory plus what the interface needs to name and link it. Every route
// that touches messages resolves a Room first, so there is one place a
// permission check can be forgotten instead of a dozen.

export interface Room {
  /** The directory holding messages/, threads/, files/. */
  dir: string;
  /** The room's page: /c/general, /d/3, /c/general/t/14. */
  url: string;
  kind: 'channel' | 'dm' | 'thread';
  /** How the page titles it: "#general", "alice, bob", "Thread". */
  title: string;
  channel?: ChannelInfo;
  dm?: DmInfo;
  /** For a thread: the room it hangs off and the message it hangs from. */
  parent?: Room;
  threadOf?: number;
}

/** The channel as a room, or null when it is absent or not this viewer's to see. */
export function channelRoom(root: string, name: string, auth: AuthResult | null): Room | null {
  const channel = readChannel(root, name);
  if (!channel || !canSeeChannel(auth, channel)) return null;
  return {
    dir: channelDir(root, name),
    url: `/c/${encodeURIComponent(name)}`,
    kind: 'channel',
    title: `#${name}`,
    channel,
  };
}

export function dmRoom(root: string, id: number, auth: AuthResult | null): Room | null {
  const dm = readDm(root, id);
  if (!dm || !canSeeDm(auth, dm)) return null;
  return {
    dir: dmDir(root, id),
    url: `/d/${id}`,
    kind: 'dm',
    title: auth ? dmTitle(dm, auth.username) : dm.participants.join(', '),
    dm,
  };
}

/**
 * The thread hanging off one of a room's messages. The parent message must
 * exist, and threads do not nest: a thread's own messages have no threads.
 */
export function threadRoom(parent: Room, id: number): Room | null {
  if (parent.kind === 'thread') return null;
  const anchor = readMessage(parent.dir, id);
  if (!anchor) return null;
  return {
    dir: threadRoomDir(parent.dir, id),
    url: `${parent.url}/t/${id}`,
    kind: 'thread',
    title: 'Thread',
    channel: parent.channel,
    dm: parent.dm,
    parent,
    threadOf: id,
  };
}
