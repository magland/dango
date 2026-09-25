import { createHash } from 'crypto';

// The service worker, served at /sw.js so that its scope is the whole
// workspace. It has one job: to be woken by a push and show the notification
// (with a chime from an open tab, if there is one), and to open the right
// room when the notification is pressed. It does not intercept requests or
// cache pages, so the workspace behaves online exactly as it did before
// there was a worker, and there is no stale copy of a page to go wrong.
//
// A push carries {title, body, tag, url, unread, time} (see notify.ts). Every
// push shows a notification: Safari withdraws the permission of a site whose
// pushes show nothing, and Chrome shows a notice of its own in their place.

const SW_JS = `
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

// The chime. A worker cannot play sound, and a notification cannot choose
// its own (the system decides, and often decides on silence), so an open
// workspace tab is asked to play it: the focused one first, then the visible
// ones, then the rest, stopping at the first that says it did. A tab can only
// play sound once someone has clicked or typed in it, which is why it is
// asked rather than told. If one played it, the notification is shown silent,
// so the chime and the system's sound do not both go off; if none could, the
// notification makes whatever sound the system gives it.
function askToChime(client) {
  return new Promise(function (resolve) {
    var done = false;
    var channel = new MessageChannel();
    channel.port1.onmessage = function (m) { if (!done) { done = true; resolve(!!(m.data && m.data.played)); } };
    setTimeout(function () { if (!done) { done = true; resolve(false); } }, 400);
    try { client.postMessage({ type: 'chime' }, [channel.port2]); } catch (err) { done = true; resolve(false); }
  });
}
function chimeSomewhere() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var rank = function (c) { return c.focused ? 0 : c.visibilityState === 'visible' ? 1 : 2; };
    list = list.slice().sort(function (a, b) { return rank(a) - rank(b); }).slice(0, 4);
    var i = 0;
    function next() {
      if (i >= list.length) return false;
      return askToChime(list[i++]).then(function (played) { return played || next(); });
    }
    return next();
  }).catch(function () { return false; });
}

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  var work = [chimeSomewhere().then(function (chimed) {
    return self.registration.showNotification(d.title || 'dango', {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      silent: chimed,
      icon: '/icon/192.png',
      badge: '/icon/badge.png',
      timestamp: d.time || Date.now(),
      data: { url: d.url || '/' }
    });
  })];
  // The unread total on the app's icon, where the platform has one (an
  // installed app on iOS, macOS, Windows, ChromeOS).
  if (typeof d.unread === 'number' && self.navigator.setAppBadge) {
    work.push((d.unread > 0 ? self.navigator.setAppBadge(d.unread) : self.navigator.clearAppBadge()).catch(function () {}));
  }
  e.waitUntil(Promise.all(work));
});

// Pressing a notification brings a workspace window forward and shows the
// room; a new window only when none is open.
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url === url && list[i].focus) return list[i].focus();
    }
    if (list.length && list[0].navigate) {
      var c = list[0];
      return c.focus().then(function () { return c.navigate(url); }).catch(function () { return self.clients.openWindow(url); });
    }
    return self.clients.openWindow(url);
  }));
});

// A browser that replaces a subscription by itself tells the workspace, with
// the old subscription's secret as its credential, since a worker has no
// session to send.
self.addEventListener('pushsubscriptionchange', function (e) {
  var old = e.oldSubscription ? e.oldSubscription.toJSON() : null;
  if (!old) return;
  var renew = (e.newSubscription ? Promise.resolve(e.newSubscription) : self.registration.pushManager.subscribe(e.oldSubscription.options))
    .then(function (sub) {
      return fetch('/push/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old: { endpoint: old.endpoint, auth: old.keys && old.keys.auth }, subscription: sub.toJSON() })
      });
    })
    .catch(function () {});
  e.waitUntil(renew);
});
`;

let made: { body: string; tag: string } | null = null;

export function serviceWorker(): { body: string; tag: string } {
  if (!made) made = { body: SW_JS, tag: createHash('sha256').update(SW_JS).digest('hex').slice(0, 12) };
  return made;
}
