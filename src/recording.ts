import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Rebuilding a recorded call from its folder (see "Recording" in
// docs/calls.md). The page that recorded wrote each track to files of its
// own and a manifest of whose each file is and when; this pieces them back
// together, with ffmpeg, into what other programs can use:
//
//  - audio/<nn>-<name>.wav, one per person, all the same length and starting
//    at the same moment, silent where that person was not there. Files like
//    these open aligned in any audio or video editor, and each is one
//    speaker for a transcript.
//  - call.mp4, everyone in one picture: a shared screen large with the
//    cameras in a column beside it, or else the cameras in a grid, each tile
//    named at its lower left, and the voices mixed.
//  - timeline.json, the plan both were made from, in the rebuilt timeline.
//
// The rebuilt timeline is the recording's with its pauses taken out, so
// that the files have no silent stretches where nothing was recorded. Both
// outputs share it, so a time in one is the same moment in the other.
//
// Planning is a pure function of the manifest (planRecording), and is what
// the unit tests check; rendering runs ffmpeg on the plan.

export interface Manifest {
  format: string;
  version: number;
  title?: string;
  startedAt?: string;
  endedAt?: string | null;
  participants: Record<string, { user?: string; name?: string; self?: boolean }>;
  segments: { file: string; participant: string; kind: string; start: number | null; end: number | null }[];
  events?: { t: number; type: string }[];
}

export interface Placement {
  file: string;
  /** Where the segment begins in the rebuilt timeline, in ms. */
  at: number;
  /** How much of it to use, in ms, from its own start. */
  duration: number;
}

export interface Person {
  id: string;
  name: string;
  self: boolean;
  /** The file name of this person's aligned audio, under audio/. */
  audioFile: string;
  audio: Placement[];
}

export interface Tile {
  file: string;
  participant: string;
  kind: 'camera' | 'screen';
  /** How far into the segment's own file this interval begins, in ms. */
  offset: number;
  /** The name shown on the tile: the person's, or "<name>’s screen". */
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Interval {
  from: number;
  to: number;
  tiles: Tile[];
}

export interface Plan {
  title: string;
  width: number;
  height: number;
  fps: number;
  /** Length of the rebuilt timeline, in ms. */
  duration: number;
  /** The recording's pauses, in its own timeline, in ms. */
  pauses: { from: number; to: number }[];
  people: Person[];
  intervals: Interval[];
  /** Segments left out, and why. */
  skipped: { file: string; reason: string }[];
}

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;

export function fileSafe(s: string): string {
  return (
    String(s)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'someone'
  );
}

/** The recording's pauses, from its events, as [from, to) in its own timeline. */
function pausesOf(m: Manifest, end: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let open: number | null = null;
  for (const e of m.events ?? []) {
    if (e.type === 'pause' && open === null) open = e.t;
    else if ((e.type === 'resume' || e.type === 'stop') && open !== null) {
      out.push({ from: open, to: e.t });
      open = null;
    }
  }
  if (open !== null) out.push({ from: open, to: end });
  return out;
}

/** A time in the recording's own timeline, moved to the rebuilt one. */
function rebuiltTime(t: number, pauses: { from: number; to: number }[]): number {
  let cut = 0;
  for (const p of pauses) {
    if (t >= p.to) cut += p.to - p.from;
    else if (t > p.from) cut += t - p.from;
  }
  return t - cut;
}

/** Where each tile goes, for the screens and cameras on at once. */
export function layout(screens: string[], cameras: string[], width = WIDTH, height = HEIGHT): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  if (screens.length) {
    // The first screen large; the cameras, and any other screen, in a column
    // at the right, as many as fit, the rest left out.
    const colW = Math.round(width / 4);
    const colH = Math.round((colW * 9) / 16);
    out.set(screens[0], { x: 0, y: 0, w: width - colW, h: height });
    const side = [...screens.slice(1), ...cameras].slice(0, Math.floor(height / colH));
    const top = Math.round((height - side.length * colH) / 2);
    side.forEach((id, i) => out.set(id, { x: width - colW, y: top + i * colH, w: colW, h: colH }));
    return out;
  }
  const n = cameras.length;
  if (!n) return out;
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const w = Math.floor(width / cols / 2) * 2;
  const h = Math.floor(height / rows / 2) * 2;
  const top = Math.round((height - rows * h) / 2);
  cameras.forEach((id, i) => {
    const row = Math.floor(i / cols);
    // A last row that is not full is centered.
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const left = Math.round((width - inRow * w) / 2);
    out.set(id, { x: left + (i % cols) * w, y: top + row * h, w, h });
  });
  return out;
}

export function planRecording(m: Manifest, present: (file: string) => boolean = () => true): Plan {
  if (m.format !== 'dango-recording') throw new Error('This is not a dango recording’s manifest.');
  if (m.version !== 1) throw new Error(`This recording's manifest is version ${m.version}, and this dango reads version 1.`);
  const skipped: { file: string; reason: string }[] = [];
  const segs: { file: string; participant: string; kind: string; start: number; end: number }[] = [];
  for (const s of m.segments) {
    if (s.start === null || s.end === null) skipped.push({ file: s.file, reason: 'it was never finished (the page closed while recording)' });
    else if (!present(s.file)) skipped.push({ file: s.file, reason: 'the file is not in the folder' });
    else if (s.end > s.start) segs.push({ ...s, start: s.start, end: s.end });
  }
  // A track's next segment starts a moment before the last one ends (see
  // SEGMENT_MAX_MS in the call script); the earlier one is cut where the
  // later begins, so the two never play at once.
  const byTrack = new Map<string, typeof segs>();
  for (const s of segs) {
    const k = s.participant + '/' + s.kind;
    if (!byTrack.has(k)) byTrack.set(k, []);
    byTrack.get(k)!.push(s);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < list.length; i++) list[i].end = Math.min(list[i].end, list[i + 1].start);
  }
  const live = segs.filter((s) => s.end > s.start);

  const lastEvent = (m.events ?? []).find((e) => e.type === 'stop');
  const end = Math.max(lastEvent ? lastEvent.t : 0, ...live.map((s) => s.end), 0);
  const pauses = pausesOf(m, end);
  const at = (t: number) => rebuiltTime(t, pauses);
  const duration = at(end);

  // The people, in the manifest's order, with names made unique for files.
  const people: Person[] = [];
  const used = new Set<string>();
  for (const [id, p] of Object.entries(m.participants)) {
    const audio = live
      .filter((s) => s.participant === id && s.kind === 'audio')
      .map((s) => ({ file: s.file, at: at(s.start), duration: s.end - s.start }));
    const name = p.name || p.user || 'someone';
    let base = fileSafe(name);
    for (let i = 2; used.has(base); i++) base = fileSafe(name) + '-' + i;
    used.add(base);
    people.push({ id, name, self: !!p.self, audioFile: String(people.length + 1).padStart(2, '0') + '-' + base + '.wav', audio });
  }

  // The picture: cut wherever a video segment begins or ends, each cut on a
  // frame, and laid out afresh for what is on in between.
  const frame = 1000 / FPS;
  const snap = (t: number) => Math.round(Math.round(t / frame) * frame);
  const videos = live.filter((s) => s.kind === 'camera' || s.kind === 'screen').map((s) => ({ ...s, from: snap(at(s.start)), to: snap(at(s.end)) }));
  const cuts = new Set<number>([0, snap(duration)]);
  for (const v of videos) {
    cuts.add(v.from);
    cuts.add(v.to);
  }
  const times = [...cuts].filter((t) => t >= 0 && t <= snap(duration)).sort((a, b) => a - b);
  const order = people.map((p) => p.id);
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const intervals: Interval[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const from = times[i];
    const to = times[i + 1];
    if (to <= from) continue;
    const on = videos.filter((v) => v.from <= from && v.to >= to);
    const rank = (v: { participant: string }) => order.indexOf(v.participant);
    const screens = on.filter((v) => v.kind === 'screen').sort((a, b) => rank(a) - rank(b));
    const cameras = on.filter((v) => v.kind === 'camera').sort((a, b) => rank(a) - rank(b));
    const places = layout(
      screens.map((v) => v.file),
      cameras.map((v) => v.file)
    );
    const tiles: Tile[] = [];
    for (const v of [...screens, ...cameras]) {
      const p = places.get(v.file);
      const name = nameOf.get(v.participant) ?? 'someone';
      if (p) tiles.push({ file: v.file, participant: v.participant, kind: v.kind as 'camera' | 'screen', offset: from - v.from, label: v.kind === 'screen' ? name + '’s screen' : name, ...p });
    }
    intervals.push({ from, to, tiles });
  }
  return { title: m.title || 'call', width: WIDTH, height: HEIGHT, fps: FPS, duration, pauses, people, intervals, skipped };
}

// ---- rendering ----

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd });
    let err = '';
    p.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    p.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new Error(`${cmd} was not found. Install ffmpeg (which includes ${cmd}) and try again.`) : e));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed:\n${err.trim()}`))));
  });
}

const ffmpeg = (args: string[], cwd?: string) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], cwd);

// The names on the tiles are drawn by ffmpeg's drawtext, which a build of
// ffmpeg may lack (it needs libfreetype), or may have with no font to find;
// without it the tiles go unnamed rather than the rendering failing.
async function canDrawText(): Promise<boolean> {
  try {
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1', '-vf', 'drawtext=text=a', '-f', 'null', '-']);
    return true;
  } catch {
    return false;
  }
}

/** The size of a tile's name, for a tile this tall. */
function labelSize(h: number): number {
  return Math.round(Math.min(28, Math.max(14, h / 14)));
}
const sec = (ms: number) => (ms / 1000).toFixed(3);

export interface RenderOptions {
  out?: string;
  video?: boolean;
  log?: (line: string) => void;
}

export async function renderRecording(dir: string, opts: RenderOptions = {}): Promise<Plan> {
  const log = opts.log ?? (() => {});
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`${dir} has no manifest.json; is it a recording's folder?`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  const plan = planRecording(manifest, (f) => fs.existsSync(path.join(dir, f)));
  for (const s of plan.skipped) log(`Leaving out ${s.file}: ${s.reason}.`);
  if (plan.duration < 100) throw new Error('Nothing in this recording can be rebuilt: it has no finished segments.');
  const out = path.resolve(opts.out ?? path.join(dir, 'rebuilt'));
  const work = path.join(out, '.work');
  fs.mkdirSync(path.join(out, 'audio'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  // MediaRecorder writes WebM with no duration or index, which makes
  // seeking in it slow and loose; copying each file once gives it both.
  const used = new Set<string>();
  for (const p of plan.people) for (const a of p.audio) used.add(a.file);
  for (const iv of plan.intervals) for (const t of iv.tiles) used.add(t.file);
  log(`Indexing ${used.size} files…`);
  for (const f of used) await ffmpeg(['-i', path.join(dir, f), '-c', 'copy', path.join(work, f)]);
  const src = (f: string) => path.join(work, f);

  // Each person's audio: every segment delayed to its place, mixed (they do
  // not overlap), and padded to the whole length.
  const total = sec(plan.duration);
  for (const p of plan.people) {
    const dest = path.join(out, 'audio', p.audioFile);
    log(`Audio for ${p.name}…`);
    if (!p.audio.length) {
      await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', total, '-c:a', 'pcm_s16le', dest]);
      continue;
    }
    const inputs = p.audio.flatMap((a) => ['-i', src(a.file)]);
    const chains = p.audio.map((a, i) => `[${i}:a]atrim=0:${sec(a.duration)},asetpts=PTS-STARTPTS,aresample=48000,adelay=${Math.round(a.at)}:all=1[a${i}]`);
    const mix = p.audio.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${p.audio.length}:normalize=0,apad,atrim=0:${total}[out]`;
    await ffmpeg([...inputs, '-filter_complex', [...chains, mix].join(';'), '-map', '[out]', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', dest]);
  }

  if (opts.video !== false) {
    // Each name is written to a file of its own and drawn from there, run
    // from the working directory, so that no name, and no path, has to be
    // escaped for ffmpeg's filter syntax.
    const labels = (await canDrawText()) ? new Map<string, string>() : null;
    if (!labels) log('This ffmpeg cannot draw text (it has no drawtext filter, or no font), so the tiles are left unnamed.');
    const labelFile = (label: string) => {
      if (!labels!.has(label)) {
        const f = `label-${labels!.size}.txt`;
        fs.writeFileSync(path.join(work, f), label);
        labels!.set(label, f);
      }
      return labels!.get(label)!;
    };
    // The picture, one interval at a time, each the same layout throughout.
    const clips: string[] = [];
    for (const [k, iv] of plan.intervals.entries()) {
      log(`Picture ${k + 1} of ${plan.intervals.length}…`);
      const clip = path.join(work, `clip-${String(k).padStart(4, '0')}.mp4`);
      const dur = sec(iv.to - iv.from);
      const args = ['-f', 'lavfi', '-i', `color=c=black:s=${plan.width}x${plan.height}:r=${plan.fps}`];
      const chains: string[] = [];
      let last = '[0:v]';
      iv.tiles.forEach((t, i) => {
        args.push('-ss', sec(t.offset), '-i', src(t.file));
        // The name goes on the picture after it is scaled and before it is
        // padded to the tile, so that it sits at the picture's own lower
        // left rather than out on a letterbox bar; on a box, to stay
        // readable over a light picture.
        let name = '';
        if (labels) {
          const size = labelSize(t.h);
          const pad = Math.round(size / 3);
          name = `,drawtext=textfile=${labelFile(t.label)}:expansion=none:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=${pad}:x=${2 * pad}:y=h-th-${2 * pad}`;
        }
        chains.push(
          `[${i + 1}:v]setpts=PTS-STARTPTS,scale=${t.w}:${t.h}:force_original_aspect_ratio=decrease${name},pad=${t.w}:${t.h}:(ow-iw)/2:(oh-ih)/2,setsar=1[t${i}]`,
          `${last}[t${i}]overlay=${t.x}:${t.y}:eof_action=repeat[o${i}]`
        );
        last = `[o${i}]`;
      });
      chains.push(`${last}fps=${plan.fps},format=yuv420p[v]`);
      args.push('-filter_complex', chains.join(';'), '-map', '[v]', '-t', dur, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', clip);
      await ffmpeg(args, work);
      clips.push(clip);
    }
    const list = path.join(work, 'clips.txt');
    fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    log('Putting the picture and the voices together…');
    const picture = path.join(work, 'picture.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', picture]);
    const voices = plan.people.map((p) => path.join(out, 'audio', p.audioFile));
    const mix = voices.map((_, i) => `[${i + 1}:a]`).join('') + `amix=inputs=${voices.length}:normalize=0[a]`;
    await ffmpeg([
      '-i', picture,
      ...voices.flatMap((v) => ['-i', v]),
      ...(voices.length ? ['-filter_complex', mix, '-map', '0:v', '-map', '[a]'] : ['-map', '0:v']),
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-t', total,
      '-movflags', '+faststart',
      path.join(out, 'call.mp4'),
    ]);
  }

  fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify(plan, null, 2) + '\n');
  fs.rmSync(work, { recursive: true, force: true });
  return plan;
}
