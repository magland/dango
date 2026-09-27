# Calls

A call belongs to a channel or a direct conversation. Anyone who can see the room can start one with the camera button in the room's header, and anyone else who can see it can join at any time, from that button or from the call's entry in the timeline. Everyone joins with microphone and camera off. The browser asks for both devices on joining, and each person turns them on with the call's own buttons.

The call is drawn in the page, not in a window of its own. In the call's room it is a strip of small tiles under the header, with the conversation below it. Moving to another room keeps the call, shrunk to a small window in a corner that can be dragged aside and leads back to its room. Either can be expanded to fill the page, where pressing a tile enlarges it, and collapsed again with the same button or Escape. The strip, the floating window, and the full page are one element that the page moves; the page itself does not reload when you move between rooms, so the call's connections and video are never interrupted.

This document describes how calls connect, what an administrator can configure, and the limits of the design.

## How a call connects

A call's audio and video go directly between the browsers in it, using WebRTC. Every browser in the call connects to every other one (a *full mesh*), sending its audio and video to each. The workspace server never carries media. What it does is what WebRTC calls signaling: it keeps the list of who is in each call, tells each page who else is there, and passes the connection offers, answers, and network candidates between pages. These travel over the event stream each page already holds open for unread counts, and go up as ordinary requests, each checked against the room like any other. Someone who loses sight of the room during a call (removed from a private channel, removed from the workspace, or the channel deleted) is taken out of the call, and the others drop their connections to them. The WebRTC half is ported from commonroom, with its Nostr signaling replaced by the workspace.

A page is a participant, not a person. Someone with the workspace open in two tabs, or on a laptop and a phone, can have both in a call, and each connects separately.

To connect, two browsers need a network path to each other. Each browser asks a *STUN server* for the address the internet sees it at, and that is enough for most home and office networks. When both ends are behind strict NATs, or a network lets little out besides web traffic on port 443, no direct path exists, and the pair needs a *TURN server* to relay their media. A relay carries the whole call for the pair that uses it, so it costs bandwidth, and its credentials are guarded.

## Configuring STUN and TURN

Both are set on the Admin page, under Calls, and stored in `config.json` under `calls`.

**STUN servers.** The default is two public servers, `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`, so calls work with no setup. The trade-off is that Google and Cloudflare see the address of each person who joins a call. An admin can list other servers, or none, in which case calls connect only where the browsers can reach each other directly: on the same network, or where one side has a public address.

**TURN relay.** There are four choices.

- *None.* Calls connect directly or not at all.
- *A TURN server with a fixed username and password.* Any provider can supply these, and so can a coturn server configured with `lt-cred-mech` and a user. The username and password are handed to every member who joins a call, so anyone in the workspace can read them from their browser.
- *coturn, with a shared secret.* The TURN REST scheme: coturn is configured with `use-auth-secret` and a `static-auth-secret`, and the workspace keeps the same secret. For each person joining a call it makes a credential that expires after 12 hours, whose username is the expiry time and the person's name, and whose password is an HMAC of that username under the secret. The secret never leaves the server. A call that lasts longer asks for a fresh credential before the old one expires.
- *Cloudflare Realtime TURN.* In the Cloudflare dashboard, under Realtime, create a TURN key; it has an id and an API token. The workspace keeps both and asks Cloudflare for a short-lived credential for each person joining a call. The token never leaves the server. If Cloudflare cannot be reached, the call goes ahead without a relay rather than failing, and the server logs why.

The password, the shared secret, and the API token are never written back into the Admin page. Their fields are blank, say whether a value is saved, and keep the saved value when left blank.

### A coturn server

TURN needs UDP ports and a wide range of relay ports open to the internet, which a platform like Fly.io does not give an ordinary app, so the relay is best run on a small machine of its own. A minimal `/etc/turnserver.conf` for the shared-secret mode:

```
listening-port=3478
tls-listening-port=5349
realm=turn.example.org
use-auth-secret
static-auth-secret=<a long random string, the same one given to the workspace>
cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem
min-port=49152
max-port=65535
fingerprint
no-cli
```

Open 3478 (UDP and TCP), 5349 (TCP), and the relay range (UDP) in the machine's firewall. On the Admin page, choose coturn and list both `turn:turn.example.org:3478` and `turns:turn.example.org:5349`; a `turns:` URL on port 443 (with `tls-listening-port=443`) is what reaches people on the most restrictive networks.

## Limits

- **Eight at a time.** In a mesh, each participant uploads a copy of their video to every other, so the cost grows with the call. The server refuses a ninth page. The video quality setting (in the call's device and quality panel) is shared by the whole call and lowers what everyone sends; it helps on slow connections. Going beyond eight would need a media server (an SFU) that receives each stream once and forwards it, which is exactly the traffic this design keeps off the server.
- **The roster is in memory.** A restart of the server forgets who is in which call, but the browsers stay connected to each other. Each page notices its event stream reopen and joins again under the same call, so the call keeps its entry in the timeline. A page whose stream stays closed for 20 seconds is taken out of the call.
- **Leaving the page leaves the call.** Moving between the workspace's own pages keeps the call. Reloading the page, closing it, or following a link to another site ends it; the browser asks first.
- **Notifications.** A call starting in a direct conversation is notified like a message. A call in a channel is not pushed to anyone; the channel is marked in the sidebar while the call goes on.
- **Devices.** Choosing a speaker needs a browser that supports it (Chrome, Edge, and Firefox do; Safari does not). Screen sharing is offered where the browser can share a screen, which excludes phones.
