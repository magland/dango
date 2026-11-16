import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AuthResult, addUserToken } from '../../mochiforge/src/vault';
import { createChannel } from '../src/channels';
import { openDm } from '../src/dms';
import { addMessage, deleteMessage, readMessage, threadRoomDir } from '../src/messages';
import { audienceOf, followThread, followedThreads, markRead, mentionsUser, newReplies, readMarkers, threadsUnread, unreadIn, unreadRooms } from '../src/reads';
import { postMessage } from '../src/post';
import { channelRoom, dmRoom, threadRoom } from '../src/rooms';
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

test('new replies are counted in a thread the user follows: opened, replied in, or hung off their message', () => {
  const root = tmpRoot();
  for (const u of ['alice', 'bob', 'carol']) addUserToken(root, u, {});
  createChannel(root, 'general', { createdBy: 'alice' });
  const general = channelRoom(root, 'general', auth('alice'))!;
  const m = postMessage(root, general, { author: 'alice', body: 'question' });
  const thread = threadRoom(general, m.id)!;
  const anchor = () => readMessage(general.dir, m.id)!;
  assert.strictEqual(newReplies(root, 'alice', '/c/general', general.dir, anchor()), 0);
  postMessage(root, thread, { author: 'bob', body: 'answer' });
  // The reply made alice follow her message's thread; carol never looked into it.
  assert.strictEqual(readMarkers(root, 'alice')['c/general/t/1'], 0);
  assert.strictEqual(newReplies(root, 'alice', '/c/general', general.dir, anchor()), 1);
  assert.strictEqual(newReplies(root, 'carol', '/c/general', general.dir, anchor()), 0);
  assert.strictEqual(newReplies(root, 'bob', '/c/general', general.dir, anchor()), 0);
  markRead(root, 'alice', '/c/general/t/1', 1);
  markRead(root, 'carol', '/c/general/t/1', 1);
  postMessage(root, thread, { author: 'alice', body: 'thanks' });
  const gone = postMessage(root, thread, { author: 'bob', body: 'oops' });
  deleteMessage(thread.dir, gone.id);
  postMessage(root, thread, { author: 'bob', body: 'one more thing' });
  // Your own replies and deleted ones are not news, and sending one reads the thread.
  assert.strictEqual(newReplies(root, 'alice', '/c/general', general.dir, anchor()), 1);
  assert.strictEqual(newReplies(root, 'carol', '/c/general', general.dir, anchor()), 2);
  assert.strictEqual(newReplies(root, 'bob', '/c/general', general.dir, anchor()), 0);
});

test('following a thread never unreads it', () => {
  const root = tmpRoot();
  markRead(root, 'alice', '/c/general/t/3', 4);
  followThread(root, 'alice', '/c/general/t/3');
  followThread(root, 'alice', '/c/general/t/5');
  assert.deepStrictEqual(readMarkers(root, 'alice'), { 'c/general/t/3': 4, 'c/general/t/5': 0 });
});

test('the threads a user follows are those in rooms they can still see, with their counts', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  createChannel(root, 'secret', { createdBy: 'alice', private: true });
  const general = channelDir(root, 'general');
  const secret = channelDir(root, 'secret');
  const a = addMessage(general, { author: 'alice', body: 'one' });
  const b = addMessage(secret, { author: 'alice', body: 'two' });
  addMessage(threadRoomDir(general, a.id), { author: 'bob', body: 'reply, @carol' });
  addMessage(threadRoomDir(secret, b.id), { author: 'bob', body: 'secret reply' });
  for (const t of ['/c/general/t/1', '/c/secret/t/1']) followThread(root, 'carol', t);
  // Carol is not in #secret, so its thread is not hers to see, whatever read.json says.
  assert.deepStrictEqual(
    followedThreads(root, auth('carol')).map((t) => [t.url, t.count, t.mentions]),
    [['/c/general/t/1', 1, 1]]
  );
  assert.deepStrictEqual(threadsUnread(root, auth('carol')), { count: 1, mentions: 1 });
  assert.deepStrictEqual(threadsUnread(root, auth('dave')), { count: 0, mentions: 0 });
});

test('a reply makes whoever it or the message @mentions follow the thread, if the room reaches them', () => {
  const root = tmpRoot();
  for (const u of ['alice', 'bob', 'carol', 'dave', 'erin']) addUserToken(root, u, {});
  createChannel(root, 'general', { createdBy: 'alice' });
  createChannel(root, 'secret', { createdBy: 'alice', private: true });
  const general = channelRoom(root, 'general', auth('alice'))!;
  const m = postMessage(root, general, { author: 'alice', body: 'what do you think, @dave?' });
  postMessage(root, threadRoom(general, m.id)!, { author: 'bob', body: 'ask @carol too' });
  const followed = (u: string) => readMarkers(root, u)['c/general/t/1'];
  assert.strictEqual(followed('alice'), 0);
  assert.strictEqual(followed('bob'), 1);
  assert.strictEqual(followed('carol'), 0);
  assert.strictEqual(followed('dave'), 0);
  assert.strictEqual(followed('erin'), undefined);
  // A private channel reaches its members only, so a mention does not reach past them.
  const secret = channelRoom(root, 'secret', auth('alice'))!;
  const s = postMessage(root, secret, { author: 'alice', body: 'between us' });
  postMessage(root, threadRoom(secret, s.id)!, { author: 'alice', body: 'should @erin know?' });
  assert.strictEqual(readMarkers(root, 'erin')['c/secret/t/1'], undefined);
});

test('a reply in a direct conversation makes everyone in it follow the thread', () => {
  const root = tmpRoot();
  for (const u of ['alice', 'bob', 'carol', 'dave']) addUserToken(root, u, {});
  const d = openDm(root, ['alice', 'bob', 'carol']);
  const room = dmRoom(root, d.id, auth('alice'))!;
  const m = postMessage(root, room, { author: 'alice', body: 'plans for Friday' });
  postMessage(root, threadRoom(room, m.id)!, { author: 'bob', body: 'I can do the morning' });
  const key = `d/${d.id}/t/${m.id}`;
  assert.strictEqual(readMarkers(root, 'carol')[key], 0);
  assert.strictEqual(readMarkers(root, 'dave')[key], undefined);
  assert.deepStrictEqual(threadsUnread(root, auth('carol')), { count: 1, mentions: 0 });
  assert.deepStrictEqual(threadsUnread(root, auth('alice')), { count: 1, mentions: 0 });
  assert.deepStrictEqual(threadsUnread(root, auth('bob')), { count: 0, mentions: 0 });
});
