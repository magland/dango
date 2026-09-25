import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Viewer } from '../../mochiforge/src/session';
import { createChannel } from '../src/channels';
import { addMessage, toggleReaction } from '../src/messages';
import { channelRoom } from '../src/rooms';
import { channelPage, loginPage, messageHtml } from '../src/views';

// The escaping tests drive the real page functions with a script tag where
// user-written text goes, and assert both halves, as mochiforge's do: nothing
// executable comes out, and the payload reached the page, so a test cannot
// pass by rendering nothing.

const PAYLOAD = '<script>alert(1)</script>';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dango-esc-'));
}

function viewer(username: string): Viewer {
  return { auth: { username, user: { tokens: [] }, token: { hash: '' } }, csrf: 'csrf-token' };
}

test('a hostile message body renders inert, and inline code keeps its text', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'eve' });
  const room = channelRoom(root, 'general', viewer('eve').auth)!;
  // A bare script tag is sanitized away outright; in a code span the text
  // must survive, escaped.
  const m = addMessage(room.dir, { author: 'eve', body: `\`${PAYLOAD}\` and ${PAYLOAD}` });
  const out = messageHtml(root, room, m, viewer('eve')).text;
  assert.ok(!out.includes('<script'), 'no executable markup');
  assert.ok(out.includes('alert(1)'), 'the code-span text still reached the page');
});

test('a hostile topic and a hostile reaction render inert on the channel page', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { topic: `"><img src=x onerror=alert(1)>`, createdBy: 'eve' });
  const room = channelRoom(root, 'general', viewer('eve').auth)!;
  const m = addMessage(room.dir, { author: 'eve', body: 'hello' });
  toggleReaction(room.dir, m.id, '"><b>x</b>', 'eve');
  const out = channelPage(root, room, [m], viewer('eve'));
  assert.ok(!out.includes('<img src=x'), 'the attribute break stayed text');
  assert.ok(!out.includes('"><b>'), 'the reaction stayed text');
  assert.ok(out.includes('onerror=alert(1)&gt;'), 'the topic still reached the page');
});

test('a hostile author name cannot break out of the message header', () => {
  const root = tmpRoot();
  createChannel(root, 'general', { createdBy: 'eve' });
  const room = channelRoom(root, 'general', viewer('eve').auth)!;
  const m = addMessage(room.dir, { author: `"><script>alert(2)</script>`, body: 'hi' });
  const out = messageHtml(root, room, m, viewer('eve')).text;
  assert.ok(!out.includes('<script'), 'no executable markup');
});

test('the login page keeps a hostile next value as text', () => {
  const out = loginPage(`/"><script>alert(3)</script>`);
  assert.ok(!out.includes('<script>alert'), 'no executable markup');
});
