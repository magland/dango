#!/usr/bin/env bash
# End-to-end smoke test: builds dango, starts the compiled server on a fresh
# workspace, and exercises the web interface, the JSON API, the CLI, live
# delivery, attachments, and backup, the way a person and a script would.
# Run from the repository root: bash scripts/smoke.sh
#
# It drives dist rather than src, because dist is what the npm package and the
# image ship: a module the compiled output needs and cannot find fails here.
set -euo pipefail

cd "$(dirname "$0")/.."

# Two servers over the suite's life, on PORT and the port above it, chosen
# below the kernel's ephemeral range for mochi's reason: a listening port
# picked from inside it can be taken as the source port of one of the suite's
# own outgoing connections between being chosen and being bound.
pick_ports() {
  node -e '
    const net = require("net");
    const fs = require("fs");
    let low = 32768;
    try {
      const parsed = parseInt(fs.readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").split(/\s+/)[0], 10);
      if (parsed > 0) low = parsed;
    } catch {}
    const min = 20000, max = Math.max(min + 1000, low - 2);
    const free = (port) => new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const base = min + Math.floor(Math.random() * (max - min));
        if ((await free(base)) && (await free(base + 1))) { console.log(base); return; }
      }
      process.exit(1);
    })();
  '
}
PORT="${SMOKE_PORT:-$(pick_ports)}"
[ -n "$PORT" ] || { echo "FAIL: no free ports to run the servers on"; exit 1; }
BASE="http://127.0.0.1:$PORT"
RESTORE_PORT=$((PORT + 1))

TMP="$(mktemp -d)"
WS="$TMP/workspace"
mkdir -p "$WS"
SERVER_PID=""
RESTORE_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$RESTORE_PID" ] && kill "$RESTORE_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

CHECKS=0
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $1"; }
fail() {
  echo "FAIL: $1"
  [ -f "$TMP/server.log" ] && { echo "--- server log"; tail -30 "$TMP/server.log"; }
  exit 1
}
# The value at a dotted path in a JSON document on stdin, or empty.
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(0)};for(const k of process.argv[1].split(".").filter(Boolean))v=v==null?v:v[k];if(v!==undefined&&v!==null)console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }

echo "Building"
npm run build >/dev/null
DANGO=(node dist/dango/src/index.js)

# The CLI talks to this server alone, and remembers nothing outside TMP: no
# login, no credential store, no backups index in the real home directory.
export XDG_CONFIG_HOME="$TMP/config"
export DANGO_HOST="$BASE"
unset DANGO_TOKEN

# ---- a fresh workspace, with the owner token handed in ----

OWNER="dango_$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
DANGO_OWNER_TOKEN="$OWNER" DANGO_TRUST_PROXY=1 "${DANGO[@]}" serve "$WS" --port "$PORT" > "$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "$BASE/login" 2>/dev/null && break
  sleep 0.2
done
curl -fsS -o /dev/null "$BASE/login" || fail "the server did not start"
ok "the compiled server starts on a fresh workspace"

[ -f "$WS/workspace.json" ] && ok "the workspace was initialized (workspace.json)" || fail "no workspace.json"
grep -q "$OWNER" "$TMP/server.log" && fail "the server echoed the supplied owner token into its log"
ok "a supplied owner token is not logged"
[ "$(jget network.trustProxy < "$WS/config.json")" = "true" ] || fail "DANGO_TRUST_PROXY did not seed config.json"
ok "DANGO_TRUST_PROXY seeds network.trustProxy"

api() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$body" "$BASE/api$path"
  else
    curl -sS -X "$method" -H "authorization: Bearer $token" "$BASE/api$path"
  fi
}
status() {
  local token="$1" method="$2" path="$3" body="${4:-}"
  curl -sS -o /dev/null -w '%{http_code}' -X "$method" -H "authorization: Bearer $token" \
    ${body:+-H 'content-type: application/json' -d "$body"} "$BASE/api$path"
}

[ "$(api "$OWNER" GET /whoami | jget username)" = "owner" ] || fail "the owner token was not adopted"
ok "the supplied owner token is the owner's"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" = "303" ] || fail "an anonymous visitor was not sent to sign in"
ok "anonymous requests are sent to /login"
[ "$(status bogus GET /whoami)" = "401" ] || fail "a bad token was not refused"
ok "a bad token is refused"

# ---- users and channels through the CLI ----

export DANGO_TOKEN="$OWNER"
ALICE="$("${DANGO[@]}" user add alice --json | jget token)"
BOB="$("${DANGO[@]}" user add bob --json | jget token)"
[ -n "$ALICE" ] && [ -n "$BOB" ] || fail "user add did not return tokens"
ok "dango user add mints a token per user"
"${DANGO[@]}" user add admin >/dev/null 2>&1 && fail "a routed name was accepted as a username"
ok "a username that a route answers to is refused"

"${DANGO[@]}" channel create general --topic "Everything" >/dev/null
"${DANGO[@]}" channel create secret --private >/dev/null
"${DANGO[@]}" channel list | grep -q '#general' || fail "channel list does not show #general"
ok "dango channel create and list"

"${DANGO[@]}" send general "hello from the CLI" >/dev/null
echo "piped from stdin" | "${DANGO[@]}" send general - >/dev/null
"${DANGO[@]}" history general | grep -q "hello from the CLI" || fail "history does not show the sent message"
"${DANGO[@]}" history general | grep -q "piped from stdin" || fail "send - did not read stdin"
ok "dango send and history, including stdin"

# ---- permissions ----

[ "$(status "$ALICE" GET /channels/secret)" = "404" ] || fail "a non-member could see a private channel"
ok "a private channel is a 404 to a non-member"
api "$ALICE" GET /channels | grep -q '"secret"' && fail "a private channel was listed to a non-member"
ok "a private channel is not listed to a non-member"
api "$OWNER" POST /channels/secret/members '{"user":"alice"}' >/dev/null
[ "$(status "$ALICE" GET /channels/secret/messages)" = "200" ] || fail "an added member could not read"
ok "adding a member opens a private channel to them"

# ---- messages: threads, reactions, edits, deletion ----

M="$(api "$ALICE" POST /channels/general/messages '{"body":"anchor for a thread"}' | jget id)"
api "$BOB" POST "/channels/general/threads/$M/messages" '{"body":"a reply"}' >/dev/null
[ "$(api "$BOB" GET "/channels/general/messages/$M" | jget replyCount)" = "1" ] || fail "the reply was not counted on its parent"
ok "a thread reply is counted on its parent"
api "$BOB" POST "/channels/general/messages/$M/reactions" '{"emoji":"👍"}' | grep -q '"👍":\["bob"\]' || fail "the reaction was not recorded"
api "$BOB" POST "/channels/general/messages/$M/reactions" '{"emoji":"👍"}' | grep -q '"👍"' && fail "a second press did not remove the reaction"
ok "reactions toggle per person"
[ "$(status "$BOB" PATCH "/channels/general/messages/$M" '{"body":"hijacked"}')" = "403" ] || fail "someone other than the author edited a message"
[ -n "$(api "$ALICE" PATCH "/channels/general/messages/$M" '{"body":"anchor, edited"}' | jget edited)" ] || fail "the author could not edit"
ok "only the author edits a message"
api "$OWNER" DELETE "/channels/general/messages/$M" | grep -q '"deleted":true' || fail "a site admin could not delete"
[ "$(api "$BOB" GET "/channels/general/threads/$M/messages" | jget messages.0.body)" = "a reply" ] || fail "the thread did not survive its anchor's deletion"
ok "deletion leaves a tombstone, and the thread survives it"

# ---- direct messages and search ----

DANGO_TOKEN="$ALICE" "${DANGO[@]}" dm bob "psst, a direct message" >/dev/null
api "$BOB" GET /dms | grep -q '"alice"' || fail "bob does not see the conversation"
[ "$(api "$OWNER" GET /dms | jget dms.length)" = "0" ] || fail "a site admin could see someone else's conversation"
ok "a conversation is its participants' alone"
DANGO_TOKEN="$BOB" "${DANGO[@]}" search "direct message" | grep -q "psst" || fail "search did not find the direct message"
api "$OWNER" GET '/search?q=psst' | grep -q psst && fail "search showed a site admin someone else's conversation"
ok "search finds what the searcher can read, and nothing else"

# ---- the web interface ----

JAR="$TMP/alice.jar"
[ "$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' -d "token=$ALICE&next=/c/general" "$BASE/login")" = "303" ] || fail "signing in with a token failed"
PAGE="$(curl -s -b "$JAR" "$BASE/c/general")"
echo "$PAGE" | grep -q "hello from the CLI" || fail "the channel page does not show messages"
ok "signing in on the web, and a channel page"
CSRF="$(echo "$PAGE" | grep -o 'name="csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')"
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -F "body=no token" "$BASE/c/general/messages")" = "403" ] || fail "a form without its CSRF token was accepted"
ok "a form without its CSRF token is refused"

printf 'attached bytes' > "$TMP/note.txt"
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -F "csrf=$CSRF" -F "body=with a file" -F "files=@$TMP/note.txt" "$BASE/c/general/messages")" = "303" ] || fail "posting a message with a file failed"
FID="$(api "$ALICE" GET '/channels/general/messages?limit=1' | jget messages.0.id)"
HEADERS="$(curl -s -b "$JAR" -D - -o "$TMP/got.txt" "$BASE/c/general/files/$FID/note.txt")"
cmp -s "$TMP/note.txt" "$TMP/got.txt" || fail "the attachment did not come back intact"
echo "$HEADERS" | grep -qi '^content-security-policy: sandbox' || fail "an attachment was served without the sandbox policy"
ok "an attachment round-trips, served under a sandbox policy"

# --form-string, since curl -F reads a value beginning with < from a file.
# The code span comes first: a line that begins with <script> is a raw HTML
# block in markdown, which the sanitizer removes whole, code span and all.
curl -s -b "$JAR" -o /dev/null -F "csrf=$CSRF" --form-string 'body=`<script>kept</script>` and <script>alert(1)</script>' "$BASE/c/general/messages" \
  || fail "posting the hostile message failed"
PAGE="$(curl -s -b "$JAR" "$BASE/c/general")"
echo "$PAGE" | grep -q '<script>alert' && fail "a message's markup reached the page unescaped"
echo "$PAGE" | grep -q '&lt;script&gt;kept' || fail "a code span's text did not reach the page"
ok "a hostile message renders inert"

# ---- live delivery ----

# With gzip offered, as every browser offers it: a compressed event stream is
# a buffered one, and a buffered one delivers nothing.
LAST="$(api "$ALICE" GET '/channels/general/messages?limit=1' | jget messages.0.id)"
( curl -s -N -b "$JAR" -H 'accept-encoding: gzip' --max-time 4 "$BASE/c/general/events?after=$LAST" > "$TMP/events.txt" || true ) &
STREAM=$!
sleep 1
api "$BOB" POST /channels/general/messages '{"body":"delivered live"}' >/dev/null
wait "$STREAM"
grep -q "delivered live" "$TMP/events.txt" || fail "a new message was not pushed to an open event stream"
ok "a new message reaches an open event stream, with gzip offered"
( curl -s -N -b "$JAR" --max-time 2 "$BASE/c/general/events?after=0" > "$TMP/catchup.txt" || true )
grep -q "hello from the CLI" "$TMP/catchup.txt" || fail "a stream opened late did not catch up"
ok "a stream catches up from ?after="

# ---- backup ----

BK="$TMP/backup"
"${DANGO[@]}" backup "$BK" --snapshot --quiet || fail "the backup failed"
[ -f "$BK/current/workspace.json" ] || fail "the backup has no workspace.json"
ok "dango backup copies the workspace"
AGAIN="$("${DANGO[@]}" backup "$BK" --json)"
[ "$(echo "$AGAIN" | jget files.fetched)" = "0" ] || fail "an unchanged workspace was fetched again: $AGAIN"
ok "a second backup fetches nothing"
"${DANGO[@]}" backup verify "$BK" --quiet || fail "backup verify found problems"
ok "dango backup verify"
DANGO_TOKEN="$ALICE" "${DANGO[@]}" backup "$TMP/alice-backup" --quiet 2>/dev/null && fail "a non-admin made a backup"
ok "a backup needs a site admin"
"${DANGO[@]}" backup "$TMP/nofiles" --no-files --quiet
find "$TMP/nofiles/current" -name note.txt | grep -q . && fail "--no-files copied an attachment"
ok "--no-files leaves attachments out"

"${DANGO[@]}" serve "$BK/current" --port "$RESTORE_PORT" > "$TMP/restore.log" 2>&1 &
RESTORE_PID=$!
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$RESTORE_PORT/login" 2>/dev/null && break
  sleep 0.2
done
curl -s -H "authorization: Bearer $ALICE" "http://127.0.0.1:$RESTORE_PORT/api/channels/general/messages" | grep -q "hello from the CLI" \
  || fail "the backup does not serve as a workspace with its tokens"
ok "a backup serves as a workspace, tokens and all"

echo ""
echo "All $CHECKS smoke checks passed."
