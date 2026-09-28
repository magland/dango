import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mock, test } from 'node:test';
import { Response } from 'express';
import { readDoc, writeDoc } from '../../mochiforge/src/discussion';
import { bootstrapVault, addUserToken } from '../../mochiforge/src/vault';
import { parseReport } from '../src/calllog';
import { createChannel, readChannel } from '../src/channels';
import { loadConfig, moveTurnSecrets, updateConfig } from '../src/config';
import { openDm, readDm } from '../src/dms';
import { MAX_ATTACHMENTS, MAX_REACTIONS, addMessage, changedSince, countAfter, editMessage, readMessage, readMessages, toggleReaction } from '../src/messages';
import { MAX_UNSENT_BYTES, STALLED_BYTES, publish, serveEvents } from '../src/events';
import { forgetRoom, isRoomKey, readPrefs, setMuted, writePrefs } from '../src/notify';
import { postMessage } from '../src/post';
import { markRead, readMarkers } from '../src/reads';
import { channelRoom, removeWorkspaceUser } from '../src/rooms';
import { SCAN_LIMIT, searchMessages } from '../src/search';
import { channelDir, userDir } from '../src/workspace';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-hardening-'));
}

function auth(username: string) {
  return { username, user: { tokens: [] }, token: { hash: '' } };
}

test('a reaction kept under a name every object has stays a key like any other', () => {
  const room = tmp();
  const m = addMessage(room, { author: 'alice', body: 'x' });
  // Such names are not emoji and are refused as reactions, but a file edited
  // by hand, or written by an earlier version, can still hold them.
  const file = path.join(room, 'messages', `${m.id}.md`);
  const doc = readDoc(file)!;
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  writeDoc(file, { ...doc.meta, reactions: Object.fromEntries(names.map((e) => [e, ['bob']])) }, doc.body);
  for (const e of names) assert.throws(() => toggleReaction(room, m.id, e, 'carol'), /one emoji/, e);
  const after = toggleReaction(room, m.id, '\u{1F44D}', 'bob');
  for (const e of names) assert.deepStrictEqual(after.reactions[e], ['bob'], e);
  const back = readMessage(room, m.id)!;
  assert.deepStrictEqual(Object.keys(back.reactions).sort(), ['__proto__', 'constructor', 'hasOwnProperty', 'toString', '\u{1F44D}'].sort());
  assert.strictEqual(Object.getPrototypeOf(back.reactions), Object.prototype);
});

test('a reaction is one emoji, and a message gathers at most so many', () => {
  const room = tmp();
  const m = addMessage(room, { author: 'alice', body: 'x' });
  for (const e of ['ok', 'you are wrong', '1', '#', '\u{1F44D}\u{1F44D}', 'x\u{1F44D}', '\u{1F1EB}', '"><b>x</b>']) {
    assert.throws(() => toggleReaction(room, m.id, e, 'bob'), /one emoji/, e);
  }
  for (const e of ['\u{1F44D}\u{1F3FD}', '\u{1F1EB}\u{1F1F7}', '1\uFE0F\u20E3', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', ':tada:']) {
    assert.doesNotThrow(() => toggleReaction(room, m.id, e, 'bob'), e);
  }
  // Fill the message to the cap with distinct pictographs, then one more.
  const room2 = tmp();
  const m2 = addMessage(room2, { author: 'alice', body: 'x' });
  const faces = Array.from({ length: MAX_REACTIONS + 1 }, (_, i) => String.fromCodePoint(0x1f600 + i));
  for (const e of faces.slice(0, MAX_REACTIONS)) toggleReaction(room2, m2.id, e, 'bob');
  assert.throws(() => toggleReaction(room2, m2.id, faces[MAX_REACTIONS], 'bob'), /at most 50 different reactions/);
  assert.doesNotThrow(() => toggleReaction(room2, m2.id, faces[0], 'carol'), 'joining a reaction already there still works');
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

test('a page that lost its stream is told what changed meanwhile, and how far behind it is', () => {
  const room = tmp();
  const ids = [1, 2, 3, 4].map((i) => addMessage(room, { author: 'alice', body: `m${i}` }).id);
  assert.strictEqual(countAfter(room, 1), 3);
  const old = Date.now() - 60000;
  for (const id of ids) fs.utimesSync(path.join(room, 'messages', `${id}.md`), old / 1000, old / 1000);
  const since = Date.now() - 30000;
  assert.deepStrictEqual(changedSince(room, 4, since), []);
  editMessage(room, 2, 'edited');
  toggleReaction(room, 3, '👍', 'bob');
  addMessage(path.join(room, 'threads', '1'), { author: 'bob', body: 'a reply' });
  assert.deepStrictEqual(changedSince(room, 4, since).map((m) => m.id), [1, 2, 3]);
  assert.deepStrictEqual(changedSince(room, 2, since).map((m) => m.id), [1, 2], 'only what the page already has');
});

test('saving settings keeps what was written into config.json by hand', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ name: 'W', note: 'mine', limits: { future: 3 } }));
  updateConfig(root, { name: 'Renamed' });
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.strictEqual(raw.name, 'Renamed');
  assert.strictEqual(raw.note, 'mine');
  assert.strictEqual(raw.limits.future, 3);
  assert.strictEqual(loadConfig(root).name, 'Renamed');
});

test('a search says when some room was longer than it reads', () => {
  const root = tmp();
  createChannel(root, 'long', { createdBy: 'alice' });
  const dir = channelDir(root, 'long');
  addMessage(dir, { author: 'alice', body: 'needle' });
  // Settled long ago, so that the listing below is trusted until the
  // directory changes (see messageIds).
  const past = (Date.now() - 60000) / 1000;
  fs.utimesSync(path.join(dir, 'messages'), past, past);
  const info = { partial: false };
  assert.strictEqual(searchMessages(root, auth('alice'), 'needle', info).length, 1);
  assert.strictEqual(info.partial, false);
  fs.writeFileSync(path.join(dir, 'messages', `${SCAN_LIMIT + 1}.md`), '---\nauthor: bob\ncreated: 2026-01-01T00:00:00.000Z\n---\nlate\n');
  searchMessages(root, auth('alice'), 'needle', info);
  assert.strictEqual(info.partial, true);
});

/** A stream's response, with its unsent output set by the test. */
function stream() {
  const closers: (() => void)[] = [];
  const res = {
    writableLength: 0,
    destroyed: false,
    writes: 0,
    writeHead() {},
    write() {
      res.writes++;
      return true;
    },
    end() {
      res.destroy();
    },
    destroy() {
      if (res.destroyed) return;
      res.destroyed = true;
      closers.forEach((f) => f());
    },
    on(ev: string, fn: () => void) {
      if (ev === 'close') closers.push(fn);
    },
    status() {
      return res;
    },
    setHeader() {},
  };
  return res;
}

test('a stream whose reader has stopped reading is let go', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const url = '/c/stalled-test';
    const message = { id: 1, author: 'a', created: '', body: '', reactions: {}, files: [], replyCount: 0 };
    const slow = stream();
    serveEvents(slow as unknown as Response, 'reader', url, [], () => 'x', (p) => p, () => true);
    slow.writableLength = STALLED_BYTES + 10;
    mock.timers.tick(25000);
    assert.strictEqual(slow.destroyed, false, 'the first heartbeat sees the backlog');
    mock.timers.tick(25000);
    assert.strictEqual(slow.destroyed, true, 'a backlog that did not go down is a reader that stopped');

    const draining = stream();
    serveEvents(draining as unknown as Response, 'reader', url, [], () => 'x', (p) => p, () => true);
    draining.writableLength = STALLED_BYTES * 3;
    mock.timers.tick(25000);
    draining.writableLength = STALLED_BYTES * 2;
    mock.timers.tick(25000);
    assert.strictEqual(draining.destroyed, false, 'a slow reader that is taking its backlog is kept');

    const flooded = stream();
    serveEvents(flooded as unknown as Response, 'reader', url, [], () => 'x', (p) => p, () => true);
    flooded.writableLength = MAX_UNSENT_BYTES + 1;
    publish(url, { type: 'message', message });
    assert.strictEqual(flooded.destroyed, true, 'past the ceiling it goes at once');
    const writes = flooded.writes;
    publish(url, { type: 'message', message });
    assert.strictEqual(flooded.writes, writes, 'and hears nothing more');
    draining.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('the muted list holds only room keys, and only so many', () => {
  const root = tmp();
  for (const k of ['c/general', 'd/3']) assert.ok(isRoomKey(k), k);
  for (const k of ['', 'general', 'c/', 'c/Not-A-Name', 'd/0', 'd/x', 'x/1', 'c/general/t/4']) assert.ok(!isRoomKey(k), k);
  const many = Array.from({ length: 2000 }, (_, i) => `d/${i + 1}`);
  const prefs = writePrefs(root, 'alice', { ...readPrefs(root, 'alice'), muted: ['junk', 'c/general', ...many] });
  assert.strictEqual(prefs.muted[0], 'c/general');
  assert.strictEqual(prefs.muted.length, 500);
});
