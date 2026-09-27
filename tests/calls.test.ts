import '../src/branding';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { Response } from 'express';
import { AuthResult, addUserToken } from '../../mochiforge/src/vault';
import { CLIENT_GRACE_MS, MAX_IN_CALL, joinCall, leaveCall, liveCall, pruneCalls, relaySignals, resetCalls } from '../src/calls';
import { addMember, createChannel, removeMember } from '../src/channels';
import { DEFAULT_STUN, CallsConfig, loadConfig } from '../src/config';
import { openDm } from '../src/dms';
import { ClientEvent, clientOwner, serveUserEvents } from '../src/events';
import { coturnCredential, iceFor, sanitizeIceServers, turnProblem } from '../src/ice';
import { readMessages } from '../src/messages';
import { DEFAULT_PREFS, wantsPush } from '../src/notify';
import { canEditMessage } from '../src/perms';
import { channelRoom, dmRoom } from '../src/rooms';
import { callLength } from '../src/views';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-calls-'));
}

function auth(username: string): AuthResult {
  return { username, user: { tokens: [] }, token: { hash: '' } };
}

/** A page's event stream, as serveUserEvents writes it, with what it was sent. */
function page(username: string, id: string) {
  const events: ClientEvent[] = [];
  const closers: (() => void)[] = [];
  const res = {
    writeHead() {},
    write(chunk: string) {
      const m = /^data: (.*)$/m.exec(chunk);
      if (m) events.push(JSON.parse(m[1]));
      return true;
    },
    on(ev: string, fn: () => void) {
      if (ev === 'close') closers.push(fn);
    },
  } as unknown as Response;
  serveUserEvents(res, username, id);
  return {
    id,
    events,
    close: () => closers.forEach((f) => f()),
    last: (type: string) => [...events].reverse().find((e) => e.type === type) as Record<string, unknown> | undefined,
  };
}

const pages: ReturnType<typeof page>[] = [];
function open(username: string, n: number) {
  const p = page(username, n.toString(16).padStart(32, '0'));
  pages.push(p);
  return p;
}

afterEach(() => {
  for (const p of pages.splice(0)) p.close();
  resetCalls();
  mock.timers.reset();
});

function calls(over: Partial<CallsConfig['turn']> = {}, stun = ['stun:stun.example.org:3478']): CallsConfig {
  return { stun, turn: { mode: 'none', urls: [], username: '', credential: '', secret: '', keyId: '', apiToken: '', ...over } };
}

// ---- ICE servers ----

test('a coturn credential is the TURN REST scheme: expiry and name, signed with the secret', () => {
  const now = Date.UTC(2026, 8, 27, 12, 0, 0);
  const c = coturnCredential('s3cret', 'alice', now, 3600);
  const expiry = now / 1000 + 3600;
  assert.strictEqual(c.username, `${expiry}:alice`);
  assert.strictEqual(c.credential, createHmac('sha1', 's3cret').update(`${expiry}:alice`).digest('base64'));
  assert.strictEqual(c.expiresAt, expiry * 1000);
});

test('each TURN mode hands out what it should, and nothing it should not', async () => {
  const none = await iceFor(calls(), 'alice');
  assert.deepStrictEqual(none.iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);

  const fixed = await iceFor(calls({ mode: 'static', urls: ['turn:t.example.org:3478'], username: 'u', credential: 'p' }), 'alice');
  assert.deepStrictEqual(fixed.iceServers[1], { urls: ['turn:t.example.org:3478'], username: 'u', credential: 'p' });

  const now = Date.now();
  const made = await iceFor(calls({ mode: 'coturn', urls: ['turns:t.example.org:443?transport=tcp'], secret: 'shh' }), 'bob', now);
  const relay = made.iceServers[1];
  assert.match(relay.username!, /^\d+:bob$/);
  assert.notStrictEqual(relay.credential, 'shh', 'the secret itself is never handed out');
  assert.strictEqual(made.expiresAt, parseInt(relay.username!, 10) * 1000);

  // A mode missing what it needs is not used, and says what is missing.
  const half = calls({ mode: 'static', urls: ['turn:t.example.org'] });
  assert.match(turnProblem(half)!, /username/);
  assert.strictEqual((await iceFor(half, 'alice')).iceServers.length, 1);
  assert.strictEqual(turnProblem(calls({ mode: 'cloudflare', keyId: 'k', apiToken: 't' })), null);

  // No STUN servers at all is a choice the admin can make.
  assert.deepStrictEqual((await iceFor(calls({}, []), 'alice')).iceServers, []);
});

test('ICE servers from outside are reduced to well-formed URLs with credentials for relays', () => {
  const out = sanitizeIceServers([
    { urls: ['stun:ok.example:3478', 'stun:dns.example:53', 'http://nope'] },
    { urls: 'turn:relay.example:3478' },
    { urls: ['turn:relay.example:3478', 'turns:relay.example:443?transport=tcp'], username: 'u', credential: 'c' },
    'junk',
  ]);
  assert.deepStrictEqual(out, [
    { urls: ['stun:ok.example:3478'] },
    { urls: ['turn:relay.example:3478', 'turns:relay.example:443?transport=tcp'], username: 'u', credential: 'c' },
  ]);
});

test('calls default to the public STUN servers, and config.json can say otherwise', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(loadConfig(root).calls.stun, DEFAULT_STUN);
  assert.strictEqual(loadConfig(root).calls.turn.mode, 'none');
  const other = tmpRoot();
  fs.writeFileSync(path.join(other, 'config.json'), JSON.stringify({ calls: { stun: [], turn: { mode: 'coturn', urls: ['turn:x.example'], secret: ' s ' } } }));
  const c = loadConfig(other).calls;
  assert.deepStrictEqual(c.stun, []);
  assert.strictEqual(c.turn.mode, 'coturn');
  assert.strictEqual(c.turn.secret, 's');
});

// ---- the call itself ----

// A public channel's news reaches everyone in the vault, so the people who
// hear that a call is on have to be in it.
function workspace() {
  const root = tmpRoot();
  for (const u of ['alice', 'bob', 'carol']) addUserToken(root, u, {});
  createChannel(root, 'general', { topic: '', private: false, createdBy: 'alice' });
  return { root, room: channelRoom(root, 'general', auth('alice'))! };
}

test('joining starts a call with an entry in the timeline, and every page hears the roster', () => {
  const { root, room } = workspace();
  const a = open('alice', 1);
  const b = open('bob', 2);
  const id = joinCall(root, room, 'alice', a.id);
  let entries = readMessages(room.dir).filter((m) => m.call);
  assert.strictEqual(entries.length, 1);
  assert.deepStrictEqual(entries[0].call, { id, people: ['alice'] });
  assert.deepStrictEqual((a.last('call-roster')!.peers as { user: string }[]).map((p) => p.user), ['alice']);
  // bob, who can see the room, hears that a call is on before joining it.
  assert.deepStrictEqual((b.events.find((e) => (e as { type: string }).type === 'call') as unknown as { people: string[] }).people, ['alice']);

  assert.strictEqual(joinCall(root, room, 'bob', b.id), id, 'the second joins the same call');
  for (const p of [a, b]) assert.deepStrictEqual((p.last('call-roster')!.peers as { user: string }[]).map((x) => x.user), ['alice', 'bob']);
  entries = readMessages(room.dir).filter((m) => m.call);
  assert.strictEqual(entries.length, 1, 'joining does not post another entry');
  assert.deepStrictEqual(entries[0].call!.people, ['alice', 'bob']);
  assert.deepStrictEqual(liveCall(room.url)!.people, ['alice', 'bob']);
});

test('signals pass only between pages in the call', () => {
  const { root, room } = workspace();
  const a = open('alice', 1);
  const b = open('bob', 2);
  const c = open('carol', 3);
  joinCall(root, room, 'alice', a.id);
  joinCall(root, room, 'bob', b.id);
  relaySignals(room.url, a.id, b.id, [{ type: 'offer', sdp: 'v=0' }]);
  assert.deepStrictEqual(b.last('call-signal'), { type: 'call-signal', url: room.url, from: a.id, signals: [{ type: 'offer', sdp: 'v=0' }] });
  assert.throws(() => relaySignals(room.url, a.id, c.id, []), /not in the call/);
  assert.throws(() => relaySignals(room.url, c.id, a.id, []), /not in the call/);
});

test('a page can join only as the person whose page it is, and a call holds at most eight', () => {
  const { root, room } = workspace();
  const a = open('alice', 1);
  assert.throws(() => joinCall(root, room, 'mallory', a.id), /lost its connection/);
  for (let i = 0; i < MAX_IN_CALL; i++) joinCall(root, room, `user${i}`, open(`user${i}`, 100 + i).id);
  assert.throws(() => joinCall(root, room, 'alice', a.id), /full/);
});

test('a page’s id stays its person’s after its stream closes, so nobody else can take it', () => {
  const { root, room } = workspace();
  const a = open('alice', 1);
  joinCall(root, room, 'alice', a.id);
  a.close();
  const b = page('bob', a.id);
  pages.push(b);
  assert.strictEqual(clientOwner(a.id), null, 'bob did not get alice’s id');
  assert.throws(() => joinCall(root, room, 'bob', a.id), /lost its connection/);
  const back = page('alice', a.id);
  pages.push(back);
  assert.strictEqual(clientOwner(a.id), 'alice');
});

test('someone who can no longer see the room is taken out of its call', () => {
  const root = tmpRoot();
  for (const u of ['alice', 'bob']) addUserToken(root, u, {});
  createChannel(root, 'secret', { topic: '', private: true, createdBy: 'alice' });
  addMember(root, 'secret', 'alice');
  addMember(root, 'secret', 'bob');
  const room = channelRoom(root, 'secret', auth('alice'))!;
  const a = open('alice', 1);
  const b = open('bob', 2);
  joinCall(root, room, 'alice', a.id);
  joinCall(root, room, 'bob', b.id);
  removeMember(root, 'secret', 'bob');
  pruneCalls(root);
  assert.deepStrictEqual(liveCall(room.url)!.people, ['alice']);
  assert.strictEqual(b.last('call-gone')!.url, room.url);
  assert.deepStrictEqual((a.last('call-roster')!.peers as unknown[]).length, 1);
});

test('the last to leave ends the call, and its entry records the end', () => {
  const { root, room } = workspace();
  const a = open('alice', 1);
  const b = open('bob', 2);
  joinCall(root, room, 'alice', a.id);
  joinCall(root, room, 'bob', b.id);
  leaveCall(room.url, b.id);
  assert.deepStrictEqual((a.last('call-roster')!.peers as unknown[]).length, 1);
  assert.strictEqual(readMessages(room.dir).find((m) => m.call)!.call!.ended, undefined);
  leaveCall(room.url, a.id);
  assert.strictEqual(liveCall(room.url), null);
  const rec = readMessages(room.dir).find((m) => m.call)!.call!;
  assert.ok(rec.ended && !Number.isNaN(Date.parse(rec.ended)));
  assert.deepStrictEqual((a.last('call') as unknown as { people: string[] }).people, [], 'the room hears the call ended');
});

test('a page whose stream closes leaves after a grace period, unless it comes back', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { root, room } = workspace();
  const a = open('alice', 1);
  const b = open('bob', 2);
  joinCall(root, room, 'alice', a.id);
  joinCall(root, room, 'bob', b.id);
  b.close();
  mock.timers.tick(CLIENT_GRACE_MS - 1000);
  const again = page('bob', b.id);
  pages.push(again);
  mock.timers.tick(5000);
  assert.deepStrictEqual(liveCall(room.url)!.people, ['alice', 'bob'], 'a stream that reopened in time stays');
  again.close();
  mock.timers.tick(CLIENT_GRACE_MS + 1);
  assert.deepStrictEqual(liveCall(room.url)!.people, ['alice']);
});

test('after a restart, pages joining again under the call id pick up its entry', () => {
  const { root, room } = workspace();
  const a = open('alice', 1);
  const id = joinCall(root, room, 'alice', a.id);
  resetCalls();
  assert.strictEqual(joinCall(root, room, 'alice', a.id, id), id);
  assert.strictEqual(readMessages(room.dir).filter((m) => m.call).length, 1);
  // A call that ended is not taken up again; a new one starts.
  leaveCall(room.url, a.id);
  assert.notStrictEqual(joinCall(root, room, 'alice', a.id, id), id);
});

test('a call starting is pushed in a conversation but not to a whole channel, and its entry is not editable', () => {
  const { root, room } = workspace();
  const a = open('alice', 1);
  joinCall(root, room, 'alice', a.id);
  const entry = readMessages(room.dir).find((m) => m.call)!;
  const none = () => new Set<string>();
  assert.strictEqual(wantsPush({ ...DEFAULT_PREFS, level: 'all' }, room, entry, 'bob', none), false);
  const dm = openDm(root, ['alice', 'bob']);
  const direct = dmRoom(root, dm.id, auth('alice'))!;
  leaveCall(room.url, a.id);
  joinCall(root, direct, 'alice', a.id);
  const call = readMessages(direct.dir).find((m) => m.call)!;
  assert.strictEqual(wantsPush(DEFAULT_PREFS, direct, call, 'bob', none), true);
  assert.strictEqual(canEditMessage(auth('alice'), call), false);
});

test('how long a call lasted, in words', () => {
  assert.strictEqual(callLength(20 * 1000), 'under a minute');
  assert.strictEqual(callLength(60 * 1000), '1 minute');
  assert.strictEqual(callLength(23 * 60 * 1000), '23 minutes');
  assert.strictEqual(callLength(60 * 60 * 1000), '1 hour');
  assert.strictEqual(callLength(125 * 60 * 1000), '2 hours 5 minutes');
});
