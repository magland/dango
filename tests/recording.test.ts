import '../src/branding';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Manifest, layout, planRecording, renderRecording } from '../src/recording';

// A call recorded by alice: bob joins after a second, alice shares her
// screen for two seconds, the recording is paused for a second, and alice's
// camera rolls over into a second segment (as one does every five minutes).
function sampleManifest(): Manifest {
  return {
    format: 'dango-recording',
    version: 1,
    title: '#general',
    participants: {
      a: { user: 'alice', name: 'alice', self: true },
      b: { user: 'bob', name: 'bob', self: false },
    },
    segments: [
      { file: '001-alice-audio.webm', participant: 'a', kind: 'audio', start: 0, end: 4000 },
      { file: '002-alice-camera.webm', participant: 'a', kind: 'camera', start: 0, end: 2050 },
      { file: '003-alice-camera.webm', participant: 'a', kind: 'camera', start: 2000, end: 4000 },
      { file: '004-bob-audio.webm', participant: 'b', kind: 'audio', start: 1000, end: 4000 },
      { file: '005-bob-camera.webm', participant: 'b', kind: 'camera', start: 1000, end: 4000 },
      { file: '006-alice-screen.webm', participant: 'a', kind: 'screen', start: 1500, end: 3500 },
      { file: '007-alice-audio.webm', participant: 'a', kind: 'audio', start: 5000, end: 6000 },
      { file: '008-bob-audio.webm', participant: 'b', kind: 'audio', start: 5000, end: null },
    ],
    events: [
      { t: 0, type: 'start' },
      { t: 4000, type: 'pause' },
      { t: 5000, type: 'resume' },
      { t: 6000, type: 'stop' },
    ],
  };
}

test('the plan takes the pauses out, and places each person’s audio in the rebuilt timeline', () => {
  const plan = planRecording(sampleManifest());
  assert.strictEqual(plan.duration, 5000);
  assert.deepStrictEqual(plan.pauses, [{ from: 4000, to: 5000 }]);
  assert.deepStrictEqual(
    plan.people.map((p) => [p.audioFile, p.audio.map((a) => [a.file, a.at, a.duration])]),
    [
      ['01-alice.wav', [['001-alice-audio.webm', 0, 4000], ['007-alice-audio.webm', 4000, 1000]]],
      ['02-bob.wav', [['004-bob-audio.webm', 1000, 3000]]],
    ]
  );
  assert.deepStrictEqual(plan.skipped.map((s) => s.file), ['008-bob-audio.webm'], 'an unfinished segment is left out');
});

test('a track’s segments that overlap where one rolled over to the next are cut so they do not', () => {
  const plan = planRecording(sampleManifest());
  const at2000 = plan.intervals.find((iv) => iv.from <= 2000 && iv.to > 2000)!;
  const cams = at2000.tiles.filter((t) => t.participant === 'a' && t.kind === 'camera');
  assert.deepStrictEqual(cams.map((t) => t.file), ['003-alice-camera.webm']);
});

test('the picture is cut where videos begin and end, with the screen large while it is shared', () => {
  const plan = planRecording(sampleManifest());
  const shape = plan.intervals.map((iv) => [iv.from, iv.to, iv.tiles.map((t) => t.file.slice(0, 3) + (t.w === 960 ? '*' : ''))]);
  assert.deepStrictEqual(shape, [
    [0, 1000, ['002']],
    [1000, 1500, ['002', '005']],
    [1500, 2000, ['006*', '002', '005']],
    [2000, 3500, ['006*', '003', '005']],
    [3500, 4000, ['003', '005']],
    [4000, 5000, []],
  ]);
  const later = plan.intervals[3].tiles.find((t) => t.file === '005-bob-camera.webm')!;
  assert.strictEqual(later.offset, 1000, 'a tile starts as far into its file as the interval is into the segment');
  // Each cut falls on a frame at 30 frames a second.
  for (const iv of plan.intervals) assert.ok(Math.abs(((iv.from * 30) / 1000) - Math.round((iv.from * 30) / 1000)) < 0.02);
});

test('cameras alone are laid out in a grid, a short last row centered', () => {
  const one = layout([], ['a']);
  assert.deepStrictEqual(one.get('a'), { x: 0, y: 0, w: 1280, h: 720 });
  const three = layout([], ['a', 'b', 'c']);
  assert.deepStrictEqual(three.get('a'), { x: 0, y: 0, w: 640, h: 360 });
  assert.deepStrictEqual(three.get('c'), { x: 320, y: 360, w: 640, h: 360 });
});

test('a manifest that is not a recording’s is refused', () => {
  assert.throws(() => planRecording({ ...sampleManifest(), format: 'other' }), /not a dango recording/);
  assert.throws(() => planRecording({ ...sampleManifest(), version: 2 }), /version 2/);
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('rendering makes aligned audio of the whole length for each person, and the call as one video', { skip: !haveFfmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dango-recording-'));
  const m = sampleManifest();
  // Files like MediaRecorder's: WebM, Opus or VP8, each as long as its segment.
  for (const s of m.segments) {
    if (s.start === null || s.end === null) continue;
    const secs = String((s.end - s.start) / 1000);
    const args =
      s.kind === 'audio'
        ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-c:a', 'libopus']
        : ['-f', 'lavfi', '-i', `testsrc=size=${s.kind === 'screen' ? '1920x1080' : '640x480'}:rate=15:duration=${secs}`, '-c:v', 'libvpx', '-b:v', '200k'];
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(dir, s.file)]);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  const lines: string[] = [];
  await renderRecording(dir, { log: (l) => lines.push(l) });
  const out = path.join(dir, 'rebuilt');
  const seconds = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
  for (const f of ['01-alice.wav', '02-bob.wav']) assert.ok(Math.abs(seconds(path.join(out, 'audio', f)) - 5) < 0.05, `${f} is the whole length`);
  assert.ok(Math.abs(seconds(path.join(out, 'call.mp4')) - 5) < 0.2, 'call.mp4 is the whole length');
  const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(out, 'call.mp4')]).toString().trim();
  assert.strictEqual(size, '1280,720');
  assert.ok(fs.existsSync(path.join(out, 'timeline.json')));
  assert.ok(!fs.existsSync(path.join(out, '.work')), 'the working files are removed');
  assert.ok(lines.some((l) => l.includes('Leaving out 008-bob-audio.webm')));
});
