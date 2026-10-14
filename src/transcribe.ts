import * as fs from 'fs';
import * as path from 'path';
import { Manifest, Plan, planRecording } from './recording';

// Transcribing a recorded call with Deepgram (see "Recording" in
// docs/calls.md). Each person's voice was recorded apart, so each audio
// segment is one speaker and nobody has to be told apart by their voice:
// each segment is sent to Deepgram's pre-recorded API as it is (WebM with
// Opus, which it reads), and the words that come back are moved to where
// the segment sits in the rebuilt timeline, the one `dango recording render`
// uses, so a time in the transcript is the same moment in call.mp4 and the
// aligned audio. Segments rather than the aligned files are sent because
// Deepgram charges by the length of the audio, and an aligned file is
// mostly silence for anyone who was not there throughout.
//
// What comes back for each segment is kept under .deepgram/, so running
// this again (to change the output, say) does not pay for it twice.
//
// It writes, beside what render writes:
//   transcript.json   every word and every utterance, with who and when
//   transcript.vtt    WebVTT, one cue an utterance, with the speaker's name
//                     in a voice tag, for a player to show over call.mp4
//   transcript.md     to read: each turn with the speaker and the time

export interface Word {
  person: string;
  name: string;
  word: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface Utterance {
  person: string;
  name: string;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  title: string;
  model: string;
  language: string;
  createdAt: string;
  /** Seconds, in the rebuilt timeline. */
  duration: number;
  pauses: number[];
  words: Word[];
  utterances: Utterance[];
}

export interface TranscribeOptions {
  key: string;
  out?: string;
  model?: string;
  language?: string;
  /** For the tests: where Deepgram's /v1/listen is. */
  endpoint?: string;
  log?: (line: string) => void;
}

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
}

async function listen(file: string, opts: TranscribeOptions, model: string, language: string): Promise<any> {
  const url = new URL(opts.endpoint ?? 'https://api.deepgram.com/v1/listen');
  url.searchParams.set('model', model);
  url.searchParams.set('language', language);
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('utterances', 'true');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${opts.key}`, 'Content-Type': 'audio/webm' },
    body: fs.readFileSync(file),
  });
  if (!res.ok) throw new Error(`Deepgram answered ${res.status} for ${path.basename(file)}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** One segment's words and utterances, moved to its place in the rebuilt timeline. */
export function placeResult(json: any, at: number, duration: number, person: string, name: string): { words: Word[]; utterances: Utterance[] } {
  const offset = at / 1000;
  const limit = duration / 1000;
  const alt = json?.results?.channels?.[0]?.alternatives?.[0] ?? {};
  // The segment may have been cut short where the next one of the same
  // track began; what is past the cut is the next segment's.
  const words: Word[] = ((alt.words ?? []) as DeepgramWord[])
    .filter((w) => w.start < limit)
    .map((w) => ({
      person,
      name,
      word: w.word,
      text: w.punctuated_word ?? w.word,
      start: offset + w.start,
      end: offset + Math.min(w.end, limit),
      confidence: w.confidence ?? 0,
    }));
  const utterances: Utterance[] = ((json?.results?.utterances ?? []) as { start: number; end: number; transcript: string }[])
    .filter((u) => u.start < limit && u.transcript.trim())
    .map((u) => ({ person, name, start: offset + u.start, end: offset + Math.min(u.end, limit), text: u.transcript.trim() }));
  return { words, utterances };
}

function clock(s: number, ms: boolean): string {
  const t = Math.max(0, s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = Math.floor(t % 60);
  const two = (n: number) => String(n).padStart(2, '0');
  if (ms) return `${two(h)}:${two(m)}:${two(sec)}.${String(Math.floor((t * 1000) % 1000)).padStart(3, '0')}`;
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export function toVtt(t: Transcript): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cues = t.utterances.map((u) => `${clock(u.start, true)} --> ${clock(u.end, true)}\n<v ${esc(u.name)}>${esc(u.text)}`);
  return ['WEBVTT', '', ...cues.flatMap((c) => [c, ''])].join('\n');
}

/** Turns to read: one person's utterances in a row become one paragraph, and a pause is marked where it fell. */
export function toMarkdown(t: Transcript): string {
  const lines = [`# ${t.title}`, ''];
  let who = '';
  let para: string[] = [];
  let paraStart = 0;
  const flush = () => {
    if (para.length) lines.push(`**${who}** (${clock(paraStart, false)}): ${para.join(' ')}`, '');
    para = [];
  };
  const pauses = [...t.pauses];
  for (const u of t.utterances) {
    while (pauses.length && pauses[0] <= u.start) {
      flush();
      who = '';
      lines.push(`*Recording paused at ${clock(pauses.shift()!, false)}.*`, '');
    }
    if (u.name !== who) {
      flush();
      who = u.name;
      paraStart = u.start;
    }
    para.push(u.text);
  }
  flush();
  return lines.join('\n');
}

export async function transcribeRecording(dir: string, opts: TranscribeOptions): Promise<Transcript> {
  const log = opts.log ?? (() => {});
  const model = opts.model || 'nova-3';
  const language = opts.language || 'en';
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`${dir} has no manifest.json; is it a recording's folder?`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  const plan: Plan = planRecording(manifest, (f) => fs.existsSync(path.join(dir, f)));
  for (const s of plan.skipped) log(`Leaving out ${s.file}: ${s.reason}.`);
  const out = path.resolve(opts.out ?? path.join(dir, 'rebuilt'));
  const cache = path.join(out, '.deepgram');
  fs.mkdirSync(cache, { recursive: true });

  const jobs = plan.people.flatMap((p) => p.audio.map((a) => ({ person: p, a })));
  const results: { words: Word[]; utterances: Utterance[] }[] = [];
  let next = 0;
  let done = 0;
  // A few at a time: a long call has a segment every five minutes for each person.
  const worker = async () => {
    while (next < jobs.length) {
      const { person, a } = jobs[next++];
      const cached = path.join(cache, `${a.file}.${model}.${language}.json`);
      let json: any;
      if (fs.existsSync(cached)) json = JSON.parse(fs.readFileSync(cached, 'utf8'));
      else {
        json = await listen(path.join(dir, a.file), opts, model, language);
        fs.writeFileSync(cached, JSON.stringify(json));
      }
      results.push(placeResult(json, a.at, a.duration, person.id, person.name));
      log(`Transcribed ${++done} of ${jobs.length} (${a.file}).`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));

  const byStart = <T extends { start: number }>(list: T[]) => list.sort((x, y) => x.start - y.start);
  const transcript: Transcript = {
    title: plan.title,
    model,
    language,
    createdAt: new Date().toISOString(),
    duration: plan.duration / 1000,
    // Where each pause fell in the rebuilt timeline, which has them taken out.
    pauses: plan.pauses.map((p) => plan.pauses.filter((q) => q.to <= p.from).reduce((t, q) => t - (q.to - q.from), p.from) / 1000),
    words: byStart(results.flatMap((r) => r.words)),
    utterances: byStart(results.flatMap((r) => r.utterances)),
  };
  fs.writeFileSync(path.join(out, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'transcript.vtt'), toVtt(transcript));
  fs.writeFileSync(path.join(out, 'transcript.md'), toMarkdown(transcript));
  return transcript;
}
