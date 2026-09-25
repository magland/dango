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
 *   users/
 *     alice/
 *       read.json           the newest message she has seen in each room
 * ```
 *
 * Channels and conversations sit one level down in fixed directories for the
 * same reason a vault's collections do: the workspace has files of its own and
 * will have more, and holding the named things apart keeps a future file from
 * taking a name away from a channel that already exists.
 */
export const CHANNELS_DIR = 'channels';
export const DMS_DIR = 'dms';
/** Per-user state that is not identity: today, what each person has read. */
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

/**
 * A channel name: lowercase letters, digits, and interior hyphens, the way
 * Slack spells them. Length is bounded well below any filesystem limit
 * because the interface has to render these in a narrow sidebar.
 */
export function isValidChannelName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(name) && !name.includes('--');
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
  'login',
  'logout',
  'new',
  'search',
  'settings',
]);

export function isValidWorkspaceUserName(name: string): boolean {
  return isValidUserName(name) && !RESERVED_USER_NAMES.has(name.toLowerCase());
}
