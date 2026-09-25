import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AuthResult } from '../../mochiforge/src/vault';
import { createChannel } from '../src/channels';
import { openDm } from '../src/dms';
import { addMessage, deleteMessage } from '../src/messages';
import { audienceOf, markRead, mentionsUser, readMarkers, unreadIn, unreadRooms } from '../src/reads';
import { channelDir, dmDir } from '../src/workspace';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-reads-'));
}

function auth(username: string): AuthResult {
  return { username, user: { tokens: [] }, token: { hash: '' } };
}

test('unread is what others wrote after the marker, deletions and your own excluded', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  const dir = channelDir(root, 'general');
  addMessage(dir, { author: 'alice', body: 'one' });
  addMessage(dir, { author: 'bob', body: 'two' });
  const gone = addMessage(dir, { author: 'bob', body: 'three' });
  deleteMessage(dir, gone.id);
  addMessage(dir, { author: 'bob', body: 'four, @alice look' });
  assert.deepStrictEqual(unreadIn(root, 'alice', '/c/general', dir), { count: 2, mentions: 1 });
  assert.deepStrictEqual(unreadIn(root, 'bob', '/c/general', dir), { count: 1, mentions: 0 });
  markRead(root, 'alice', '/c/general', 4);
  assert.deepStrictEqual(unreadIn(root, 'alice', '/c/general', dir), { count: 0, mentions: 0 });
});

test('the marker only moves forward, and lives in users/<name>/read.json', () => {
  const root = tmpRoot();
  assert.strictEqual(markRead(root, 'alice', '/c/general', 5), true);
  assert.strictEqual(markRead(root, 'alice', '/c/general', 3), false);
  assert.strictEqual(markRead(root, 'alice', '/c/general', 5), false);
  assert.strictEqual(markRead(root, 'alice', '/c/general', 6), true);
  assert.deepStrictEqual(readMarkers(root, 'alice'), { 'c/general': 6 });
  assert.ok(fs.existsSync(path.join(root, 'users', 'alice', 'read.json')));
});

test('mentions follow the renderer’s rule: a name after an @, not inside a word or an address', () => {
  assert.ok(mentionsUser('hey @alice', 'alice'));
  assert.ok(mentionsUser('@Alice?', 'alice'));
  assert.ok(!mentionsUser('mail@alice.example', 'alice'));
  assert.ok(!mentionsUser('@alicia', 'alice'));
  assert.ok(!mentionsUser('alice', 'alice'));
});

test('unreadRooms lists every room the viewer can see, in sidebar order', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  createChannel(root, 'secret', { private: true, createdBy: 'alice' });
  const dm = openDm(root, ['alice', 'bob']);
  addMessage(dmDir(root, dm.id), { author: 'bob', body: 'hi' });
  const forAlice = unreadRooms(root, auth('alice'));
  assert.deepStrictEqual(forAlice.map((r) => r.url), ['/c/general', '/c/secret', `/d/${dm.id}`]);
  assert.strictEqual(forAlice[2].count, 1);
  assert.strictEqual(forAlice[2].title, 'bob');
  const forCarol = unreadRooms(root, auth('carol'));
  assert.deepStrictEqual(forCarol.map((r) => r.url), ['/c/general']);
});

test('a room’s news reaches everyone, its members, or its participants', () => {
  const everyone = () => ['alice', 'bob', 'carol'];
  assert.deepStrictEqual(audienceOf({ channel: { name: 'g', topic: '', private: false, members: [] } }, everyone), everyone());
  assert.deepStrictEqual(audienceOf({ channel: { name: 's', topic: '', private: true, members: ['alice'] } }, everyone), ['alice']);
  assert.deepStrictEqual(audienceOf({ dm: { id: 1, participants: ['alice', 'bob'] } }, everyone), ['alice', 'bob']);
});
