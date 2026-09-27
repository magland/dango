import '../src/branding';
import assert from 'node:assert';
import { test } from 'node:test';
import { RateLimited, createBodySlots, createWriteLimits } from '../src/limits';

const cfg = { requestsPerMinute: 0, authFailures: 0, messagesPerMinute: 3, messagesPerHour: 5, uploadMbPerHour: 1, actionsPerMinute: 2, roomsPerHour: 2, searchesPerMinute: 2 };

test('messages are limited per person per minute, and a refusal says how long to wait', () => {
  const limits = createWriteLimits(cfg);
  for (let i = 0; i < 3; i++) limits.message('alice', 0);
  assert.throws(() => limits.message('alice', 0), (e: unknown) => e instanceof RateLimited && e.retryAfter > 0 && /Wait \d+ seconds/.test(e.message));
  assert.doesNotThrow(() => limits.message('bob', 0), 'one person’s limit is not another’s');
});

test('uploads are weighed per hour, and a refused upload spends nothing', () => {
  const limits = createWriteLimits({ ...cfg, messagesPerMinute: 100, messagesPerHour: 100 });
  const mb = 1024 * 1024;
  limits.message('alice', 0.6 * mb);
  assert.throws(() => limits.message('alice', 0.6 * mb), /uploaded 1 MB/);
  assert.doesNotThrow(() => limits.message('alice', 0), 'a message without attachments still goes');
  assert.doesNotThrow(() => limits.message('alice', 0.3 * mb), 'the refused upload was not counted');
});

test('other writes share their own limit', () => {
  const limits = createWriteLimits(cfg);
  limits.action('alice');
  limits.action('alice');
  assert.throws(() => limits.action('alice'), RateLimited);
  assert.doesNotThrow(() => limits.message('alice', 0), 'actions do not spend the message limit');
});

test('new rooms have an hourly limit of their own, and are actions too', () => {
  const limits = createWriteLimits({ ...cfg, actionsPerMinute: 100 });
  limits.newRoom('alice');
  limits.newRoom('alice');
  assert.throws(() => limits.newRoom('alice'), (e: unknown) => e instanceof RateLimited && /started 2 channels and conversations/.test(e.message));
  assert.doesNotThrow(() => limits.action('alice'), 'a refused room spends nothing else');
  const tight = createWriteLimits({ ...cfg, roomsPerHour: 100 });
  tight.newRoom('bob');
  tight.newRoom('bob');
  assert.throws(() => tight.newRoom('bob'), /faster than this workspace allows/, 'the action limit applies to rooms too');
});

test('searches are limited per person per minute', () => {
  const limits = createWriteLimits(cfg);
  limits.search('alice');
  limits.search('alice');
  assert.throws(() => limits.search('alice'), /searching faster/);
  assert.doesNotThrow(() => limits.search('bob'));
  assert.doesNotThrow(() => limits.action('alice'), 'searching does not spend the action limit');
});

test('a person may have only so many large bodies arriving at once', () => {
  const slots = createBodySlots(2);
  const a = slots.take('alice')!;
  const b = slots.take('alice')!;
  assert.strictEqual(slots.take('alice'), null);
  assert.ok(slots.take('bob'), 'one person’s uploads do not hold up another’s');
  a();
  a();
  const c = slots.take('alice');
  assert.ok(c, 'a slot given back can be taken again');
  assert.strictEqual(slots.take('alice'), null, 'giving a slot back twice frees it once');
  b();
});
