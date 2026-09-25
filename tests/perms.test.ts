import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AuthResult } from '../../mochiforge/src/vault';
import { addMember, createChannel, deleteChannel, listChannels, removeMember } from '../src/channels';
import { dmTitle, listDmsFor, openDm } from '../src/dms';
import { EDIT_WINDOW_MS, canDeleteMessage, canEditMessage, canSeeChannel, canSeeDm } from '../src/perms';
import { channelRoom, dmRoom, threadRoom } from '../src/rooms';
import { addMessage } from '../src/messages';
import { isValidChannelName, isValidWorkspaceUserName } from '../src/workspace';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-perm-'));
}

function auth(username: string, admin = false): AuthResult {
  return { username, user: { tokens: [], ...(admin ? { siteAdmin: true } : {}) }, token: { hash: '' } };
}

test('public channels are everyone’s; private ones are their members’ alone', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  createChannel(root, 'secret', { private: true, createdBy: 'alice' });
  const [general, secret] = [listChannels(root)[0], listChannels(root)[1]];
  assert.strictEqual(canSeeChannel(auth('bob'), general), true);
  assert.strictEqual(canSeeChannel(null, general), false);
  assert.strictEqual(canSeeChannel(auth('alice'), secret), true);
  assert.strictEqual(canSeeChannel(auth('bob'), secret), false);
  // The site admin manages the workspace, not other people's rooms.
  assert.strictEqual(canSeeChannel(auth('root', true), secret), false);
});

test('a private room resolves to null for an outsider, like an absent one', () => {
  const root = tmpRoot();
  createChannel(root, 'secret', { private: true, createdBy: 'alice' });
  assert.notStrictEqual(channelRoom(root, 'secret', auth('alice')), null);
  assert.strictEqual(channelRoom(root, 'secret', auth('bob')), null);
  assert.strictEqual(channelRoom(root, 'missing', auth('bob')), null);
});

test('membership edits apply to private channels only, and keep the last member', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  createChannel(root, 'secret', { private: true, createdBy: 'alice' });
  assert.throws(() => addMember(root, 'general', 'bob'));
  addMember(root, 'secret', 'bob');
  assert.deepStrictEqual(listChannels(root).find((c) => c.name === 'secret')!.members, ['alice', 'bob']);
  removeMember(root, 'secret', 'bob');
  assert.throws(() => removeMember(root, 'secret', 'alice'));
});

test('conversations belong to their participants and reuse one per set', () => {
  const root = tmpRoot();
  const dm = openDm(root, ['alice', 'bob']);
  assert.strictEqual(openDm(root, ['bob', 'alice']).id, dm.id);
  assert.strictEqual(canSeeDm(auth('alice'), dm), true);
  assert.strictEqual(canSeeDm(auth('carol'), dm), false);
  assert.strictEqual(canSeeDm(auth('root', true), dm), false);
  assert.strictEqual(dmRoom(root, dm.id, auth('carol')), null);
  assert.deepStrictEqual(listDmsFor(root, 'alice').map((d) => d.id), [dm.id]);
  assert.strictEqual(dmTitle(dm, 'alice'), 'bob');
});

test('editing is the author’s, for two hours; deleting is the author’s or a site admin’s', () => {
  const now = Date.now();
  const fresh = { author: 'alice', created: new Date(now - 60_000).toISOString() };
  const old = { author: 'alice', created: new Date(now - EDIT_WINDOW_MS - 1000).toISOString() };
  assert.strictEqual(canEditMessage(auth('alice'), fresh, now), true);
  assert.strictEqual(canEditMessage(auth('root', true), fresh, now), false);
  assert.strictEqual(canEditMessage(auth('alice'), old, now), false);
  assert.strictEqual(canEditMessage(auth('alice'), { author: 'alice', created: 'garbled' }, now), false);
  assert.strictEqual(canDeleteMessage(auth('alice'), 'alice'), true);
  assert.strictEqual(canDeleteMessage(auth('bob'), 'alice'), false);
  assert.strictEqual(canDeleteMessage(auth('root', true), 'alice'), true);
});

test('threads do not nest, and hang only off messages that exist', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  const room = channelRoom(root, 'general', auth('alice'))!;
  const m = addMessage(room.dir, { author: 'alice', body: 'anchor' });
  const thread = threadRoom(room, m.id);
  assert.notStrictEqual(thread, null);
  assert.strictEqual(threadRoom(room, 99), null);
  assert.strictEqual(threadRoom(thread!, 1), null);
});

test('names: channels are slack-shaped, usernames avoid the routed names', () => {
  assert.ok(isValidChannelName('general'));
  assert.ok(isValidChannelName('a-b-c'));
  assert.ok(!isValidChannelName('General'));
  assert.ok(!isValidChannelName('a--b'));
  assert.ok(!isValidChannelName('-x'));
  assert.ok(isValidWorkspaceUserName('alice'));
  assert.ok(!isValidWorkspaceUserName('admin'));
  assert.ok(!isValidWorkspaceUserName('c'));
  assert.ok(!isValidWorkspaceUserName('.hidden'));
});

test('deleting a channel removes it outright', () => {
  const root = tmpRoot();
  createChannel(root, 'doomed', { createdBy: 'alice' });
  deleteChannel(root, 'doomed');
  assert.deepStrictEqual(listChannels(root), []);
  assert.throws(() => deleteChannel(root, 'doomed'));
});
