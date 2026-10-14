import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Manifest } from '../src/recording';
import { placeResult, transcribeRecording } from '../src/transcribe';

// What Deepgram's pre-recorded API answers, in the parts read here: words
// with their times, and utterances.
function answer(said: { text: string; start: number; end: number }[]) {
  return {
    results: {
      channels: [{ alternatives: [{ transcript: said.map((s) => s.text).join(' '), words: said.flatMap((s) => s.text.split(' ').map((w, i, all) => {
        const step = (s.end - s.start) / all.length;
        return { word: w.toLowerCase().replace(/[^a-z]/g, ''), punctuated_word: w, start: s.start + i * step, end: s.start + (i + 1) * step, confidence: 0.9 };
      })) }] }],
      utterances: said.map((s) => ({ start: s.start, end: s.end, transcript: s.text })),
    },
  };
}

test('a segment’s words are moved to its place in the call, and what is past its cut is left to the next', () => {
  const r = placeResult(answer([{ text: 'Hello there.', start: 0.5, end: 1.5 }, { text: 'Past the cut.', start: 3.2, end: 4 }]), 10000, 3000, 'a', 'alice');
  assert.deepStrictEqual(r.utterances, [{ person: 'a', name: 'alice', start: 10.5, end: 11.5, text: 'Hello there.' }]);
  assert.deepStrictEqual(r.words.map((w) => [w.text, w.start]), [['Hello', 10.5], ['there.', 11]]);
});

test('transcribing sends each segment to Deepgram once, and writes the call as turns, captions, and words', async () => {
  // A stand-in for Deepgram: each file's contents say what was said in it.
  const seen: { auth: string; params: Record<string, string>; type: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      seen.push({ auth: String(req.headers.authorization), params: Object.fromEntries(url.searchParams), type: String(req.headers['content-type']), body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(answer(JSON.parse(body))));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/listen`;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dango-transcribe-'));
    const m: Manifest = {
      format: 'dango-recording',
      version: 1,
      title: '#general',
      participants: { a: { name: 'alice', self: true }, b: { name: 'bob' } },
      segments: [
        { file: '001-alice-audio.webm', participant: 'a', kind: 'audio', start: 0, end: 10000 },
        { file: '002-bob-audio.webm', participant: 'b', kind: 'audio', start: 2000, end: 10000 },
        { file: '003-alice-audio.webm', participant: 'a', kind: 'audio', start: 15000, end: 20000 },
      ],
      events: [
        { t: 0, type: 'start' },
        { t: 10000, type: 'pause' },
        { t: 15000, type: 'resume' },
        { t: 20000, type: 'stop' },
      ],
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    const said: Record<string, { text: string; start: number; end: number }[]> = {
      '001-alice-audio.webm': [{ text: 'Shall we start?', start: 1, end: 2 }, { text: 'Good, the plan is ready.', start: 5, end: 7 }],
      '002-bob-audio.webm': [{ text: 'Yes, go ahead.', start: 1, end: 2 }],
      '003-alice-audio.webm': [{ text: 'We are back.', start: 0.5, end: 1.5 }],
    };
    for (const [f, s] of Object.entries(said)) fs.writeFileSync(path.join(dir, f), JSON.stringify(s));

    const t = await transcribeRecording(dir, { key: 'test-key', endpoint });
    assert.strictEqual(seen.length, 3);
    assert.ok(seen.every((r) => r.auth === 'Token test-key' && r.type === 'audio/webm' && r.params.model === 'nova-3' && r.params.utterances === 'true'));
    assert.deepStrictEqual(
      t.utterances.map((u) => [u.name, u.start, u.text]),
      [
        ['alice', 1, 'Shall we start?'],
        ['bob', 3, 'Yes, go ahead.'],
        ['alice', 5, 'Good, the plan is ready.'],
        ['alice', 10.5, 'We are back.'],
      ],
      'in order of time, bob two seconds in, and alice after the pause five seconds earlier than she said it'
    );
    assert.deepStrictEqual(t.pauses, [10]);
    const out = path.join(dir, 'rebuilt');
    const md = fs.readFileSync(path.join(out, 'transcript.md'), 'utf8');
    assert.strictEqual(
      md,
      '# #general\n\n**alice** (0:01): Shall we start?\n\n**bob** (0:03): Yes, go ahead.\n\n**alice** (0:05): Good, the plan is ready.\n\n*Recording paused at 0:10.*\n\n**alice** (0:10): We are back.\n'
    );
    const vtt = fs.readFileSync(path.join(out, 'transcript.vtt'), 'utf8');
    assert.ok(vtt.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v alice>Shall we start?\n'), vtt);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'transcript.json'), 'utf8')).words.length, 14);

    // Again: Deepgram's answers are kept, and not paid for twice.
    await transcribeRecording(dir, { key: 'test-key', endpoint });
    assert.strictEqual(seen.length, 3);
  } finally {
    server.close();
  }
});
