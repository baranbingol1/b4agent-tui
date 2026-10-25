#!/bin/bash
# End-to-end /init, /usage and painter in a real terminal, driven by tuistory
# and the scripted model. No real login: a fake openai-codex credential and a
# models.json base URL point Pi at a local stub of chatgpt.com/backend-api
# (wham/usage with a recorded response, and codex/images/generations).
#
#   tests/e2e/misc.sh            (from anywhere; screenshots go to dist/shots)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/misc-e2e.XXXX); P=$W/proj; S=$R/dist/shots; T="npx --prefix $R tuistory -s misc-e2e"
mkdir -p $S $W/agent $W/home
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; $T snapshot --trim 2>/dev/null | tail -30; $T close >/dev/null 2>&1; kill $STUB 2>/dev/null; exit 1; }
screen() { $T snapshot --trim 2>/dev/null; }
send() { $T press ctrl u >/dev/null; $T type "$1" >/dev/null; $T press enter >/dev/null; }

# The stub backend. Reset times are relative to now so the overlay shows stable "in ..." text.
cat > $W/stub.mjs <<'JS'
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const now = Math.floor(Date.now() / 1000);
const seen = [];
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url, turn: req.headers["x-codex-image-turn-id"], account: req.headers["chatgpt-account-id"], body: (() => { try { return JSON.parse(body); } catch { return undefined; } })() });
    writeFileSync(process.argv[3], JSON.stringify(seen, null, 2));
    res.setHeader("content-type", "application/json");
    if (req.url === "/backend-api/wham/usage") {
      return res.end(JSON.stringify({ plan_type: "plus", rate_limit: { allowed: true, limit_reached: false,
        primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 5400, reset_at: now + 5400 },
        secondary_window: { used_percent: 91, limit_window_seconds: 604800, reset_after_seconds: 183600, reset_at: now + 183600 } },
        credits: { has_credits: false, unlimited: false, balance: "0" }, additional_rate_limits: null }));
    }
    if (req.url === "/backend-api/codex/images/generations") {
      res.setHeader("x-codex-imagegen-request-id", "req-stub-1");
      res.setHeader("x-codex-primary-used-percent", "43");
      return res.end(JSON.stringify({ created: now, data: [{ b64_json: png }], size: "1024x1024" }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ detail: "Not Found" }));
  });
});
srv.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(srv.address().port)));
JS
node $W/stub.mjs $W/port $W/seen.json & STUB=$!
for _ in $(seq 50); do [ -s $W/port ] && break; sleep 0.1; done
PORT=$(cat $W/port)
# A fake JWT with a ChatGPT account claim, valid for a day, so Pi never tries to refresh it.
TOKEN="e30.$(printf '{"https://api.openai.com/auth":{"chatgpt_account_id":"acc-stub"}}' | base64 -w0 | tr '+/' '-_' | tr -d '=').sig"
EXP=$(( $(date +%s) * 1000 + 86400000 ))
echo "{ \"openai-codex\": { \"type\": \"oauth\", \"access\": \"$TOKEN\", \"refresh\": \"stub\", \"expires\": $EXP, \"accountId\": \"acc-stub\" } }" > $W/agent/auth.json
chmod 600 $W/agent/auth.json
echo "{ \"providers\": { \"openai-codex\": { \"baseUrl\": \"http://127.0.0.1:$PORT/backend-api\" } } }" > $W/agent/models.json
cat > $W/script.json <<'JSON'
{ "paint": [{ "tool": "painter", "args": { "prompt": "a red fox icon", "name": "Fox icon" } }] }
JSON
cat > $W/launch.sh <<SH
#!/bin/bash
cd $P
export B4AGENT_HOME=$W/home B4_SCRIPT=$W/script.json PI_CODING_AGENT_SESSION_DIR=$W/sessions PI_CODING_AGENT_DIR=$W/agent
exec "$R/node_modules/.bin/pi" -ne -ns -nc --offline -e "$R/src/extension/index.ts" -e "$R/tests/e2e/scripted-model.ts" --model script/agent
SH
chmod +x $W/launch.sh

mkdir -p $P && cd $P && git init -q -b main && printf '# AGENTS.md\n\n- run make test\n' > AGENTS.md && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null

# 0. No backend, no painter: a session without any login doesn't list the tool.
mkdir -p $W/bare
OUT=$(cd $P && B4AGENT_HOME=$W/home B4_SCRIPT=$W/script.json PI_CODING_AGENT_SESSION_DIR=$W/sessions PI_CODING_AGENT_DIR=$W/bare timeout 60 "$R/node_modules/.bin/pi" -ne -ns -nc --offline -e "$R/src/extension/index.ts" -e "$R/tests/e2e/scripted-model.ts" --model script/agent --yolo -p paint 2>&1)
echo "$OUT" | grep -q "RESULT painter ERROR" && ! echo "$OUT" | grep -q "Saved " && pass "no backend: painter isn't registered" || { echo "$OUT" | tail -5; fail "painter without a backend"; }

$T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/launch.sh -s misc-e2e --cols 110 --rows 36 --background --timeout 15000 >/dev/null
$T wait "auto mode" --timeout 20000 >/dev/null || fail "start"

# 1. /init sends the brief; an existing AGENTS.md is to be improved, not overwritten.
send "/init"; $T wait "NO SCRIPT for: Write the AGENTS.md for this project" --timeout 10000 >/dev/null && screen | tr '\n' ' ' | grep -aq "It already exists: *improve it in place" && pass "/init sends the brief (improve in place)" || fail "/init"
grep -q "run make test" $P/AGENTS.md && pass "AGENTS.md untouched by the command" || fail "AGENTS.md changed"

# 2. /usage overlay with the stub's limits: 5-hour first, then weekly, and session totals.
send "/usage"; $T wait "ChatGPT plan limits (plus)" --timeout 10000 >/dev/null || fail "/usage overlay"
screen | grep -aq "5-hour .* 42% used .*(in 1h" && pass "5-hour window, used percent, reset" || fail "5-hour line"
screen | grep -aq "weekly .* 91% used .*(in 2d" && pass "weekly window" || fail "weekly line"
screen | grep -aq "1 turn · input" && pass "session totals" || fail "session totals"
$T screenshot -o $S/usage.png --pixel-ratio 2 >/dev/null
$T press escape >/dev/null; sleep 0.5; screen | grep -aq "ChatGPT plan limits" && fail "esc closes" || pass "esc closes the overlay"

# 3. painter through the Codex images endpoint: Codex CLI's request, saved under the project dir.
# The gate reviews painter like any non-built-in tool (offline, no reviewer, so it asks): approve.
send "paint"; $T wait "painter is not a built-in read or edit tool" --timeout 10000 >/dev/null && pass "the gate asks before painting" || fail "painter dialog"
$T press enter >/dev/null; $T wait "RESULT painter OK" --timeout 20000 >/dev/null || fail "painter"
F=$(ls $W/home/projects/proj-*/images/*-fox-icon.png 2>/dev/null | head -1)
[ -n "$F" ] && [ ! -e $P/*.png ] && pass "saved to ~/.b4agent/projects/<repo>/images/$(basename $F), not the repo" || fail "image file"
node -e 'const s=require(process.argv[1]).find(x=>x.url==="/backend-api/codex/images/generations"); process.exit(s && s.account==="acc-stub" && /^[0-9a-f-]{36}$/.test(s.turn) && s.body.model==="gpt-image-2" && s.body.size==="auto" ? 0 : 1)' $W/seen.json && pass "request: gpt-image-2, account id, x-codex-image-turn-id" || fail "painter request"

$T close >/dev/null 2>&1; kill $STUB 2>/dev/null
echo "ALL PASSED"
