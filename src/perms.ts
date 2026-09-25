import { AuthResult } from '../../mochiforge/src/vault';
import { ChannelInfo } from './channels';
import { DmInfo } from './dms';

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
//  - A message may be edited by its author, and deleted by its author or by a
//    site admin where the admin can see it at all.
//  - Site admins create and remove users, delete channels, and change
//    workspace settings.

export function isSiteAdmin(auth: AuthResult | null): boolean {
  return auth !== null && auth.user.siteAdmin === true;
}

export function canSeeChannel(auth: AuthResult | null, channel: ChannelInfo): boolean {
  if (!auth) return false;
  if (!channel.private) return true;
  return channel.members.includes(auth.username);
}

export function canSeeDm(auth: AuthResult | null, dm: DmInfo): boolean {
  return auth !== null && dm.participants.includes(auth.username);
}

export function canEditMessage(auth: AuthResult | null, author: string): boolean {
  return auth !== null && auth.username === author;
}

export function canDeleteMessage(auth: AuthResult | null, author: string): boolean {
  return auth !== null && (auth.username === author || isSiteAdmin(auth));
}
