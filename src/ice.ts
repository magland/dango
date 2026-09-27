import { createHmac } from 'crypto';
import { CallsConfig } from './config';

// The ICE servers a call's browsers are given, as the workspace's config
// says. A call's media goes straight from browser to browser; what the
// workspace hands out here is only how they find a path to each other.
//
//  - STUN servers tell a browser the address the internet sees it at, which
//    is enough for most pairs to connect directly. They carry no media.
//  - A TURN server relays the media of a pair that cannot connect directly
//    (both behind strict NATs, or a network that only lets port 443 out). It
//    carries the whole call for that pair, so it is usually a paid service
//    or a server of the workspace's own, and its credentials are guarded.
//
// Three ways of holding TURN credentials are supported. A static username and
// password is what any provider can give, and is handed to every member who
// joins a call. coturn's shared secret (the TURN REST scheme) and Cloudflare's
// TURN keys never leave the server: what a member is given is a credential
// made for them that stops working after a while, and the call asks for a
// fresh one before it does.

export interface IceConfig {
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  /** When the credentials stop working, epoch ms. */
  expiresAt: number;
  /** Why the relay the workspace is set to use was left out, if it was. */
  problems: string[];
}

/**
 * How long a made credential lasts. A call longer than this refreshes it
 * (/call/ice), which asks again whether the person can see the room; so this
 * is also how long someone taken out of the room, or out of the workspace,
 * can go on using the relay with what they already hold.
 */
export const CREDENTIAL_TTL_S = 2 * 60 * 60;

// The four ICE schemes, and only the characters that belong in their URLs.
// Port 53 is refused because browsers block it, so such a URL can only time out.
const URL_RE = /^(?:stuns?|turns?):[A-Za-z0-9._~-]+(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/;

export function isIceUrl(u: string, schemes: 'stun' | 'turn'): boolean {
  return URL_RE.test(u) && !/:53(?:\?|$)/.test(u) && u.startsWith(schemes);
}

/**
 * The TURN REST credential for a person: the username is when it expires and
 * who it is for, and the password is an HMAC of the username under the shared
 * secret, which is what coturn checks with use-auth-secret.
 */
export function coturnCredential(secret: string, who: string, now: number, ttlS = CREDENTIAL_TTL_S): { username: string; credential: string; expiresAt: number } {
  const expiry = Math.floor(now / 1000) + ttlS;
  const username = `${expiry}:${who}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt: expiry * 1000 };
}

/** What a TURN mode needs filled in before it can be used, or null when it has it. */
export function turnProblem(calls: CallsConfig): string | null {
  const t = calls.turn;
  if (t.mode === 'static' && (!t.urls.length || !t.username || !t.credential)) return 'a static TURN server needs its URLs, a username, and a password';
  if (t.mode === 'coturn' && (!t.urls.length || !t.secret)) return 'coturn needs its URLs and its shared secret';
  if (t.mode === 'cloudflare' && (!t.keyId || !t.apiToken)) return 'Cloudflare TURN needs the key id and an API token';
  return null;
}

/**
 * Reduce an ICE server list from Cloudflare to what can be handed to a
 * browser: well-formed URLs, never port 53, with a credential for any relay.
 */
export function sanitizeIceServers(value: unknown): IceConfig['iceServers'] {
  if (!Array.isArray(value)) value = value ? [value] : [];
  const out: IceConfig['iceServers'] = [];
  for (const raw of (value as unknown[]).slice(0, 8)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as { urls?: unknown; username?: unknown; credential?: unknown };
    const list = Array.isArray(e.urls) ? e.urls : typeof e.urls === 'string' ? [e.urls] : [];
    const urls = list.filter((u): u is string => typeof u === 'string' && (isIceUrl(u, 'stun') || isIceUrl(u, 'turn'))).slice(0, 12);
    if (!urls.length) continue;
    if (typeof e.username === 'string' && typeof e.credential === 'string') {
      out.push({ urls, username: e.username, credential: e.credential });
    } else if (!urls.some((u) => u.startsWith('turn'))) {
      out.push({ urls });
    }
  }
  return out;
}

async function cloudflareServers(keyId: string, apiToken: string): Promise<IceConfig['iceServers']> {
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: CREDENTIAL_TTL_S }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Cloudflare answered ${r.status}`);
  const body = (await r.json()) as { iceServers?: unknown };
  return sanitizeIceServers(body.iceServers).filter((s) => s.username);
}

/**
 * The ICE configuration for one person joining a call. A TURN service that
 * cannot be reached is logged and left out rather than refusing the call:
 * most pairs connect without a relay, and a call that works for most is
 * better than none.
 */
export async function iceFor(calls: CallsConfig, username: string, now = Date.now()): Promise<IceConfig> {
  const iceServers: IceConfig['iceServers'] = [];
  const stun = calls.stun.filter((u) => isIceUrl(u, 'stun'));
  if (stun.length) iceServers.push({ urls: stun });
  let expiresAt = now + CREDENTIAL_TTL_S * 1000;
  const problems: string[] = [];
  const t = calls.turn;
  const urls = t.urls.filter((u) => isIceUrl(u, 'turn'));
  const missing = turnProblem(calls);
  if (missing) problems.push(`The relay is not used: ${missing}.`);
  if (missing === null) {
    if (t.mode === 'static' && urls.length) {
      iceServers.push({ urls, username: t.username, credential: t.credential });
    } else if (t.mode === 'coturn' && urls.length) {
      const c = coturnCredential(t.secret, username, now);
      iceServers.push({ urls, username: c.username, credential: c.credential });
      expiresAt = c.expiresAt;
    } else if (t.mode === 'cloudflare') {
      try {
        iceServers.push(...(await cloudflareServers(t.keyId, t.apiToken)));
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        console.error(`calls: Cloudflare TURN credentials could not be made: ${why}`);
        problems.push(`The relay is not used: Cloudflare's TURN credentials could not be made (${why}).`);
      }
    }
  }
  return { iceServers, expiresAt, problems };
}
