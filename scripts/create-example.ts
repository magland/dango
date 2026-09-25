import '../src/branding';
import * as fs from 'fs';
import * as path from 'path';
import { addUserToken } from '../../mochiforge/src/vault';
import { createChannel } from '../src/channels';
import { updateConfig } from '../src/config';
import { openDm } from '../src/dms';
import { addMessage, threadRoomDir, toggleReaction } from '../src/messages';
import { channelDir, dmDir } from '../src/workspace';

// An example workspace with sample people and conversation, for npm run dev.
// The tokens are fixed and known, which is fine for a workspace that only
// ever listens on 127.0.0.1.

const root = path.resolve(process.argv[2] ?? 'example-root');
if (fs.existsSync(path.join(root, 'workspace.json'))) {
  console.log(`${root} already exists; leaving it alone.`);
  process.exit(0);
}
fs.mkdirSync(root, { recursive: true });

addUserToken(root, 'dev', { siteAdmin: true, token: 'dango_example_dev_token_000000' });
addUserToken(root, 'alice', { token: 'dango_example_alice_token_0000' });
addUserToken(root, 'bob', { token: 'dango_example_bob_token_000000' });

updateConfig(root, { name: 'dango dev' });

createChannel(root, 'general', { topic: 'Everything and nothing', createdBy: 'dev' });
createChannel(root, 'random', { topic: 'The watercooler', createdBy: 'alice' });
createChannel(root, 'ops', { topic: 'Deploys and alerts', private: true, createdBy: 'dev' });

const general = channelDir(root, 'general');
addMessage(general, { author: 'dev', body: 'Welcome to **dango**. Markdown works, `code` works, so does $e^{i\\pi}+1=0$.' });
const m2 = addMessage(general, { author: 'alice', body: 'Trying out a thread on this one.' });
addMessage(threadRoomDir(general, m2.id), { author: 'bob', body: 'And a reply in it.' });
addMessage(threadRoomDir(general, m2.id), { author: 'alice', body: 'Threads keep the channel readable.' });
const m3 = addMessage(general, { author: 'bob', body: 'Reactions below this message.' });
toggleReaction(general, m3.id, '\u{1F44D}', 'alice');
toggleReaction(general, m3.id, '\u{1F44D}', 'dev');
toggleReaction(general, m3.id, '\u{1F389}', 'alice');

addMessage(channelDir(root, 'random'), { author: 'alice', body: 'Anyone else hungry for actual dango now?' });

const dm = openDm(root, ['alice', 'bob']);
addMessage(dmDir(root, dm.id), { author: 'alice', body: 'Direct messages are their own rooms.' });
addMessage(dmDir(root, dm.id), { author: 'bob', body: 'Visible to the two of us and nobody else.' });

console.log(`Example workspace at ${root}`);
console.log('  site admin: dev    token dango_example_dev_token_000000');
console.log('  user:       alice  token dango_example_alice_token_0000');
console.log('  user:       bob    token dango_example_bob_token_000000');
