import * as path from 'path';
import * as fs from 'fs';
import { fileCache } from '../../mochiforge/src/filecache';
import { withFileLock, writeFileAtomic } from '../../mochiforge/src/atomic';
import { DEFAULT_THEME, findTheme } from '../../mochiforge/src/themes';

// Workspace-level settings, kept in <workspace>/config.json next to
// workspace.json. A plain file: hand-editing it is legitimate, and a missing
// or unreadable file simply means defaults.

export const CONFIG_FILE = 'config.json';

/**
 * The TURN relay's credentials: its password, coturn's shared secret, and
 * Cloudflare's API token. They are kept apart from config.json, which holds
 * nothing secret and so goes into a backup made without secrets; this file,
 * like .secret, does not.
 */
export const TURN_SECRETS_FILE = '.turn';
const SECRET_FIELDS = ['credential', 'secret', 'apiToken'] as const;

export interface LimitsConfig {
  /** Requests per minute per address, over everything not exempt. 0 disables. */
  requestsPerMinute: number;
  /** Failed credential checks per address per username, per 15 minutes. 0 disables. */
  authFailures: number;
  /** Messages one person may send per minute, and per hour. 0 disables either. */
  messagesPerMinute: number;
  messagesPerHour: number;
  /** Megabytes of attachments one person may upload per hour. 0 disables. */
  uploadMbPerHour: number;
  /** Reactions, edits, deletions, and new rooms, together, per person per minute. 0 disables. */
  actionsPerMinute: number;
}

export interface NetworkConfig {
  /** Whether X-Forwarded-For and X-Forwarded-Proto may be believed. */
  trustProxy: boolean;
}

/**
 * How a call's browsers find a path to each other (see src/ice.ts). STUN
 * servers only tell a browser its public address; a TURN server relays the
 * media of a pair that cannot reach each other directly, and so carries
 * traffic and is usually paid for, which is why it has a mode of its own.
 */
export type TurnMode = 'none' | 'static' | 'coturn' | 'cloudflare';

export interface CallsConfig {
  /** stun: URLs handed to every call as they are. Empty means none. */
  stun: string[];
  turn: {
    mode: TurnMode;
    /** turn:/turns: URLs, for the static and coturn modes. */
    urls: string[];
    /** static: the fixed username and password every member is given. */
    username: string;
    credential: string;
    /** coturn: its static-auth-secret, from which short-lived credentials are made. */
    secret: string;
    /** cloudflare: the TURN key's id and an API token for it. */
    keyId: string;
    apiToken: string;
  };
}

export interface WorkspaceConfig {
  /** The workspace's display name, shown at the top of the sidebar. */
  name: string;
  theme: string;
  network: NetworkConfig;
  limits: LimitsConfig;
  calls: CallsConfig;
}

/**
 * Public STUN servers, used until an admin says otherwise: with them a call
 * connects across most home and office networks with nothing set up, at the
 * cost that Google and Cloudflare see the address of each person in a call.
 */
export const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

const DEFAULTS: WorkspaceConfig = {
  name: 'dango',
  theme: DEFAULT_THEME,
  network: { trustProxy: false },
  // Sized for people using the interface: a burst of quick messages passes,
  // a sustained stream at a pace nobody types does not.
  limits: {
    requestsPerMinute: 600,
    authFailures: 10,
    messagesPerMinute: 20,
    messagesPerHour: 300,
    uploadMbPerHour: 200,
    actionsPerMinute: 60,
  },
  calls: {
    stun: DEFAULT_STUN,
    turn: { mode: 'none', urls: [], username: '', credential: '', secret: '', keyId: '', apiToken: '' },
  },
};

export function configFilePath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function normalizeCalls(v: unknown): CallsConfig {
  const out: CallsConfig = { stun: [...DEFAULTS.calls.stun], turn: { ...DEFAULTS.calls.turn, urls: [] } };
  if (typeof v !== 'object' || v === null) return out;
  const rec = v as Record<string, unknown>;
  out.stun = strings(rec.stun) ?? out.stun;
  const t = rec.turn;
  if (typeof t === 'object' && t !== null) {
    const r = t as Record<string, unknown>;
    if (r.mode === 'static' || r.mode === 'coturn' || r.mode === 'cloudflare') out.turn.mode = r.mode;
    out.turn.urls = strings(r.urls) ?? [];
    out.turn.username = text(r.username);
    out.turn.credential = text(r.credential);
    out.turn.secret = text(r.secret);
    out.turn.keyId = text(r.keyId);
    out.turn.apiToken = text(r.apiToken);
  }
  return out;
}

function normalize(parsed: unknown): WorkspaceConfig {
  const out: WorkspaceConfig = {
    name: DEFAULTS.name,
    theme: DEFAULTS.theme,
    network: { ...DEFAULTS.network },
    limits: { ...DEFAULTS.limits },
    calls: normalizeCalls(null),
  };
  if (typeof parsed !== 'object' || parsed === null) return out;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.name === 'string' && rec.name.trim() !== '') out.name = rec.name.trim();
  if (typeof rec.theme === 'string' && findTheme(rec.theme)) out.theme = rec.theme;
  const net = rec.network;
  if (typeof net === 'object' && net !== null) {
    out.network.trustProxy = (net as Record<string, unknown>).trustProxy === true;
  }
  const limits = rec.limits;
  if (typeof limits === 'object' && limits !== null) {
    const l = limits as Record<string, unknown>;
    out.limits.requestsPerMinute = num(l.requestsPerMinute, DEFAULTS.limits.requestsPerMinute);
    out.limits.authFailures = num(l.authFailures, DEFAULTS.limits.authFailures);
    out.limits.messagesPerMinute = num(l.messagesPerMinute, DEFAULTS.limits.messagesPerMinute);
    out.limits.messagesPerHour = num(l.messagesPerHour, DEFAULTS.limits.messagesPerHour);
    out.limits.uploadMbPerHour = num(l.uploadMbPerHour, DEFAULTS.limits.uploadMbPerHour);
    out.limits.actionsPerMinute = num(l.actionsPerMinute, DEFAULTS.limits.actionsPerMinute);
  }
  out.calls = normalizeCalls(rec.calls);
  return out;
}

const cache = fileCache<WorkspaceConfig>({
  read: (file) => {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return normalize(null);
    }
  },
  missing: () => normalize(null),
});

type TurnSecrets = Pick<CallsConfig['turn'], (typeof SECRET_FIELDS)[number]>;

const secretsCache = fileCache<Partial<TurnSecrets>>({
  read: (file) => {
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const out: Partial<TurnSecrets> = {};
      for (const k of SECRET_FIELDS) if (typeof rec[k] === 'string') out[k] = (rec[k] as string).trim();
      return out;
    } catch {
      return {};
    }
  },
  missing: () => ({}),
});

/** The workspace's settings, with the TURN credentials from their own file (a value hand-written into config.json is used where that file has none). */
export function loadConfig(root: string): WorkspaceConfig {
  const config = cache.get(configFilePath(root));
  const secrets = secretsCache.get(path.join(root, TURN_SECRETS_FILE));
  if (!SECRET_FIELDS.some((k) => secrets[k])) return config;
  return { ...config, calls: { ...config.calls, turn: { ...config.calls.turn, ...Object.fromEntries(SECRET_FIELDS.filter((k) => secrets[k]).map((k) => [k, secrets[k]])) } } };
}

/**
 * Record network.trustProxy: true, unless config.json already says either
 * way. Called on startup when DANGO_TRUST_PROXY=1, which `dango deploy fly`
 * sets because Fly always terminates TLS in front but cannot write to the
 * volume before the workspace exists. Only seeded, as mochi's is, so a value
 * changed by hand afterwards sticks.
 */
export function seedTrustProxy(root: string): boolean {
  return withFileLock(`${configFilePath(root)}.lock`, () => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(fs.readFileSync(configFilePath(root), 'utf8')) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const network =
      typeof parsed.network === 'object' && parsed.network !== null ? (parsed.network as Record<string, unknown>) : {};
    if (typeof network.trustProxy === 'boolean') return false;
    const next = { ...parsed, network: { ...network, trustProxy: true } };
    writeFileAtomic(configFilePath(root), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return true;
  });
}

/** Rewrite config.json with some fields changed, keeping the rest. */
export function updateConfig(root: string, changes: Partial<WorkspaceConfig>): WorkspaceConfig {
  const current = loadConfig(root);
  const next: WorkspaceConfig = {
    ...current,
    ...changes,
    network: { ...current.network, ...(changes.network ?? {}) },
    limits: { ...current.limits, ...(changes.limits ?? {}) },
    calls: changes.calls ?? current.calls,
  };
  const turn: Record<string, unknown> = { ...next.calls.turn };
  const secrets: Record<string, string> = {};
  for (const k of SECRET_FIELDS) {
    secrets[k] = next.calls.turn[k];
    delete turn[k];
  }
  writeFileAtomic(path.join(root, TURN_SECRETS_FILE), JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
  writeFileAtomic(configFilePath(root), JSON.stringify({ ...next, calls: { ...next.calls, turn } }, null, 2) + '\n', { mode: 0o600 });
  return next;
}
