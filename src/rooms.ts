import * as fs from 'fs';
import { AuthResult, removeUser } from '../../mochiforge/src/vault';
import { ChannelInfo, leaveAllChannels, readChannel } from './channels';
import { DmInfo, dmTitle, leaveAllDms, readDm } from './dms';
import { MeetingInfo, leaveAllMeetings, readMeeting } from './meetings';
import { readMessage, threadRoomDir } from './messages';
import { canSeeChannel, canSeeDm, canSeeMeeting } from './perms';
import { channelDir, dmDir, isValidWorkspaceUserName, meetingDir, userDir } from './workspace';

// One description of "the place a message lives", resolved from a URL and
// already checked against the viewer. Channels, conversations, and threads
// all hold messages the same way on disk (see src/messages.ts); a Room is the
// directory plus what the interface needs to name and link it. Every route
// that touches messages resolves a Room first, so there is one place a
// permission check can be forgotten instead of a dozen.

export interface Room {
  /** The directory holding messages/, threads/, files/. */
  dir: string;
  /** The room's page: /c/general, /d/3, /m/2, /c/general/t/14. */
  url: string;
  kind: 'channel' | 'dm' | 'meeting' | 'thread';
  /** How the page titles it: "#general", "alice, bob", "Weekly sync", "Thread". */
  title: string;
  channel?: ChannelInfo;
  dm?: DmInfo;
  meeting?: MeetingInfo;
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

export function meetingRoom(root: string, id: number, auth: AuthResult | null): Room | null {
  const meeting = readMeeting(root, id);
  if (!meeting || !canSeeMeeting(auth, meeting)) return null;
  return {
    dir: meetingDir(root, id),
    url: `/m/${id}`,
    kind: 'meeting',
    title: meeting.title,
    meeting,
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
    meeting: parent.meeting,
    parent,
    threadOf: id,
  };
}

/**
 * Remove a person from the workspace. Their tokens go with their entry in
 * workspace.json, and so does everything else that is decided by their
 * name: private channels, conversations, and meetings let people in by name, and
 * users/<name>/ holds the browsers their notifications go to. Leaving those
 * behind would hand them to whoever is given the same name next. Their
 * messages stay, signed with the name they were written under.
 */
export function removeWorkspaceUser(root: string, username: string): boolean {
  if (!removeUser(root, username)) return false;
  leaveAllChannels(root, username);
  leaveAllDms(root, username);
  leaveAllMeetings(root, username);
  if (isValidWorkspaceUserName(username)) fs.rmSync(userDir(root, username), { recursive: true, force: true });
  return true;
}
