import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { bootstrapVault, addUserToken } from '../../mochiforge/src/vault';
import { parseReport } from '../src/calllog';
import { createChannel, readChannel } from '../src/channels';
import { loadConfig, moveTurnSecrets } from '../src/config';
import { openDm, readDm } from '../src/dms';
import { MAX_ATTACHMENTS, addMessage, readMessage, readMessages, toggleReaction } from '../src/messages';
import { forgetRoom, readPrefs, setMuted } from '../src/notify';
import { postMessage } from '../src/post';
import { markRead, readMarkers } from '../src/reads';
import { channelRoom, removeWorkspaceUser } from '../src/rooms';
import { channelDir, userDir } from '../src/workspace';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-hardening-'));
}

function auth(username: string) {
  return { username, user: { tokens: [] }, token: { hash: '' } };
}

test('a reaction may be spelled like a property every object has', () => {
  const room = tmp();
  const m = addMessage(room, { author: 'alice', body: 'x' });
  for (const e of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const after = toggleReaction(room, m.id, e, 'bob');
    assert.deepStrictEqual(after.reactions[e], ['bob'], e);
  }
  const back = readMessage(room, m.id)!;
  assert.deepStrictEqual(Object.keys(back.reactions).sort(), ['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
  toggleReaction(room, m.id, '__proto__', 'bob');
  assert.strictEqual(Object.keys(readMessage(room, m.id)!.reactions).includes('__proto__'), false);
});

test('a message carries at most so many files', () => {
  const room = tmp();
  const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ name: `f${i}`, size: 1 }));
  assert.throws(() => addMessage(room, { author: 'alice', body: '', files }), /at most 50 files/);
});

test('a send whose attachments cannot be written leaves no message behind', () => {
  const root = tmp();
  createChannel(root, 'general', { createdBy: 'alice' });
  const room = channelRoom(root, 'general', auth('alice'))!;
  const input = { author: 'alice', body: 'with a file', files: [{ name: 'a.txt', size: 1 }], nonce: 'n'.repeat(16) };
  assert.throws(() =>
    postMessage(root, room, input, {
      settle: () => {
        throw new Error('ENAMETOOLONG');
      },
    })
  );
  assert.strictEqual(readMessages(room.dir, {}).length, 0);
  // The retry, with the same nonce, sends it afresh.
  const m = postMessage(root, room, input, { settle: () => {} });
  assert.strictEqual(m.body, 'with a file');
  assert.strictEqual(readMessages(room.dir, {}).length, 1);
});

test('a call report cannot write a line of its own into the log', () => {
  const r = parseReport({ outcome: 'failed', errors: [{ url: 'turn:x', code: 1, text: 'boom\ncall: forged\r\u2028' }] })!;
  assert.ok(r);
  assert.strictEqual(/[\n\r\u2028]/.test(r.errors[0].text), false);
});

test('a channel.json that does not parse hides the channel rather than opening it', () => {
  const root = tmp();
  createChannel(root, 'hush', { createdBy: 'alice', private: true });
  fs.writeFileSync(path.join(channelDir(root, 'hush'), 'channel.json'), '{ not json');
  const info = readChannel(root, 'hush')!;
  assert.strictEqual(info.private, true);
  assert.deepStrictEqual(info.members, []);
  assert.strictEqual(channelRoom(root, 'hush', auth('bob')), null);
});

test('TURN credentials left in config.json move to .turn, keeping what .turn has', () => {
  const root = tmp();
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ name: 'W', extra: 1, calls: { turn: { mode: 'coturn', urls: ['turn:t'], secret: 'from-config', credential: 'c' } } })
  );
  fs.writeFileSync(path.join(root, '.turn'), JSON.stringify({ credential: 'held' }));
  assert.strictEqual(moveTurnSecrets(root), true);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.strictEqual(config.extra, 1, 'the rest of config.json is kept as it was');
  assert.strictEqual('secret' in config.calls.turn || 'credential' in config.calls.turn, false);
  const turn = JSON.parse(fs.readFileSync(path.join(root, '.turn'), 'utf8'));
  assert.strictEqual(turn.secret, 'from-config');
  assert.strictEqual(turn.credential, 'held');
  assert.strictEqual(loadConfig(root).calls.turn.secret, 'from-config');
  assert.strictEqual(moveTurnSecrets(root), false, 'a second start has nothing to move');
});

test('a removed user leaves every room, and a new user of that name inherits none', () => {
  const root = tmp();
  bootstrapVault(root, null);
  addUserToken(root, 'alice', {});
  addUserToken(root, 'sam', {});
  createChannel(root, 'hush', { createdBy: 'alice', private: true });
  createChannel(root, 'solo', { createdBy: 'sam', private: true });
  const ch = readChannel(root, 'hush')!;
  fs.writeFileSync(path.join(channelDir(root, 'hush'), 'channel.json'), JSON.stringify({ ...ch, members: ['alice', 'sam'] }));
  const dm = openDm(root, ['alice', 'sam']);
  markRead(root, 'sam', '/c/hush', 3);

  assert.strictEqual(removeWorkspaceUser(root, 'sam'), true);
  assert.deepStrictEqual(readChannel(root, 'hush')!.members, ['alice']);
  assert.deepStrictEqual(readChannel(root, 'solo')!.members, []);
  assert.strictEqual(fs.existsSync(userDir(root, 'sam')), false);
  const after = readDm(root, dm.id)!;
  assert.deepStrictEqual(after.participants, ['alice']);
  assert.deepStrictEqual(after.former, ['sam']);

  addUserToken(root, 'sam', {});
  assert.strictEqual(channelRoom(root, 'hush', auth('sam')), null);
  assert.notStrictEqual(openDm(root, ['alice', 'sam']).id, dm.id, 'a new conversation, not the old one');
  assert.strictEqual(removeWorkspaceUser(root, 'nobody'), false);
});

test('a deleted room is forgotten in everyone’s markers and mutes', () => {
  const root = tmp();
  markRead(root, 'bob', '/c/bar', 30);
  markRead(root, 'bob', '/c/bar/t/4', 2);
  markRead(root, 'bob', '/c/barn', 5);
  setMuted(root, 'bob', '/c/bar', true);
  setMuted(root, 'bob', '/c/barn', true);
  forgetRoom(root, '/c/bar');
  assert.deepStrictEqual(readMarkers(root, 'bob'), { 'c/barn': 5 });
  assert.deepStrictEqual(readPrefs(root, 'bob').muted, ['c/barn']);
});
