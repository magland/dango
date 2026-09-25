import * as path from 'path';
import * as fs from 'fs';
import { fileCache } from '../../mochiforge/src/filecache';
import { withFileLock, writeFileAtomic } from '../../mochiforge/src/atomic';
import { DEFAULT_THEME, findTheme } from '../../mochiforge/src/themes';

// Workspace-level settings, kept in <workspace>/config.json next to
// workspace.json. A plain file: hand-editing it is legitimate, and a missing
// or unreadable file simply means defaults.

export const CONFIG_FILE = 'config.json';

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

export interface WorkspaceConfig {
  /** The workspace's display name, shown at the top of the sidebar. */
  name: string;
  theme: string;
  network: NetworkConfig;
  limits: LimitsConfig;
}

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
};

export function configFilePath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function normalize(parsed: unknown): WorkspaceConfig {
  const out: WorkspaceConfig = {
    name: DEFAULTS.name,
    theme: DEFAULTS.theme,
    network: { ...DEFAULTS.network },
    limits: { ...DEFAULTS.limits },
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

export function loadConfig(root: string): WorkspaceConfig {
  return cache.get(configFilePath(root));
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
  };
  writeFileAtomic(configFilePath(root), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}
