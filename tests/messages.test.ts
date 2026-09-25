import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  addMessage,
  deleteMessage,
  editMessage,
  lastMessageId,
  readMessage,
  readMessages,
  threadRoomDir,
  toggleReaction,
} from '../src/messages';

function tmpRoom(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-msg-'));
}

test('messages allocate sequential ids and read back oldest first', () => {
  const room = tmpRoom();
  const a = addMessage(room, { author: 'alice', body: 'first' });
  const b = addMessage(room, { author: 'bob', body: 'second' });
  assert.strictEqual(a.id, 1);
  assert.strictEqual(b.id, 2);
  const all = readMessages(room);
  assert.deepStrictEqual(all.map((m) => m.body), ['first', 'second']);
  assert.strictEqual(lastMessageId(room), 2);
});

test('before and after slice history the way paging and catch-up need', () => {
  const room = tmpRoom();
  for (let i = 1; i <= 5; i++) addMessage(room, { author: 'a', body: `m${i}` });
  assert.deepStrictEqual(readMessages(room, { before: 4 }).map((m) => m.id), [1, 2, 3]);
  assert.deepStrictEqual(readMessages(room, { after: 3 }).map((m) => m.id), [4, 5]);
  assert.deepStrictEqual(readMessages(room, { limit: 2 }).map((m) => m.id), [4, 5]);
});

test('an empty message is refused, an oversized one too', () => {
  const room = tmpRoom();
  assert.throws(() => addMessage(room, { author: 'a', body: '   ' }));
  assert.throws(() => addMessage(room, { author: 'a', body: 'x'.repeat(17 * 1024) }));
});

test('editing keeps the id and stamps edited; a deleted message refuses edits', () => {
  const room = tmpRoom();
  const m = addMessage(room, { author: 'a', body: 'draft' });
  const edited = editMessage(room, m.id, 'final');
  assert.strictEqual(edited.body, 'final');
  assert.ok(edited.edited);
  deleteMessage(room, m.id);
  assert.throws(() => editMessage(room, m.id, 'again'));
});

test('deleting leaves a tombstone rather than a hole', () => {
  const room = tmpRoom();
  const m = addMessage(room, { author: 'a', body: 'oops' });
  const gone = deleteMessage(room, m.id);
  assert.strictEqual(gone.deleted, true);
  assert.strictEqual(gone.body, '');
  // The number stays allocated: the next message takes the one after it.
  const next = addMessage(room, { author: 'a', body: 'later' });
  assert.strictEqual(next.id, m.id + 1);
});

test('reactions toggle per user and drop empty sets', () => {
  const room = tmpRoom();
  const m = addMessage(room, { author: 'a', body: 'hi' });
  toggleReaction(room, m.id, '👍', 'alice');
  toggleReaction(room, m.id, '👍', 'bob');
  let read = readMessage(room, m.id)!;
  assert.deepStrictEqual(read.reactions['👍'], ['alice', 'bob']);
  toggleReaction(room, m.id, '👍', 'alice');
  toggleReaction(room, m.id, '👍', 'bob');
  read = readMessage(room, m.id)!;
  assert.deepStrictEqual(read.reactions, {});
});

test('a thread is a room hung off a message, counted on the parent', () => {
  const room = tmpRoom();
  const m = addMessage(room, { author: 'a', body: 'anchor' });
  const thread = threadRoomDir(room, m.id);
  addMessage(thread, { author: 'b', body: 'reply one' });
  addMessage(thread, { author: 'a', body: 'reply two' });
  const read = readMessage(room, m.id)!;
  assert.strictEqual(read.replyCount, 2);
  assert.deepStrictEqual(readMessages(thread).map((r) => r.body), ['reply one', 'reply two']);
});

test('attachments ride in the frontmatter and survive a read', () => {
  const room = tmpRoom();
  const m = addMessage(room, { author: 'a', body: 'with a file', files: [{ name: 'x.png', size: 10 }] });
  const read = readMessage(room, m.id)!;
  assert.deepStrictEqual(read.files, [{ name: 'x.png', size: 10 }]);
});
