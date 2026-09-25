import * as fs from 'fs';
import * as path from 'path';
import { BackupLayout } from '../../mochiforge/src/api/backup';
import { BackupProfile } from '../../mochiforge/src/cli/backup-cmd';
import { CONFIG_FILE } from './config';
import { channelsDir, dmsDir, usersDir } from './workspace';

// Backing up a workspace, with mochi's protocol and mochi's client. A
// workspace is a directory, and every part of it is ordinary files, so it
// needs no transport of its own: the manifest names the state files at the
// root and every file under channels/ and dms/, and the client fetches what
// changed. There are no repositories, so no mirrors, and the backup
// directory's current/ is a servable workspace, exactly as a vault backup's
// is a servable vault.

/** The state files at the workspace root. Nothing else there belongs to a workspace. */
const ROOT_FILES = ['workspace.json', CONFIG_FILE, '.secret'];

/** Which of those `--no-secrets` leaves out. config.json holds no credential. */
const SECRET_FILES = new Set(['workspace.json', '.secret']);

/**
 * An uploads directory: a `files/` that sits beside a `messages/`, which is
 * true of a channel, a conversation, and a thread, and of nothing else. The
 * check is on the sibling rather than on depth, so a channel named "files"
 * is not mistaken for one.
 */
function isUploadsDir(name: string, abs: string): boolean {
  return name === 'files' && fs.existsSync(path.join(path.dirname(abs), 'messages'));
}

export function workspaceLayout(root: string): BackupLayout {
  return {
    rootFiles: ROOT_FILES,
    secretFiles: SECRET_FILES,
    excludable: new Set(['files', 'secrets']),
    // The client warns when a vault keeps LFS objects outside itself; a
    // workspace keeps everything on the volume, which is what "volume" says.
    header: () => ({ lfs: 'volume' }),
    async walk(w, exclude) {
      const skip = exclude.has('files') ? isUploadsDir : undefined;
      if (!(await w.tree(channelsDir(root), skip))) return false;
      if (!(await w.tree(dmsDir(root), skip))) return false;
      return w.tree(usersDir(root));
    },
  };
}

export const DANGO_BACKUP: BackupProfile = {
  exclusions: [
    { category: 'files', summary: 'Leave out uploaded attachments (each room’s files/)' },
    { category: 'secrets', summary: 'Leave out workspace.json and .secret' },
  ],
  repos: false,
  description: `A workspace is a directory, so a backup of one is a directory too, and this makes
it over HTTP: it needs no shell on the server, no flyctl, and no rsync at the
far end, so it works the same against a Fly app, a VPS, a Docker deployment,
and 127.0.0.1:3000.

  <dir>/current      a servable workspace. Restoring is: dango serve <dir>/current
  <dir>/snapshots    hardlinked copies, each one also a servable workspace
  <dir>/backup.json  which workspace, what is left out, and how each run went

Every file - messages, threads, conversations, uploads, and the workspace's
state files - is compared by size and modification time and fetched only where
it differs, so a nightly run moves the day's messages and little else.

The token needs to belong to a site admin, because the copy includes
workspace.json. The workspace URL, the exclusions, and the retention policy are
recorded in backup.json, so a cron entry is this command and a directory.

There is no workspace-wide point-in-time image: the server holds no lock a
client could take, so a run is a walk of a live tree and can catch a mixed
vintage (a thread reply whose parent arrived in the previous run, say). Every
individual file in a backup is one that really existed. See docs/backup.md.

Related: dango backup list, verify, prune.`,
  verifyDescription: `Asks the workspace for hashes of every file and reports anything missing,
extra, or different. Exits non-zero when there is something to report, so it
can be run from cron.`,
  pruneDescription: `Grandfather-father-son: the newest snapshot of each of the last N days, weeks,
and months is kept and the rest are removed, evaluated in UTC. The newest
snapshot is always kept.`,
};
