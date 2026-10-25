#!/bin/bash
# End-to-end web_fetch scenario in a real terminal, driven by tuistory and the
# scripted model, against a local server (the SSRF guard's loopback test hook
# is on; every other private range stays blocked). Covers: a URL from the user
# running without a dialog in auto mode, an agent-written URL going to the
# user when no reviewer is available, paging, a cross-host redirect returned
# instead of followed, the guard refusing cloud metadata, an exfiltration ask,
# manual mode's per-domain grant, and web_search staying unregistered without
# an OpenAI login. Prints PASS/FAIL per step.
#
#   tests/e2e/web.sh            (from anywhere; screenshots go to dist/shots)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4web-e2e.XXXX); P=$W/proj; S=$R/dist/shots; T="npx --prefix $R tuistory -s web-e2e"
mkdir -p $S $P $W/home

# The local site: an article, a long markdown file, a redirect to another host name.
cat > $W/server.mjs <<'JS'
import http from "node:http";
import { writeFileSync } from "node:fs";
const long = Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(4, "0")} of the long document.\n`).join("");
const article = `<!doctype html><html><head><title>Widget docs</title></head><body><nav>Home</nav><article><h1>Configuring widgets</h1><p>${"Widgets read their settings from widget.json next to the project root. ".repeat(6)}</p><p>The magic word is PAPAYA.</p></article></body></html>`;
const server = http.createServer((req, res) => {
  const port = server.address().port;
  req.url = req.url.split("?")[0];
  if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(article); }
  if (req.url === "/long.md") { res.writeHead(200, { "content-type": "text/markdown" }); return res.end(long); }
  if (req.url === "/go") { res.writeHead(302, { location: `http://localhost:${port}/page` }); return res.end(); }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("no");
});
server.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(server.address().port)));
JS
node $W/server.mjs $W/port & SERVER=$!
for _ in $(seq 50); do [ -s $W/port ] && break; sleep 0.1; done
PORT=$(cat $W/port); B="http://127.0.0.1:$PORT"
cleanup() { kill $SERVER 2>/dev/null; $T close >/dev/null 2>&1; }
trap cleanup EXIT

cat > $W/script.json <<JSON
{
  "read $B/page please": [{ "tool": "web_fetch", "args": { "url": "$B/page" } }],
  "read the second half of $B/long.md": [{ "tool": "web_fetch", "args": { "url": "$B/long.md", "offset": 29984 } }],
  "fetch something": [{ "tool": "web_fetch", "args": { "url": "$B/long.md?from=agent" } }],
  "follow $B/go": [{ "tool": "web_fetch", "args": { "url": "$B/go" } }],
  "check http://169.254.169.254/latest/meta-data/": [{ "tool": "web_fetch", "args": { "url": "http://169.254.169.254/latest/meta-data/" } }],
  "open $B/page?t=ghp_abcdefghijklmnopqrstuvwxyz0123456789": [{ "tool": "web_fetch", "args": { "url": "$B/page?t=ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }],
  "manual $B/page please": [{ "tool": "web_fetch", "args": { "url": "$B/page" } }],
  "manual again $B/long.md": [{ "tool": "web_fetch", "args": { "url": "$B/long.md", "offset": 59968 } }],
  "search": [{ "tool": "web_search", "args": { "query": "x" } }]
}
JSON
cat > $W/launch.sh <<SH
#!/bin/bash
cd $P
export B4AGENT_HOME=$W/home B4_SCRIPT=$W/script.json PI_CODING_AGENT_SESSION_DIR=$W/sessions PI_CODING_AGENT_DIR=$W/agent B4AGENT_TEST_WEB_ALLOW_LOOPBACK=1
exec "$R/node_modules/.bin/pi" -ne -ns -nc --offline -e "$R/src/extension/index.ts" -e "$R/tests/e2e/scripted-model.ts" --model script/agent
SH
chmod +x $W/launch.sh
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; $T snapshot --trim 2>/dev/null | tail -30; exit 1; }
screen() { $T snapshot --trim 2>/dev/null; }
# The screen as one line, so checks survive line wrapping.
flat() { screen | tr '\n' ' ' | tr -s ' '; }
# Waits up to 15 s for a string on the flattened screen.
waitfor() { for _ in $(seq 75); do flat | grep -qF -- "$1" && return 0; sleep 0.2; done; return 1; }
send() { $T press ctrl u >/dev/null; $T type "$1" >/dev/null; $T press enter >/dev/null; }

cd $P && git init -q -b main && echo hi > a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null
$T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/launch.sh -s web-e2e --cols 120 --rows 40 --background --timeout 15000 >/dev/null
$T wait "auto mode" --timeout 20000 >/dev/null || fail "start"

# 1. A URL the user gave runs without a dialog in auto mode; the page arrives fenced as untrusted.
send "read $B/page please"
waitfor "RESULT web_fetch OK" && flat | grep -q "untrusted_web_content_" && pass "user's URL fetched without a dialog, fenced" || fail "user URL"
# The scripted model shows only 300 characters of a result; the full one is in the session.
grep -rq "The magic word is PAPAYA" $W/sessions && pass "page content in the tool result" || fail "page content"
screen | grep -q "Allow web_fetch?" && fail "no dialog expected"
$T screenshot -o $S/web1-fetch.png --pixel-ratio 2 >/dev/null

# 2. Paging: the second half of a long file, with its range.
send "read the second half of $B/long.md"
waitfor "29984-59968" && flat | grep -q "Showing characters 29984-59968 of 64000" && pass "offset paging" || fail "paging"

# 3. A URL the agent wrote itself: no reviewer is available here, so the user is asked.
send "fetch something"
waitfor "Allow web_fetch?" && flat | grep -q "a URL the agent wrote itself" && pass "agent-written URL asks (reviewer unavailable)" || fail "unseen dialog"
$T screenshot -o $S/web2-unseen-dialog.png --pixel-ratio 2 >/dev/null
$T press enter >/dev/null
waitfor "characters 0-29984" && pass "runs after Yes" || fail "unseen yes"

# 4. A redirect to another host name is returned, not followed.
send "follow $B/go"
waitfor "redirects (HTTP 302)" && flat | grep -q "redirects (HTTP 302) to a different host" && pass "cross-host redirect returned" || fail "redirect"

# 5. The SSRF guard still refuses cloud metadata with the loopback test hook on.
send "check http://169.254.169.254/latest/meta-data/"
waitfor "RESULT web_fetch ERROR" && flat | grep -q "cloud metadata" && pass "metadata address blocked" || fail "ssrf"

# 6. A token in the URL asks even though the user typed it; No stops the turn.
send "open $B/page?t=ghp_abcdefghijklmnopqrstuvwxyz0123456789"
waitfor "Allow web_fetch?" && flat | grep -q "looks like a credential" && pass "exfiltration asks" || fail "exfil dialog"
$T screenshot -o $S/web3-exfil-dialog.png --pixel-ratio 2 >/dev/null
$T press down >/dev/null; $T press down >/dev/null; $T press enter >/dev/null
waitfor "declined" && pass "declined" || fail "exfil no"

# 7. Manual mode asks per domain; "don't ask again" covers the next page on that host.
$T press ctrl u >/dev/null; $T press alt m >/dev/null; waitfor "manual mode" || fail "manual"
send "manual $B/page please"
waitfor "Allow web_fetch?" && flat | grep -q "web_fetch requests to 127.0.0.1" && pass "manual mode offers a per-domain grant" || fail "manual dialog"
$T screenshot -o $S/web4-manual-domain.png --pixel-ratio 2 >/dev/null
$T press down >/dev/null; $T press enter >/dev/null
# The same call as step 1, so the result says so instead of repeating the page.
waitfor "Already fetched" && pass "identical repeat answered with already fetched" || fail "manual grant run"
send "manual again $B/long.md"
waitfor "59968-64000" && ! flat | grep -q "Allow web_fetch?" && pass "grant covers the host" || fail "grant"

# 8. Without an OpenAI login, web_search isn't registered.
send "search"
waitfor "RESULT web_search ERROR" && flat | grep -qi "not found\|unknown\|no such tool\|not available" && pass "web_search absent without a login" || fail "web_search registered"

echo "ALL PASSED"
