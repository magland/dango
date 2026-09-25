#!/usr/bin/env node
import './branding';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { api, request } from '../../mochiforge/src/cli-api';
import { normalizeApiPath } from '../../mochiforge/src/cli/api-cmd';
import { CliError, EXIT_FAIL, EXIT_USAGE, exitCodeForStatus } from '../../mochiforge/src/cli/exit';
import { readFileArg, readStdin } from '../../mochiforge/src/cli/input';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, shortDate } from '../../mochiforge/src/cli/output';
import { Cli, Command, Invocation, dispatch } from '../../mochiforge/src/cli/parse';
import { TARGET_OPTIONS, targetFrom } from '../../mochiforge/src/cli/target';
import {
  approveCredential,
  clearLogin,
  configuredHelper,
  credentialTarget,
  loginPath,
  readCredential,
  rejectCredential,
  saveLogin,
  setHelper,
} from '../../mochiforge/src/credentials';
import { makeBackupCommands } from '../../mochiforge/src/cli/backup-cmd';
import { deployDestroyCmd, deployFlyCmd, deployShowCmd } from '../../mochiforge/src/deploy-cli';
import { bootstrapVault } from '../../mochiforge/src/vault';
import { DANGO_BACKUP } from './backup';
import { seedTrustProxy } from './config';
import { DANGO_DEPLOY } from './deploy';

// The dango command: serve a workspace, or talk to a served one the way `gh`
// talks to GitHub. Built on mochiforge's CLI framework, so the option
// grammar, the exit codes, and --json behave exactly as the mochi command's
// do.

const FOOTER = `Configuration:
  dango login https://chat.example.com   once, then the rest need no arguments

The workspace URL is kept in ~/.config/dango/login.json and the token in git's
own credential store. --host and --token override either for a single command,
and DANGO_HOST and DANGO_TOKEN sit between the two, for a caller with no
keyring and possibly no writable home directory.

Workspace layout:
  <workspace>/workspace.json           users and hashed tokens (server-managed)
  <workspace>/config.json              settings: name, theme, limits
  <workspace>/.secret                  session-cookie signing key (server-managed)
  <workspace>/channels/<name>/         channel.json, messages/, threads/, files/
  <workspace>/dms/<id>/                conversation.json and the same layout

Everything is plain files, so on a machine you have a shell on, backup is cp -a.

Putting a workspace on the internet, and backing up a hosted one:
  dango deploy fly my-workspace-name          see docs/deploying.md
  dango backup ~/backups/mychat --snapshot    incremental, over HTTP; see docs/backup.md`;

// ---- serve ----

async function serveCmd(args: string[], usage: () => never) {
  let dir: string | null = null;
  let port = 3000;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '-p' || a === '--port') port = parseInt(args[++i], 10);
    else if (a === '--host') host = args[++i];
    else if (a.startsWith('-')) throw new CliError(`Unknown option: ${a}`, EXIT_USAGE);
    else dir = a;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new CliError('Invalid port', EXIT_USAGE);
  const root = path.resolve(dir ?? process.env.DANGO_WORKSPACE ?? '.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new CliError(`Workspace directory does not exist: ${root}`);
  }
  // A workspace with no workspace.json is initialized on first start, exactly
  // as a vault is: the owner token is minted and printed once, or supplied
  // through DANGO_OWNER_TOKEN and then not printed at all.
  const boot = bootstrapVault(root, process.env.DANGO_OWNER_TOKEN ?? null);
  // Set by `dango deploy fly`, which knows there is a TLS proxy in front but
  // cannot write to the volume before the workspace exists. It only seeds the
  // setting; config.json remains the place it lives.
  const seeded = process.env.DANGO_TRUST_PROXY === '1' ? seedTrustProxy(root) : false;
  // Imported here rather than at the top of the file, for mochi's reason: the
  // server pulls in express and the whole rendering stack, and a command that
  // is not starting it should not pay for it.
  const { createApp } = await import('./server');
  const app = createApp(root);
  // The process holds no state that matters -- the workspace is on disk,
  // written by rename, re-read on every request -- so an escaped error is
  // logged and the server goes on, rather than taking the workspace down.
  process.on('uncaughtException', (err) => {
    console.error('uncaught exception (the server continues):', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection (the server continues):', reason);
  });
  app.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    if (boot && boot.preset) {
      console.log('');
      console.log('Initialized a new workspace (no workspace.json found).');
      console.log(`Owner '${boot.username}' was given the token from DANGO_OWNER_TOKEN, so it is`);
      console.log('not repeated here; only its hash is stored.');
      console.log('');
    } else if (boot) {
      console.log('');
      console.log('Initialized a new workspace (no workspace.json found).');
      console.log(`Owner token for user '${boot.username}' (shown once; only its hash is stored):`);
      console.log('');
      console.log(`  ${boot.token}`);
      console.log('');
      console.log('Sign in on the web with it, or manage users from anywhere:');
      console.log(`  dango login ${url}`);
      console.log('');
    }
    if (seeded) console.log('Recorded network.trustProxy: true in config.json (DANGO_TRUST_PROXY is set).');
    console.log(`dango serving workspace ${root}`);
    console.log(`  ${url}`);
  });
}

// ---- login and logout ----

function promptToken(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function loginCmd(inv: Invocation) {
  const given = inv.args[0] ?? inv.str('host');
  if (!given) throw new CliError('Usage: dango login <url>', EXIT_USAGE);
  const target = credentialTarget(given);
  const host = target.url;

  const chosen = inv.str('helper');
  if (chosen) await setHelper(target.url, chosen);
  const helper = await configuredHelper(target.url);
  if (!helper) {
    console.error(`No credential helper is configured for ${target.url}, so git has nowhere to keep a token.`);
    console.error('Choose where the token should live and run login again:');
    console.error('  dango login --helper store        a file at ~/.git-credentials, in plain text');
    console.error('  dango login --helper cache        memory only, forgotten after 15 minutes');
    console.error('  dango login --helper libsecret    the desktop keyring, on Linux');
    console.error('  dango login --helper osxkeychain  the login keychain, on macOS');
    process.exit(EXIT_FAIL);
  }

  let token = inv.str('token');
  if (inv.bool('token-stdin')) token = (await readStdin()).trim();
  if (!token) token = await promptToken(`Token for ${target.url}: `);
  if (!token) throw new CliError('No token given.', EXIT_USAGE);

  // Verified before it is stored: a token that does not work is worse stored
  // than absent.
  const who = await api({ host, token }, 'GET', '/api/whoami');
  const username = String(who.username ?? '');
  if (!username) throw new CliError(`${host} did not say who this token belongs to.`);

  await approveCredential(target, username, token);
  const stored = await readCredential(target);
  if (!stored || stored.password !== token) {
    console.error(`The credential helper '${helper}' did not keep the token for ${target.url}.`);
    process.exit(EXIT_FAIL);
  }
  saveLogin(host);
  console.log(`Stored the token for '${username}' at ${target.url} (helper: ${helper}).`);
  console.log(`dango commands talk to it by default (${loginPath()}). Run 'dango logout' to remove it.`);
}

async function logoutCmd(inv: Invocation) {
  const given = inv.args[0] ?? inv.str('host');
  const host = given ?? process.env.DANGO_HOST ?? null;
  if (!host) throw new CliError('Usage: dango logout <url> (or log in first, so there is a default)', EXIT_USAGE);
  const target = credentialTarget(host);
  await rejectCredential(target);
  clearLogin(target.url);
  console.log(`Forgot the token for ${target.url}.`);
}

// ---- helpers for talking commands ----

function textFrom(inv: Invocation, startAt: number): Promise<string> {
  const words = inv.args.slice(startAt);
  if (words.length === 1 && words[0] === '-') return readStdin();
  return Promise.resolve(words.join(' '));
}

// ---- the registry ----

const commands: Command[] = [
  {
    path: ['serve'],
    summary: 'Serve a workspace directory over HTTP',
    description: `Initializes the directory as a workspace on first start, printing the owner
token once. Options: -p/--port <n> (default 3000), --host <addr> (default
127.0.0.1; use 0.0.0.0 behind a proxy).`,
    raw: true,
    args: [{ name: 'dir' }],
    run(inv) {
      return serveCmd(inv.argv, inv.help);
    },
  },
  {
    path: ['login'],
    summary: 'Store a token for a workspace and make it the default',
    args: [{ name: 'url' }],
    options: [
      ...TARGET_OPTIONS,
      { name: 'helper', type: 'string', value: '<h>', summary: 'Configure this git credential helper first' },
    ],
    run: loginCmd,
  },
  {
    path: ['logout'],
    summary: 'Forget the stored token for a workspace',
    args: [{ name: 'url' }],
    options: [{ name: 'host', type: 'string', value: '<url>', summary: 'Workspace URL when not given as an argument' }],
    run: logoutCmd,
  },
  {
    path: ['whoami'],
    summary: 'Say who the current token belongs to',
    options: [...TARGET_OPTIONS, JSON_OPTION],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', '/api/whoami');
      const json = jsonMode(inv);
      if (json.enabled) printJson(pickObject(data, json.fields));
      else console.log(`${data.username} @ ${target.host}${data.siteAdmin ? ' (site admin)' : ''}`);
    },
  },
  {
    path: ['channel', 'list'],
    summary: 'List the channels this token can see',
    options: [...TARGET_OPTIONS, JSON_OPTION],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', '/api/channels');
      const channels = (data.channels ?? []) as { name: string; topic: string; private: boolean }[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ channels: pickFields(channels as unknown as Record<string, unknown>[], json.fields) });
        return;
      }
      if (!channels.length) {
        console.log(`No channels on ${target.host}`);
        return;
      }
      const width = Math.max(...channels.map((c) => c.name.length));
      for (const c of channels) {
        console.log(`#${c.name.padEnd(width)}  ${c.private ? 'private' : '       '}  ${c.topic}`.trimEnd());
      }
    },
  },
  {
    path: ['channel', 'create'],
    summary: 'Create a channel',
    args: [{ name: 'name', required: true }],
    options: [
      { name: 'topic', type: 'string', value: '<text>', summary: 'The channel topic' },
      { name: 'private', type: 'boolean', summary: 'Visible only to people added to it' },
      ...TARGET_OPTIONS,
      JSON_OPTION,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'POST', '/api/channels', {
        name: inv.args[0],
        topic: inv.str('topic') ?? undefined,
        private: inv.bool('private') || undefined,
      });
      const json = jsonMode(inv);
      if (json.enabled) printJson(pickObject(data, json.fields));
      else console.log(`Created #${data.name} on ${target.host}`);
    },
  },
  {
    path: ['channel', 'delete'],
    summary: 'Delete a channel and everything said in it (site admin)',
    args: [{ name: 'name', required: true }],
    options: [...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      await api(target, 'DELETE', `/api/channels/${encodeURIComponent(inv.args[0])}`);
      console.log(`Deleted #${inv.args[0]}`);
    },
  },
  {
    path: ['send'],
    summary: 'Send a message to a channel',
    description: `The message is the words after the channel, or stdin when the one word is '-':

  dango send general Deploy is done.
  git log --oneline -5 | dango send general -`,
    args: [
      { name: 'channel', required: true },
      { name: 'text', required: true, variadic: true },
    ],
    options: [
      { name: 'thread', type: 'int', value: '<id>', summary: 'Reply in the thread of this message' },
      ...TARGET_OPTIONS,
      JSON_OPTION,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const body = await textFrom(inv, 1);
      const channel = encodeURIComponent(inv.args[0]);
      const thread = inv.int('thread');
      const p = thread
        ? `/api/channels/${channel}/threads/${thread}/messages`
        : `/api/channels/${channel}/messages`;
      const data = await api(target, 'POST', p, { body });
      const json = jsonMode(inv);
      if (json.enabled) printJson(pickObject(data, json.fields));
      else console.log(`Sent to #${inv.args[0]} as message ${data.id}`);
    },
  },
  {
    path: ['history'],
    summary: 'Print the latest messages in a channel',
    args: [{ name: 'channel', required: true }],
    options: [
      { name: 'limit', type: 'int', value: '<n>', summary: 'How many (default 20)' },
      { name: 'thread', type: 'int', value: '<id>', summary: 'Read this message’s thread instead' },
      ...TARGET_OPTIONS,
      JSON_OPTION,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const channel = encodeURIComponent(inv.args[0]);
      const thread = inv.int('thread');
      const base = thread ? `/api/channels/${channel}/threads/${thread}` : `/api/channels/${channel}`;
      const data = await api(target, 'GET', `${base}/messages?limit=${inv.int('limit') ?? 20}`);
      const messages = (data.messages ?? []) as {
        id: number;
        author: string;
        created: string;
        body: string;
        deleted?: boolean;
        replyCount: number;
      }[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ messages: pickFields(messages as unknown as Record<string, unknown>[], json.fields) });
        return;
      }
      for (const m of messages) {
        const line = m.deleted ? '(deleted)' : m.body.replace(/\n/g, '\n    ');
        const replies = m.replyCount ? `  [+${m.replyCount} in thread]` : '';
        console.log(`${String(m.id).padStart(4)}  ${shortDate(m.created)}  ${m.author}: ${line}${replies}`);
      }
    },
  },
  {
    path: ['dm'],
    summary: 'Send a direct message',
    args: [
      { name: 'user', required: true },
      { name: 'text', required: true, variadic: true },
    ],
    options: [...TARGET_OPTIONS, JSON_OPTION],
    async run(inv) {
      const target = await targetFrom(inv);
      const body = await textFrom(inv, 1);
      const dm = await api(target, 'POST', '/api/dms', { users: [inv.args[0]] });
      const data = await api(target, 'POST', `/api/dms/${dm.id}/messages`, { body });
      const json = jsonMode(inv);
      if (json.enabled) printJson(pickObject(data, json.fields));
      else console.log(`Sent to ${inv.args[0]} as message ${data.id}`);
    },
  },
  {
    path: ['search'],
    summary: 'Search messages everywhere this token can read',
    args: [{ name: 'query', required: true, variadic: true }],
    options: [...TARGET_OPTIONS, JSON_OPTION],
    async run(inv) {
      const target = await targetFrom(inv);
      const q = inv.args.join(' ');
      const data = await api(target, 'GET', `/api/search?q=${encodeURIComponent(q)}`);
      const hits = (data.hits ?? []) as { where: string; message: { author: string; created: string; body: string } }[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ hits: pickFields(hits as unknown as Record<string, unknown>[], json.fields) });
        return;
      }
      if (!hits.length) {
        console.log('Nothing matched.');
        return;
      }
      for (const h of hits) {
        console.log(`${h.where}  ${shortDate(h.message.created)}  ${h.message.author}: ${h.message.body.split('\n')[0]}`);
      }
    },
  },
  {
    path: ['user', 'add'],
    summary: 'Create a user and mint their first token (site admin)',
    args: [{ name: 'username', required: true }],
    options: [
      { name: 'site-admin', type: 'boolean', summary: 'Make the new user a site admin' },
      ...TARGET_OPTIONS,
      JSON_OPTION,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'POST', '/api/users', {
        username: inv.args[0],
        siteAdmin: inv.bool('site-admin') || undefined,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Created user '${data.username}' on ${target.host}`);
      console.log('');
      console.log('Token (copy it now; only its hash is stored):');
      console.log(`  ${data.token}`);
    },
  },
  {
    path: ['user', 'list'],
    summary: 'List the workspace’s users',
    options: [...TARGET_OPTIONS, JSON_OPTION],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', '/api/users');
      const users = (data.users ?? []) as { username: string; siteAdmin?: boolean; name?: string }[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ users: pickFields(users as unknown as Record<string, unknown>[], json.fields) });
        return;
      }
      const width = Math.max(1, ...users.map((u) => u.username.length));
      for (const u of users) {
        console.log(`${u.username.padEnd(width)}  ${u.siteAdmin ? 'site admin' : ''}`.trimEnd());
      }
    },
  },
  {
    path: ['user', 'token'],
    summary: 'Mint a new token for a user (site admin)',
    args: [{ name: 'username', required: true }],
    options: [...TARGET_OPTIONS, JSON_OPTION],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'POST', `/api/users/${encodeURIComponent(inv.args[0])}/tokens`);
      const json = jsonMode(inv);
      if (json.enabled) printJson(pickObject(data, json.fields));
      else {
        console.log(`New token for '${data.username}' (copy it now; only its hash is stored):`);
        console.log(`  ${data.token}`);
      }
    },
  },
  {
    path: ['user', 'remove'],
    summary: 'Remove a user and every token they hold (site admin)',
    args: [{ name: 'username', required: true }],
    options: [...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      await api(target, 'DELETE', `/api/users/${encodeURIComponent(inv.args[0])}`);
      console.log(`Removed ${inv.args[0]}`);
    },
  },
  {
    path: ['api'],
    summary: 'Call any route of the workspace JSON API and print what it answers',
    description: `The path may be written with or without a leading slash and with or without
the 'api/' prefix. The response body is printed verbatim on stdout; a non-2xx
status prints it on stderr and exits non-zero.

  dango api channels
  dango api channels/general/messages -X POST --input msg.json`,
    args: [{ name: 'path', required: true }],
    options: [
      { name: 'method', short: 'X', type: 'string', value: '<m>', summary: 'HTTP method (default GET, POST with a body)' },
      { name: 'input', type: 'string', value: '<file>', summary: "JSON body from a file, or '-' for stdin" },
      { name: 'include', short: 'i', type: 'boolean', summary: 'Print the status and content type to stderr' },
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const pathname = normalizeApiPath(inv.args[0]);
      const input = inv.str('input');
      const body = input ? await readFileArg(input) : undefined;
      const method = (inv.str('method') ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
      const r = await request(target, method, pathname, { body });
      if (inv.bool('include')) {
        process.stderr.write(`HTTP ${r.status}\n`);
        if (r.contentType) process.stderr.write(`content-type: ${r.contentType}\n\n`);
      }
      const out = r.body.endsWith('\n') || r.body === '' ? r.body : r.body + '\n';
      if (!r.ok) {
        process.stderr.write(out);
        process.exit(exitCodeForStatus(r.status));
      }
      process.stdout.write(out);
    },
  },
];

// A command that parses its own arguments, as the deploy commands do, since
// they are mochiforge's and take (args, usage).
function raw(
  path: string[],
  summary: string,
  description: string,
  run: (args: string[], usage: () => never) => void | Promise<void>
): Command {
  return { path, summary, description: description || undefined, raw: true, run: (inv) => run(inv.argv, () => inv.help()) };
}

commands.push(
  raw(
    ['deploy', 'fly'],
    'Put a workspace on Fly.io, or deploy an update to one',
    `Usage: dango deploy fly <app> [--region <r>] [--volume <gb>] [--vm-size <s>]
                            [--vm-memory <m>] [--org <o>]
                            [--image <ref> | --from-source [--local-build]]

Needs flyctl installed, and fly auth login done. The app name is globally
unique on Fly and becomes the URL, https://<app>.fly.dev. Creating one mints
the owner token here and hands it to the server as a secret, then prints it
once the workspace answers, with how to sign in on the web and how to store it
for the CLI. Nothing is kept on this machine: dango login with that token is
what does that. Run it again to deploy a new version; settings not named by a
flag keep whatever the live app has, so a single flag changes a single thing. A
workspace is a directory on one volume, so the app runs as exactly one machine:
a busier workspace wants a bigger one, not more.

By default the image deployed is the published one for this CLI's own version.
--from-source builds it from the checkouts you are running instead (dango and
mochiforge side by side), which is how to deploy a change before it has been
released; --local-build uses this machine's Docker rather than Fly's builder.
--image <ref> deploys some other published tag.

See also: dango deploy fly show <app>, dango deploy fly destroy <app>.
`,
    (args, usage) => deployFlyCmd(args, usage, DANGO_DEPLOY)
  ),
  raw(
    ['deploy', 'fly', 'show'],
    'What Fly has for this app, and whether the workspace answers',
    '',
    (args, usage) => deployShowCmd(args, usage, DANGO_DEPLOY)
  ),
  raw(
    ['deploy', 'fly', 'destroy'],
    'Destroy the app and its volume, and with them the workspace',
    'No undo. Pass --yes to skip the confirmation.',
    (args, usage) => deployDestroyCmd(args, usage, DANGO_DEPLOY)
  ),
  ...makeBackupCommands(DANGO_BACKUP)
);

const cli: Cli = {
  name: 'dango',
  groups: [
    { name: 'channel', summary: 'Create, list, and delete channels' },
    { name: 'user', summary: 'Manage the workspace’s users (site admin)' },
    { name: 'deploy', summary: 'Put a workspace on Fly.io' },
    { name: 'backup', summary: 'Copy a workspace to a directory on this machine' },
  ],
  commands,
  footer: FOOTER,
};

async function main() {
  await dispatch(cli, process.argv.slice(2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(e instanceof CliError ? e.code : EXIT_FAIL);
});
