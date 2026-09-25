# Backing up a workspace

A workspace is a directory, and on a machine you have a shell on, backing it up is `cp -a`. That is not true of a workspace on a Fly volume, where there is no shell in the ordinary sense and no rsync at the far end. `dango backup` is the answer for that case, and works identically against a VPS, a Docker deployment, and `127.0.0.1:3000`:

```bash
dango backup ~/backups/chat --snapshot
```

This is mochi's backup client and mochi's protocol, unchanged apart from the options. Mochiforge's [Backing up a vault](../../mochiforge/docs/backup.md) is the full account; what follows is what is particular to a workspace.

## A backup is a workspace

```
~/backups/chat/
  current/      a servable workspace
  snapshots/    hardlinked copies, each one also a servable workspace
  backup.json   which workspace, what is left out, and how each run went
```

Restoring is serving the copy, which is also how to look at one:

```bash
dango serve ~/backups/chat/current --port 3001
```

The copy includes `workspace.json`, so everyone's tokens work against it exactly as they did against the original. To stand a hosted workspace back up, copy `current/` onto the new volume or machine and start the server on it.

## How it works

The server offers two routes, both for site admins only: a manifest listing every file in the workspace with its size and modification time, and a bulk fetch of named files. The client compares the manifest against what it already holds and fetches only what differs, so after the first run a nightly backup moves that day's messages and uploads and little else. A workspace has no git repositories, so unlike a vault backup there are no mirrors; every part of it is an ordinary file.

What the manifest covers: `workspace.json`, `config.json`, and `.secret` at the root, every file under `channels/` and `dms/`, which is every message, thread, conversation, and upload, and `users/`, which holds what each person has read.

## Options

`--snapshot` takes a hardlinked snapshot after a successful sync and prunes old ones under the retention policy (`--keep-daily`, `--keep-weekly`, `--keep-monthly`; 7, 4, and 6 by default). A snapshot costs inodes rather than bytes, since nothing in the backup is ever modified in place.

`--no-files` leaves out uploaded attachments, which are usually most of a workspace's bytes, and backs up the conversation alone. `--no-secrets` leaves out `workspace.json`, `.secret`, and `.vapid` (the key pair notifications are signed with); a backup made that way is not directly servable, since it has no users, and a workspace restored from it makes new push keys, so everyone turns notifications on again, but it is safe to keep somewhere less trusted. Exclusions are remembered in `backup.json`, so a cron entry is the command and the directory.

`dango backup verify <dir>` asks the workspace for hashes of every file and reports anything missing, extra, or different. `dango backup list <dir>` shows the snapshots and how the last run went, and `dango backup prune <dir>` applies the retention policy without syncing.

## What a backup does not promise

There is no point-in-time image. The server holds no lock a client could take, so a run is a walk of a live workspace and can catch a mixed vintage: a thread reply whose parent message arrived in the previous run, say, or a reaction on one message and not yet on another. Every individual file in a backup is one that really existed, and the next run brings the rest.

An empty directory is not copied, only files. A channel created with no messages yet comes back without its empty `messages/` directory, which the server recreates when the first message is sent.
