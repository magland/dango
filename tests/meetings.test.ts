import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { Request, Response } from 'express';
import { AuthResult, addUserToken } from '../../mochiforge/src/vault';
import { MEMBERLESS_MS, NOT_STARTED, joinCall, leaveCall, liveCall, pruneCalls, resetCalls } from '../src/calls';
import { createChannel } from '../src/channels';
import { loadConfig, updateConfig } from '../src/config';
import { ClientEvent, UserEvent, serveUserEvents, subscribeUser } from '../src/events';
import { MAX_WAITING, admittedGuest, askToJoin, asViewer, issueGuest, leaveLobby, readGuestCookie, resetLobbies, waitingIn } from '../src/guests';
import { iceFor } from '../src/ice';
import {
  addMeetingMember,
  admitGuest,
  cleanGuestName,
  createMeeting,
  guestKey,
  guestKeyMatches,
  isCurrentGuest,
  leaveAllMeetings,
  mayDeleteMeeting,
  personLabel,
  readMeeting,
  removeGuest,
  removeMeetingMember,
  resetGuestLink,
} from '../src/meetings';
import { DEFAULT_PREFS, wantsPush } from '../src/notify';
import { canSeeChannel, canSeeDm, canSeeMeeting, isSiteAdmin } from '../src/perms';
import { postMessage } from '../src/post';
import { markRead, unreadRooms } from '../src/reads';
import { channelRoom, meetingRoom } from '../src/rooms';
import { isValidWorkspaceUserName, isGuestName } from '../src/workspace';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-meetings-'));
}

function auth(username: string, siteAdmin = false): AuthResult {
  return { username, user: { tokens: [], ...(siteAdmin ? { siteAdmin: true } : {}) }, token: { hash: '' } };
}

const GUEST = '~0123456789ab';
const OTHER_GUEST = '~ba9876543210';

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
  return { id, events, close: () => closers.forEach((f) => f()) };
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
  resetLobbies();
  mock.timers.reset();
});

// ---- who a guest is, and what they can see ----

test('a guest name can never be a username, and a username never a guest name', () => {
  assert.ok(isGuestName(GUEST));
  assert.ok(!isGuestName('alice'));
  assert.ok(!isValidWorkspaceUserName(GUEST));
  assert.ok(!isValidWorkspaceUserName('m'), 'meetings live at /m/');
  assert.ok(!isValidWorkspaceUserName('join'));
});

test('a guest sees their meeting and nothing else, not even a public channel', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice', members: ['bob'] });
  admitGuest(root, m.id, GUEST, 'Dana');
  const guest = auth(GUEST, true);
  assert.strictEqual(channelRoom(root, 'general', guest), null);
  assert.strictEqual(canSeeChannel(guest, { name: 'general', topic: '', private: false, members: [] }), false);
  assert.strictEqual(canSeeDm(guest, { id: 1, participants: [GUEST, 'alice'] }), false);
  assert.strictEqual(isSiteAdmin(guest), false, 'a guest is never an admin, whatever the record says');
  assert.ok(meetingRoom(root, m.id, guest));
  assert.strictEqual(meetingRoom(root, m.id, auth(OTHER_GUEST)), null, 'a guest never let in sees nothing');
  assert.strictEqual(meetingRoom(root, m.id, auth('carol')), null, 'a member of the workspace outside the meeting sees nothing');
  assert.ok(meetingRoom(root, m.id, auth('bob')));
  assert.strictEqual(meetingRoom(root, m.id, auth('alice', true))?.meeting?.title, 'Review');
  assert.strictEqual(unreadRooms(root, guest).length, 0, 'a guest has no sidebar');
  assert.deepStrictEqual(unreadRooms(root, auth('bob')).map((r) => r.url), ['/c/general', `/m/${m.id}`]);
});

test('resetting the link, or taking a guest out, ends what they can see', () => {
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice' });
  admitGuest(root, m.id, GUEST, 'Dana');
  admitGuest(root, m.id, OTHER_GUEST, 'Eli');
  const before = guestKey(root, m);
  assert.ok(guestKeyMatches(root, m, before));
  removeGuest(root, m.id, OTHER_GUEST);
  assert.ok(!canSeeMeeting(auth(OTHER_GUEST), readMeeting(root, m.id)!));
  assert.ok(canSeeMeeting(auth(GUEST), readMeeting(root, m.id)!));
  const after = resetGuestLink(root, m.id);
  assert.ok(!guestKeyMatches(root, after, before), 'the old link no longer works');
  assert.ok(guestKeyMatches(root, after, guestKey(root, after)));
  assert.ok(!isCurrentGuest(after, GUEST), 'nor does a guest let in under it');
  // Their names stay, beside what they wrote.
  assert.strictEqual(personLabel(after, GUEST), 'Dana (guest)');
  assert.strictEqual(personLabel(after, 'alice'), 'alice');
});

test('a meeting keeps its last member, and whoever made it decides who else goes', () => {
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice', members: ['bob'] });
  assert.ok(mayDeleteMeeting(m, 'alice'));
  assert.ok(!mayDeleteMeeting(m, 'bob'));
  removeMeetingMember(root, m.id, 'alice');
  assert.throws(() => removeMeetingMember(root, m.id, 'bob'), /last member/);
  // Once its maker is gone, any member may manage it.
  assert.ok(mayDeleteMeeting(readMeeting(root, m.id)!, 'bob'));
  addMeetingMember(root, m.id, 'carol');
  leaveAllMeetings(root, 'carol');
  const now = readMeeting(root, m.id)!;
  assert.deepStrictEqual(now.members, ['bob']);
  assert.deepStrictEqual(now.former, ['carol']);
});

test('a guest gives one line of a name, of at most 40 characters', () => {
  assert.strictEqual(cleanGuestName('  Dana \n Scully '), 'Dana Scully');
  assert.strictEqual(cleanGuestName(''), null);
  assert.strictEqual(cleanGuestName('x'.repeat(41)), null);
  assert.strictEqual(cleanGuestName(7), null);
});

test('a guest keeps no read markers, and no directory under users/', () => {
  const root = tmpRoot();
  assert.strictEqual(markRead(root, GUEST, '/m/1', 3), false);
  assert.ok(!fs.existsSync(path.join(root, 'users', GUEST)));
});

// ---- the cookie and the lobby ----

/** Enough of a request and a response for the guest cookie to be set and read back. */
function cookieJar() {
  let cookie = '';
  const res = {
    cookie(name: string, value: string) {
      cookie = `${name}=${encodeURIComponent(value)}`;
    },
  } as unknown as Response;
  const req = () => ({ protocol: 'http', headers: { cookie } }) as unknown as Request;
  return { req, res, set: (c: string) => (cookie = c) };
}

test('a guest cookie names one guest of one meeting, and a tampered one names nobody', () => {
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice' });
  const jar = cookieJar();
  const g = issueGuest(jar.req(), jar.res, root, m, 'Dana');
  assert.ok(isGuestName(g.id));
  assert.deepStrictEqual(readGuestCookie(jar.req(), root)?.id, g.id);
  assert.strictEqual(admittedGuest(jar.req(), root), null, 'not let in yet');
  admitGuest(root, m.id, g.id, 'Dana');
  assert.strictEqual(admittedGuest(jar.req(), root)?.meeting.id, m.id);
  assert.strictEqual(asViewer(g).auth.username, g.id);
  // The same bytes with another guest's name in them do not verify.
  const raw = decodeURIComponent(jar.req().headers.cookie!.split('=')[1]);
  const [body, sig] = raw.split('.');
  const forged = Buffer.from(Buffer.from(body, 'base64url').toString('utf8').replace(g.id, OTHER_GUEST)).toString('base64url');
  jar.set(`dango_guest=${encodeURIComponent(`${forged}.${sig}`)}`);
  assert.strictEqual(readGuestCookie(jar.req(), root), null);
});

test('guests are not let in when the workspace turns them off', () => {
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice' });
  const jar = cookieJar();
  const g = issueGuest(jar.req(), jar.res, root, m, 'Dana');
  admitGuest(root, m.id, g.id, 'Dana');
  updateConfig(root, { calls: { ...loadConfig(root).calls, guests: false } });
  assert.strictEqual(admittedGuest(jar.req(), root), null);
  assert.strictEqual(askToJoin(root, g, '203.0.113.1').state, 'closed');
});

test('knocking puts a guest in the lobby once, tells the members, and a full lobby says so', () => {
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice' });
  const heard: UserEvent[] = [];
  const stop = subscribeUser('alice', (e) => heard.push(e));
  try {
    const jar = cookieJar();
    const g = issueGuest(jar.req(), jar.res, root, m, 'Dana');
    assert.deepStrictEqual(askToJoin(root, g, '203.0.113.1'), { state: 'waiting', knocked: true });
    assert.deepStrictEqual(askToJoin(root, g, '203.0.113.1'), { state: 'waiting', knocked: false });
    assert.deepStrictEqual(waitingIn(m.id), [{ id: g.id, name: 'Dana' }]);
    assert.deepStrictEqual(heard.at(-1), { type: 'lobby', url: `/m/${m.id}`, title: 'Review', waiting: [{ id: g.id, name: 'Dana' }] });
    // Turned away, they are told so, and do not knock again for a while.
    leaveLobby(root, m.id, g.id, true);
    assert.strictEqual(askToJoin(root, g, '203.0.113.1').state, 'turned-away');
    assert.deepStrictEqual(heard.at(-1), { type: 'lobby', url: `/m/${m.id}`, title: 'Review', waiting: [] });
    for (let i = 0; i < MAX_WAITING; i++) askToJoin(root, issueGuest(jar.req(), jar.res, root, m, `g${i}`), `203.0.113.${10 + i}`);
    assert.throws(() => askToJoin(root, issueGuest(jar.req(), jar.res, root, m, 'late'), '203.0.113.99'), /Too many people are waiting/);
  } finally {
    stop();
  }
});

test('one address cannot knock without end', () => {
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice' });
  const jar = cookieJar();
  let refused = false;
  for (let i = 0; i < 20 && !refused; i++) {
    const g = issueGuest(jar.req(), jar.res, root, m, `g${i}`);
    try {
      askToJoin(root, g, '198.51.100.7');
      leaveLobby(root, m.id, g.id);
    } catch (e) {
      refused = /too often/.test(String(e));
    }
  }
  assert.ok(refused);
});

// ---- calls with guests ----

test('a guest joins a call a member started, and never starts one', () => {
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice' });
  admitGuest(root, m.id, GUEST, 'Dana');
  const room = meetingRoom(root, m.id, auth('alice'))!;
  const guestPage = open(GUEST, 1);
  const alicePage = open('alice', 2);
  assert.throws(() => joinCall(root, room, GUEST, guestPage.id), new RegExp(NOT_STARTED.slice(0, 20)));
  assert.strictEqual(liveCall(room.url), null);
  joinCall(root, room, 'alice', alicePage.id);
  joinCall(root, room, GUEST, guestPage.id);
  assert.deepStrictEqual(liveCall(room.url)!.names, ['alice', 'Dana (guest)']);
  const roster = alicePage.events.filter((e) => e.type === 'call-roster').at(-1) as Extract<ClientEvent, { type: 'call-roster' }>;
  assert.deepStrictEqual(
    roster.peers.map((p) => [p.user, p.name]),
    [
      ['alice', 'alice'],
      [GUEST, 'Dana (guest)'],
    ]
  );
  // A guest in a channel's call is refused outright.
  const channel = createChannel(root, 'general', { createdBy: 'alice' });
  void channel;
  assert.throws(() => joinCall(root, channelRoom(root, 'general', auth('alice'))!, GUEST, guestPage.id), /Only a meeting has guests/);
});

test('a call left with guests alone ends for them after a while', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice' });
  admitGuest(root, m.id, GUEST, 'Dana');
  const room = meetingRoom(root, m.id, auth('alice'))!;
  const alicePage = open('alice', 3);
  const guestPage = open(GUEST, 4);
  joinCall(root, room, 'alice', alicePage.id);
  joinCall(root, room, GUEST, guestPage.id);
  leaveCall(room.url, alicePage.id);
  assert.ok(liveCall(room.url), 'a member reloading their page does not end it at once');
  // A member back in time keeps it going.
  joinCall(root, room, 'alice', alicePage.id);
  mock.timers.tick(MEMBERLESS_MS + 1);
  assert.ok(liveCall(room.url));
  leaveCall(room.url, alicePage.id);
  mock.timers.tick(MEMBERLESS_MS + 1);
  assert.strictEqual(liveCall(room.url), null);
  assert.ok(guestPage.events.some((e) => e.type === 'call-gone' && /Everyone from the workspace has left/.test(e.reason)));
});

test('a guest whose link was reset leaves the call they are in', () => {
  const root = tmpRoot();
  addUserToken(root, 'alice', {});
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice' });
  admitGuest(root, m.id, GUEST, 'Dana');
  const room = meetingRoom(root, m.id, auth('alice'))!;
  const alicePage = open('alice', 5);
  const guestPage = open(GUEST, 6);
  joinCall(root, room, 'alice', alicePage.id);
  joinCall(root, room, GUEST, guestPage.id);
  resetGuestLink(root, m.id);
  pruneCalls(root);
  assert.deepStrictEqual(liveCall(room.url)!.people, ['alice']);
  assert.ok(guestPage.events.some((e) => e.type === 'call-gone' && /no longer a guest/.test(e.reason)));
});

test('a guest is told who is in their meeting’s call; a member elsewhere is not', () => {
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice' });
  admitGuest(root, m.id, GUEST, 'Dana');
  const heardByGuest: UserEvent[] = [];
  const heardByCarol: UserEvent[] = [];
  const stops = [subscribeUser(GUEST, (e) => heardByGuest.push(e)), subscribeUser('carol', (e) => heardByCarol.push(e))];
  try {
    joinCall(root, meetingRoom(root, m.id, auth('alice'))!, 'alice', open('alice', 7).id);
    assert.deepStrictEqual(heardByGuest.at(-1), { type: 'call', url: `/m/${m.id}`, people: ['alice'] });
    assert.strictEqual(heardByCarol.length, 0);
  } finally {
    stops.forEach((s) => s());
  }
});

test('a fixed TURN password is not handed to a guest', async () => {
  const calls = { stun: [], turn: { mode: 'static' as const, urls: ['turn:t.example.org:3478'], username: 'u', credential: 'p', secret: '', keyId: '', apiToken: '' }, guests: true };
  assert.strictEqual((await iceFor(calls, 'alice')).iceServers.length, 1);
  const forGuest = await iceFor(calls, GUEST);
  assert.strictEqual(forGuest.iceServers.length, 0);
  assert.match(forGuest.problems.join(' '), /not offered to guests/);
});

// ---- messages and notifications ----

test('a call in a meeting is notified like one in a conversation, and a guest’s message names them', () => {
  const root = tmpRoot();
  const m = createMeeting(root, { title: 'Review', createdBy: 'alice', members: ['bob'] });
  admitGuest(root, m.id, GUEST, 'Dana');
  const room = meetingRoom(root, m.id, auth('bob'))!;
  const call = { id: 1, author: 'alice', created: '', body: 'started a call', reactions: {}, files: [], replyCount: 0, call: { id: 'abc', people: ['alice'] } };
  assert.ok(wantsPush(DEFAULT_PREFS, room, call, 'bob', () => new Set()));
  const posted = postMessage(root, meetingRoom(root, m.id, auth(GUEST))!, { author: GUEST, body: 'hello from outside' });
  assert.strictEqual(posted.author, GUEST);
  assert.ok(!fs.existsSync(path.join(root, 'users', GUEST)), 'posting keeps no marker for the guest');
  assert.deepStrictEqual(
    unreadRooms(root, auth('bob')).find((r) => r.url === room.url),
    { url: room.url, title: 'Review', kind: 'meeting', count: 1, mentions: 0 }
  );
});
