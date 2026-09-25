import express, { Express, Request, Response } from 'express';
import { apiError, requireApiAuth } from '../../mochiforge/src/api/auth';
import { AuthLimiter } from '../../mochiforge/src/limit';
import { OpError, opErrorStatus } from '../../mochiforge/src/ops';
import {
  AuthResult,
  addUserToken,
  loadVault,
  removeUser,
  setSiteAdmin,
  tokenId,
  userExists,
} from '../../mochiforge/src/vault';
import {
  ChannelInfo,
  addMember,
  createChannel,
  deleteChannel,
  listChannels,
  removeMember,
  setTopic,
} from './channels';
import { DmInfo, listDmsFor, openDm } from './dms';
import { publish } from './events';
import {
  Message,
  deleteMessage,
  editMessage,
  lastMessageId,
  readMessage,
  readMessages,
  toggleReaction,
} from './messages';
import { canDeleteMessage, canEditMessage, canSeeChannel, isSiteAdmin } from './perms';
import { noteRead, postMessage } from './post';
import { unreadRooms } from './reads';
import { Room, channelRoom, dmRoom, threadRoom } from './rooms';
import { inviteLink } from './views';
import { searchMessages } from './search';
import { isValidWorkspaceUserName } from './workspace';

// The JSON API, bearer-token only, exactly as mochiforge's is: session
// cookies never authorize an API call, and requiring a token on /api keeps
// one rule for the whole surface. Everything the web can do to messages the
// API can do, through the same domain functions, so the two transports
// cannot drift.

function channelJson(c: ChannelInfo): Record<string, unknown> {
  return { name: c.name, topic: c.topic, private: c.private, ...(c.private ? { members: c.members } : {}) };
}

function dmJson(d: DmInfo): Record<string, unknown> {
  return { id: d.id, participants: d.participants };
}

function messageJson(m: Message): Record<string, unknown> {
  return {
    id: m.id,
    author: m.author,
    created: m.created,
    ...(m.edited ? { edited: m.edited } : {}),
    ...(m.deleted ? { deleted: true } : {}),
    body: m.body,
    reactions: m.reactions,
    files: m.files,
    replyCount: m.replyCount,
  };
}

function sendOpError(res: Response, e: unknown): void {
  if (e instanceof OpError) apiError(res, opErrorStatus(e.kind), e.message);
  else throw e;
}

/** The origin the request arrived on; behind a trusted proxy its scheme is the proxy's. */
function originOf(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? req.hostname}`;
}

function intParam(raw: string): number {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : 0;
}

export function registerApi(app: Express, root: string, authLimiter: AuthLimiter): void {
  const json = express.json({ limit: '256kb' });

  const withAuth = (req: Request, res: Response, fn: (auth: AuthResult) => void): void => {
    const auth = requireApiAuth(root, authLimiter, req, res);
    if (!auth) return;
    try {
      fn(auth);
    } catch (e) {
      sendOpError(res, e);
    }
  };

  const body = (req: Request): Record<string, unknown> =>
    typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};

  app.get('/api/whoami', (req, res) =>
    withAuth(req, res, (auth) => {
      res.json({ username: auth.username, siteAdmin: isSiteAdmin(auth) });
    })
  );

  // ---- channels ----

  app.get('/api/channels', (req, res) =>
    withAuth(req, res, (auth) => {
      res.json({ channels: listChannels(root).filter((c) => canSeeChannel(auth, c)).map(channelJson) });
    })
  );

  app.post('/api/channels', json, (req, res) =>
    withAuth(req, res, (auth) => {
      const b = body(req);
      const c = createChannel(root, String(b.name ?? '').toLowerCase(), {
        topic: typeof b.topic === 'string' ? b.topic : '',
        private: b.private === true,
        createdBy: auth.username,
      });
      res.status(201).json(channelJson(c));
    })
  );

  /** The channel, or null having already answered 404. Private names 404 like absent ones. */
  const requireChannel = (res: Response, auth: AuthResult, name: string): Room | null => {
    const room = channelRoom(root, name, auth);
    if (!room) {
      apiError(res, 404, `no channel ${name}`);
      return null;
    }
    return room;
  };

  app.get('/api/channels/:channel', (req, res) =>
    withAuth(req, res, (auth) => {
      const room = requireChannel(res, auth, req.params.channel);
      if (room) res.json(channelJson(room.channel!));
    })
  );

  app.patch('/api/channels/:channel', json, (req, res) =>
    withAuth(req, res, (auth) => {
      const room = requireChannel(res, auth, req.params.channel);
      if (!room) return;
      const topic = body(req).topic;
      if (typeof topic !== 'string') {
        apiError(res, 400, 'send {"topic": "..."}');
        return;
      }
      res.json(channelJson(setTopic(root, room.channel!.name, topic)));
    })
  );

  app.delete('/api/channels/:channel', (req, res) =>
    withAuth(req, res, (auth) => {
      const room = requireChannel(res, auth, req.params.channel);
      if (!room) return;
      if (!isSiteAdmin(auth)) {
        apiError(res, 403, 'only a site admin may delete a channel');
        return;
      }
      deleteChannel(root, room.channel!.name);
      res.json({ deleted: true });
    })
  );

  app.post('/api/channels/:channel/members', json, (req, res) =>
    withAuth(req, res, (auth) => {
      const room = requireChannel(res, auth, req.params.channel);
      if (!room) return;
      const user = String(body(req).user ?? '');
      if (!userExists(root, user)) {
        apiError(res, 404, `no user ${user}`);
        return;
      }
      res.json(channelJson(addMember(root, room.channel!.name, user)));
    })
  );

  app.delete('/api/channels/:channel/members/:user', (req, res) =>
    withAuth(req, res, (auth) => {
      const room = requireChannel(res, auth, req.params.channel);
      if (!room) return;
      const user = req.params.user;
      if (user !== auth.username && !isSiteAdmin(auth)) {
        apiError(res, 403, 'you can remove yourself; removing others is for a site admin');
        return;
      }
      res.json(channelJson(removeMember(root, room.channel!.name, user)));
    })
  );

  // ---- conversations ----

  app.get('/api/dms', (req, res) =>
    withAuth(req, res, (auth) => {
      res.json({ dms: listDmsFor(root, auth.username).map(dmJson) });
    })
  );

  app.post('/api/dms', json, (req, res) =>
    withAuth(req, res, (auth) => {
      const users = body(req).users;
      if (!Array.isArray(users) || !users.every((u): u is string => typeof u === 'string')) {
        apiError(res, 400, 'send {"users": ["name", ...]}');
        return;
      }
      for (const u of users) {
        if (!userExists(root, u)) {
          apiError(res, 404, `no user ${u}`);
          return;
        }
      }
      res.status(201).json(dmJson(openDm(root, [auth.username, ...users])));
    })
  );

  // ---- messages, over every kind of room ----

  const resolveRoom = (req: Request, auth: AuthResult): Room | null => {
    const p = req.params as Record<string, string>;
    let room: Room | null = null;
    if (p.channel !== undefined) room = channelRoom(root, p.channel, auth);
    else if (p.dm !== undefined) room = dmRoom(root, intParam(p.dm), auth);
    if (room && p.tid !== undefined) room = threadRoom(room, intParam(p.tid));
    return room;
  };

  const withRoom = (req: Request, res: Response, fn: (auth: AuthResult, room: Room) => void): void => {
    withAuth(req, res, (auth) => {
      const room = resolveRoom(req, auth);
      if (!room) {
        apiError(res, 404, 'no such room');
        return;
      }
      fn(auth, room);
    });
  };

  const BASES = ['/api/channels/:channel', '/api/dms/:dm'];
  const ROOM_PATHS = (suffix: string) => BASES.flatMap((b) => [`${b}${suffix}`, `${b}/threads/:tid${suffix}`]);

  app.get(ROOM_PATHS('/messages'), (req, res) =>
    withRoom(req, res, (_auth, room) => {
      const limit = intParam(String(req.query.limit ?? '50')) || 50;
      const before = intParam(String(req.query.before ?? '0'));
      res.json({
        messages: readMessages(room.dir, {
          limit: Math.min(limit, 500),
          ...(before ? { before } : {}),
        }).map(messageJson),
      });
    })
  );

  app.post(ROOM_PATHS('/messages'), json, (req, res) =>
    withRoom(req, res, (auth, room) => {
      const text = body(req).body;
      if (typeof text !== 'string') {
        apiError(res, 400, 'send {"body": "..."}');
        return;
      }
      const m = postMessage(root, room, { author: auth.username, body: text });
      res.status(201).json(messageJson(m));
    })
  );

  app.get(ROOM_PATHS('/messages/:mid'), (req, res) =>
    withRoom(req, res, (_auth, room) => {
      const m = readMessage(room.dir, intParam(req.params.mid));
      if (!m) apiError(res, 404, 'no such message');
      else res.json(messageJson(m));
    })
  );

  app.patch(ROOM_PATHS('/messages/:mid'), json, (req, res) =>
    withRoom(req, res, (auth, room) => {
      const id = intParam(req.params.mid);
      const m = readMessage(room.dir, id);
      if (!m || !canEditMessage(auth, m.author)) {
        apiError(res, m ? 403 : 404, m ? 'only the author may edit a message' : 'no such message');
        return;
      }
      const text = body(req).body;
      if (typeof text !== 'string') {
        apiError(res, 400, 'send {"body": "..."}');
        return;
      }
      const edited = editMessage(room.dir, id, text);
      publish(room.url, { type: 'update', message: edited });
      res.json(messageJson(edited));
    })
  );

  app.delete(ROOM_PATHS('/messages/:mid'), (req, res) =>
    withRoom(req, res, (auth, room) => {
      const id = intParam(req.params.mid);
      const m = readMessage(room.dir, id);
      if (!m || !canDeleteMessage(auth, m.author)) {
        apiError(res, m ? 403 : 404, m ? 'only the author or a site admin may delete a message' : 'no such message');
        return;
      }
      const deleted = deleteMessage(room.dir, id);
      publish(room.url, { type: 'update', message: deleted });
      res.json(messageJson(deleted));
    })
  );

  app.post(ROOM_PATHS('/messages/:mid/reactions'), json, (req, res) =>
    withRoom(req, res, (auth, room) => {
      const emoji = body(req).emoji;
      if (typeof emoji !== 'string') {
        apiError(res, 400, 'send {"emoji": "..."}');
        return;
      }
      const m = toggleReaction(room.dir, intParam(req.params.mid), emoji, auth.username);
      publish(room.url, { type: 'update', message: m });
      res.json(messageJson(m));
    })
  );

  // ---- what is unread ----

  app.get('/api/unread', (req, res) =>
    withAuth(req, res, (auth) => {
      res.json({ rooms: unreadRooms(root, auth).filter((r) => r.count > 0) });
    })
  );

  app.post(ROOM_PATHS('/read'), json, (req, res) =>
    withRoom(req, res, (auth, room) => {
      const id = body(req).id;
      const upTo = typeof id === 'number' && Number.isInteger(id) && id > 0 ? Math.min(id, lastMessageId(room.dir)) : lastMessageId(room.dir);
      noteRead(root, auth.username, room, upTo);
      res.json({ read: upTo });
    })
  );

  // ---- search ----

  app.get('/api/search', (req, res) =>
    withAuth(req, res, (auth) => {
      const q = String(req.query.q ?? '');
      res.json({
        hits: searchMessages(root, auth, q).map((h) => ({
          url: h.url,
          where: h.where,
          message: messageJson(h.message),
        })),
      });
    })
  );

  // ---- users (admin, except for reading the list) ----

  app.get('/api/users', (req, res) =>
    withAuth(req, res, () => {
      const state = loadVault(root);
      if (state.status !== 'ok') {
        apiError(res, 500, 'the workspace could not be read');
        return;
      }
      res.json({
        users: Object.entries(state.vault.users).map(([name, u]) => ({
          username: name,
          siteAdmin: u.siteAdmin === true,
          ...(u.profile?.name ? { name: u.profile.name } : {}),
        })),
      });
    })
  );

  const requireAdmin = (res: Response, auth: AuthResult): boolean => {
    if (!isSiteAdmin(auth)) {
      apiError(res, 403, 'site admin only');
      return false;
    }
    return true;
  };

  app.post('/api/users', json, (req, res) =>
    withAuth(req, res, (auth) => {
      if (!requireAdmin(res, auth)) return;
      const b = body(req);
      const username = String(b.username ?? '').trim();
      if (!isValidWorkspaceUserName(username)) {
        apiError(res, 400, 'that is not usable as a username');
        return;
      }
      if (userExists(root, username)) {
        apiError(res, 409, `there is already a user named ${username}`);
        return;
      }
      const { token } = addUserToken(root, username, { siteAdmin: b.siteAdmin === true });
      res.status(201).json({ username, token, invite: inviteLink(originOf(req), token) });
    })
  );

  app.post('/api/users/:name/tokens', (req, res) =>
    withAuth(req, res, (auth) => {
      if (!requireAdmin(res, auth)) return;
      if (!userExists(root, req.params.name)) {
        apiError(res, 404, `no user ${req.params.name}`);
        return;
      }
      const { token, user } = addUserToken(root, req.params.name, {});
      res.status(201).json({
        username: req.params.name,
        token,
        invite: inviteLink(originOf(req), token),
        tokens: user.tokens.map((t) => tokenId(t)),
      });
    })
  );

  app.post('/api/users/:name/admin', json, (req, res) =>
    withAuth(req, res, (auth) => {
      if (!requireAdmin(res, auth)) return;
      if (req.params.name === auth.username) {
        apiError(res, 400, 'ask another admin to change your own admin bit');
        return;
      }
      try {
        const user = setSiteAdmin(root, req.params.name, body(req).value === true);
        res.json({ username: req.params.name, siteAdmin: user.siteAdmin === true });
      } catch (e) {
        apiError(res, 404, e instanceof Error ? e.message : String(e));
      }
    })
  );

  app.delete('/api/users/:name', (req, res) =>
    withAuth(req, res, (auth) => {
      if (!requireAdmin(res, auth)) return;
      if (req.params.name === auth.username) {
        apiError(res, 400, 'removing yourself is a job for another admin');
        return;
      }
      res.json({ removed: removeUser(root, req.params.name) });
    })
  );
}
