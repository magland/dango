# dango

A self-hosted team chat, Slack-shaped: channels, threads, direct messages, reactions, file attachments, and search. One Node process, no database, nothing installed beside it but Node.

dango is built from the same parts as [Mochi Forge](../mochiforge), its sibling in the next directory, and makes the same kinds of decisions: state is plain files in one directory, pages are server-rendered HTML with no client framework and no build step, every write is authorized by a token, and users are created by an administrator rather than registering themselves. Where mochi has a vault of repositories, dango has a *workspace* of channels.

Unlike a mochi vault, a workspace has no anonymous surface at all: reading requires signing in, a private channel is visible only to its members (the site admin included in the exclusion), and a direct conversation only to its participants. The operator can of course read the files on disk; that is true of everything here and worth knowing rather than pretending away.

## Try it locally

```bash
mkdir mychat
npx @magland/dango serve mychat
```

The server initializes the workspace and prints an owner token once (only its hash is stored). Open http://127.0.0.1:3000, sign in at `/login` with the token, and create channels and users from there, or from the CLI:

```bash
dango login http://127.0.0.1:3000
dango user add alice
dango channel create general --topic "Everything and nothing"
dango send general "Hello."
```

## Put it on the internet

With a [Fly.io](https://fly.io) account and flyctl installed, one command creates the app, the volume, and the machine:

```bash
npm install -g @magland/dango
dango deploy fly my-workspace-name       # -> https://my-workspace-name.fly.dev
dango login https://my-workspace-name.fly.dev
dango user add alice
```

The same command deploys updates, and `dango backup ~/backups/chat --snapshot` keeps an incremental copy of a hosted workspace on your own disk. From a checkout, `--from-source` builds the image from your own dango and mochiforge instead of pulling the published one. See [Deploying a workspace](docs/deploying.md) for Docker, self-hosting with Caddy, and a domain of your own, and [Backing up a workspace](docs/backup.md).

## What it does

- **Channels,** public to every member or private to a member list. Messages are markdown with KaTeX and emoji; links out of the workspace open in a new tab.
- **@mentions,** completed as you type; a message naming you is marked in the room and counted in the sidebar.
- **Unread counts** in the sidebar, the tab title, and a dot on the tab's icon, kept on the server per person, so reading a room on one device clears it on the others.
- **Threads** hung off any message, **reactions** toggled per person, **pinned messages** per room, **editing** your own messages for two hours after sending them, and **deleting** them after a confirmation (a deletion leaves a tombstone, so a thread keeps its anchor).
- **Direct messages,** one conversation per set of up to nine people.
- **File attachments,** up to 20 MB per message, stored in the workspace and served only to who could read the message, each shown with its size. Images, audio, and video show or play in place; everything else is a download, under a sandbox policy so an uploaded page is never a page of ours.
- **Sending that survives trouble:** an upload shows its progress, the composer locks until it finishes, and a send that fails keeps the message and says why. Each send carries a nonce, so sending again after a failure whose outcome was unclear never makes a second message.
- **Rate limits per person,** sized for someone typing: 20 messages a minute, 300 an hour, 200 MB of uploads an hour, and 60 other writes (reactions, edits, deletions, new rooms) a minute. A refusal says how long to wait. They are settings in `config.json` (`limits.messagesPerMinute`, `messagesPerHour`, `uploadMbPerHour`, `actionsPerMinute`; 0 turns one off) and apply to the API as well, so a script cannot go around them.
- **Notifications** on the desktop and on phones, through the browsers' own Web Push, so no app store is involved and nothing runs beside the server. Each person chooses, on their Account page, between what is addressed to them (direct messages, @mentions, and replies in their threads; the default), everything, or nothing, whether a notification shows the text, and quiet hours in their own time zone, when nothing is sent and nothing is saved up for later. A bell in each room's header mutes that room, and the sidebar marks the rooms muted. A push waits a few seconds and is dropped if the message was read meanwhile on some other screen, and messages inside the wait become one notification. The text is encrypted for the receiving browser, so the push service (Google's, Apple's, Mozilla's, or Microsoft's, whichever the browser uses) sees that a notification was sent and when, but not what it says. On iPhone and iPad this needs iOS 16.4 or later and the workspace added to the Home Screen, which is Apple's condition for any web page; installed there, the workspace also shows the unread total on its icon. Notifications need HTTPS (or a browser on the same machine at localhost).
- **Live delivery** over server-sent events. Every form also works with no script at all; the page script only makes things quieter.
- **Search** across everything you can read, walked from the files when asked.
- **Invite links:** adding someone gives a link that signs them in with one press of a button, the token carried in its fragment so it never reaches a server log.
- **CLI and JSON API** covering the same operations, bearer-token only, with `--json` everywhere and the exit codes scripts want.

## The workspace

A workspace is one directory. No database, no state outside it; backup is `cp -a`, and `dango backup <dir>` pulls the same copy over HTTP where you have no shell.

```
<workspace>/
  workspace.json          users and hashed tokens
  config.json             name, theme, limits
  .secret                 session-cookie signing key
  .vapid                  the key pair notifications are signed with
  channels/
    general/
      channel.json        topic, private flag, members
      messages/1.md ...   one markdown file per message, YAML frontmatter
      threads/4/          replies to message 4, holding its own messages/
      files/4/photo.png   uploads attached to message 4
  dms/
    1/
      conversation.json   participants, and the same layout as a channel
                          (each room also keeps pins.json, its pinned messages)
  users/
    alice/
      read.json           the newest message she has seen in each room
      notify.json         what she wants to be notified of
      push.json           the browsers her notifications go to
```

Every message is a markdown file a person can read, grep, and edit with ordinary tools, the way mochi stores issues. Message numbers are allocated by exclusive create, so concurrent writers cannot collide.

## Relationship to mochiforge

dango imports mochiforge's modules directly from the sibling checkout (`../mochiforge`): the identity store, sessions and CSRF, the escaping-by-type HTML templates, markdown rendering, themes, rate limiting, the CLI framework, the Fly deploy procedure, and the backup protocol and client are the forge's own code, not copies. A small `naming` module in mochiforge lets the shared code spell dango's names, so a workspace mints `dango_` tokens, sets a `dango_session` cookie, and keeps identity in `workspace.json`; the deploy and backup modules take a profile for what differs beyond names (the image, the volume, the backup's exclusions). With the defaults, mochiforge behaves exactly as before.

The trade-off is stated rather than hidden: dango does not build without the sibling checkout present, and its CI and image workflows check out both. What it ships does not share that coupling: the compiler emits the mochiforge modules dango uses into its own `dist`, so the npm package and the container image are self-contained. Pinning to a published mochi package would remove the build-time coupling, at the cost of the two drifting; for two projects developed side by side, the checkout wins.

## Development

```bash
npm install
npm run example    # creates example-root/ with sample users and messages
npm run dev        # serves example-root/ at http://127.0.0.1:3000
npm run test:unit  # the pure modules, in milliseconds
npm run smoke      # end to end, against the compiled output
npm run test:browser  # the page script in headless Chrome (Node 22+, Chrome installed)
```

A release is a version bump pushed to main: `npm run bump` (patch, or `minor`, `major`, or a version) commits the new version, and `.github/workflows/publish.yml` tests it, publishes it to npm through trusted publishing, tags it, and builds its image, which is what `dango deploy fly` deploys.

The example workspace has site admin `dev` with token `dango_example_dev_token_000000` (example workspace only), and users `alice` and `bob` with tokens spelled the same way.

## Limitations and roadmap

- One process serves the workspace. Events are delivered in-process, so a second server on the same directory would render correct pages but not push the other's messages.
- Unread counts cover what arrives in a room, not replies inside its threads; a thread is read from its message. Nothing reaches you by email.
- Signing in takes the token each time on a new browser. Passkeys and GitHub sign-in exist in the shared modules and are the natural next step.
- Whether someone is reading is judged from the page: it must be visible and have been used (a key, a click, a scroll, the pointer moving over it) within the last five minutes, or two when the window lacks the focus. A room left open on an unattended desktop therefore stops counting as read after a few minutes and the phone is notified, while someone who watches a busy room longer than that without touching anything is notified of messages they saw. Notification settings are not yet in the CLI or the JSON API.
- On iPhone and iPad the Home Screen app keeps its own cookies, apart from Safari's, so it has to be signed into separately, with the token; an invite link opens in Safari, not in the app.
- Search walks the files on every query, which is fine well past the point where a workspace is large; an index can come later without changing what is stored.

## License

Apache License 2.0.
