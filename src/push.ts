import { createECDH, createHash, createPrivateKey, createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign, KeyObject } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../../mochiforge/src/atomic';

// Web Push, the standard way a server reaches a browser that has no page of
// ours open: the browser subscribes with its vendor's push service (Google's,
// Mozilla's, Apple's, Microsoft's) and hands us an endpoint URL and two keys;
// we POST an encrypted message to the endpoint, and the service wakes our
// service worker on that device with it.
//
// Three standards, written out here on node:crypto rather than taken from a
// package, the way the multipart parser and the rate limiter are:
//
//  - VAPID (RFC 8292): each workspace has its own P-256 key pair, made on
//    first use and kept in <workspace>/.vapid. The browser is told the public
//    half when it subscribes, and every push carries a short-lived JWT signed
//    with the private half, so a push service accepts messages for a
//    subscription only from the workspace that made it. No relay and no
//    account with anyone is involved.
//  - Message encryption (RFC 8291) with the aes128gcm content coding
//    (RFC 8188): the payload is encrypted to the subscribing browser's key, so
//    the push service carries it without being able to read it. What the
//    service does see is when a push is sent, to which endpoint, and its size.
//  - The push protocol (RFC 8030): TTL, Urgency, and Topic headers, and the
//    status codes that say a subscription has gone.

export const VAPID_FILE = '.vapid';

export interface VapidKeys {
  /** The uncompressed P-256 public key, base64url: what applicationServerKey takes. */
  publicKey: string;
  privateKey: KeyObject;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

let cached: { root: string; keys: VapidKeys } | null = null;

/**
 * The workspace's VAPID keys, made the first time anyone asks. They are part
 * of the workspace like .secret is: a backup keeps them (a restored workspace
 * with new keys would find every browser's subscription refused), and
 * `--no-secrets` leaves them out.
 */
export function vapidKeys(root: string): VapidKeys {
  if (cached && cached.root === root) return cached.keys;
  const file = path.join(root, VAPID_FILE);
  let jwk: Record<string, string> | null = null;
  try {
    jwk = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    jwk = null;
  }
  if (!jwk || typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
    writeFileAtomic(file, JSON.stringify(jwk) + '\n', { mode: 0o600 });
  }
  const publicRaw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const keys = {
    publicKey: b64url(publicRaw),
    privateKey: createPrivateKey({ key: jwk as unknown as import('crypto').JsonWebKey, format: 'jwk' }),
  };
  cached = { root, keys };
  return keys;
}

/**
 * The Authorization header for one push service: a JWT naming the service's
 * origin as its audience, valid for twelve hours, signed ES256. The subject
 * is how the service's operator could reach whoever runs the workspace;
 * Apple refuses a push without one, so it is the workspace's own origin.
 */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }))
  );
  const unsigned = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypt a payload to one subscription, as RFC 8291 lays it out: an
 * ephemeral ECDH key agreed with the browser's key, mixed with the browser's
 * auth secret, gives the content key and nonce for a single aes128gcm record.
 * The salt and the ephemeral key are fresh each time, so no two pushes share
 * a key. `salt` and `ecdh` are parameters only so a test can pin them.
 */
export function encryptPayload(
  payload: Buffer,
  subscriptionKeys: { p256dh: string; auth: string },
  opts: { salt?: Buffer; ecdh?: ReturnType<typeof createECDH> } = {}
): Buffer {
  const uaPublic = Buffer.from(subscriptionKeys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscriptionKeys.auth, 'base64url');
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('the subscription keys are malformed');
  const ecdh = opts.ecdh ?? createECDH('prime256v1');
  if (!opts.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = opts.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  // One record, so it is the last: the plaintext ends with the 0x02 delimiter.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/**
 * The push services a subscription may point at. The workspace POSTs to
 * whatever endpoint a browser hands it, so without a list a signed-in person
 * could have the server send requests to any address it can reach, internal
 * ones included. These are the services the browsers in use today subscribe
 * with: Chrome, Edge's Android build, Samsung Internet, Opera, and Brave on
 * Google's; Firefox on Mozilla's; Safari on Apple's; desktop Edge on
 * Microsoft's.
 */
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)mozilla\.com$/, /(^|\.)mozaws\.net$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function isPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.port === '' && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The origin the subscription was made from, which signs as the VAPID subject. */
  origin: string;
}

export type PushOutcome = 'sent' | 'gone' | 'failed';

/**
 * Send one push. 'gone' means the push service says the subscription no
 * longer exists (the person turned notifications off, or the browser dropped
 * it), and the caller should forget it; 'failed' is anything else, worth a
 * line in the log and nothing more, since a notification is not worth a retry.
 */
export async function sendPush(
  root: string,
  target: PushTarget,
  payload: unknown,
  opts: { ttl?: number; urgency?: 'normal' | 'high'; topic?: string } = {}
): Promise<{ outcome: PushOutcome; status: number; detail?: string }> {
  const keys = vapidKeys(root);
  let body: Buffer;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(payload)), target.keys);
  } catch (e) {
    return { outcome: 'gone', status: 0, detail: e instanceof Error ? e.message : String(e) };
  }
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(keys, target.endpoint, target.origin),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttl ?? 12 * 3600),
    Urgency: opts.urgency ?? 'normal',
  };
  // A topic lets the service replace a push still waiting for an offline
  // device with a newer one on the same topic, instead of queueing both.
  if (opts.topic) headers.Topic = createHash('sha256').update(opts.topic).digest('base64url').slice(0, 32);
  let res: Response;
  try {
    res = await fetch(target.endpoint, { method: 'POST', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { outcome: 'failed', status: 0, detail: e instanceof Error ? e.message : String(e) };
  }
  if (res.status >= 200 && res.status < 300) return { outcome: 'sent', status: res.status };
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  // 404 and 410 are the protocol's "no such subscription". A 403 is kept as a
  // failure rather than a goodbye: it can mean the subscription was made under
  // other keys, but it is also what a rejected JWT gets, and forgetting every
  // subscription over a signing problem would be the worse mistake.
  if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status, detail };
  return { outcome: 'failed', status: res.status, detail };
}
