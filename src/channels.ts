import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from '../../mochiforge/src/atomic';
import { OpError } from '../../mochiforge/src/ops';
import { channelDir, channelsDir, isValidChannelName } from './workspace';

// A channel is a directory under channels/ holding a channel.json beside its
// messages. Public channels are readable and postable by every workspace
// member; a private channel lists its members and is invisible to everyone
// else, the site admin included, the way a Slack admin cannot read a private
// channel from the interface. (The operator can read the files on disk, which
// is true of everything in the workspace and is stated in the README rather
// than pretended away.)

export const CHANNEL_FILE = 'channel.json';
export const MAX_TOPIC = 250;

export interface ChannelInfo {
  name: string;
  topic: string;
  private: boolean;
  /** Members, meaningful only when private; empty and unread otherwise. */
  members: string[];
  created?: string;
  createdBy?: string;
}

function channelFile(root: string, name: string): string {
  return path.join(channelDir(root, name), CHANNEL_FILE);
}

function normalize(name: string, parsed: unknown): ChannelInfo {
  const out: ChannelInfo = { name, topic: '', private: false, members: [] };
  if (typeof parsed !== 'object' || parsed === null) return out;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.topic === 'string') out.topic = rec.topic;
  if (rec.private === true) out.private = true;
  if (Array.isArray(rec.members)) {
    out.members = rec.members.filter((m): m is string => typeof m === 'string');
  }
  if (typeof rec.created === 'string') out.created = rec.created;
  if (typeof rec.createdBy === 'string') out.createdBy = rec.createdBy;
  return out;
}

export function readChannel(root: string, name: string): ChannelInfo | null {
  if (!isValidChannelName(name)) return null;
  let text: string;
  try {
    text = fs.readFileSync(channelFile(root, name), 'utf8');
  } catch {
    return null;
  }
  try {
    return normalize(name, JSON.parse(text));
  } catch {
    // A hand-edited file that does not parse still names a channel that
    // exists; it reads as a public channel with no topic.
    return normalize(name, null);
  }
}

function writeChannel(root: string, info: ChannelInfo): void {
  const { name, ...rest } = info;
  void name;
  writeFileAtomic(channelFile(root, info.name), JSON.stringify(rest, null, 2) + '\n', { mode: 0o600 });
}

/** Every channel in the workspace, sorted by name. */
export function listChannels(root: string): ChannelInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(channelsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ChannelInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isValidChannelName(e.name)) continue;
    const info = readChannel(root, e.name);
    if (info) out.push(info);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function createChannel(
  root: string,
  name: string,
  opts: { topic?: string; private?: boolean; createdBy: string }
): ChannelInfo {
  if (!isValidChannelName(name)) {
    throw new OpError('A channel name is lowercase letters, digits, and single hyphens, at most 80 characters.');
  }
  const topic = (opts.topic ?? '').trim();
  if (topic.length > MAX_TOPIC) throw new OpError(`A topic may be at most ${MAX_TOPIC} characters.`);
  const dir = channelDir(root, name);
  // mkdir is the allocation, as it is for issue numbers in mochiforge: whoever
  // creates the directory owns the name, and the filesystem decides that
  // rather than a check two writers could both pass.
  fs.mkdirSync(channelsDir(root), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch {
    throw new OpError(`A channel named ${name} already exists.`, 'exists');
  }
  fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
  const info: ChannelInfo = {
    name,
    topic,
    private: opts.private === true,
    members: opts.private ? [opts.createdBy] : [],
    created: new Date().toISOString(),
    createdBy: opts.createdBy,
  };
  writeChannel(root, info);
  return info;
}

/** Every edit to channel.json is a read, a change, and a write, under one lock. */
function editChannel(root: string, name: string, fn: (info: ChannelInfo) => void): ChannelInfo {
  return withFileLock(`${channelFile(root, name)}.lock`, () => {
    const info = readChannel(root, name);
    if (!info) throw new OpError(`Channel ${name} does not exist.`, 'notfound');
    fn(info);
    writeChannel(root, info);
    return info;
  });
}

export function setTopic(root: string, name: string, topic: string): ChannelInfo {
  const t = topic.trim().replace(/\s+/g, ' ');
  if (t.length > MAX_TOPIC) throw new OpError(`A topic may be at most ${MAX_TOPIC} characters.`);
  return editChannel(root, name, (info) => {
    info.topic = t;
  });
}

export function addMember(root: string, name: string, user: string): ChannelInfo {
  return editChannel(root, name, (info) => {
    if (!info.private) throw new OpError(`#${name} is public; every workspace member is already in it.`);
    if (!info.members.includes(user)) info.members.push(user);
  });
}

export function removeMember(root: string, name: string, user: string): ChannelInfo {
  return editChannel(root, name, (info) => {
    if (!info.private) throw new OpError(`#${name} is public; there is no member list to leave.`);
    if (info.members.length === 1 && info.members[0] === user) {
      throw new OpError('A private channel keeps its last member; delete the channel instead.');
    }
    info.members = info.members.filter((m) => m !== user);
  });
}

/** Remove a channel and everything in it. Site-admin only; the caller checks. */
export function deleteChannel(root: string, name: string): void {
  if (!isValidChannelName(name)) throw new OpError(`Channel ${name} does not exist.`, 'notfound');
  const dir = channelDir(root, name);
  if (!fs.existsSync(path.join(dir, CHANNEL_FILE))) {
    throw new OpError(`Channel ${name} does not exist.`, 'notfound');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
