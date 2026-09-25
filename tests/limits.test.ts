import '../src/branding';
import assert from 'node:assert';
import { test } from 'node:test';
import { RateLimited, createWriteLimits } from '../src/limits';

const cfg = { requestsPerMinute: 0, authFailures: 0, messagesPerMinute: 3, messagesPerHour: 5, uploadMbPerHour: 1, actionsPerMinute: 2 };

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
