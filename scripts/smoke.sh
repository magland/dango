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

# grep over a pipe, reading all of its input before it answers. A plain
# `producer | grep_all -q` stops reading at the first match, the producer then
# dies writing to a closed pipe, and under pipefail the pipeline fails even
# though the match was found: on a long page, only when the match comes early.
grep_all() { local text; text="$(cat)"; grep "$@" <<< "$text"; }
# The form token on a page, read from all of it: the same trouble as above
# makes `curl | grep -m1` fail whenever curl is still writing when grep stops.
csrf_in() { local page; page="$(cat)"; grep -o 'name="csrf" value="[^"]*"' <<< "$page" | sed -n '1s/.*value="//;1s/"//;1p'; }

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
"${DANGO[@]}" channel list | grep_all -q '#general' || fail "channel list does not show #general"
ok "dango channel create and list"

"${DANGO[@]}" send general "hello from the CLI" >/dev/null
echo "piped from stdin" | "${DANGO[@]}" send general - >/dev/null
"${DANGO[@]}" history general | grep_all -q "hello from the CLI" || fail "history does not show the sent message"
"${DANGO[@]}" history general | grep_all -q "piped from stdin" || fail "send - did not read stdin"
ok "dango send and history, including stdin"

# ---- permissions ----

[ "$(status "$ALICE" GET /channels/secret)" = "404" ] || fail "a non-member could see a private channel"
ok "a private channel is a 404 to a non-member"
api "$ALICE" GET /channels | grep_all -q '"secret"' && fail "a private channel was listed to a non-member"
ok "a private channel is not listed to a non-member"
api "$OWNER" POST /channels/secret/members '{"user":"alice"}' >/dev/null
[ "$(status "$ALICE" GET /channels/secret/messages)" = "200" ] || fail "an added member could not read"
ok "adding a member opens a private channel to them"

# ---- messages: threads, reactions, edits, deletion ----

M="$(api "$ALICE" POST /channels/general/messages '{"body":"anchor for a thread"}' | jget id)"
api "$BOB" POST "/channels/general/threads/$M/messages" '{"body":"a reply"}' >/dev/null
[ "$(api "$BOB" GET "/channels/general/messages/$M" | jget replyCount)" = "1" ] || fail "the reply was not counted on its parent"
ok "a thread reply is counted on its parent"
api "$BOB" POST "/channels/general/messages/$M/reactions" '{"emoji":"👍"}' | grep_all -q '"👍":\["bob"\]' || fail "the reaction was not recorded"
api "$BOB" POST "/channels/general/messages/$M/reactions" '{"emoji":"👍"}' | grep_all -q '"👍"' && fail "a second press did not remove the reaction"
ok "reactions toggle per person"
[ "$(status "$BOB" PATCH "/channels/general/messages/$M" '{"body":"hijacked"}')" = "403" ] || fail "someone other than the author edited a message"
[ -n "$(api "$ALICE" PATCH "/channels/general/messages/$M" '{"body":"anchor, edited"}' | jget edited)" ] || fail "the author could not edit"
ok "only the author edits a message"
api "$OWNER" DELETE "/channels/general/messages/$M" | grep_all -q '"deleted":true' || fail "a site admin could not delete"
[ "$(api "$BOB" GET "/channels/general/threads/$M/messages" | jget messages.0.body)" = "a reply" ] || fail "the thread did not survive its anchor's deletion"
ok "deletion leaves a tombstone, and the thread survives it"

# ---- direct messages and search ----

DANGO_TOKEN="$ALICE" "${DANGO[@]}" dm bob "psst, a direct message" >/dev/null
api "$BOB" GET /dms | grep_all -q '"alice"' || fail "bob does not see the conversation"
[ "$(api "$OWNER" GET /dms | jget dms.length)" = "0" ] || fail "a site admin could see someone else's conversation"
ok "a conversation is its participants' alone"
DANGO_TOKEN="$BOB" "${DANGO[@]}" search "direct message" | grep_all -q "psst" || fail "search did not find the direct message"
api "$OWNER" GET '/search?q=psst' | grep_all -q psst && fail "search showed a site admin someone else's conversation"
ok "search finds what the searcher can read, and nothing else"

# ---- the web interface ----

JAR="$TMP/alice.jar"
[ "$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' -d "token=$ALICE&next=/c/general" "$BASE/login")" = "303" ] || fail "signing in with a token failed"
PAGE="$(curl -s -b "$JAR" "$BASE/c/general")"
echo "$PAGE" | grep_all -q "hello from the CLI" || fail "the channel page does not show messages"
ok "signing in on the web, and a channel page"
CSRF="$(csrf_in <<< "$PAGE")"
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -F "body=no token" "$BASE/c/general/messages")" = "403" ] || fail "a form without its CSRF token was accepted"
ok "a form without its CSRF token is refused"

printf 'attached bytes' > "$TMP/note.txt"
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -F "csrf=$CSRF" -F "body=with a file" -F "files=@$TMP/note.txt" "$BASE/c/general/messages")" = "303" ] || fail "posting a message with a file failed"
FID="$(api "$ALICE" GET '/channels/general/messages?limit=1' | jget messages.0.id)"
HEADERS="$(curl -s -b "$JAR" -D - -o "$TMP/got.txt" "$BASE/c/general/files/$FID/note.txt")"
cmp -s "$TMP/note.txt" "$TMP/got.txt" || fail "the attachment did not come back intact"
echo "$HEADERS" | grep_all -qi '^content-security-policy: sandbox' || fail "an attachment was served without the sandbox policy"
ok "an attachment round-trips, served under a sandbox policy"

# --form-string, since curl -F reads a value beginning with < from a file.
# The code span comes first: a line that begins with <script> is a raw HTML
# block in markdown, which the sanitizer removes whole, code span and all.
curl -s -b "$JAR" -o /dev/null -F "csrf=$CSRF" --form-string 'body=`<script>kept</script>` and <script>alert(1)</script>' "$BASE/c/general/messages" \
  || fail "posting the hostile message failed"
PAGE="$(curl -s -b "$JAR" "$BASE/c/general")"
echo "$PAGE" | grep_all -q '<script>alert' && fail "a message's markup reached the page unescaped"
echo "$PAGE" | grep_all -q '&lt;script&gt;kept' || fail "a code span's text did not reach the page"
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

# ---- unread counts, kept on the server ----

api "$BOB" POST /channels/general/messages '{"body":"news for @alice"}' >/dev/null
UNREAD="$(api "$ALICE" GET /unread)"
echo "$UNREAD" | grep_all -q '"url":"/c/general"' || fail "the API does not report #general unread for alice: $UNREAD"
[ "$(echo "$UNREAD" | jget rooms.0.mentions)" = "1" ] || fail "the mention was not counted: $UNREAD"
api "$BOB" POST /channels/general/read '{}' >/dev/null
api "$BOB" POST /channels/general/messages '{"body":"bob again"}' >/dev/null
api "$BOB" GET /unread | grep_all -q '"url":"/c/general"' && fail "bob's own message counts as unread for bob"
ok "unread counts and mentions, and your own messages do not count"
PAGE="$(curl -s -b "$JAR" "$BASE/")"
echo "$PAGE" | grep_all -q 'data-room="/c/general"' || fail "the home page has no room links"
echo "$PAGE" | grep_all -qE 'class="badge mention"[^>]*>[0-9]+<' || fail "the page shows no mention badge for #general"
ok "the sidebar shows the count, marked for the mention"
curl -s -b "$JAR" -o /dev/null "$BASE/c/general"
[ "$(api "$ALICE" GET /unread | jget rooms.length)" = "0" ] || fail "viewing the room did not mark it read"
[ -f "$WS/users/alice/read.json" ] || fail "the marker is not in users/alice/read.json"
ok "viewing a room marks it read, in a file on the server"
( curl -s -N -b "$JAR" --max-time 4 "$BASE/events" > "$TMP/user-events.txt" || true ) &
STREAM=$!
sleep 1
api "$BOB" POST /channels/general/messages '{"body":"one more"}' >/dev/null
wait "$STREAM"
grep -q '"type":"unread"' "$TMP/user-events.txt" && grep -q '"url":"/c/general"' "$TMP/user-events.txt" || fail "the count change did not reach alice's stream"
grep -q '"count":1' "$TMP/user-events.txt" || fail "the stream carried the wrong count: $(cat "$TMP/user-events.txt")"
ok "a new message pushes the room's count to the reader's other pages"
LAST="$(api "$ALICE" GET '/channels/general/messages?limit=1' | jget messages.0.id)"
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -F "csrf=$CSRF" -F "id=$LAST" "$BASE/c/general/read")" = "204" ] || fail "the read endpoint refused"
[ "$(api "$ALICE" GET /unread | jget rooms.length)" = "0" ] || fail "reporting a message read did not clear the count"
ok "an open page reports what it has seen"
curl -s -b "$JAR" "$BASE/assets/users.json" | grep_all -q '"name":"bob"' || fail "users.json does not list bob"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/assets/users.json")" = "401" ] || fail "users.json answered an anonymous request"
ok "the member list for @-completion, signed-in only"

# ---- invite links ----

INVITE="$("${DANGO[@]}" user add carol --json | jget invite)"
case "$INVITE" in
  "$BASE/invite#token=dango_"*) ;;
  *) fail "user add did not return an invite link with the token in its fragment: $INVITE" ;;
esac
ok "user add returns an invite link, the token in its fragment"
PAGE="$(curl -s -D "$TMP/invite.h" "$BASE/invite")"
echo "$PAGE" | grep_all -q 'data-invite' || fail "the invite page did not render for an anonymous visitor"
grep -qi '^cache-control: no-store' "$TMP/invite.h" || fail "the invite page may be cached"
curl -s -b "$JAR" "$BASE/invite" | grep_all -q 'signed in as <strong>alice</strong>' || fail "the invite page does not warn a signed-in visitor"
ok "the invite page opens for anyone, and warns a signed-in visitor"
CAROL="${INVITE#*#token=}"
[ "$(curl -s -c "$TMP/carol.jar" -o /dev/null -w '%{http_code}' -d "token=$CAROL&next=/" "$BASE/login")" = "303" ] || fail "the invite's token did not sign carol in"
curl -s -b "$TMP/carol.jar" "$BASE/" | grep_all -q 'class="whoami">carol<' || fail "carol is not the one signed in"
ok "the token an invite carries signs its person in"
[ "$(status "$OWNER" POST /users '{"username":"invite"}')" = "400" ] || fail "'invite' was accepted as a username"
ok "'invite' cannot be a username"
ADMIN_JAR="$TMP/owner.jar"
curl -s -c "$ADMIN_JAR" -o /dev/null -d "token=$OWNER&next=/admin" "$BASE/login"
ADMIN_CSRF="$(curl -s -b "$ADMIN_JAR" "$BASE/admin" | csrf_in)"
curl -s -b "$ADMIN_JAR" -d "csrf=$ADMIN_CSRF&username=dave" "$BASE/admin/users/add" | grep_all -q "value=\"$BASE/invite#token=dango_" \
  || fail "the admin page's new-user result has no invite link"
ok "adding someone on the admin page shows their invite link"

# ---- sending, made robust ----

JSON_ACCEPT=(-H 'accept: application/json')
BEFORE="$(api "$ALICE" GET '/channels/general/messages?limit=1' | jget messages.0.id)"
for _ in 1 2; do
  curl -s -b "$JAR" "${JSON_ACCEPT[@]}" -o "$TMP/send.json" -F "csrf=$CSRF" -F "nonce=retrytest0001" -F "body=sent twice, kept once" "$BASE/c/general/messages"
done
AFTER="$(api "$ALICE" GET '/channels/general/messages?limit=1' | jget messages.0.id)"
[ "$AFTER" = "$((BEFORE + 1))" ] || fail "a send retried with its nonce made a second message ($BEFORE -> $AFTER)"
[ "$(jget id < "$TMP/send.json")" = "$AFTER" ] || fail "the retry did not answer with the first message's id"
ok "a send retried with the same nonce makes one message"
CODE="$(curl -s -b "$JAR" "${JSON_ACCEPT[@]}" -o "$TMP/err.json" -w '%{http_code}' -F "csrf=$CSRF" -F "body=   " "$BASE/c/general/messages")"
[ "$CODE" = "400" ] && [ -n "$(jget error < "$TMP/err.json")" ] || fail "an empty send did not come back as a JSON refusal ($CODE)"
[ "$(curl -s "${JSON_ACCEPT[@]}" -o /dev/null -w '%{http_code}' -F "body=x" "$BASE/c/general/messages")" = "401" ] || fail "a signed-out send did not answer 401 JSON"
ok "the composer's refusals come back as JSON it can show"
head -c $((21 * 1024 * 1024)) /dev/zero > "$TMP/big.bin"
CODE="$(curl -s -b "$JAR" "${JSON_ACCEPT[@]}" -o "$TMP/big.json" -w '%{http_code}' -F "csrf=$CSRF" -F "body=too big" -F "files=@$TMP/big.bin" "$BASE/c/general/messages")"
[ "$CODE" = "413" ] || fail "a 21 MB attachment was not refused ($CODE)"
jget error < "$TMP/big.json" | grep_all -q '20 MB' || fail "the refusal does not name the limit: $(cat "$TMP/big.json")"
ok "attachments over 20 MB are refused, naming the limit"
rm -f "$TMP/big.bin"
PAGE="$(curl -s -b "$JAR" "$BASE/c/general")"
echo "$PAGE" | grep_all -q 'class="file-size">14 B<' || fail "an attachment's size is not shown"
echo "$PAGE" | grep_all -q 'data-max-bytes="20971520"' || fail "the composer does not know the 20 MB cap"
ok "attachments show their size, and the composer knows the cap"

EVE="$("${DANGO[@]}" user add eve --json | jget token)"
REFUSED=""
for i in $(seq 1 25); do
  CODE="$(curl -s -D "$TMP/flood.h" -o "$TMP/flood.json" -w '%{http_code}' -X POST -H "authorization: Bearer $EVE" -H 'content-type: application/json' -d "{\"body\":\"flood $i\"}" "$BASE/api/channels/general/messages")"
  if [ "$CODE" = "429" ]; then REFUSED="$i"; break; fi
done
[ "$REFUSED" = "21" ] || fail "the per-minute message limit did not refuse the 21st message (refused at: ${REFUSED:-never})"
grep -qi '^retry-after: [0-9]' "$TMP/flood.h" || fail "a rate-limited send has no Retry-After"
jget error < "$TMP/flood.json" | grep_all -qE 'Wait [0-9]+ seconds' || fail "the refusal does not say how long to wait: $(cat "$TMP/flood.json")"
ok "one person sending faster than 20 a minute is refused, with how long to wait"

# From here on the checks send as carol: alice has sent more than twenty
# messages in the last minute, and the limit just tested would refuse her.
CJAR="$TMP/carol.jar"
CCSRF="$(curl -s -b "$CJAR" "$BASE/c/general" | csrf_in)"
DEL="$(api "$CAROL" POST /channels/general/messages '{"body":"about to go"}' | jget id)"
[ -n "$DEL" ] || fail "carol could not send a message to delete"
PAGE="$(curl -s -b "$CJAR" "$BASE/c/general/m/$DEL/delete")"
echo "$PAGE" | grep_all -q 'Delete this message?' || fail "the delete confirmation page did not render"
curl -s -b "$CJAR" "$BASE/c/general" | grep_all -q "href=\"/c/general/m/$DEL/delete\" data-delete-message" || fail "the trash button does not lead to the confirmation"
[ "$(curl -s -b "$CJAR" -o /dev/null -w '%{http_code}' -d "csrf=$CCSRF" "$BASE/c/general/m/$DEL/delete")" = "303" ] || fail "confirming did not delete"
[ "$(api "$CAROL" GET "/channels/general/messages/$DEL" | jget deleted)" = "true" ] || fail "the message was not deleted"
ok "deleting asks first, on a page of its own without script"

# ---- pins, and links out ----

PINME="$(api "$CAROL" POST /channels/general/messages '{"body":"pin this, see https://example.com"}' | jget id)"
[ "$(curl -s -b "$CJAR" -o /dev/null -w '%{http_code}' -d "csrf=$CCSRF" "$BASE/c/general/m/$PINME/pin")" = "303" ] || fail "pinning from the web failed"
PAGE="$(curl -s -b "$CJAR" "$BASE/c/general")"
echo "$PAGE" | grep_all -q 'Pinned by carol' || fail "a pinned message is not marked"
echo "$PAGE" | grep_all -q 'data-pin-count>1<' || fail "the header does not count the pin"
curl -s -b "$CJAR" "$BASE/c/general/pins" | grep_all -q 'pin this' || fail "the pinned page does not list the message"
[ "$(api "$BOB" GET /channels/general/pins | jget pins.0.by)" = "carol" ] || fail "the API does not list the pin"
ok "pinning marks the message, counts it in the header, and lists it"
api "$BOB" DELETE "/channels/general/pins/$PINME" >/dev/null
[ "$(api "$BOB" GET /channels/general/pins | jget pins.length)" = "0" ] || fail "unpinning did not remove the pin"
api "$CAROL" PUT "/channels/general/pins/$PINME" >/dev/null
api "$CAROL" DELETE "/channels/general/messages/$PINME" >/dev/null
[ "$(api "$BOB" GET /channels/general/pins | jget pins.length)" = "0" ] || fail "deleting a pinned message left its pin"
ok "anyone in the room can unpin, and deleting a message unpins it"
echo "$PAGE" | grep_all -q 'href="https://example.com" rel="nofollow noopener noreferrer" target="_blank"' || fail "a link out of the workspace does not open in a new tab"
echo "$PAGE" | grep_all -qE 'href="/c/general/files/[0-9]+/note.txt" target="_blank"' || fail "an attachment does not open in a new tab"
ok "links out of the workspace, and attachments, open in a new tab"

# ---- the account menu and inline media ----

PAGE="$(curl -s -b "$JAR" "$BASE/")"
echo "$PAGE" | grep_all -q 'class="side-user"' || fail "the account menu is not the viewer's own name"
echo "$PAGE" | grep_all -q 'dropdown-menu dd-up' || fail "the account menu does not open upward"
ok "the account menu opens upward from the viewer's name"
printf 'RIFF\0\0\0\0WAVEfmt ' > "$TMP/clip.wav"
curl -s -b "$CJAR" -o /dev/null -F "csrf=$CCSRF" -F "body=a clip" -F "files=@$TMP/clip.wav" "$BASE/c/general/messages"
PAGE="$(curl -s -b "$CJAR" "$BASE/c/general")"
echo "$PAGE" | grep_all -q '<audio controls' || fail "a .wav attachment has no player"
CLIP="$(api "$CAROL" GET '/channels/general/messages?limit=1' | jget messages.0.id)"
curl -s -b "$CJAR" -D - -o /dev/null "$BASE/c/general/files/$CLIP/clip.wav" | grep_all -qi '^content-disposition: attachment' && fail "a .wav is served as a download, which a player cannot use"
curl -s -b "$CJAR" -D - -o /dev/null -H 'range: bytes=0-3' "$BASE/c/general/files/$CLIP/clip.wav" | grep_all -q '^HTTP/1.1 206' || fail "a range request on a .wav was not answered, so a player cannot seek"
ok "a .wav plays in place, and can be seeked"

# ---- backup ----

BK="$TMP/backup"
"${DANGO[@]}" backup "$BK" --snapshot --quiet || fail "the backup failed"
[ -f "$BK/current/workspace.json" ] || fail "the backup has no workspace.json"
[ -f "$BK/current/users/alice/read.json" ] || fail "the backup left out users/ (read markers)"
ok "dango backup copies the workspace, read markers included"
AGAIN="$("${DANGO[@]}" backup "$BK" --json)"
[ "$(echo "$AGAIN" | jget files.fetched)" = "0" ] || fail "an unchanged workspace was fetched again: $AGAIN"
ok "a second backup fetches nothing"
"${DANGO[@]}" backup verify "$BK" --quiet || fail "backup verify found problems"
ok "dango backup verify"
DANGO_TOKEN="$ALICE" "${DANGO[@]}" backup "$TMP/alice-backup" --quiet 2>/dev/null && fail "a non-admin made a backup"
ok "a backup needs a site admin"
"${DANGO[@]}" backup "$TMP/nofiles" --no-files --quiet
find "$TMP/nofiles/current" -name note.txt | grep_all -q . && fail "--no-files copied an attachment"
ok "--no-files leaves attachments out"

"${DANGO[@]}" serve "$BK/current" --port "$RESTORE_PORT" > "$TMP/restore.log" 2>&1 &
RESTORE_PID=$!
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$RESTORE_PORT/login" 2>/dev/null && break
  sleep 0.2
done
curl -s -H "authorization: Bearer $ALICE" "http://127.0.0.1:$RESTORE_PORT/api/channels/general/messages" | grep_all -q "hello from the CLI" \
  || fail "the backup does not serve as a workspace with its tokens"
ok "a backup serves as a workspace, tokens and all"

echo ""
echo "All $CHECKS smoke checks passed."
