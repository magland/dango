import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../../mochiforge/src/atomic';

// What became of each connection in each call, as the pages in it saw it,
// so that when someone says a call did not work there is something to look
// at. Every page reports each of its connections once: when it opens (with
// the path it took, direct or through the relay), when an attempt fails, and
// when an open connection drops. Two people in a call each report their side,
// since two networks can see one connection differently.
//
// A report says what kind of path was found and which ICE servers answered
// with errors, never the addresses themselves. The newest few hundred are kept
// in call-log.json at the workspace's root, shown to site admins on the admin
// page, and written to the server's log as one line each. The file is a
// diagnostic, not part of the workspace, and backups leave it out.

export const CALL_LOG_FILE = 'call-log.json';
const MAX_REPORTS = 300;

export type Outcome = 'connected' | 'failed' | 'dropped';

export interface CandidatePath {
  /** The ICE candidate types of the pair in use: host, srflx, prflx, or relay. */
  local: string;
  remote: string;
  /** udp or tcp, and for a relay, how this browser reaches it: udp, tcp, or tls. */
  protocol: string;
  relayProtocol?: string;
  /** Round trip in seconds, as the browser measured it. */
  rtt?: number;
}

export interface IceError {
  url: string;
  code: number;
  text: string;
}

export interface ConnectionReport {
  at: string;
  room: string;
  user: string;
  with: string;
  /** The reporting browser, as a device label ("Chrome on macOS"). */
  device: string;
  outcome: Outcome;
  /** Milliseconds: to connect, until the attempt was given up, or how long it stayed open. */
  ms: number;
  attempt: number;
  path?: CandidatePath;
  /** The kinds of candidate this browser found: "host/udp", "srflx/udp", "relay/tcp". */
  gathered: string[];
  errors: IceError[];
  /** Whether the workspace gave this page a relay to use. */
  relayOffered: boolean;
}

const KIND = /^(?:host|srflx|prflx|relay)$/;
const PROTO = /^(?:udp|tcp|tls)$/;

/** A page's text, shortened, and with control characters (a newline most of all) made spaces, since it is written to the server's log a line at a time. */
function clip(v: unknown, n: number): string {
  return typeof v === 'string' ? v.slice(0, n).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ') : '';
}

/** What a page sent, reduced to the report's shape, or null when it is not one. */
export function parseReport(raw: unknown): Omit<ConnectionReport, 'at' | 'room' | 'user' | 'with' | 'device'> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.outcome !== 'connected' && r.outcome !== 'failed' && r.outcome !== 'dropped') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  let p: CandidatePath | undefined;
  if (typeof r.path === 'object' && r.path !== null) {
    const x = r.path as Record<string, unknown>;
    if (typeof x.local === 'string' && KIND.test(x.local) && typeof x.remote === 'string' && KIND.test(x.remote)) {
      p = {
        local: x.local,
        remote: x.remote,
        protocol: typeof x.protocol === 'string' && PROTO.test(x.protocol) ? x.protocol : '',
        ...(typeof x.relayProtocol === 'string' && PROTO.test(x.relayProtocol) ? { relayProtocol: x.relayProtocol } : {}),
        ...(typeof x.rtt === 'number' && Number.isFinite(x.rtt) ? { rtt: Math.round(x.rtt * 1000) / 1000 } : {}),
      };
    }
  }
  const gathered = Array.isArray(r.gathered)
    ? [...new Set(r.gathered.filter((g): g is string => typeof g === 'string' && /^(?:host|srflx|prflx|relay)\/(?:udp|tcp)$/.test(g)))].slice(0, 12)
    : [];
  const errors = Array.isArray(r.errors)
    ? r.errors
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .map((e) => ({ url: clip(e.url, 200), code: Math.floor(num(e.code)), text: clip(e.text, 200) }))
        .slice(0, 10)
    : [];
  return {
    outcome: r.outcome,
    ms: Math.round(num(r.ms)),
    attempt: Math.min(1000, Math.floor(num(r.attempt)) || 1),
    ...(p ? { path: p } : {}),
    gathered,
    errors,
    relayOffered: r.relayOffered === true,
  };
}

function logFile(root: string): string {
  return path.join(root, CALL_LOG_FILE);
}

export function readReports(root: string): ConnectionReport[] {
  try {
    const list = JSON.parse(fs.readFileSync(logFile(root), 'utf8'));
    return Array.isArray(list) ? (list as ConnectionReport[]) : [];
  } catch {
    return [];
  }
}

/** How a connection went, in words, for the admin page and the server's log. */
export function describePath(p: CandidatePath | undefined): string {
  if (!p) return 'by a path the browser did not say';
  if (p.local === 'relay' || p.remote === 'relay') {
    const how = p.local === 'relay' ? (p.relayProtocol ?? p.protocol).toUpperCase() : 'the other side’s relay';
    return p.local === 'relay' ? `through the relay (TURN over ${how})` : `through ${how}`;
  }
  return `directly (${p.protocol.toUpperCase() || 'UDP'})`;
}

export function describeReport(r: ConnectionReport): string {
  const secs = (ms: number) => (ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);
  if (r.outcome === 'connected') return `connected ${describePath(r.path)} in ${secs(r.ms)}`;
  if (r.outcome === 'dropped') return `dropped after ${secs(r.ms)}, having been connected ${describePath(r.path)}`;
  return `failed to connect after ${secs(r.ms)} (attempt ${r.attempt})`;
}

// Reports come from pages, a few per call; this keeps one page that has gone
// wrong from filling the log.
const recent = new Map<string, number[]>();
const REPORTS_PER_MINUTE = 30;

export function allowReport(user: string, now = Date.now()): boolean {
  const times = (recent.get(user) ?? []).filter((t) => now - t < 60000);
  if (times.length >= REPORTS_PER_MINUTE) return false;
  times.push(now);
  recent.set(user, times);
  return true;
}

export function recordReport(root: string, report: ConnectionReport): void {
  const list = [...readReports(root), report].slice(-MAX_REPORTS);
  writeFileAtomic(logFile(root), JSON.stringify(list) + '\n', { mode: 0o600 });
  const errors = report.errors.length ? `; ICE errors: ${report.errors.map((e) => `${e.code} ${e.text} (${e.url})`).join(', ')}` : '';
  console.log(
    `call: ${report.user} to ${report.with} in ${report.room}, ${report.device}: ${describeReport(report)}; found ${report.gathered.join(', ') || 'no candidates'}${report.relayOffered ? '' : '; no relay offered'}${errors}`
  );
}
