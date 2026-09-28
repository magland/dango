import '../src/branding';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Viewer } from '../../mochiforge/src/session';
import { createChannel } from '../src/channels';
import { addMessage } from '../src/messages';
import { channelRoom } from '../src/rooms';
import { messageHtml } from '../src/views';

function viewer(username: string): Viewer {
  return { auth: { username, user: { tokens: [] }, token: { hash: '' } }, csrf: 'csrf-token' };
}

test('lines typed one under another are shown on their own lines, and code keeps its own', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dango-breaks-'));
  createChannel(root, 'general', { createdBy: 'eve' });
  const room = channelRoom(root, 'general', viewer('eve').auth)!;
  const m = addMessage(room.dir, { author: 'eve', body: 'first\nsecond\n```\ncode a\ncode b\n```' });
  const out = messageHtml(root, room, m, viewer('eve')).text;
  assert.ok(/first<br \/>\s*second/.test(out), out);
  assert.ok(out.includes('code a\ncode b'), 'the code block is as written');
});
