import { AuthResult } from '../../mochiforge/src/vault';
import { ChannelInfo } from './channels';
import { DmInfo } from './dms';
import { MeetingInfo, isCurrentGuest } from './meetings';
import { isGuestName } from './workspace';

// Who may do what, in one place, the way mochiforge keeps it in its perms.ts.
// The model is smaller than a forge's because a chat's is: there are members
// and there are site admins, and beyond that everything follows from where a
// thing is.
//
//  - Reading anything requires being signed in. A workspace is members-only;
//    there is no anonymous surface at all.
//  - Public channels are readable and postable by every member.
//  - A private channel is visible to its members and to nobody else, the site
//    admin included: an admin manages users and settings, not other people's
//    rooms. (The operator can read the files on disk; that is stated rather
//    than pretended away.)
//  - A direct conversation is visible to its participants and to nobody else.
//  - A meeting is visible to its members, and to the guests let in through
//    its link. A guest is not a member of the workspace and sees nothing
//    else in it: every other check below says no to a guest by name, so a
//    guest's identity handed somewhere it was not meant for opens nothing.
//  - A message may be edited by its author, and deleted by its author or by a
//    site admin where the admin can see it at all.
//  - Site admins create and remove users, delete channels, and change
//    workspace settings.

/** Whether this is a meeting's guest rather than a member of the workspace. */
export function isGuest(auth: AuthResult | null): boolean {
  return auth !== null && isGuestName(auth.username);
}

export function isSiteAdmin(auth: AuthResult | null): boolean {
  return auth !== null && !isGuest(auth) && auth.user.siteAdmin === true;
}

export function canSeeChannel(auth: AuthResult | null, channel: ChannelInfo): boolean {
  if (!auth || isGuest(auth)) return false;
  if (!channel.private) return true;
  return channel.members.includes(auth.username);
}

export function canSeeDm(auth: AuthResult | null, dm: DmInfo): boolean {
  return auth !== null && !isGuest(auth) && dm.participants.includes(auth.username);
}

export function canSeeMeeting(auth: AuthResult | null, meeting: MeetingInfo): boolean {
  if (!auth) return false;
  return isGuest(auth) ? isCurrentGuest(meeting, auth.username) : meeting.members.includes(auth.username);
}

/**
 * How long after sending a message its author may still edit it. Past this a
 * message stands as it was read; deleting it remains possible.
 */
export const EDIT_WINDOW_MS = 2 * 60 * 60 * 1000;

export const EDIT_WINDOW_PASSED = 'A message can be edited for two hours after it is sent.';

export const CALL_NOT_EDITABLE = "A call's entry is kept by the call and cannot be edited.";

/** Whether a message is still inside its edit window. A timestamp that does not parse is outside it. */
export function withinEditWindow(created: string, now: number = Date.now()): boolean {
  const t = Date.parse(created);
  return Number.isFinite(t) && now - t < EDIT_WINDOW_MS;
}

/** The author may edit, and only within the edit window. A call's entry is written by the call, not by its author. */
export function canEditMessage(auth: AuthResult | null, m: { author: string; created: string; call?: unknown }, now?: number): boolean {
  return auth !== null && auth.username === m.author && !m.call && withinEditWindow(m.created, now);
}

export function canDeleteMessage(auth: AuthResult | null, author: string): boolean {
  return auth !== null && (auth.username === author || isSiteAdmin(auth));
}
