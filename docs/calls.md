# Calls

A call belongs to a channel, a direct conversation, or a meeting. Anyone who can see the room can start one with the camera button in the room's header, and anyone else who can see it can join at any time, from that button or from the call's entry in the timeline. Everyone joins with microphone and camera off. The browser asks for both devices on joining, and each person turns them on with the call's own buttons.

The call is drawn in the page, not in a window of its own. In the call's room it is a strip of small tiles under the header, with the conversation below it. Moving to another room keeps the call, shrunk to a small window in a corner that can be dragged aside and leads back to its room. Either can be expanded to fill the page, where pressing a tile enlarges it, and collapsed again with the same button or Escape. The strip, the floating window, and the full page are one element that the page moves; the page itself does not reload when you move between rooms, so the call's connections and video are never interrupted.

This document describes how calls connect, what an administrator can configure, how meetings let people outside the workspace join a call, and the limits of the design.

## How a call connects

A call's audio and video go directly between the browsers in it, using WebRTC. Every browser in the call connects to every other one (a *full mesh*), sending its audio and video to each. The workspace server never carries media. What it does is what WebRTC calls signaling: it keeps the list of who is in each call, tells each page who else is there, and passes the connection offers, answers, and network candidates between pages. These travel over the event stream each page already holds open for unread counts, and go up as ordinary requests, each checked against the room like any other. Someone who loses sight of the room during a call (removed from a private channel, removed from the workspace, or the channel deleted) is taken out of the call, and the others drop their connections to them. The WebRTC half is ported from commonroom, with its Nostr signaling replaced by the workspace.

A page is a participant, not a person. Someone with the workspace open in two tabs, or on a laptop and a phone, can have both in a call, and each connects separately.

To connect, two browsers need a network path to each other. Each browser asks a *STUN server* for the address the internet sees it at, and that is enough for most home and office networks. When both ends are behind strict NATs, or a network lets little out besides web traffic on port 443, no direct path exists, and the pair needs a *TURN server* to relay their media. A relay carries the whole call for the pair that uses it, so it costs bandwidth, and its credentials are guarded.

## Configuring STUN and TURN

Both are set on the Admin page, under Calls, and stored in `config.json` under `calls`.

**STUN servers.** The default is two public servers, `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`, so calls work with no setup. The trade-off is that Google and Cloudflare see the address of each person who joins a call. An admin can list other servers, or none, in which case calls connect only where the browsers can reach each other directly: on the same network, or where one side has a public address.

**TURN relay.** There are four choices.

- *None.* Calls connect directly or not at all.
- *A TURN server with a fixed username and password.* Any provider can supply these, and so can a coturn server configured with `lt-cred-mech` and a user. The username and password are handed to every member who joins a call, so anyone in the workspace can read them from their browser. They are not handed to a meeting's guests, since a guest is anyone with the meeting's link; a guest connects directly or not at all in this mode, and the other modes are the ones to choose where guests matter.
- *coturn, with a shared secret.* The TURN REST scheme: coturn is configured with `use-auth-secret` and a `static-auth-secret`, and the workspace keeps the same secret. For each person joining a call it makes a credential that expires after 2 hours, whose username is the expiry time and the person's name, and whose password is an HMAC of that username under the secret. The secret never leaves the server. A call that lasts longer asks for a fresh credential before the old one expires, and is given one only while the person can still see the room, so someone removed can use the relay for at most that long.
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
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
```

The `denied-peer-ip` lines matter. Anyone who has joined a call holds a credential, and a relay that would forward to any address would let them reach the machine's own network, its cloud provider's metadata service included; browsers in a call reach each other at public addresses, so nothing is lost by refusing the private ranges.

Open 3478 (UDP and TCP), 5349 (TCP), and the relay range (UDP) in the machine's firewall. On the Admin page, choose coturn and list both `turn:turn.example.org:3478` and `turns:turn.example.org:5349`; a `turns:` URL on port 443 (with `tls-listening-port=443`) is what reaches people on the most restrictive networks.

## Meetings and guests

A call in a channel or a conversation is among members of the workspace. A limitation of that arrangement is that it cannot include anyone else: a client, a collaborator at another institution, a candidate for a job. Meetings are the response. A meeting is a third kind of room beside channels and conversations, made from the sidebar (Meetings, then the plus) or with `dango meeting create`. It is visible to the members added to it and to nobody else, the site admin included, as a private channel is, and it has a timeline, threads, pins, and a call like any other room. What it adds is a guest link.

We say someone is a *guest* when they come in through a meeting's link rather than with a token. A guest has no account: nothing is written to `workspace.json` or `users/` for them. What they hold is a cookie, signed with the workspace's `.secret`, naming them and the one meeting, and what the workspace keeps is a line in the meeting's `meeting.json` with the name they gave, so that what they wrote still says who wrote it after they have gone.

**Joining.** The link has the form `/m/<id>/join#k=<key>`. The key is in the fragment, as an invite link's token is, so it never reaches the server's logs or a proxy; the page script moves it into the form. The page names nothing, the meeting's title included, until the key has been checked, since meetings are numbered and a number is easily guessed. The guest gives a name and presses Ask to join. By default they then wait in the meeting's *lobby*: every member of the meeting who has a page open sees a notice saying who is waiting, with buttons to let them in or turn them away, and members who take notifications are sent one. Once let in, the guest's page goes on to the meeting by itself. A meeting's settings can instead let guests in on the link alone, which is simpler and suits a link sent only to the people expected; the trade-off is that anyone the link reaches comes straight in. Someone signed in to the workspace who opens the link joins as themselves and is added to the meeting's members.

**What a guest can do.** A guest sees the meeting's page and nothing else: no sidebar, no other room, no search, no profiles, no API. They can read and write the meeting's timeline and threads, react, edit and delete their own messages, and open its attachments; they cannot attach files, since a meeting that lets guests straight in would otherwise let anyone with its link fill the workspace's disk, and they cannot pin or mute. Their messages and their tile in the call show the name they gave, followed by "(guest)", so that a guest calling themselves "alice" is not taken for alice. Everything else refuses them as it refuses a stranger: the workspace's own session cookie is the only thing the rest of the interface reads, and every permission check in `src/perms.ts` says no to a guest by name, so a guest's identity that reached some other route by mistake would open nothing there.

**Calls with guests.** A guest can join a meeting's call once a member has started it, and cannot start one; until then their call button says so. A call left with guests alone, because every member left or lost their connection, ends for the guests after 45 seconds, which is long enough for a member to reload their page or for the workspace to restart. The intent is that a meeting's link is a way for outsiders to talk with the workspace's members, and not a way for strangers to meet one another on the workspace's server and relay. A guest is given relay credentials as a member is, in the coturn and Cloudflare modes, each made for them and expiring; in the fixed-password mode they are given none.

**Taking access away.** A member can take a guest out of the meeting from its settings, which ends their call at once. Making a new link (in the settings, "Make a new link") shuts out the old link and every guest let in under it; their names stay beside what they wrote. A guest can leave by themselves with the Leave button. A site admin can turn guest links off for the whole workspace on the Admin page, under Calls, which stops every link working and takes every guest out of every call.

**Limits.** At most ten people can wait in one meeting's lobby at once, and one address can ask to join ten times in ten minutes, across all meetings; each knock is a notification to the meeting's members, so a stranger with a link is held to a few. A meeting keeps at most 500 guests. A guest's cookie lasts a day from its last use, and a browser holds one, so it is a guest in one meeting at a time: joining a second meeting as a guest leaves the first. The eight-page cap on a call applies to meetings as to any room, and it is the real bound on meetings as a replacement for a video-conferencing service: they suit a small group, and a larger one would need a media server.

## Diagnosing connection problems

Calls that fail to connect are the usual trouble with WebRTC, and the cause is nearly always the networks at either end rather than the workspace. Three things help find it.

**The admin page tests the servers.** Under Calls, the admin page runs a test from the admin's own browser whenever it is opened, and again with Test again. Each STUN server is asked for the browser's public address. For each TURN URL, the page makes a connection to itself through that relay alone, allowing only relay candidates, and sends a message round it. A relay that passes has accepted the credentials and actually carried traffic. A relay that fails is described by how: it could not be reached (error 701, usually a firewall or a wrong port), it refused the credentials (401, usually a wrong secret, or a server clock far from the workspace's), or it gave out a relay address but nothing went through it, which usually means its relay port range is closed. The test is only as good as the network the admin is on: a relay reached over UDP from home can be unreachable from an office that allows only port 443, which is what a `turns:` URL on port 443 is for. Beside the test, the page says when a real call last went through the relay.

**The call shows its connections.** The call's settings button (the sliders) opens a panel that lists, for each other person, whether the connection is open and how: directly, or through the relay and over which protocol, with the round-trip time, the resolution and frame rate received, the share of packets lost, and what is holding back the video sent (the network or the processor). It also says what kinds of address this browser found (its own, a public one from STUN, a relay one from TURN) and any errors the ICE servers answered with. Copy the details puts all of it on the clipboard as text, to paste to whoever looks after the workspace. A tile that has been retried says "Still trying to connect".

**Each connection is logged.** Every page in a call reports each of its connections to the workspace once: when it opens, with the path it took; when an attempt is given up (it is retried after 15 seconds); and when an open connection drops. Each side reports its own view, since the two ends can be on very different networks. Reports carry the kinds of candidate found and the ICE errors, never addresses. The workspace keeps the newest 300 in `call-log.json`, writes each to the server's log as one line beginning `call:`, and lists them on the admin page with a count of the last week's direct, relayed, failed, and dropped connections. A room the admin cannot see is not named there.

Reading a failure: if neither browser found a relay address, the relay was not offered or not reachable, and the ICE errors say which; if one side found only its own addresses, it has no STUN either, which is typical of a network that blocks UDP; a connection that opened and then dropped points at a network change, such as a phone moving from Wi-Fi to cellular.

## Limits

- **Eight at a time.** In a mesh, each participant uploads a copy of their video to every other, so the cost grows with the call. The server refuses a ninth page. The video quality setting (in the call's device and quality panel) is shared by the whole call and lowers what everyone sends; it helps on slow connections. Going beyond eight would need a media server (an SFU) that receives each stream once and forwards it, which is exactly the traffic this design keeps off the server.
- **The roster is in memory.** A restart of the server forgets who is in which call, but the browsers stay connected to each other. Each page notices its event stream reopen and joins again under the same call, so the call keeps its entry in the timeline. A page whose stream stays closed for 20 seconds is taken out of the call.
- **Leaving the page leaves the call.** Moving between the workspace's own pages keeps the call. Reloading the page, closing it, or following a link to another site ends it; the browser asks first.
- **Notifications.** A call starting in a direct conversation or a meeting is notified like a message. A call in a channel is not pushed to anyone; the channel is marked in the sidebar while the call goes on.
- **Devices.** Choosing a speaker needs a browser that supports it (Chrome, Edge, and Firefox do; Safari does not). Screen sharing is offered where the browser can share a screen, which excludes phones.
