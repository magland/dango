import { deflateSync } from 'zlib';
import { Theme, activeTheme } from '../../mochiforge/src/themes';

// The mark as PNG, for the places SVG is not taken: the home-screen icon on
// iPhone and iPad (apple-touch-icon), the installed app's icon on Android and
// the desktop (the manifest's icons), and the icons a notification carries.
//
// The mark is three circles and a stroke, so it is drawn here directly rather
// than by an SVG renderer: each pixel is sampled sixteen times against the
// same geometry logo.ts writes as SVG, in the same 64-unit square, and the
// samples averaged for the edges. The result is encoded as an ordinary PNG
// with zlib from Node itself.

const LINE = { x1: 14, y1: 50, x2: 50, y2: 14, r: 3 };
const CIRCLES = [
  [22, 42],
  [32, 32],
  [42, 22],
];
/** The circles' ring: stroke width 6 centred on radius 9. */
const RING_IN = 6;
const RING_OUT = 12;

type Ink = 'ground' | 'mark';

function segmentDistance(px: number, py: number): number {
  const dx = LINE.x2 - LINE.x1;
  const dy = LINE.y2 - LINE.y1;
  const t = Math.max(0, Math.min(1, ((px - LINE.x1) * dx + (py - LINE.y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (LINE.x1 + t * dx), py - (LINE.y1 + t * dy));
}

/** What the mark paints at a point, in paint order: the stick, then each dango over it. */
function inkAt(x: number, y: number): Ink {
  let ink: Ink = segmentDistance(x, y) <= LINE.r ? 'mark' : 'ground';
  for (const [cx, cy] of CIRCLES) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= RING_OUT) ink = d >= RING_IN ? 'mark' : 'ground';
  }
  return ink;
}

function parseColor(css: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return fallback;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An RGBA image as PNG: 8 bits per channel, no filtering, one IDAT. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draw the mark into a size-by-size image. `scale` is how much of the square
 * the mark keeps around its centre; `ground` and `mark` are RGBA.
 */
function draw(size: number, scale: number, ground: number[], mark: number[]): Buffer {
  const out = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = ((px + (sx + 0.5) / S) / size) * 64;
          const v = ((py + (sy + 0.5) / S) / size) * 64;
          if (inkAt(32 + (u - 32) / scale, 32 + (v - 32) / scale) === 'mark') hits++;
        }
      }
      const a = hits / (S * S);
      const o = (py * size + px) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(ground[c] * (1 - a) + mark[c] * a);
    }
  }
  return out;
}

const made = new Map<string, Buffer>();

/**
 * The app icon: the mark on a full square of the theme's surface colour. The
 * square is full-bleed because the platforms cut their own shape from it (a
 * rounded square on iOS, a circle or a squircle on Android), and the mark is
 * held inside the central circle Android's "maskable" rule keeps visible, so
 * one image serves as both the plain and the maskable icon.
 */
export function appIconPng(size: number, theme: Theme = activeTheme()): Buffer {
  const key = `icon:${theme.name}:${size}`;
  let png = made.get(key);
  if (!png) {
    const ground = [...parseColor(theme.vars.surface, [255, 255, 255]), 255];
    const ink = [...parseColor(theme.vars.fg, [0, 0, 0]), 255];
    png = encodePng(size, size, draw(size, 0.78, ground, ink));
    made.set(key, png);
  }
  return png;
}

/**
 * The badge: the small monochrome icon Android shows in the status bar for a
 * notification. Only its alpha is used, so it is the mark in white on
 * transparent, drawn larger since it is shown at 24 pixels.
 */
export function badgePng(size = 96): Buffer {
  const key = `badge:${size}`;
  let png = made.get(key);
  if (!png) {
    png = encodePng(size, size, draw(size, 1.3, [255, 255, 255, 0], [255, 255, 255, 255]));
    made.set(key, png);
  }
  return png;
}

/** The sizes served: Apple's home-screen size, and the two the manifest lists. */
export const ICON_SIZES = [180, 192, 512];
