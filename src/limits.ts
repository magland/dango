import { createLimiter } from '../../mochiforge/src/limit';
import { OpError } from '../../mochiforge/src/ops';
import { LimitsConfig } from './config';

// Per-person limits on writing, so that one account cannot flood a workspace,
// whether by a script or by a key held down. They are sized for a person using
// the interface: a quick burst of messages passes, a sustained stream at a
// pace no one types does not. The address-based limit in server.ts is a
// separate, coarser thing, about request volume rather than about people.
//
// Keyed by username, so the key space is the workspace's users and cannot be
// grown by anyone outside it. Counted in memory, in fixed windows (mochi's
// limiter), and forgotten on a restart, which is a limit's usual bargain.

/**
 * A refusal for going too fast. An OpError, so that every place which already
 * shows an operation's refusal on its form shows this one the same way; the
 * routes that answer with a status give it 429 and a Retry-After.
 */
export class RateLimited extends OpError {
  constructor(
    message: string,
    readonly retryAfter: number
  ) {
    super(message, 'conflict');
  }
}

/** The status a refused operation deserves, 429 for going too fast. */
export function refusalStatus(e: OpError, opErrorStatus: (kind: OpError['kind']) => number): number {
  return e instanceof RateLimited ? 429 : opErrorStatus(e.kind);
}

export interface WriteLimits {
  /** Charge one message with this many bytes of attachments, or throw RateLimited. */
  message(username: string, bytes: number): void;
  /** Charge one other write (a reaction, an edit, a deletion, a new room), or throw RateLimited. */
  action(username: string): void;
}

/** Bytes per person per window. mochi's limiter counts events, and an upload is weighed, not counted. */
function createByteBudget(bytesPerWindow: number, windowMs: number) {
  const used = new Map<string, { bytes: number; resetAt: number }>();
  return (key: string, bytes: number): number => {
    if (bytesPerWindow <= 0 || bytes === 0) return 0;
    const now = Date.now();
    let entry = used.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { bytes: 0, resetAt: now + windowMs };
      used.set(key, entry);
    }
    if (entry.bytes + bytes > bytesPerWindow) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    entry.bytes += bytes;
    return 0;
  };
}

function wait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function createWriteLimits(cfg: LimitsConfig): WriteLimits {
  const maxKeys = 100000;
  const perMinute = createLimiter({ limit: cfg.messagesPerMinute, windowMs: 60_000, maxKeys });
  const perHour = createLimiter({ limit: cfg.messagesPerHour, windowMs: 3_600_000, maxKeys });
  const actions = createLimiter({ limit: cfg.actionsPerMinute, windowMs: 60_000, maxKeys });
  const uploads = createByteBudget(cfg.uploadMbPerHour * 1024 * 1024, 3_600_000);
  return {
    message(username, bytes) {
      // Checked before charged, so a refusal by one window does not spend the
      // other, and a refused send costs nothing it can be refused for later.
      for (const limiter of [perMinute, perHour]) {
        const d = limiter.check(username);
        if (!d.ok) throw new RateLimited(`You are sending messages faster than this workspace allows. Wait ${wait(d.retryAfter)} and send again.`, d.retryAfter);
      }
      const late = uploads(username, bytes);
      if (late) {
        throw new RateLimited(
          `You have uploaded ${cfg.uploadMbPerHour} MB in the last hour, which is this workspace's limit. Wait ${wait(late)}, or send the message without its attachments.`,
          late
        );
      }
      perMinute.hit(username);
      perHour.hit(username);
    },
    action(username) {
      const d = actions.hit(username);
      if (!d.ok) throw new RateLimited(`That is faster than this workspace allows. Wait ${wait(d.retryAfter)} and try again.`, d.retryAfter);
    },
  };
}
