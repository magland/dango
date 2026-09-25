import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { MAX_PINS, pinMessage, pinOf, readPins, unpinMessage } from '../src/pins';
import { externalLinksInNewTab } from '../src/views';

function tmpRoom(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-pins-'));
}

test('pins are kept newest first, once each, and unpinned by id', () => {
  const room = tmpRoom();
  pinMessage(room, 3, 'alice');
  pinMessage(room, 7, 'bob');
  pinMessage(room, 3, 'carol');
  assert.deepStrictEqual(readPins(room).map((p) => [p.id, p.by]), [[7, 'bob'], [3, 'alice']]);
  assert.strictEqual(pinOf(room, 3)?.by, 'alice');
  unpinMessage(room, 3);
  assert.strictEqual(pinOf(room, 3), null);
  assert.deepStrictEqual(unpinMessage(room, 99).map((p) => p.id), [7], 'unpinning what is not pinned changes nothing');
  assert.ok(fs.existsSync(path.join(room, 'pins.json')));
});

test('a room holds at most a hundred pins', () => {
  const room = tmpRoom();
  for (let i = 1; i <= MAX_PINS; i++) pinMessage(room, i, 'alice');
  assert.throws(() => pinMessage(room, MAX_PINS + 1, 'alice'), /at most 100/);
});

test('links out of the workspace open in a new tab; links within it do not', () => {
  const out = externalLinksInNewTab(
    '<a href="https://example.com" rel="nofollow noopener noreferrer">x</a> <a href="/bob">@bob</a> <a href="http://a.b" target="_self" rel="nofollow noopener noreferrer">y</a>'
  );
  assert.ok(out.includes('<a href="https://example.com" rel="nofollow noopener noreferrer" target="_blank">'));
  assert.ok(out.includes('<a href="/bob">@bob</a>'));
  assert.ok(out.includes('<a href="http://a.b" rel="nofollow noopener noreferrer" target="_blank">'), 'a target the message set is replaced');
});
