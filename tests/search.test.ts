import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AuthResult } from '../../mochiforge/src/vault';
import { createChannel } from '../src/channels';
import { openDm } from '../src/dms';
import { ROOM_PAGE, addMessage, deleteMessage, threadRoomDir } from '../src/messages';
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

test('from: and in: narrow a search, and alone list what they allow', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  createChannel(root, 'random', { createdBy: 'alice' });
  createChannel(root, 'secret', { private: true, createdBy: 'alice' });
  addMessage(channelDir(root, 'general'), { author: 'alice', body: 'lunch at noon' });
  addMessage(channelDir(root, 'general'), { author: 'bob', body: 'lunch sounds good' });
  addMessage(channelDir(root, 'random'), { author: 'bob', body: 'lunch photos' });
  addMessage(channelDir(root, 'secret'), { author: 'alice', body: 'secret lunch' });
  const dm = openDm(root, ['alice', 'bob']);
  addMessage(dmDir(root, dm.id), { author: 'alice', body: 'lunch?' });

  const bodies = (q: string, who = 'bob') => searchMessages(root, auth(who), q).map((h) => h.message.body).sort();
  assert.deepStrictEqual(bodies('lunch from:bob'), ['lunch photos', 'lunch sounds good']);
  assert.deepStrictEqual(bodies('lunch from:@Alice'), ['lunch at noon', 'lunch?']);
  assert.deepStrictEqual(bodies('lunch in:#general'), ['lunch at noon', 'lunch sounds good']);
  assert.deepStrictEqual(bodies('in:alice'), ['lunch?']);
  assert.deepStrictEqual(bodies('from:bob in:random'), ['lunch photos']);
  // A filter does not open a channel the viewer cannot read.
  assert.deepStrictEqual(bodies('in:secret'), []);
  assert.deepStrictEqual(bodies('in:secret', 'alice'), ['secret lunch']);
});

test('a hit links to its message, and one older than the room page shows as its thread', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  const general = channelDir(root, 'general');
  const old = addMessage(general, { author: 'alice', body: 'an old needle' });
  for (let i = 0; i < ROOM_PAGE; i++) addMessage(general, { author: 'alice', body: `filler ${i}` });
  const recent = addMessage(general, { author: 'alice', body: 'a new needle' });
  const dm = openDm(root, ['alice', 'bob']);
  addMessage(dmDir(root, dm.id), { author: 'bob', body: 'a needle in private' });
  const hits = searchMessages(root, auth('alice'), 'needle');
  const byBody = new Map(hits.map((h) => [h.message.body, h]));
  assert.strictEqual(byBody.get('a new needle')!.url, `/c/general#msg-${recent.id}`);
  assert.strictEqual(byBody.get('an old needle')!.url, `/c/general/t/${old.id}`);
  assert.strictEqual(byBody.get('an old needle')!.room, '/c/general');
  assert.strictEqual(byBody.get('a needle in private')!.kind, 'dm');
  assert.strictEqual(byBody.get('a new needle')!.kind, 'channel');
});
