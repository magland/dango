# Deploying a workspace

A remote workspace is the same server with a persistent disk and TLS in front; there is nothing else to it, since the workspace directory is the entire state. On first start the server initializes the workspace and adopts or prints the owner token, and from then on all administration happens from your own machine, on the web or through the CLI after `dango login`.

The procedure is mochi's, and so is most of the code that carries it out: `dango deploy fly` is mochiforge's deploy command given a workspace's profile, and `dango backup` is mochi's backup client. This document is organized the same way as mochiforge's [Deploying a vault](../../mochiforge/docs/deploying.md), which remains the fuller account of the reasoning. First, `dango deploy fly` puts a workspace on the internet in one command. Next, [a domain of your own](#a-domain-of-your-own) is the step to take once the workspace is something you mean to keep. Finally, [a machine of your own](#a-machine-of-your-own) is the same container hosted yourself.

## Fly.io, in one command

Install [flyctl](https://fly.io/docs/flyctl/install/), run `fly auth login` once, then:

```bash
dango deploy fly my-workspace-name
```

Fly app names are globally unique and the name becomes the URL, so pick your own. That creates the app, a 10GB volume named `workspace`, and a single machine serving the workspace over HTTPS at `https://my-workspace-name.fly.dev`, and ends by printing the owner token:

```
==> Creating 'my-workspace-name' in ewr
==> Creating a 10GB volume 'workspace' in ewr
==> Setting the one-time owner token as a Fly secret
==> Deploying ghcr.io/magland/dango:0.1.0
==> Waiting for the workspace to answer

==> Ready: https://my-workspace-name.fly.dev

The workspace is initialized, and 'owner' owns it. This is its token, shown
here once and nowhere else: ...

  dango_7acfa9fa32691cdbb53c3865fed61e59f61ab4eb948b4157d7e7fafc163fcb08
```

That token is the way in, and it is the one thing to save before the terminal scrolls away. In the browser, paste it on the `/login` page; the Admin page then adds people, each with a token of their own to hand over. To work from the CLI instead, store it once:

```bash
dango login https://my-workspace-name.fly.dev
dango user add alice
dango channel create general
```

The token is minted on your machine, not on the server. The deploy sets it as the `DANGO_OWNER_TOKEN` secret, and the server adopts it when it initializes the empty workspace, storing only its hash. It cannot be recovered afterwards from either the server or the Fly secret, which can be written but never read back. The deploy also stores nothing on your machine: `dango login` is the one command that writes a credential.

Fly always terminates TLS in front of the app, so the deploy also sets `DANGO_TRUST_PROXY`, and the server records `network.trustProxy: true` in the workspace's `config.json` on the next start. That is what makes `Secure` cookies and the per-address limits read the real scheme and address. It is only seeded, so changing it by hand afterwards sticks.

### The published image, and deploying your own build

By default the image deployed is `ghcr.io/magland/dango:<version>`, matching the version of the CLI you ran. Each release's image is built by `.github/workflows/image.yml` after the release is published to npm, so for some minutes after a release the newest CLI names an image that is not there yet; the deploy says so and stops before creating anything, and trying again shortly is the fix.

`--from-source` builds the image from your checkouts instead, which is how to try a change against a real workspace before it is released:

```bash
# mochiforge and dango side by side, as on a development machine
dango deploy fly my-workspace-name --from-source
dango deploy fly my-workspace-name --from-source --local-build   # this machine's Docker
```

Dango compiles mochiforge's sources in with its own, so a build needs both checkouts. Rather than hand Fly the parent directory, which may hold a great deal else, the deploy copies the two source trees, the manifests, and the `Dockerfile` into a temporary directory (a few hundred kilobytes), builds from there, and removes it afterwards. A dirty working tree in either checkout is deployed as it stands, uncommitted changes included. After a source build, `deploy fly show` reports an image like `registry.fly.io/my-workspace-name:deployment-...` rather than a version tag.

### Deploying updates, and changing settings

The same command deploys an update. Fly already knows the region, the volume size, and the machine's shape, so each run reads them back from the live app and applies only what a flag changes:

```bash
dango deploy fly my-workspace-name                     # a new version, nothing else
dango deploy fly my-workspace-name --volume 50         # grow the disk
dango deploy fly my-workspace-name --vm-memory 1gb     # a bigger machine
dango deploy fly my-workspace-name --image ghcr.io/magland/dango:main
```

The flags, all optional: `--region` (default `ewr`), `--volume <gb>` (default 10), `--vm-size` (default `shared-cpu-1x`), `--vm-memory` (default `512mb`), `--org`, and `--image <ref>` or `--from-source`. Fly volumes can grow but never shrink, and a volume cannot move between regions, so a smaller `--volume` and a different `--region` are both refused rather than quietly ignored.

Every update is a restart, and a restart drops the open event streams. Pages reconnect by themselves and are sent every message that arrived in the meantime, so people see a pause of a few seconds rather than lost messages. An edit or a reaction made during the gap is the exception: it shows on the next reload rather than live. A quiet hour is still the time to deploy. [Updating on a schedule](../../mochiforge/docs/deploying.md#updating-on-a-schedule) in mochi's document applies unchanged, with `npx --yes @magland/dango@latest deploy fly my-workspace-name` as the command.

To see what is deployed, and whether it answers:

```bash
dango deploy fly show my-workspace-name
```

```
my-workspace-name  https://my-workspace-name.fly.dev

  machine   1857701b4de389  started  ewr  shared-cpu-1x, 512mb
  image     ghcr.io/magland/dango:0.1.0
  volume    10GB in ewr (created)
  workspace answering, and you are 'owner' on it
  backup    /home/me/backups/chat (last run 2026-09-25)
```

`dango deploy fly destroy my-workspace-name` removes the app, the volume, and with them the workspace, after you type the app name (`--yes` skips the prompt). Anything else is flyctl's job: `fly logs -a my-workspace-name`, and `fly ssh console -a my-workspace-name` for a shell on the volume.

### What differs from a vault's deployment

The generated `fly.toml` is mochi's with three changes. The volume is named `workspace` and mounts at `/workspace`. Fly's proxy counts load in connections rather than requests, with a soft limit of 800 and a hard limit of 1000, because every open room holds one event stream for as long as it is open: counted as requests, a quiet workspace with a hundred people in it would look like a machine under load. And there is no `--lfs-bucket`, since a workspace keeps everything on its volume.

The one-machine rule matters more here than for a vault. Live delivery is in process: a message sent to one machine is pushed to the pages connected to that machine. A second machine would be a second volume and a second workspace in any case, but even a shared disk would leave people on two machines not seeing each other's messages until they reloaded. A busier workspace wants a bigger machine, not more of them.

The machine stops when idle and starts on the next request, as a vault's does. An open page counts as traffic while its stream is connected, so the machine stays up while anyone has the workspace open and stops once everyone has closed it. The first page after a quiet spell takes a few seconds to arrive.

## A domain of your own

The workspace's own hostname is three flyctl commands, exactly as for a vault:

```bash
fly certs add chat.example.org -a my-workspace-name
fly certs setup chat.example.org -a my-workspace-name    # prints the DNS records to create
fly certs check chat.example.org -a my-workspace-name
```

Nothing in the workspace has to be told its name: redirects and cookies are built from the host of the request, so `.fly.dev` keeps working while people move over. Log in again under the new name with `dango login https://chat.example.org`. A workspace has no static sites, so the wildcard half of mochi's section does not apply.

## A machine of your own

The container needs both checkouts to build, since it compiles mochiforge's sources in. With mochiforge beside this directory:

```bash
docker build -f Dockerfile -t dango ..
docker run -d --name dango -p 3000:3000 -v ./workspace:/workspace dango
docker logs dango    # copy the one-time owner token
```

`Dockerfile.dockerignore` limits the context to the two source trees and the manifests, whatever else the parent directory holds; BuildKit, the default builder in current Docker, reads it because it sits beside the Dockerfile. The image runs no git and needs none.

This serves plain HTTP, which is fine on a private network but not on the open internet, since session cookies are only marked `Secure` behind HTTPS. With a domain name pointed at the machine, the included `docker-compose.yml` adds Caddy for automatic HTTPS:

```bash
DOMAIN=chat.example.org docker compose up -d
docker compose logs dango            # the owner token
dango login https://chat.example.org
```

Unlike mochi's compose file, this one sets `DANGO_TRUST_PROXY=1`, since the server's port is not published and Caddy is the only way in. Caddy passes the event streams through unbuffered with no configuration. Behind any other proxy, make sure it does not buffer `text/event-stream` responses; nginx needs no change, because the server sends `X-Accel-Buffering: no`.

On a host with Node and no Docker, the published package needs no checkout:

```bash
npm install -g @magland/dango
dango serve /srv/chat --host 0.0.0.0 --port 3000
```

The package carries the compiled mochiforge modules inside it, so it has no dependency on mochiforge being installed.

## Backing up

A workspace on a machine you have a shell on is backed up by copying its directory. On a Fly volume there is no shell in the ordinary sense, so `dango backup <dir>` pulls the copy over HTTP instead, incrementally: see [Backing up a workspace](backup.md).
