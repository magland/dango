import '../src/branding';
import assert from 'node:assert';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, test } from 'node:test';
import { AuthResult, addUserToken } from '../../mochiforge/src/vault';
import { THEMES } from '../../mochiforge/src/themes';
import { appIconPng } from '../src/appicon';
import { createChannel } from '../src/channels';
import { openDm } from '../src/dms';
import { addMessage } from '../src/messages';
import {
  DEFAULT_PREFS,
  NotifyPrefs,
  addDevice,
  cancelPending,
  deviceLabel,
  parseSubscription,
  previewText,
  queueNotifications,
  readDevices,
  readPrefs,
  removeDevice,
  renewDevice,
  wantsPush,
  writePrefs,
} from '../src/notify';
import { encryptPayload, isPushEndpoint, vapidAuthorization, vapidKeys } from '../src/push';
import { markRead } from '../src/reads';
import { channelRoom, dmRoom, threadRoom } from '../src/rooms';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-notify-'));
}

function auth(username: string): AuthResult {
  return { username, user: { tokens: [] }, token: { hash: '' } };
}

/** A browser's side of a subscription: its key pair and auth secret, and what it hands over. */
function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    sub: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}

/** The receiving side of RFC 8291, as a browser performs it. */
function decrypt(body: Buffer, b: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const serverKey = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = b.ecdh.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, b.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2, 'a single record ends with the last-record delimiter');
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

// ---- the push protocol ----

test('a payload encrypts to what the subscribing browser can decrypt, and to nobody else', () => {
  const b = browser();
  const text = JSON.stringify({ title: '#general', body: 'alice: héllo ' + 'x'.repeat(2000) });
  const body = encryptPayload(Buffer.from(text), b.sub.keys);
  assert.strictEqual(body.readUInt32BE(16), 4096);
  assert.strictEqual(decrypt(body, b), text);
  const other = browser();
  assert.throws(() => decrypt(body, { ...other, auth: b.auth }));
  // Fresh salt and key each time.
  assert.notDeepStrictEqual(encryptPayload(Buffer.from(text), b.sub.keys).subarray(0, 86), body.subarray(0, 86));
});

test('the VAPID keys are made once, kept in .vapid, and sign a JWT for the push service', () => {
  const root = tmpRoot();
  const keys = vapidKeys(root);
  assert.ok(fs.existsSync(path.join(root, '.vapid')));
  assert.strictEqual((fs.statSync(path.join(root, '.vapid')).mode & 0o777).toString(8), '600');
  assert.strictEqual(Buffer.from(keys.publicKey, 'base64url').length, 65);
  const header = vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', 'https://chat.example.org', 1_700_000_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.strictEqual(m[4], keys.publicKey);
  assert.deepStrictEqual(JSON.parse(Buffer.from(m[2], 'base64url').toString()), {
    aud: 'https://fcm.googleapis.com',
    exp: 1_700_000_000 + 12 * 3600,
    sub: 'https://chat.example.org',
  });
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});

test('only the browsers’ push services are endpoints the workspace will send to', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://wns2-by3p.notify.windows.com/w/?token=abc',
  ]) {
    assert.ok(isPushEndpoint(ok), ok);
  }
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest',
    'https://evilgoogleapis.com/x',
    'https://googleapis.com.evil.net/x',
    'not a url',
    42,
  ]) {
    assert.ok(!isPushEndpoint(bad), String(bad));
  }
});

test('a subscription is checked before it is kept', () => {
  const b = browser();
  assert.deepStrictEqual(parseSubscription({ ...b.sub, expirationTime: null }), b.sub);
  assert.strictEqual(parseSubscription({ ...b.sub, endpoint: 'https://example.org/push' }), null);
  assert.strictEqual(parseSubscription({ ...b.sub, keys: { p256dh: 'AAAA', auth: b.sub.keys.auth } }), null);
  assert.strictEqual(parseSubscription({ endpoint: b.sub.endpoint }), null);
  assert.strictEqual(parseSubscription(null), null);
});

// ---- devices and preferences ----

test('devices are per person, one endpoint belongs to one person, and a renewal needs the old secret', () => {
  const root = tmpRoot();
  addUserToken(root, 'alice');
  addUserToken(root, 'bob');
  const b = browser();
  const d = addDevice(root, 'alice', b.sub, { origin: 'https://chat.example.org', label: 'Chrome on Android' });
  assert.strictEqual(readDevices(root, 'alice').length, 1);
  assert.strictEqual((fs.statSync(path.join(root, 'users', 'alice', 'push.json')).mode & 0o777).toString(8), '600');
  // Offering it again keeps one entry and its date.
  assert.strictEqual(addDevice(root, 'alice', b.sub, { origin: 'https://chat.example.org', label: 'Chrome on Android' }).created, d.created);
  assert.strictEqual(readDevices(root, 'alice').length, 1);
  // The same browser signed in as bob takes the endpoint with it.
  addDevice(root, 'bob', b.sub, { origin: 'https://chat.example.org', label: 'Chrome on Android' });
  assert.strictEqual(readDevices(root, 'alice').length, 0);
  assert.strictEqual(readDevices(root, 'bob').length, 1);

  const next = browser();
  assert.strictEqual(renewDevice(root, { endpoint: b.sub.endpoint, auth: 'wrong' }, next.sub), false);
  assert.strictEqual(renewDevice(root, { endpoint: b.sub.endpoint, auth: b.sub.keys.auth }, next.sub), true);
  assert.deepStrictEqual(readDevices(root, 'bob').map((x) => x.endpoint), [next.sub.endpoint]);
  assert.strictEqual(removeDevice(root, 'bob', readDevices(root, 'bob')[0].id), true);
  assert.strictEqual(readDevices(root, 'bob').length, 0);
});

test('preferences default to what is addressed to you, and survive a round trip', () => {
  const root = tmpRoot();
  assert.deepStrictEqual(readPrefs(root, 'alice'), DEFAULT_PREFS);
  writePrefs(root, 'alice', { level: 'all', preview: false, muted: ['c/random', 'c/random'] });
  assert.deepStrictEqual(readPrefs(root, 'alice'), { level: 'all', preview: false, muted: ['c/random'] });
  fs.writeFileSync(path.join(root, 'users', 'alice', 'notify.json'), '{"level":"loud"}');
  assert.strictEqual(readPrefs(root, 'alice').level, 'direct');
});

test('who wants to hear of a message', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'alice' });
  const dm = openDm(root, ['alice', 'bob']);
  const general = channelRoom(root, 'general', auth('bob'))!;
  const direct = dmRoom(root, dm.id, auth('bob'))!;
  const plain = addMessage(general.dir, { author: 'bob', body: 'lunch?' });
  const mention = addMessage(general.dir, { author: 'bob', body: 'lunch, @alice?' });
  const inDm = addMessage(direct.dir, { author: 'bob', body: 'hi' });
  const thread = threadRoom(general, plain.id)!;
  const reply = addMessage(thread.dir, { author: 'carol', body: 'yes' });
  const prefs = (p: Partial<NotifyPrefs>): NotifyPrefs => ({ ...DEFAULT_PREFS, ...p });
  const none = () => new Set<string>();
  const bobsThread = () => new Set(['bob', 'carol']);

  assert.strictEqual(wantsPush(prefs({}), general, plain, 'alice', none), false);
  assert.strictEqual(wantsPush(prefs({}), general, mention, 'alice', none), true);
  assert.strictEqual(wantsPush(prefs({}), direct, inDm, 'alice', none), true);
  assert.strictEqual(wantsPush(prefs({}), thread, reply, 'bob', bobsThread), true);
  assert.strictEqual(wantsPush(prefs({}), thread, reply, 'alice', bobsThread), false);
  assert.strictEqual(wantsPush(prefs({ level: 'all' }), general, plain, 'alice', none), true);
  assert.strictEqual(wantsPush(prefs({ level: 'all' }), thread, reply, 'alice', bobsThread), false);
  assert.strictEqual(wantsPush(prefs({ level: 'none' }), direct, inDm, 'alice', none), false);
  assert.strictEqual(wantsPush(prefs({ muted: ['c/general'] }), general, mention, 'alice', none), false);
  // Muting a room mutes its threads.
  assert.strictEqual(wantsPush(prefs({ muted: ['c/general'] }), thread, reply, 'bob', bobsThread), false);
  assert.strictEqual(wantsPush(prefs({}), direct, inDm, 'bob', none), false, 'never your own message');
});

test('a preview is plain text, cut short', () => {
  assert.strictEqual(previewText('**Look** at [the doc](https://x.org) and `code`'), 'Look at the doc and code');
  assert.strictEqual(previewText('# Title\n\n> quoted\n- item'), 'Title quoted item');
  assert.strictEqual(previewText('before\n```js\nlet x = 1;\n```\nafter'), 'before [code] after');
  assert.strictEqual(previewText('x'.repeat(500)).length, 180);
});

test('a device is named from its User-Agent', () => {
  assert.strictEqual(
    deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'),
    'Chrome on Android'
  );
  assert.strictEqual(
    deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'),
    'Safari on iPhone'
  );
  assert.strictEqual(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'), 'Firefox on Linux');
  assert.strictEqual(
    deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0'),
    'Edge on Windows'
  );
});

// ---- the wait and the send, against a stand-in for the push service ----

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cancelPending();
});

function capturePushes(status = 201) {
  const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
    return new Response(null, { status });
  }) as typeof fetch;
  return sent;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function workspaceWithDm() {
  const root = tmpRoot();
  addUserToken(root, 'alice');
  addUserToken(root, 'bob');
  const dm = openDm(root, ['alice', 'bob']);
  const room = dmRoom(root, dm.id, auth('bob'))!;
  const b = browser();
  addDevice(root, 'alice', b.sub, { origin: 'https://chat.example.org', label: 'Firefox on Linux' });
  return { root, room, b };
}

test('a direct message reaches the other person’s device, encrypted, after the wait', async () => {
  const { root, room, b } = workspaceWithDm();
  const sent = capturePushes();
  const m = addMessage(room.dir, { author: 'bob', body: 'are you **there**?' });
  queueNotifications(root, room, m, 20);
  assert.strictEqual(sent.length, 0, 'nothing is sent before the wait');
  await settle(80);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].url, b.sub.endpoint);
  assert.strictEqual(sent[0].headers['Content-Encoding'], 'aes128gcm');
  assert.strictEqual(sent[0].headers.Urgency, 'high');
  assert.match(sent[0].headers.Authorization, /^vapid t=.+, k=.+$/);
  const payload = JSON.parse(decrypt(sent[0].body, b));
  assert.strictEqual(payload.title, 'bob');
  assert.strictEqual(payload.body, 'bob: are you there?');
  assert.strictEqual(payload.url, room.url);
  assert.strictEqual(payload.unread, 1);
});

test('a message read on another screen inside the wait is not pushed', async () => {
  const { root, room } = workspaceWithDm();
  const sent = capturePushes();
  const m = addMessage(room.dir, { author: 'bob', body: 'hello' });
  queueNotifications(root, room, m, 20);
  markRead(root, 'alice', room.url, m.id);
  await settle(80);
  assert.strictEqual(sent.length, 0);
});

test('messages inside one wait become one notification, and a preview can be withheld', async () => {
  const { root, room, b } = workspaceWithDm();
  writePrefs(root, 'alice', { level: 'direct', preview: false, muted: [] });
  const sent = capturePushes();
  for (const body of ['one', 'two', 'three']) queueNotifications(root, room, addMessage(room.dir, { author: 'bob', body }), 20);
  await settle(80);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(JSON.parse(decrypt(sent[0].body, b)).body, '3 new messages');
});

test('a subscription the push service says is gone is forgotten', async () => {
  const { root, room } = workspaceWithDm();
  capturePushes(410);
  queueNotifications(root, room, addMessage(room.dir, { author: 'bob', body: 'hello' }), 20);
  await settle(80);
  assert.strictEqual(readDevices(root, 'alice').length, 0);
});

test('someone removed from a private channel inside the wait hears nothing', async () => {
  const root = tmpRoot();
  addUserToken(root, 'alice');
  addUserToken(root, 'bob');
  const c = createChannel(root, 'secret', { createdBy: 'bob', private: true });
  const { addMember, removeMember } = await import('../src/channels');
  addMember(root, c.name, 'alice');
  const room = channelRoom(root, 'secret', auth('bob'))!;
  addDevice(root, 'alice', browser().sub, { origin: 'https://chat.example.org', label: 'x' });
  const sent = capturePushes();
  queueNotifications(root, room, addMessage(room.dir, { author: 'bob', body: '@alice psst' }), 20);
  removeMember(root, c.name, 'alice');
  await settle(80);
  assert.strictEqual(sent.length, 0);
});

// ---- icons ----

test('the app icon is a PNG of the requested size in the theme’s colours', () => {
  const theme = THEMES[0];
  const png = appIconPng(64, theme);
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.strictEqual(png.readUInt32BE(16), 64);
  assert.strictEqual(png.readUInt32BE(20), 64);
  // The IDAT follows the 25-byte IHDR chunk; its first row starts with a filter byte.
  const idatLen = png.readUInt32BE(33);
  const rows = inflateSync(png.subarray(41, 41 + idatLen));
  const px = (x: number, y: number) => [...rows.subarray(y * (64 * 4 + 1) + 1 + x * 4, y * (64 * 4 + 1) + 1 + x * 4 + 3)];
  const hex = (rgb: number[]) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  assert.strictEqual(hex(px(0, 0)), theme.vars.surface.toLowerCase(), 'the corner is the ground');
  assert.strictEqual(hex(px(32, 32)), theme.vars.surface.toLowerCase(), 'the middle dango is hollow');
});
