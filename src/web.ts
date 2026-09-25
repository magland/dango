import express, { Express, NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AuthLimiter } from '../../mochiforge/src/limit';
import { Part, boundaryOf, parseMultipart, partFiles } from '../../mochiforge/src/multipart';
import { OpError, opErrorStatus } from '../../mochiforge/src/ops';
import {
  Viewer,
  checkCsrf,
  clearSessionCookie,
  csrfMatches,
  getViewer,
  setSessionCookie,
} from '../../mochiforge/src/session';
import {
  addUserToken,
  authenticateToken,
  loadVault,
  removeUser,
  setSiteAdmin,
  setUserProfile,
  userExists,
} from '../../mochiforge/src/vault';
import {
  addMember,
  createChannel,
  deleteChannel,
  removeMember,
  setTopic,
} from './channels';
import { loadConfig, updateConfig } from './config';
import { openDm } from './dms';
import { RoomEvent, publish, serveEvents, serveUserEvents } from './events';
import {
  Attachment,
  Message,
  deleteMessage,
  editMessage,
  filesDir,
  MAX_ATTACHMENTS_BYTES,
  isValidNonce,
  lastMessageId,
  readMessage,
  readMessages,
  toggleReaction,
} from './messages';
import { RateLimited, WriteLimits, refusalStatus } from './limits';
import { EDIT_WINDOW_PASSED, canDeleteMessage, canEditMessage, isSiteAdmin } from './perms';
import { Pin, pinMessage, pinOf, readPins, unpinMessage } from './pins';
import {
  NotifyLevel,
  addDevice,
  isTimeOfDay,
  isTimeZone,
  deviceId,
  deviceLabel,
  parseSubscription,
  pushToUser,
  readDevices,
  readPrefs,
  removeDevice,
  renewDevice,
  setMuted,
  writePrefs,
} from './notify';
import { noteRead, postMessage } from './post';
import { vapidKeys } from './push';
import { Room, channelRoom, dmRoom, threadRoom } from './rooms';
import { searchMessages } from './search';
import * as views from './views';
import { isValidWorkspaceUserName } from './workspace';

// Every page and form of the web interface. Anonymous requests reach exactly
// two things, the sign-in page and the assets; everything else resolves a
// viewer first and redirects to /login without one, because a workspace is
// members-only all the way down.
//
// The shape of a state-changing route is mochiforge's: resolve the viewer,
// check the CSRF token, do the operation through the same functions the JSON
// API uses, publish the event, redirect back. Forms work without script; the
// page script only makes them quieter.

/**
 * Whether the page script sent this request and wants an answer it can act
 * on, rather than a page to show. The composer sends through script and
 * asks for JSON, so a refusal comes back as a sentence it can put beside the
 * message instead of a page that would replace everything.
 */
function wantsJson(req: Request): boolean {
  return (req.get('accept') ?? '').includes('application/json');
}

// The composer posts multipart (it may carry files, and the page script sends
// FormData for every intercepted form), while a plain form posts urlencoded.
// Both land here: multipart parts are folded into req.body so the CSRF check
// and the field reads are one shape, and the file parts ride on req under
// their own key.
interface FormRequest extends Request {
  fileParts?: Part[];
}

function formBody(req: FormRequest, res: Response, next: NextFunction): void {
  const urlenc = express.urlencoded({ extended: false, limit: '128kb' });
  // The attachments' cap and a megabyte for the text fields and the framing.
  const raw = express.raw({ type: 'multipart/form-data', limit: MAX_ATTACHMENTS_BYTES + 1024 * 1024 });
  const boundary = boundaryOf(req.headers['content-type']);
  if (!boundary) {
    urlenc(req, res, next);
    return;
  }
  raw(req, res, (err?: unknown) => {
    if (err) {
      next(err as Error);
      return;
    }
    let parts: Part[] = [];
    try {
      parts = Buffer.isBuffer(req.body) ? parseMultipart(req.body, boundary) : [];
    } catch {
      parts = [];
    }
    const body: Record<string, string> = {};
    for (const p of parts) {
      if (!p.filename) body[p.name] = p.data.toString('utf8');
    }
    req.body = body;
    req.fileParts = parts;
    next();
  });
}

/**
 * The origin the request arrived on, for a link to hand to someone else. The
 * scheme is req.protocol, which honours X-Forwarded-Proto only where the
 * workspace trusts its proxy, so behind Fly or Caddy it is https.
 */
function originOf(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? req.hostname}`;
}

function nextPath(raw: unknown): string {
  const n = typeof raw === 'string' ? raw : '';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

export function registerWeb(app: Express, root: string, authLimiter: AuthLimiter, limits: WriteLimits): void {
  const urlenc = express.urlencoded({ extended: false, limit: '128kb' });

  const fail = (res: Response, viewer: Viewer | null, status: number, message: string) => {
    if (wantsJson(res.req)) res.status(status).json({ error: message });
    else res.status(status).type('html').send(views.errorPage(status, message, { viewer, root }));
  };

  /** The signed-in viewer, or null having already redirected to /login. */
  const requireViewer = (req: Request, res: Response): Viewer | null => {
    const viewer = getViewer(req, root);
    if (!viewer) {
      res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return null;
    }
    return viewer;
  };

  const requireForm = (req: Request, res: Response): Viewer | null => {
    const viewer = getViewer(req, root);
    if (!viewer) {
      res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return null;
    }
    if (!checkCsrf(req, viewer)) {
      fail(res, viewer, 403, 'The form went stale; go back and try again.');
      return null;
    }
    return viewer;
  };

  const sendOpError = (res: Response, viewer: Viewer | null, e: unknown) => {
    if (e instanceof RateLimited) {
      res.setHeader('Retry-After', String(e.retryAfter));
      fail(res, viewer, 429, e.message);
    } else if (e instanceof OpError) fail(res, viewer, opErrorStatus(e.kind), e.message);
    else throw e;
  };

  // ---- sign in and out ----

  app.get('/login', (req, res) => {
    if (getViewer(req, root)) {
      res.redirect(303, nextPath(req.query.next));
      return;
    }
    res.type('html').send(views.loginPage(nextPath(req.query.next)));
  });

  app.post('/login', urlenc, (req, res) => {
    const next = nextPath((req.body as Record<string, unknown>)?.next);
    const token = String((req.body as Record<string, unknown>)?.token ?? '').trim();
    const state = loadVault(root);
    if (state.status !== 'ok') {
      res.status(500).type('html').send(views.loginPage(next, 'The workspace could not be read; try again.'));
      return;
    }
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      res.status(429).type('html').send(views.loginPage(next, 'Too many attempts; wait a few minutes.'));
      return;
    }
    const auth = token === '' ? null : authenticateToken(state.vault, token);
    if (!auth) {
      authLimiter.fail(req, null);
      res.status(401).type('html').send(views.loginPage(next, 'That token did not match anyone.'));
      return;
    }
    setSessionCookie(req, res, root, auth);
    res.redirect(303, next);
  });

  // Open to anyone, like /login: it is the page an invite link lands on,
  // and the token that makes it useful is in the fragment, which the server
  // never sees.
  app.get('/invite', (req, res) => {
    const viewer = getViewer(req, root);
    res.set('Cache-Control', 'no-store').type('html').send(views.invitePage(viewer ? viewer.auth.username : null));
  });

  app.post('/logout', urlenc, (req, res) => {
    // No CSRF requirement to sign out: the only thing a forged sign-out costs
    // is signing in again, and a stale form must always be able to leave.
    // The page script sends the browser's push endpoint along, having dropped
    // the subscription itself, so a shared computer that is signed out of
    // stops showing that person's notifications. Only the signed-in person's
    // own devices can be named, so a forged sign-out removes nothing of
    // anyone else's.
    const viewer = getViewer(req, root);
    const endpoint = (req.body as Record<string, unknown>)?.push;
    if (viewer && typeof endpoint === 'string' && endpoint) removeDevice(root, viewer.auth.username, deviceId(endpoint));
    clearSessionCookie(res);
    res.redirect(303, '/login');
  });

  // ---- the workspace's own pages ----

  app.get('/', (req, res) => {
    const viewer = requireViewer(req, res);
    if (!viewer) return;
    res.type('html').send(views.homePage(root, viewer));
  });

  app.get('/new', (req, res) => {
    const viewer = requireViewer(req, res);
    if (!viewer) return;
    res.type('html').send(views.newChannelPage(root, viewer));
  });

  app.post('/new', urlenc, (req, res) => {
    const viewer = requireForm(req, res);
    if (!viewer) return;
    const body = req.body as Record<string, unknown>;
    const name = String(body.name ?? '').trim().toLowerCase();
    try {
      limits.action(viewer.auth.username);
      const c = createChannel(root, name, {
        topic: String(body.topic ?? ''),
        private: body.private === '1',
        createdBy: viewer.auth.username,
      });
      res.redirect(303, `/c/${encodeURIComponent(c.name)}`);
    } catch (e) {
      if (e instanceof OpError) {
        res.status(refusalStatus(e, opErrorStatus)).type('html').send(views.newChannelPage(root, viewer, e.message));
        return;
      }
      throw e;
    }
  });

  app.get('/search', (req, res) => {
    const viewer = requireViewer(req, res);
    if (!viewer) return;
    const q = String(req.query.q ?? '');
    const hits = q.trim() === '' ? [] : searchMessages(root, viewer.auth, q);
    res.type('html').send(views.searchPage(root, viewer, q, hits));
  });

  app.get('/account', (req, res) => {
    const viewer = requireViewer(req, res);
    if (!viewer) return;
    res.type('html').send(views.accountPage(root, viewer, accountNotifications(viewer)));
  });

  app.post('/account', urlenc, (req, res) => {
    const viewer = requireForm(req, res);
    if (!viewer) return;
    const body = req.body as Record<string, unknown>;
    setUserProfile(root, viewer.auth.username, {
      name: String(body.name ?? ''),
      bio: String(body.bio ?? ''),
    });
    res.redirect(303, '/account');
  });

  // ---- notifications ----
  //
  // What a person wants to hear about is a plain form. The device routes are
  // spoken to by the page script in JSON, because a push subscription only
  // exists in script: the browser makes it and hands it over.

  const json = express.json({ limit: '16kb' });

  const accountNotifications = (viewer: Viewer): views.AccountNotifications => ({
    prefs: readPrefs(root, viewer.auth.username),
    devices: readDevices(root, viewer.auth.username),
    vapidKey: vapidKeys(root).publicKey,
  });

  app.post('/account/notifications', urlenc, (req, res) => {
    const viewer = requireForm(req, res);
    if (!viewer) return;
    const body = req.body as Record<string, unknown>;
    const level: NotifyLevel = body.level === 'all' || body.level === 'none' ? body.level : 'direct';
    const muted = (Array.isArray(body.mute) ? body.mute : [body.mute]).filter((k): k is string => typeof k === 'string' && k !== '');
    const start = String(body.quiet_start ?? '');
    const end = String(body.quiet_end ?? '');
    if (body.quiet === '1' && (!isTimeOfDay(start) || !isTimeOfDay(end) || start === end)) {
      res
        .status(400)
        .type('html')
        .send(views.accountPage(root, viewer, accountNotifications(viewer), { error: 'Quiet hours need a start and an end, and they cannot be the same time.' }));
      return;
    }
    const tz = String(body.tz ?? '');
    writePrefs(root, viewer.auth.username, {
      level,
      preview: body.preview === '1',
      muted,
      quiet: body.quiet === '1' ? { start, end, tz: isTimeZone(tz) ? tz : 'UTC' } : null,
    });
    res.redirect(303, '/account#notifications');
  });

  app.post('/account/push/subscribe', json, (req, res) => {
    const viewer = requireForm(req, res);
    if (!viewer) return;
    const sub = parseSubscription((req.body as Record<string, unknown>).subscription);
    if (!sub) {
      fail(res, viewer, 400, 'This browser offered a push service the workspace does not send to.');
      return;
    }
    const device = addDevice(root, viewer.auth.username, sub, {
      origin: originOf(req),
      label: deviceLabel(req.get('user-agent') ?? ''),
    });
    res.json({ id: device.id, label: device.label });
  });

  // Removing names the device by its id (the device list's buttons) or by
  // its endpoint (the page script, turning this browser off).
  app.post('/account/push/remove', express.urlencoded({ extended: false, limit: '16kb' }), json, (req, res) => {
    const viewer = requireForm(req, res);
    if (!viewer) return;
    const body = req.body as Record<string, unknown>;
    const id = typeof body.endpoint === 'string' ? deviceId(body.endpoint) : String(body.id ?? '');
    const removed = removeDevice(root, viewer.auth.username, id);
    if (wantsJson(req)) res.json({ removed });
    else res.redirect(303, '/account#notifications');
  });

  // A test notification to this browser, answering with what the push
  // service said, so a device that stays silent can be told apart from a
  // push that was refused.
  app.post('/account/push/test', json, async (req, res, next) => {
    const viewer = requireForm(req, res);
    if (!viewer) return;
    try {
      const endpoint = (req.body as Record<string, unknown>).endpoint;
      const only = typeof endpoint === 'string' ? deviceId(endpoint) : undefined;
      if (only && !readDevices(root, viewer.auth.username).some((d) => d.id === only)) {
        fail(res, viewer, 404, 'The workspace does not know this browser; turn notifications off and on again.');
        return;
      }
      const result = await pushToUser(
        root,
        viewer.auth.username,
        { title: loadConfig(root).name, body: 'Notifications work on this device.', tag: 'test', url: '/account#notifications', time: Date.now() },
        { urgency: 'high', only }
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // The service worker, when the browser has replaced its subscription by
  // itself. No session and no CSRF token: the worker has neither, and what
  // it presents instead is the old subscription's auth secret.
  app.post('/push/renew', json, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const old = body.old as Record<string, unknown> | undefined;
    const sub = parseSubscription(body.subscription);
    if (!sub || typeof old?.endpoint !== 'string' || typeof old?.auth !== 'string') {
      res.status(400).json({ error: 'That is not a subscription.' });
      return;
    }
    const renewed = renewDevice(root, { endpoint: old.endpoint, auth: old.auth }, sub);
    res.status(renewed ? 204 : 404).end();
  });

  // ---- direct conversations ----

  app.get('/d/new', (req, res) => {
    const viewer = requireViewer(req, res);
    if (!viewer) return;
    res.type('html').send(views.newDmPage(root, viewer));
  });

  app.post('/d/new', urlenc, (req, res) => {
    const viewer = requireForm(req, res);
    if (!viewer) return;
    const raw = (req.body as Record<string, unknown>).user;
    const users = (Array.isArray(raw) ? raw : [raw])
      .filter((u): u is string => typeof u === 'string' && u !== '')
      .filter((u) => userExists(root, u));
    try {
      limits.action(viewer.auth.username);
      const dm = openDm(root, [viewer.auth.username, ...users]);
      res.redirect(303, `/d/${dm.id}`);
    } catch (e) {
      if (e instanceof OpError) {
        res.status(refusalStatus(e, opErrorStatus)).type('html').send(views.newDmPage(root, viewer, e.message));
        return;
      }
      throw e;
    }
  });

  // ---- admin ----

  const requireAdminForm = (req: Request, res: Response): Viewer | null => {
    const viewer = requireForm(req, res);
    if (!viewer) return null;
    if (!isSiteAdmin(viewer.auth)) {
      fail(res, viewer, 403, 'Only a site admin may do that.');
      return null;
    }
    return viewer;
  };

  app.get('/admin', (req, res) => {
    const viewer = requireViewer(req, res);
    if (!viewer) return;
    if (!isSiteAdmin(viewer.auth)) {
      fail(res, viewer, 404, 'Page not found');
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      fail(res, viewer, 500, 'The workspace could not be read.');
      return;
    }
    res.type('html').send(views.adminPage(root, viewer, state.vault));
  });

  app.post('/admin/users/add', urlenc, (req, res) => {
    const viewer = requireAdminForm(req, res);
    if (!viewer) return;
    const body = req.body as Record<string, unknown>;
    const username = String(body.username ?? '').trim();
    if (!isValidWorkspaceUserName(username)) {
      fail(res, viewer, 400, 'That is not usable as a username.');
      return;
    }
    if (userExists(root, username)) {
      fail(res, viewer, 409, `There is already a user named ${username}.`);
      return;
    }
    const { token, created } = addUserToken(root, username, { siteAdmin: body.admin === '1' });
    res.type('html').send(views.tokenPage(root, viewer, username, token, created, originOf(req)));
  });

  app.post('/admin/users/token', urlenc, (req, res) => {
    const viewer = requireAdminForm(req, res);
    if (!viewer) return;
    const username = String((req.body as Record<string, unknown>).user ?? '');
    if (!userExists(root, username)) {
      fail(res, viewer, 404, `There is no user named ${username}.`);
      return;
    }
    const { token } = addUserToken(root, username, {});
    res.type('html').send(views.tokenPage(root, viewer, username, token, false, originOf(req)));
  });

  app.post('/admin/users/admin', urlenc, (req, res) => {
    const viewer = requireAdminForm(req, res);
    if (!viewer) return;
    const body = req.body as Record<string, unknown>;
    const username = String(body.user ?? '');
    if (username === viewer.auth.username) {
      fail(res, viewer, 400, 'Ask another admin to change your own admin bit.');
      return;
    }
    try {
      setSiteAdmin(root, username, body.value === '1');
    } catch (e) {
      fail(res, viewer, 404, e instanceof Error ? e.message : String(e));
      return;
    }
    res.redirect(303, '/admin');
  });

  app.post('/admin/users/remove', urlenc, (req, res) => {
    const viewer = requireAdminForm(req, res);
    if (!viewer) return;
    const username = String((req.body as Record<string, unknown>).user ?? '');
    if (username === viewer.auth.username) {
      fail(res, viewer, 400, 'Removing yourself is a job for another admin.');
      return;
    }
    removeUser(root, username);
    res.redirect(303, '/admin');
  });

  app.post('/admin/settings', urlenc, (req, res) => {
    const viewer = requireAdminForm(req, res);
    if (!viewer) return;
    const body = req.body as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    updateConfig(root, {
      ...(name ? { name } : {}),
      ...(typeof body.theme === 'string' ? { theme: body.theme } : {}),
    });
    res.redirect(303, '/admin');
  });

  // ---- rooms ----
  //
  // Channels, conversations, and the threads inside both share one set of
  // message routes; what differs is how the base room resolves. The four base
  // patterns below expand each message route to everywhere messages live.

  const resolveRoom = (req: Request, viewer: Viewer): Room | null => {
    const p = req.params as Record<string, string>;
    let room: Room | null = null;
    if (p.channel !== undefined) room = channelRoom(root, p.channel, viewer.auth);
    else if (p.dm !== undefined) room = dmRoom(root, parseInt(p.dm, 10), viewer.auth);
    if (room && p.tid !== undefined) room = threadRoom(room, parseInt(p.tid, 10));
    return room;
  };

  /** Resolve viewer and room, answering 404 for a room that is not this viewer's to see. */
  const withRoom = (
    req: Request,
    res: Response,
    fn: (viewer: Viewer, room: Room) => void,
    opts: { form?: boolean } = {}
  ): void => {
    const viewer = getViewer(req, root);
    if (!viewer) {
      if (wantsJson(req)) res.status(401).json({ error: 'You are signed out. Sign in again, then send.' });
      else res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (opts.form) {
      const presented = (req.body as Record<string, unknown> | undefined)?.csrf;
      if (typeof presented !== 'string' || !csrfMatches(req, presented, viewer)) {
        fail(res, viewer, 403, 'The form went stale; go back and try again.');
        return;
      }
    }
    const room = resolveRoom(req, viewer);
    if (!room) {
      // 404 rather than 403, so a private room's name is indistinguishable
      // from an absent one, the rule mochiforge follows for repositories.
      fail(res, viewer, 404, 'Page not found');
      return;
    }
    try {
      fn(viewer, room);
    } catch (e) {
      sendOpError(res, viewer, e);
    }
  };

  const BASES = ['/c/:channel', '/d/:dm'];
  const ROOM_PATHS = (suffix: string) => BASES.flatMap((b) => [`${b}${suffix}`, `${b}/t/:tid${suffix}`]);

  // Rendering a room is reading it: the viewer's marker moves to the newest
  // message shown, and their other pages hear that the count is now zero.
  const seen = (viewer: Viewer, room: Room, messages: Message[]) => {
    if (messages.length) noteRead(root, viewer.auth.username, room, messages[messages.length - 1].id);
  };

  // The room pages themselves.
  app.get('/c/:channel', (req, res) =>
    withRoom(req, res, (viewer, room) => {
      const messages = readMessages(room.dir, { limit: 100 });
      seen(viewer, room, messages);
      res.type('html').send(views.channelPage(root, room, messages, viewer));
    })
  );
  app.get('/d/:dm', (req, res) =>
    withRoom(req, res, (viewer, room) => {
      const messages = readMessages(room.dir, { limit: 100 });
      seen(viewer, room, messages);
      res.type('html').send(views.dmPage(root, room, messages, viewer));
    })
  );
  app.get(['/c/:channel/t/:tid', '/d/:dm/t/:tid'], (req, res) =>
    withRoom(req, res, (viewer, room) => {
      const anchor = readMessage(room.parent!.dir, room.threadOf!);
      if (!anchor) {
        fail(res, viewer, 404, 'Page not found');
        return;
      }
      const replies = readMessages(room.dir, { limit: 200 });
      seen(viewer, room, replies);
      res.type('html').send(views.threadPage(root, room, anchor, replies, viewer));
    })
  );

  // A page that is open and visible when a message arrives has read it, and
  // says so here, so the count does not sit at one on every other device.
  app.post(ROOM_PATHS('/read'), formBody, (req, res) =>
    withRoom(
      req,
      res,
      (viewer, room) => {
        const id = parseInt(String((req.body as Record<string, unknown>).id ?? ''), 10);
        if (Number.isInteger(id) && id > 0) noteRead(root, viewer.auth.username, room, Math.min(id, lastMessageId(room.dir)));
        res.status(204).end();
      },
      { form: true }
    )
  );

  // One stream per person, whichever page is open: their rooms' counts as
  // they change. What it says is only what the sidebar already shows.
  app.get('/events', (req, res) => {
    const viewer = requireViewer(req, res);
    if (!viewer) return;
    serveUserEvents(res, viewer.auth.username);
  });

  // Every member, as names, for the composer to complete an @ against
  // without a round trip per keystroke. It says no more than the new
  // conversation page already lists to the same eyes.
  app.get('/assets/users.json', (req, res) => {
    const viewer = getViewer(req, root);
    if (!viewer) {
      res.status(401).json([]);
      return;
    }
    const state = loadVault(root);
    const users = state.status === 'ok' ? Object.entries(state.vault.users) : [];
    res.set('Cache-Control', 'private, no-cache').json(
      users
        .map(([name, u]) => (u.profile?.name ? { name, display: u.profile.name } : { name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  });

  // The event stream: catch up from ?after, then live.
  app.get(ROOM_PATHS('/events'), (req, res) =>
    withRoom(req, res, (viewer, room) => {
      const after = parseInt(String(req.query.after ?? '0'), 10);
      const catchUp: RoomEvent[] = readMessages(room.dir, {
        after: Number.isInteger(after) && after >= 0 ? after : 0,
        limit: 200,
      }).map((m) => ({ type: 'message' as const, message: m }));
      serveEvents(res, room.url, catchUp, (ev) => views.messageHtml(root, room, ev.message, viewer).text);
    })
  );

  // Sending. After a thread reply, the parent message's reply count changed,
  // so the parent room is told to repaint it.
  app.post(ROOM_PATHS('/messages'), formBody, (req, res) =>
    withRoom(
      req,
      res,
      (viewer, room) => {
        const body = String((req.body as Record<string, unknown>).body ?? '');
        const parts = partFiles((req as FormRequest).fileParts ?? [], 'files').filter(
          (p) => p.filename && p.data.length > 0
        );
        const files: Attachment[] = [];
        const names = new Set<string>();
        for (const p of parts) {
          let name = path.basename(p.filename!).replace(/[\u0000-\u001f\\/]/g, '').trim();
          if (name === '' || name === '.' || name === '..') name = 'file';
          let unique = name;
          for (let i = 2; names.has(unique); i++) unique = `${i}-${name}`;
          names.add(unique);
          files.push({ name: unique, size: p.data.length });
        }
        const rawNonce = (req.body as Record<string, unknown>).nonce;
        const nonce = isValidNonce(rawNonce) ? rawNonce : undefined;
        // The files are written before anyone is told about the message, so
        // a page that renders it on the event finds them there. addMessage
        // refuses attachments over the cap before any of this runs.
        const bytes = files.reduce((n, f) => n + f.size, 0);
        const m = postMessage(root, room, { author: viewer.auth.username, body, files, nonce }, {
          charge: () => limits.message(viewer.auth.username, bytes),
          settle: (id) => {
            if (!files.length) return;
            const dir = filesDir(room.dir, id);
            fs.mkdirSync(dir, { recursive: true });
            parts.forEach((p, i) => fs.writeFileSync(path.join(dir, files[i].name), p.data, { mode: 0o600 }));
          },
        });
        if (wantsJson(req)) res.status(201).json({ id: m.id });
        else res.redirect(303, room.url);
      },
      { form: true }
    )
  );

  // Editing, deleting, reacting.
  app.get(ROOM_PATHS('/m/:mid/edit'), (req, res) =>
    withRoom(req, res, (viewer, room) => {
      const m = readMessage(room.dir, parseInt(req.params.mid, 10));
      if (!m || m.deleted || m.author !== viewer.auth.username) {
        fail(res, viewer, 404, 'Page not found');
        return;
      }
      if (!canEditMessage(viewer.auth, m)) {
        fail(res, viewer, 403, EDIT_WINDOW_PASSED);
        return;
      }
      res.type('html').send(views.editMessagePage(root, room, m, viewer));
    })
  );

  app.post(ROOM_PATHS('/m/:mid/edit'), formBody, (req, res) =>
    withRoom(
      req,
      res,
      (viewer, room) => {
        const id = parseInt(req.params.mid, 10);
        const m = readMessage(room.dir, id);
        if (!m || m.author !== viewer.auth.username) {
          fail(res, viewer, 404, 'Page not found');
          return;
        }
        // Checked on the save, not only when the form was opened: a form
        // opened inside the window can be submitted outside it.
        if (!canEditMessage(viewer.auth, m)) {
          fail(res, viewer, 403, EDIT_WINDOW_PASSED);
          return;
        }
        limits.action(viewer.auth.username);
        const edited = editMessage(room.dir, id, String((req.body as Record<string, unknown>).body ?? ''));
        publish(room.url, { type: 'update', message: edited });
        res.redirect(303, room.url);
      },
      { form: true }
    )
  );

  // Deleting asks first. With script, the page asks in a dialog and posts
  // below; without it, the trash button is a link to this page, which shows
  // the message and asks the same question.
  app.get(ROOM_PATHS('/m/:mid/delete'), (req, res) =>
    withRoom(req, res, (viewer, room) => {
      const m = readMessage(room.dir, parseInt(req.params.mid, 10));
      if (!m || m.deleted || !canDeleteMessage(viewer.auth, m.author)) {
        fail(res, viewer, 404, 'Page not found');
        return;
      }
      res.type('html').send(views.deleteMessagePage(root, room, m, viewer));
    })
  );

  app.post(ROOM_PATHS('/m/:mid/delete'), formBody, (req, res) =>
    withRoom(
      req,
      res,
      (viewer, room) => {
        const id = parseInt(req.params.mid, 10);
        const m = readMessage(room.dir, id);
        if (!m || !canDeleteMessage(viewer.auth, m.author)) {
          fail(res, viewer, 404, 'Page not found');
          return;
        }
        limits.action(viewer.auth.username);
        const deleted = deleteMessage(room.dir, id);
        // A deleted message has nothing left to pin.
        const pins = pinOf(room.dir, id) ? unpinMessage(room.dir, id).length : undefined;
        publish(room.url, { type: 'update', message: deleted, ...(pins !== undefined ? { pins } : {}) });
        if (wantsJson(req)) res.json({ deleted: true });
        else res.redirect(303, room.url);
      },
      { form: true }
    )
  );

  app.post(ROOM_PATHS('/m/:mid/react'), formBody, (req, res) =>
    withRoom(
      req,
      res,
      (viewer, room) => {
        const id = parseInt(req.params.mid, 10);
        const emoji = String((req.body as Record<string, unknown>).emoji ?? '');
        limits.action(viewer.auth.username);
        const m = toggleReaction(room.dir, id, emoji, viewer.auth.username);
        publish(room.url, { type: 'update', message: m });
        if (wantsJson(req)) res.json({ ok: true });
        else res.redirect(303, room.url);
      },
      { form: true }
    )
  );

  // Pinning. A room's own messages only: a thread's replies are not pinned,
  // though the message a thread hangs from can be. The room's open pages hear
  // the message repainted, with the new count for the header.
  const pinRoute = (action: 'pin' | 'unpin') =>
    app.post(BASES.map((b) => `${b}/m/:mid/${action}`), formBody, (req, res) =>
      withRoom(
        req,
        res,
        (viewer, room) => {
          const id = parseInt(req.params.mid, 10);
          const m = readMessage(room.dir, id);
          if (!m || m.deleted) {
            fail(res, viewer, 404, 'Page not found');
            return;
          }
          limits.action(viewer.auth.username);
          const pins = action === 'pin' ? pinMessage(room.dir, id, viewer.auth.username) : unpinMessage(room.dir, id);
          publish(room.url, { type: 'update', message: m, pins: pins.length });
          if (wantsJson(req)) res.json({ pins: pins.length });
          else res.redirect(303, req.get('referer')?.includes('/pins') ? `${room.url}/pins` : room.url);
        },
        { form: true }
      )
    );
  pinRoute('pin');
  pinRoute('unpin');

  // Muting, from the bell in a room's header: nothing from the room, or its
  // threads, is notified to the person who muted it. It is theirs alone, so
  // it is not published to anyone; the page it came from is shown again.
  app.post(BASES.map((b) => `${b}/mute`), formBody, (req, res) =>
    withRoom(
      req,
      res,
      (viewer, room) => {
        const muted = (req.body as Record<string, unknown>).muted === '1';
        setMuted(root, viewer.auth.username, room.url, muted);
        if (wantsJson(req)) res.json({ muted });
        else res.redirect(303, room.url);
      },
      { form: true }
    )
  );

  app.get(BASES.map((b) => `${b}/pins`), (req, res) =>
    withRoom(req, res, (viewer, room) => {
      const pinned = readPins(room.dir)
        .map((pin) => ({ pin, message: readMessage(room.dir, pin.id) }))
        .filter((p): p is { pin: Pin; message: Message } => p.message !== null && !p.message.deleted);
      res.type('html').send(views.pinsPage(root, room, pinned, viewer));
    })
  );

  // Attached files. Served with a sandbox policy so a file is a download or a
  // picture and never a page of ours: an uploaded HTML or SVG file would
  // otherwise run in the workspace's own origin.
  app.get(ROOM_PATHS('/files/:mid/:name'), (req, res) =>
    withRoom(req, res, (viewer, room) => {
      const id = parseInt(req.params.mid, 10);
      const name = req.params.name;
      const m = readMessage(room.dir, id);
      if (!m || !m.files.some((f) => f.name === name)) {
        fail(res, viewer, 404, 'Page not found');
        return;
      }
      const file = path.join(filesDir(room.dir, id), path.basename(name));
      if (!fs.existsSync(file)) {
        fail(res, viewer, 404, 'Page not found');
        return;
      }
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Shown or played in place where the browser can; everything else is a
      // download. A PDF is a download: the sandbox above stops the PDF viewer,
      // which is a plugin, so inline it would be a blank page.
      if (!/\.(png|jpe?g|gif|webp|avif|svg|txt|wav|mp3|ogg|oga|opus|flac|m4a|aac|weba|mp4|m4v|webm|ogv|mov)$/i.test(name)) {
        res.setHeader('Content-Disposition', 'attachment');
      }
      // sendFile answers range requests, which is what lets a player seek.
      res.sendFile(file);
    })
  );

  // ---- channel settings ----

  app.get('/c/:channel/settings', (req, res) =>
    withRoom(req, res, (viewer, room) => {
      res.type('html').send(views.channelSettingsPage(root, room, viewer));
    })
  );

  app.post('/c/:channel/settings', urlenc, (req, res) =>
    withRoom(
      req,
      res,
      (_viewer, room) => {
        setTopic(root, room.channel!.name, String((req.body as Record<string, unknown>).topic ?? ''));
        res.redirect(303, `${room.url}/settings`);
      },
      { form: true }
    )
  );

  app.post('/c/:channel/members/add', urlenc, (req, res) =>
    withRoom(
      req,
      res,
      (_viewer, room) => {
        const user = String((req.body as Record<string, unknown>).user ?? '').trim();
        if (!userExists(root, user)) throw new OpError(`There is no user named ${user}.`, 'notfound');
        addMember(root, room.channel!.name, user);
        res.redirect(303, `${room.url}/settings`);
      },
      { form: true }
    )
  );

  app.post('/c/:channel/members/remove', urlenc, (req, res) =>
    withRoom(
      req,
      res,
      (viewer, room) => {
        const user = String((req.body as Record<string, unknown>).user ?? '');
        // Anyone may leave; removing somebody else is for admins of the site,
        // since a private channel has no finer role to hold it to.
        if (user !== viewer.auth.username && !isSiteAdmin(viewer.auth)) {
          throw new OpError('You can remove yourself; removing others is for a site admin.');
        }
        removeMember(root, room.channel!.name, user);
        const stillIn = user !== viewer.auth.username;
        res.redirect(303, stillIn ? `${room.url}/settings` : '/');
      },
      { form: true }
    )
  );

  app.post('/c/:channel/delete', urlenc, (req, res) =>
    withRoom(
      req,
      res,
      (viewer, room) => {
        if (!isSiteAdmin(viewer.auth)) throw new OpError('Only a site admin may delete a channel.');
        deleteChannel(root, room.channel!.name);
        res.redirect(303, '/');
      },
      { form: true }
    )
  );

  // ---- profiles, last: /<name> is every name no route above claimed ----

  app.get('/:username', (req, res, next) => {
    const username = req.params.username;
    if (!userExists(root, username)) {
      next();
      return;
    }
    const viewer = requireViewer(req, res);
    if (!viewer) return;
    const state = loadVault(root);
    const profile = state.status === 'ok' ? state.vault.users[username]?.profile : undefined;
    res.type('html').send(views.profilePage(root, viewer, username, profile));
  });
}
