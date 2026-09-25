import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ManifestWriter } from '../../mochiforge/src/api/backup';
import { workspaceLayout } from '../src/backup';
import { createChannel } from '../src/channels';
import { loadConfig, seedTrustProxy, updateConfig } from '../src/config';
import { openDm } from '../src/dms';
import { addMessage, filesDir, threadRoomDir } from '../src/messages';
import { channelDir, dmDir } from '../src/workspace';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-backup-'));
}

/** A writer that records the relative paths it is handed, walking directories as the real one does. */
function recorder(root: string): { writer: ManifestWriter; paths: string[] } {
  const paths: string[] = [];
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const tree = async (dir: string, skip?: (name: string, abs: string) => boolean): Promise<boolean> => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip?.(e.name, abs)) await tree(abs, skip);
      } else paths.push(rel(abs));
    }
    return true;
  };
  return {
    paths,
    writer: {
      file: async (abs) => {
        paths.push(rel(abs));
        return true;
      },
      tree,
      line: async () => true,
    },
  };
}

function populate(root: string): void {
  createChannel(root, 'general', { createdBy: 'alice' });
  // A channel named "files" is a channel, not an uploads directory.
  createChannel(root, 'files', { createdBy: 'alice' });
  const general = channelDir(root, 'general');
  const m = addMessage(general, { author: 'alice', body: 'with a file', files: [{ name: 'a.txt', size: 1 }] });
  fs.mkdirSync(filesDir(general, m.id), { recursive: true });
  fs.writeFileSync(path.join(filesDir(general, m.id), 'a.txt'), 'x');
  const thread = threadRoomDir(general, m.id);
  const r = addMessage(thread, { author: 'bob', body: 'reply with a file', files: [{ name: 'b.txt', size: 1 }] });
  fs.mkdirSync(filesDir(thread, r.id), { recursive: true });
  fs.writeFileSync(path.join(filesDir(thread, r.id), 'b.txt'), 'y');
  const dm = openDm(root, ['alice', 'bob']);
  addMessage(dmDir(root, dm.id), { author: 'alice', body: 'hi' });
}

test('the walk covers channels, threads, conversations, and uploads', async () => {
  const root = tmpRoot();
  populate(root);
  const { writer, paths } = recorder(root);
  await workspaceLayout(root).walk(writer, new Set());
  assert.ok(paths.includes('channels/general/messages/1.md'));
  assert.ok(paths.includes('channels/general/files/1/a.txt'));
  assert.ok(paths.includes('channels/general/threads/1/files/1/b.txt'));
  assert.ok(paths.includes('channels/files/channel.json'));
  assert.ok(paths.some((p) => p.startsWith('dms/1/messages/')));
});

test('--no-files leaves out every uploads directory and nothing else', async () => {
  const root = tmpRoot();
  populate(root);
  const { writer, paths } = recorder(root);
  await workspaceLayout(root).walk(writer, new Set(['files']));
  assert.ok(!paths.some((p) => p.endsWith('a.txt') || p.endsWith('b.txt')), 'no upload listed');
  assert.ok(paths.includes('channels/files/channel.json'), 'the channel named files survives');
  assert.ok(paths.includes('channels/general/threads/1/messages/1.md'));
});

test('trust proxy is seeded once, and a value set by hand sticks', () => {
  const root = tmpRoot();
  assert.strictEqual(seedTrustProxy(root), true);
  assert.strictEqual(loadConfig(root).network.trustProxy, true);
  updateConfig(root, { network: { trustProxy: false } });
  assert.strictEqual(seedTrustProxy(root), false);
  assert.strictEqual(loadConfig(root).network.trustProxy, false);
});
