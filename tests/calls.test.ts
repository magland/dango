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
import { DEFAULT_STUN, CallsConfig, TURN_SECRETS_FILE, loadConfig, updateConfig } from '../src/config';
import { allowReport, describeReport, parseReport, readReports, recordReport } from '../src/calllog';
import { openDm } from '../src/dms';
import { ClientEvent, clientOwner, serveUserEvents } from '../src/events';
import { coturnCredential, iceFor, sanitizeIceServers, turnProblem } from '../src/ice';
import { readMessages } from '../src/messages';
import { DEFAULT_PREFS, wantsPush } from '../src/notify';
import { RateLimited } from '../src/limits';
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
  serveUserEvents(res, username, () => true, id);
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
  return { stun, turn: { mode: 'none', urls: [], username: '', credential: '', secret: '', keyId: '', apiToken: '', ...over }, guests: true };
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

test('the TURN credentials are kept in .turn, apart from config.json', () => {
  const root = tmpRoot();
  const c = calls({ mode: 'cloudflare', keyId: 'key', apiToken: 'tok', secret: 'shh', credential: 'pw' });
  updateConfig(root, { calls: c });
  const plain = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  for (const secret of ['tok', 'shh', 'pw']) assert.ok(!plain.includes(`"${secret}"`), `${secret} is in config.json`);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, TURN_SECRETS_FILE), 'utf8')), { credential: 'pw', secret: 'shh', apiToken: 'tok' });
  assert.deepStrictEqual(loadConfig(root).calls.turn, c.turn);
});

test('a relay that cannot be used is said to be, and the call goes on without it', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new globalThis.Response('{}', { status: 401 }));
  const ice = await iceFor(calls({ mode: 'cloudflare', keyId: 'k', apiToken: 't' }), 'alice');
  assert.deepStrictEqual(ice.iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);
  assert.match(ice.problems[0], /Cloudflare.*401/);
  assert.deepStrictEqual((await iceFor(calls(), 'alice')).problems, []);
});

// ---- the connection log ----

test('a connection report is reduced to its shape, addresses and all else left out', () => {
  const r = parseReport({
    outcome: 'connected',
    ms: 1234.5,
    attempt: 2,
    path: { local: 'relay', remote: 'srflx', protocol: 'udp', relayProtocol: 'tls', rtt: 0.0421, address: '203.0.113.9' },
    gathered: ['host/udp', 'relay/tcp', 'relay/tcp', '203.0.113.9'],
    errors: [{ url: 'turn:t.example:3478', code: 401, text: 'Unauthorized', extra: 'x' }],
    relayOffered: true,
  })!;
  assert.deepStrictEqual(r, {
    outcome: 'connected',
    ms: 1235,
    attempt: 2,
    path: { local: 'relay', remote: 'srflx', protocol: 'udp', relayProtocol: 'tls', rtt: 0.042 },
    gathered: ['host/udp', 'relay/tcp'],
    errors: [{ url: 'turn:t.example:3478', code: 401, text: 'Unauthorized' }],
    relayOffered: true,
  });
  assert.strictEqual(parseReport({ outcome: 'exploded' }), null);
  const full = { at: '', room: '/c/general', user: 'alice', with: 'bob', device: 'Chrome on macOS', ...r };
  assert.strictEqual(describeReport(full), 'connected through the relay (TURN over TLS) in 1.2 s');
  assert.strictEqual(describeReport({ ...full, outcome: 'failed', ms: 15000, path: undefined }), 'failed to connect after 15.0 s (attempt 2)');
  assert.strictEqual(describeReport({ ...full, path: { local: 'host', remote: 'srflx', protocol: 'udp' } }), 'connected directly (UDP) in 1.2 s');
});

test('reports are kept, the newest few hundred, and one person cannot flood them', () => {
  const root = tmpRoot();
  const base = { at: '', room: '/c/general', user: 'alice', with: 'bob', device: 'x', outcome: 'failed' as const, ms: 1, attempt: 1, gathered: [], errors: [], relayOffered: false };
  const log = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < 305; i++) recordReport(root, { ...base, ms: i });
  } finally {
    console.log = log;
  }
  const kept = readReports(root);
  assert.strictEqual(kept.length, 300);
  assert.strictEqual(kept[kept.length - 1].ms, 304);
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (allowReport('flooder', 1000)) allowed++;
  assert.strictEqual(allowed, 30);
  assert.ok(allowReport('flooder', 1000 + 61000), 'a minute later it is allowed again');
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

test('one person holds at most two of a call’s places, however many pages they have', () => {
  const { root, room } = workspace();
  const [a1, a2, a3] = [open('alice', 301), open('alice', 302), open('alice', 303)];
  joinCall(root, room, 'alice', a1.id);
  joinCall(root, room, 'alice', a2.id);
  assert.throws(() => joinCall(root, room, 'alice', a3.id), /2 other pages/);
  joinCall(root, room, 'alice', a2.id);
  leaveCall(room.url, a1.id);
  joinCall(root, room, 'alice', a3.id);
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

test('starting a call is charged as a message, and joining one under way is not', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  const room = channelRoom(root, 'general', auth('alice'))!;
  const a = open('alice', 900);
  const b = open('bob', 901);
  let charged = 0;
  const refuse = () => {
    throw new RateLimited('slow down', 5);
  };
  assert.throws(() => joinCall(root, room, 'alice', a.id, undefined, refuse), RateLimited);
  assert.strictEqual(liveCall(room.url), null, 'a refused start leaves no call');
  assert.strictEqual(readMessages(room.dir, {}).length, 0, 'and no entry in the timeline');
  joinCall(root, room, 'alice', a.id, undefined, () => charged++);
  joinCall(root, room, 'bob', b.id, undefined, () => charged++);
  assert.strictEqual(charged, 1);
});

test('a conversation is charged when it is made, not when it is opened again', () => {
  const root = tmpRoot();
  let charged = 0;
  const first = openDm(root, ['alice', 'bob'], { charge: () => charged++ });
  const again = openDm(root, ['bob', 'alice'], { charge: () => charged++ });
  assert.strictEqual(again.id, first.id);
  assert.strictEqual(charged, 1);
});
