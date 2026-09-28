import '../src/branding';
import assert from 'node:assert';
import { mock, test } from 'node:test';
import { RoomEvent, subscribe } from '../src/events';
import { TYPING_CHANGES_PER_MINUTE, TYPING_TTL_MS, noteTyping, stopTyping, typingIn } from '../src/typing';

function watch(room: string): { seen: string[][]; stop: () => void } {
  const seen: string[][] = [];
  const stop = subscribe(room, (e: RoomEvent) => {
    if (e.type === 'typing') seen.push(e.people);
  });
  return { seen, stop };
}

test('starting and stopping are announced; going on is not', () => {
  const w = watch('/c/typing-a');
  noteTyping('/c/typing-a', 'alice');
  noteTyping('/c/typing-a', 'alice');
  noteTyping('/c/typing-a', 'bob');
  stopTyping('/c/typing-a', 'alice');
  stopTyping('/c/typing-a', 'alice');
  assert.deepStrictEqual(w.seen, [['alice'], ['alice', 'bob'], ['bob']]);
  stopTyping('/c/typing-a', 'bob');
  assert.deepStrictEqual(typingIn('/c/typing-a'), []);
  w.stop();
});

test('rooms are apart, a thread from its channel', () => {
  noteTyping('/c/typing-b', 'alice');
  assert.deepStrictEqual(typingIn('/c/typing-b/t/3'), []);
  stopTyping('/c/typing-b', 'alice');
});

test('a person not heard from for the TTL stops typing, however often they were heard before', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const w = watch('/c/typing-c');
    noteTyping('/c/typing-c', 'alice');
    mock.timers.tick(TYPING_TTL_MS - 1000);
    noteTyping('/c/typing-c', 'alice');
    mock.timers.tick(TYPING_TTL_MS - 1000);
    assert.deepStrictEqual(typingIn('/c/typing-c'), ['alice'], 'kept while heard from');
    mock.timers.tick(1000);
    assert.deepStrictEqual(typingIn('/c/typing-c'), []);
    assert.deepStrictEqual(w.seen, [['alice'], []]);
    w.stop();
  } finally {
    mock.timers.reset();
  }
});

test('one person flipping between typing and not is bounded', () => {
  const w = watch('/c/typing-d');
  for (let i = 0; i < TYPING_CHANGES_PER_MINUTE + 10; i++) {
    noteTyping('/c/typing-d', 'mallory');
    stopTyping('/c/typing-d', 'mallory');
  }
  assert.strictEqual(w.seen.length, TYPING_CHANGES_PER_MINUTE * 2);
  w.stop();
});
