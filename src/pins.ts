import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from '../../mochiforge/src/atomic';
import { fileCache } from '../../mochiforge/src/filecache';
import { OpError } from '../../mochiforge/src/ops';

// Pinned messages, per room: a pins.json beside the room's messages/, listing
// which messages are pinned, by whom, and when. One file serves channels and
// direct conversations alike, since both keep messages the same way, and a
// thread's replies are not pinned (the message a thread hangs from can be).
// Any member who can see a room may pin or unpin in it, as in Slack.

export const PINS_FILE = 'pins.json';

/** A room's board holds this many; past it, something has to be unpinned first. */
export const MAX_PINS = 100;

export interface Pin {
  id: number;
  by: string;
  at: string;
}

function pinsFile(roomDir: string): string {
  return path.join(roomDir, PINS_FILE);
}

function normalize(parsed: unknown): Pin[] {
  if (!Array.isArray(parsed)) return [];
  const out: Pin[] = [];
  for (const p of parsed) {
    if (typeof p !== 'object' || p === null) continue;
    const rec = p as Record<string, unknown>;
    if (typeof rec.id === 'number' && Number.isInteger(rec.id) && rec.id > 0) {
      out.push({ id: rec.id, by: typeof rec.by === 'string' ? rec.by : 'unknown', at: typeof rec.at === 'string' ? rec.at : '' });
    }
  }
  return out;
}

// Stat-cached, because every message a room renders asks whether it is pinned.
const cache = fileCache<Pin[]>({
  read: (file) => {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  },
  missing: () => [],
});

/** A room's pins, most recently pinned first. */
export function readPins(roomDir: string): Pin[] {
  return cache.get(pinsFile(roomDir));
}

export function pinOf(roomDir: string, id: number): Pin | null {
  return readPins(roomDir).find((p) => p.id === id) ?? null;
}

function editPins(roomDir: string, fn: (pins: Pin[]) => Pin[] | null): Pin[] {
  const file = pinsFile(roomDir);
  return withFileLock(`${file}.lock`, () => {
    let pins: Pin[] = [];
    try {
      pins = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      pins = [];
    }
    const next = fn(pins);
    if (next === null) return pins;
    writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
  });
}

/** Pin a message; pinning one already pinned changes nothing. */
export function pinMessage(roomDir: string, id: number, by: string): Pin[] {
  return editPins(roomDir, (pins) => {
    if (pins.some((p) => p.id === id)) return null;
    if (pins.length >= MAX_PINS) {
      throw new OpError(`A room holds at most ${MAX_PINS} pinned messages; unpin one first.`);
    }
    return [{ id, by, at: new Date().toISOString() }, ...pins];
  });
}

/** Unpin a message; unpinning one not pinned changes nothing. */
export function unpinMessage(roomDir: string, id: number): Pin[] {
  return editPins(roomDir, (pins) => (pins.some((p) => p.id === id) ? pins.filter((p) => p.id !== id) : null));
}
