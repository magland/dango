import './branding';
import compression from 'compression';
import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { clientKey, createAuthLimiter, createLimiter } from '../../mochiforge/src/limit';
import { getViewer, renewSession } from '../../mochiforge/src/session';
import { activeTheme, setActiveTheme } from '../../mochiforge/src/themes';
import { registerBackupRoutes } from '../../mochiforge/src/api/backup';
import { registerApi } from './api';
import { workspaceLayout } from './backup';
import { loadConfig } from './config';
import { createWriteLimits } from './limits';
import { ICON_SIZES, appIconPng, badgePng } from './appicon';
import { MAX_ATTACHMENTS_BYTES } from './messages';
import { faviconSvg } from './logo';
import { pageScript } from './pagescript';
import { styleSheet } from './style';
import { serviceWorker } from './sw';
import * as views from './views';
import { registerWeb } from './web';

// One Express app, the shape of mochiforge's server with the forge-only
// parts gone: no git wire protocol, no LFS, no CI, no sites. What remains is
// the same skeleton: compression, per-address rate limits, a strict CSP with
// no inline script, immutable hashed assets, sliding sessions, and every
// route reading the workspace directory on demand.

/**
 * What a workspace page may load, and from where. The reasoning is
 * mochiforge's (see its src/server.ts): script-src 'self' and no inline
 * script anywhere, inline style allowed because the interface paints with
 * computed values and style cannot execute, img-src open because markdown
 * already references external images. form-action needs no second origin
 * here, since nothing posts anywhere else.
 */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data:',
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function isRateExempt(req: Request): boolean {
  return (
    req.path.startsWith('/assets/') ||
    req.path.startsWith('/icon/') ||
    req.path === '/favicon.svg' ||
    req.path === '/favicon.ico' ||
    req.path === '/sw.js' ||
    req.path === '/manifest.webmanifest'
  );
}

// The event streams must reach the client as they are written: compression
// wraps the response in zlib, which buffers each event instead of sending it,
// and a chat whose messages arrive when the buffer happens to fill is a chat
// where nothing appears to happen. The same exclusion mochiforge makes for
// the git wire protocol, for the same reason: a streaming body must not sit
// in a compressor. The backup routes are excluded as mochi excludes them: a
// long stream whose files are mostly already compact, where compressing costs
// the machine CPU and delays the first bytes.
const UNCOMPRESSED = /\/events$|^\/api\/backup\//;

function isCompressible(req: Request, res: Response): boolean {
  if (UNCOMPRESSED.test(req.path)) return false;
  return compression.filter(req, res);
}

export function createApp(root: string) {
  const app = express();
  app.disable('x-powered-by');
  // Node's own querystring, not qs, for the same reason mochiforge switched:
  // nothing here reads a nested query, and the simple parser has no advisory
  // history to keep up with.
  app.set('query parser', 'simple');
  const config = loadConfig(root);
  app.set('trust proxy', config.network.trustProxy);

  app.use(compression({ filter: isCompressible }));

  const authLimiter = createAuthLimiter(config.limits.authFailures);
  const requestLimiter = createLimiter({
    limit: config.limits.requestsPerMinute,
    windowMs: 60000,
    maxKeys: 20000,
  });

  // The theme is workspace state, re-read (stat-cached) per request so a
  // hand-edited config.json takes effect without a restart.
  app.use((_req, _res, next) => {
    setActiveTheme(loadConfig(root).theme);
    next();
  });

  app.use((req, res, next) => {
    if (isRateExempt(req)) return next();
    const decision = requestLimiter.hit(clientKey(req));
    if (decision.ok) return next();
    res.status(429).setHeader('Retry-After', String(decision.retryAfter));
    res
      .type('html')
      .send(views.errorPage(429, 'Too many requests from this address. Try again in a moment.', { viewer: null, root }));
  });

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', APP_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // ---- static assets, cached for good under a hash of their bytes ----

  app.get('/assets/style.css', (req, res) => {
    const sheet = styleSheet(activeTheme());
    const fresh = String(req.query.v ?? '') === sheet.tag;
    res
      .type('text/css')
      .set('Cache-Control', fresh ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(sheet.body);
  });
  app.get('/assets/page.js', (req, res) => {
    const script = pageScript();
    const fresh = String(req.query.v ?? '') === script.tag;
    res
      .type('text/javascript')
      .set('Cache-Control', fresh ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(script.body);
  });
  // KaTeX from the installed package, so rendered math needs no external
  // requests; the terms are mochiforge's.
  const katexDir = path.dirname(require.resolve('katex/dist/katex.min.css'));
  let katexCss: string | null = null;
  app.get('/assets/katex/katex.css', (_req, res) => {
    if (katexCss === null) katexCss = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8');
    res.type('text/css').set('Cache-Control', 'public, max-age=86400').send(katexCss);
  });
  app.get('/assets/katex/fonts/:file', (req, res) => {
    if (!/^KaTeX_[A-Za-z0-9]+-[A-Za-z]+\.(woff2|woff|ttf)$/.test(req.params.file)) {
      res.status(404).end();
      return;
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(katexDir, 'fonts', req.params.file));
  });
  // ?unread= picks the variant with a dot; each variant is its own URL, so
  // each can be cached, and the page script switching between them costs a
  // request only the first time.
  app.get('/favicon.svg', (req, res) => {
    const unread = req.query.unread === 'urgent' ? 'urgent' : req.query.unread === 'some' ? 'some' : null;
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(faviconSvg(undefined, unread));
  });
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });
  // The same mark as PNG, for home screens and notifications (see appicon.ts).
  app.get('/icon/:file', (req, res) => {
    const m = /^(\d+|badge)\.png$/.exec(req.params.file);
    const size = m && m[1] !== 'badge' ? parseInt(m[1], 10) : 0;
    if (!m || (m[1] !== 'badge' && !ICON_SIZES.includes(size))) {
      res.status(404).end();
      return;
    }
    res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(m[1] === 'badge' ? badgePng() : appIconPng(size));
  });

  // The service worker, at the root so its scope is every page. Never cached
  // for long: a browser checks for a new worker by fetching this URL, and a
  // stale one would keep an old worker running after a deploy.
  app.get('/sw.js', (_req, res) => {
    res.type('text/javascript').set('Cache-Control', 'no-cache').send(serviceWorker().body);
  });

  // What makes the workspace installable: "Add to Home Screen" on iOS, which
  // is what lets a web page receive notifications there, and the install
  // prompt elsewhere. It names the workspace only to someone signed in (pages
  // link it with crossorigin="use-credentials" so the cookie comes along),
  // keeping to the rule that a workspace tells a stranger nothing.
  app.get('/manifest.webmanifest', (req, res) => {
    const theme = activeTheme();
    const name = getViewer(req, root) ? loadConfig(root).name : 'dango';
    const icons = [192, 512].flatMap((size) =>
      ['any', 'maskable'].map((purpose) => ({ src: `/icon/${size}.png?t=${encodeURIComponent(theme.name)}`, sizes: `${size}x${size}`, type: 'image/png', purpose }))
    );
    res
      .type('application/manifest+json')
      .set('Cache-Control', 'private, no-cache')
      .send(
        JSON.stringify({
          id: '/',
          name,
          short_name: name,
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: theme.vars.bg,
          theme_color: theme.vars.surface,
          icons,
        })
      );
  });

  // Sliding sessions, after the cacheable assets for the reason mochiforge
  // gives: a Set-Cookie must never ride on a response a shared cache stores.
  app.use((req, res, next) => {
    renewSession(req, res, root);
    next();
  });

  // Backup, over mochi's protocol: a manifest of the workspace's files and a
  // bulk fetch of named ones, site admins only. The fetch names up to 2000
  // paths of up to 1024 characters, which is what the body limit allows for.
  app.use('/api/backup/fetch', express.json({ limit: '4mb' }));
  registerBackupRoutes(app, root, authLimiter, workspaceLayout(root));
  // Per-person limits on writing, shared by the web and the API, so that a
  // script cannot go around the interface's limits by going through /api.
  const writeLimits = createWriteLimits(config.limits);
  registerApi(app, root, authLimiter, writeLimits);
  registerWeb(app, root, authLimiter, writeLimits);

  app.use((req, res) => {
    res.status(404).type('html').send(views.errorPage(404, 'Page not found', { viewer: getViewer(req, root), root }));
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      console.error(err);
      res.end();
      return;
    }
    let viewer = null;
    try {
      viewer = getViewer(req, root);
    } catch {
      viewer = null;
    }
    const status =
      (err as Error & { statusCode?: unknown }).statusCode ?? (err as Error & { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message =
        (err as Error & { type?: unknown }).type === 'entity.too.large'
          ? `That is larger than a message may be: attachments may come to at most ${MAX_ATTACHMENTS_BYTES / (1024 * 1024)} MB.`
          : 'The request could not be read; go back and try again.';
      // The composer sends through script and asks for JSON, so that a
      // refusal lands beside the message it refused instead of replacing the page.
      if ((req.get('accept') ?? '').includes('application/json')) {
        res.status(status).json({ error: message });
        return;
      }
      res.status(status).type('html').send(views.errorPage(status, message, { viewer, root }));
      return;
    }
    console.error(err);
    res.status(500).type('html').send(views.errorPage(500, 'Internal server error', { viewer, root }));
  });

  return app;
}
