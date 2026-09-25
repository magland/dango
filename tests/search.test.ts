import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AuthResult } from '../../mochiforge/src/vault';
import { createChannel } from '../src/channels';
import { openDm } from '../src/dms';
import { addMessage, deleteMessage, threadRoomDir } from '../src/messages';
import { searchMessages } from '../src/search';
import { channelDir, dmDir } from '../src/workspace';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-search-'));
}

function auth(username: string): AuthResult {
  return { username, user: { tokens: [] }, token: { hash: '' } };
}

test('search finds messages across channels, threads, and conversations the viewer can read', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  createChannel(root, 'secret', { private: true, createdBy: 'alice' });
  const general = channelDir(root, 'general');
  const m = addMessage(general, { author: 'alice', body: 'the deploy went out' });
  addMessage(threadRoomDir(general, m.id), { author: 'bob', body: 'deploy confirmed on the replica' });
  addMessage(channelDir(root, 'secret'), { author: 'alice', body: 'deploy keys rotated' });
  const dm = openDm(root, ['alice', 'bob']);
  addMessage(dmDir(root, dm.id), { author: 'bob', body: 'psst, deploy friday' });

  const forBob = searchMessages(root, auth('bob'), 'deploy');
  const where = forBob.map((h) => h.where).sort();
  // bob is not in #secret, so its hit never appears for him.
  assert.deepStrictEqual(where, ['#general', '#general (thread)', 'alice']);

  const forAlice = searchMessages(root, auth('alice'), 'deploy');
  assert.strictEqual(forAlice.length, 4);
});

test('deleted messages and case differences behave', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  const general = channelDir(root, 'general');
  const m = addMessage(general, { author: 'alice', body: 'FORGOTTEN thing' });
  assert.strictEqual(searchMessages(root, auth('alice'), 'forgotten').length, 1);
  deleteMessage(general, m.id);
  assert.strictEqual(searchMessages(root, auth('alice'), 'forgotten').length, 0);
  assert.strictEqual(searchMessages(root, auth('alice'), '   ').length, 0);
});
