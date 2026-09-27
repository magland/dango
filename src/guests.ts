import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { createLimiter } from '../../mochiforge/src/limit';
import { OpError } from '../../mochiforge/src/ops';
import { Viewer, getSecret } from '../../mochiforge/src/session';
import { loadConfig } from './config';
import { listeningUsers, publishToUser } from './events';
import { MeetingInfo, isCurrentGuest, readMeeting } from './meetings';
import { isGuestName } from './workspace';

// A meeting's guests, as the web interface meets them: the cookie that says
// who a guest is, and the lobby they wait in until a member lets them in.
//
// A guest's cookie is signed with the workspace's .secret, as a session is,
// but it is a different cookie under a different name, read only here, and
// it names one meeting. getViewer never reads it, so every route that asks
// for a signed-in member goes on refusing a guest exactly as it refuses a
// stranger; the routes of a meeting, and only those, ask for a guest as well
// (see guestViewer), and then only for the meeting the cookie names.
//
// The lobby is held in memory, like a call's roster. A guest waiting in it
// asks after themselves every few seconds (the lobby page's script does), and
// one who stops asking, having closed the page, is dropped from it. A restart
// empties it, and the next time a waiting guest's page asks, it knocks again.

const cookieName = (req: Request) => (req.protocol === 'https' ? '__Host-dango_guest' : 'dango_guest');

/**
 * How long a guest's cookie lasts unused. Each request of theirs renews it,
 * so a guest in a long call keeps their place; one who comes back a day
 * later is a new guest, and asks to be let in again.
 */
export const GUEST_MS = 24 * 60 * 60 * 1000;

/** A waiting guest who has not asked after themselves for this long has gone. */
export const WAIT_MS = 30 * 1000;
/** How many may wait to be let in to one meeting at once. */
export const MAX_WAITING = 10;
/**
 * How many times one address may knock in ten minutes, across every meeting:
 * a guest link can be passed around, and each knock is a notification to the
 * meeting's members, so a stranger with the link is held to a few.
 */
export const KNOCKS_PER_ADDRESS = 10;

export interface Guest {
  /** The guest's name inside the workspace: see isGuestName. */
  id: string;
  meeting: number;
  /** The name they gave. */
  name: string;
  /** The link generation the cookie was issued under. */
  gen: number;
  csrf: string;
  exp: number;
}

function sign(root: string, body: string): string {
  // Kept apart from the session cookie's signatures, though both use .secret.
  return createHmac('sha256', getSecret(root)).update(`dango-guest:${body}`).digest('base64url');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // a malformed value; skip it
    }
  }
  return out;
}

/** The guest this request's cookie names, if it is signed, unexpired, and well formed. Nothing is checked against the meeting. */
export function readGuestCookie(req: Request, root: string): Guest | null {
  const raw = parseCookies(req.headers.cookie)[cookieName(req)];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const body = raw.slice(0, dot);
  const a = Buffer.from(raw.slice(dot + 1));
  const b = Buffer.from(sign(root, body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof p.g !== 'string' || !isGuestName(p.g) || typeof p.m !== 'number' || typeof p.n !== 'string') return null;
  if (typeof p.k !== 'number' || typeof p.c !== 'string' || typeof p.e !== 'number' || p.e < Date.now()) return null;
  return { id: p.g, meeting: p.m, name: p.n, gen: p.k, csrf: p.c, exp: p.e };
}

function writeGuestCookie(req: Request, res: Response, root: string, g: Guest): void {
  const body = Buffer.from(JSON.stringify({ g: g.id, m: g.meeting, n: g.name, k: g.gen, c: g.csrf, e: g.exp }), 'utf8').toString('base64url');
  res.cookie(cookieName(req), `${body}.${sign(root, body)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: GUEST_MS,
    path: '/',
  });
}

/** A new guest of a meeting, with the name they gave, and their cookie. */
export function issueGuest(req: Request, res: Response, root: string, meeting: MeetingInfo, name: string): Guest {
  const g: Guest = {
    id: `~${randomBytes(6).toString('hex')}`,
    meeting: meeting.id,
    name,
    gen: meeting.gen,
    csrf: randomBytes(16).toString('hex'),
    exp: Date.now() + GUEST_MS,
  };
  writeGuestCookie(req, res, root, g);
  return g;
}

/** A cookie in use is kept alive, as a session is, once it is past half its life. */
export function renewGuest(req: Request, res: Response, root: string, g: Guest): void {
  if (g.exp - Date.now() > GUEST_MS / 2) return;
  writeGuestCookie(req, res, root, { ...g, exp: Date.now() + GUEST_MS });
}

export function clearGuestCookie(res: Response): void {
  res.clearCookie('__Host-dango_guest', { path: '/', secure: true });
  res.clearCookie('dango_guest', { path: '/' });
}

/** Whether the workspace lets meetings have guests at all (the admin's switch). */
export function guestsAllowed(root: string): boolean {
  return loadConfig(root).calls.guests;
}

/**
 * The guest this request comes from, let in to the meeting its cookie names
 * and still in it: the workspace allows guests, the meeting exists, the link
 * they came by has not been reset, and nobody has taken them out. Null for
 * anyone else, a guest still in the lobby included.
 */
export function admittedGuest(req: Request, root: string): { guest: Guest; meeting: MeetingInfo } | null {
  const g = readGuestCookie(req, root);
  if (!g || !guestsAllowed(root)) return null;
  const meeting = readMeeting(root, g.meeting);
  if (!meeting || meeting.gen !== g.gen || !isCurrentGuest(meeting, g.id)) return null;
  return { guest: g, meeting };
}

/**
 * A guest as the routes of a room take a viewer. The identity is the guest's
 * name, which no check but a meeting's accepts (see src/perms.ts), and the
 * user record is empty: a guest holds no token, no profile, and no admin bit.
 */
export function asViewer(g: Guest): Viewer {
  return { auth: { username: g.id, user: { tokens: [] }, token: { hash: '' } }, csrf: g.csrf };
}

export function guestCsrfMatches(g: Guest, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(g.csrf);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- the lobby ----

interface Waiting {
  id: string;
  name: string;
  since: number;
  seen: number;
}

const lobbies = new Map<number, Map<string, Waiting>>();
/** Guests a member turned away, until they give up asking. */
const turnedAway = new Map<string, number>();
const knocks = createLimiter({ limit: KNOCKS_PER_ADDRESS, windowMs: 10 * 60_000, maxKeys: 100000 });

/** Tell the meeting's members who have a page open who is waiting now. */
function announceLobby(root: string, meetingId: number): void {
  const meeting = readMeeting(root, meetingId);
  if (!meeting) return;
  const waiting = waitingIn(meetingId);
  const listening = new Set(listeningUsers());
  for (const u of meeting.members) {
    if (listening.has(u)) publishToUser(u, { type: 'lobby', url: `/m/${meetingId}`, title: meeting.title, waiting });
  }
}

/** Who is waiting to be let in to a meeting, in the order they came. */
export function waitingIn(meetingId: number): { id: string; name: string }[] {
  const lobby = lobbies.get(meetingId);
  return lobby ? [...lobby.values()].map((w) => ({ id: w.id, name: w.name })) : [];
}

/** Every lobby a member has someone waiting in, for their page when it loads. */
export function lobbiesFor(meetings: MeetingInfo[]): { url: string; title: string; waiting: { id: string; name: string }[] }[] {
  return meetings
    .map((m) => ({ url: `/m/${m.id}`, title: m.title, waiting: waitingIn(m.id) }))
    .filter((l) => l.waiting.length > 0);
}

export type LobbyState = 'waiting' | 'admitted' | 'turned-away' | 'closed';

/**
 * A waiting guest asking after themselves, which is also knocking: the first
 * ask puts them in the lobby (and says so, as `knocked`, so the members can
 * be told), and each later one keeps them there. Refused when the lobby is
 * full, or when this address has knocked too often.
 */
export function askToJoin(root: string, g: Guest, address: string): { state: LobbyState; knocked: boolean } {
  const meeting = readMeeting(root, g.meeting);
  if (!meeting || !guestsAllowed(root) || meeting.gen !== g.gen) return { state: 'closed', knocked: false };
  if (isCurrentGuest(meeting, g.id)) return { state: 'admitted', knocked: false };
  const away = turnedAway.get(g.id);
  if (away && away > Date.now()) return { state: 'turned-away', knocked: false };
  let lobby = lobbies.get(g.meeting);
  const here = lobby?.get(g.id);
  if (here) {
    here.seen = Date.now();
    return { state: 'waiting', knocked: false };
  }
  if ((lobby?.size ?? 0) >= MAX_WAITING) throw new OpError('Too many people are waiting to join this meeting. Try again in a minute.', 'conflict');
  if (!knocks.hit(address).ok) throw new OpError('You have asked to join too often. Wait a few minutes and try again.', 'conflict');
  if (!lobby) {
    lobby = new Map();
    lobbies.set(g.meeting, lobby);
  }
  lobby.set(g.id, { id: g.id, name: g.name, since: Date.now(), seen: Date.now() });
  announceLobby(root, g.meeting);
  return { state: 'waiting', knocked: true };
}

/** A guest came in by the link alone, in a meeting without a lobby; counted as a knock. */
export function chargeEntry(address: string): void {
  if (!knocks.hit(address).ok) throw new OpError('You have joined too often. Wait a few minutes and try again.', 'conflict');
}

/** Take a guest out of the lobby, when they were let in, turned away, or left. */
export function leaveLobby(root: string, meetingId: number, guest: string, turnAway = false): boolean {
  const lobby = lobbies.get(meetingId);
  const was = lobby?.delete(guest) ?? false;
  if (lobby && lobby.size === 0) lobbies.delete(meetingId);
  if (turnAway) turnedAway.set(guest, Date.now() + 10 * 60_000);
  if (was) announceLobby(root, meetingId);
  return was;
}

/** Empty a meeting's lobby, when its link is reset or the meeting deleted. */
export function clearLobby(root: string, meetingId: number): void {
  if (!lobbies.delete(meetingId)) return;
  announceLobby(root, meetingId);
}

/** The waiting guest of this id, if they are still waiting. */
export function waitingGuest(meetingId: number, guest: string): { id: string; name: string } | null {
  const w = lobbies.get(meetingId)?.get(guest);
  return w ? { id: w.id, name: w.name } : null;
}

/** Drop guests who stopped asking, and turned-away marks that have run out. */
export function sweepLobbies(root: string): void {
  const now = Date.now();
  for (const [meetingId, lobby] of [...lobbies]) {
    let changed = false;
    for (const [id, w] of [...lobby]) {
      if (now - w.seen > WAIT_MS) {
        lobby.delete(id);
        changed = true;
      }
    }
    if (lobby.size === 0) lobbies.delete(meetingId);
    if (changed) announceLobby(root, meetingId);
  }
  for (const [id, until] of [...turnedAway]) if (until <= now) turnedAway.delete(id);
}

/** For tests: forget every lobby. */
export function resetLobbies(): void {
  lobbies.clear();
  turnedAway.clear();
}
