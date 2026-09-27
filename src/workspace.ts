import * as path from 'path';
import { isValidUserName } from '../../mochiforge/src/scan';

/**
 * Where a workspace keeps the things a user named.
 *
 * A workspace is one directory, the way a mochiforge vault is: identity in
 * workspace.json, settings in config.json, the cookie-signing key in .secret,
 * and everything a user says under `channels/` and `dms/`. No database, no
 * state outside the directory; backup is `cp -a`.
 *
 * ```
 * <workspace>/
 *   workspace.json          users and hashed tokens (same shape as a vault's)
 *   config.json             workspace settings
 *   .secret
 *   channels/
 *     general/
 *       channel.json        topic, private flag, members
 *       messages/1.md ...   one markdown file per message
 *       threads/4/          replies to message 4, holding its own messages/
 *       files/4/photo.png   uploads attached to message 4
 *   dms/
 *     1/
 *       conversation.json   participants
 *       messages/ threads/ files/   exactly as a channel holds them
 *   meetings/
 *     1/
 *       meeting.json        title, members, the guests let in
 *       messages/ threads/ files/   exactly as a channel holds them
 *   users/
 *     alice/
 *       read.json           the newest message she has seen in each room
 *       notify.json         what she wants to be notified of
 *       push.json           the devices her notifications go to
 * ```
 *
 * Channels and conversations sit one level down in fixed directories for the
 * same reason a vault's collections do: the workspace has files of its own and
 * will have more, and holding the named things apart keeps a future file from
 * taking a name away from a channel that already exists.
 */
export const CHANNELS_DIR = 'channels';
export const DMS_DIR = 'dms';
export const MEETINGS_DIR = 'meetings';
/** Per-user state that is not identity: what each person has read, and their notifications. */
export const USERS_DIR = 'users';

export function usersDir(root: string): string {
  return path.join(root, USERS_DIR);
}

export function userDir(root: string, username: string): string {
  return path.join(root, USERS_DIR, username);
}

export function channelsDir(root: string): string {
  return path.join(root, CHANNELS_DIR);
}

export function channelDir(root: string, name: string): string {
  return path.join(root, CHANNELS_DIR, name);
}

export function dmsDir(root: string): string {
  return path.join(root, DMS_DIR);
}

export function dmDir(root: string, id: number): string {
  return path.join(root, DMS_DIR, String(id));
}

export function meetingsDir(root: string): string {
  return path.join(root, MEETINGS_DIR);
}

export function meetingDir(root: string, id: number): string {
  return path.join(root, MEETINGS_DIR, String(id));
}

/**
 * The name a meeting's guest goes by inside the workspace: a tilde and twelve
 * hex digits. A username starts with a letter or a digit, so no member can
 * ever hold one of these, and every check that finds a guest where a member
 * was expected (see src/perms.ts) can tell them apart by the name alone.
 */
export function isGuestName(name: string): boolean {
  return /^~[0-9a-f]{12}$/.test(name);
}

/**
 * A channel name: lowercase letters, digits, and interior hyphens, the way
 * Slack spells them. Length is bounded well below any filesystem limit
 * because the interface has to render these in a narrow sidebar.
 */
export function isValidChannelName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(name) && !name.includes('--');
}

/**
 * The nearest channel name to what someone typed: accents dropped, lowercase,
 * each run of anything else a single hyphen, none at either end. Empty when
 * nothing usable is left.
 */
export function channelNameFrom(text: string): string {
  const name = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return isValidChannelName(name) ? name : '';
}

/**
 * Names no user may take, because a top-level route answers to them: user
 * profiles live at `/<username>`, which is also where @mentions link (the
 * mention renderer is shared with mochiforge and links to `/<name>`), so
 * every top-level page the interface owns is a name a user may not be.
 */
const RESERVED_USER_NAMES = new Set([
  'c',
  'd',
  'u',
  'about',
  'account',
  'admin',
  'api',
  'assets',
  'events',
  'favicon.ico',
  'favicon.svg',
  'icon',
  'invite',
  'join',
  'login',
  'logout',
  'm',
  'manifest.webmanifest',
  'new',
  'push',
  'search',
  'settings',
  'sw.js',
]);

export function isValidWorkspaceUserName(name: string): boolean {
  return isValidUserName(name) && !RESERVED_USER_NAMES.has(name.toLowerCase());
}
