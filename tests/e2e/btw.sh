#!/bin/bash
# End-to-end /btw scenario in a real terminal, driven by tuistory and the
# scripted model: a side question in the overlay, a follow-up whose write is
# refused, closing and reopening, and the main conversation left untouched.
# Prints PASS/FAIL per step.
#
#   tests/e2e/btw.sh            (from anywhere; screenshots go to dist/shots)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4btw-e2e.XXXX); P=$W/proj; S=$R/dist/shots; T="npx --prefix $R tuistory -s bw"
mkdir -p $S
cat > $W/script.json <<JSON
{
  "read a": [{ "tool": "read", "args": { "path": "a.txt" } }],
  "which files are here?": [{ "tool": "ls", "args": { "path": "." } }],
  "delete a.txt": [{ "tool": "bash", "args": { "command": "rm a.txt" } }]
}
JSON
cat > $W/launch.sh <<SH
#!/bin/bash
cd $P
export B4AGENT_HOME=$W/home B4_SCRIPT=$W/script.json PI_CODING_AGENT_SESSION_DIR=$W/sessions PI_CODING_AGENT_DIR=$W/agent
exec "$R/node_modules/.bin/pi" -ne -ns -nc --offline -e "$R/src/extension/index.ts" -e "$R/tests/e2e/scripted-model.ts" --model script/agent
SH
chmod +x $W/launch.sh
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; $T snapshot --trim 2>/dev/null | tail -30; $T close >/dev/null 2>&1; exit 1; }
screen() { $T snapshot --trim 2>/dev/null; }
send() { $T press ctrl u >/dev/null; $T type "$1" >/dev/null; $T press enter >/dev/null; }

mkdir -p $P $W/home && cd $P && git init -q -b main && echo hello > a.txt && echo world > b.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null
$T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/launch.sh -s bw --cols 110 --rows 36 --background --timeout 15000 >/dev/null
$T wait "auto mode" --timeout 20000 >/dev/null || fail "start"

# 1. A main turn, then a side question answered in the overlay with a read-only tool.
send "read a"; $T wait "RESULT read OK" --timeout 10000 >/dev/null || fail "main turn"
send "/btw which files are here?"
$T wait "btw · side chat" --timeout 10000 >/dev/null && pass "overlay opens" || fail "overlay"
$T wait "RESULT ls OK" --timeout 10000 >/dev/null && screen | grep -q "b.txt" && pass "side question answered with ls" || fail "side answer"
# Usage is logged in the session entry, not shown in the overlay.
sleep 0.5; ! screen | grep -q "input tokens" && grep -rh '"customType":"b4agent-btw"' $W/sessions 2>/dev/null | grep -q '"usage"' && pass "usage logged in the session, not shown" || fail "usage log"
$T screenshot -o $S/btw1-answer.png --pixel-ratio 2 >/dev/null

# 2. A follow-up in the same overlay: the delete is refused, the file stays.
$T type "delete a.txt" >/dev/null; $T press enter >/dev/null
$T wait "RESULT bash ERROR" --timeout 10000 >/dev/null && screen | grep -q "Refused in the /btw side chat" && pass "follow-up's delete refused" || fail "refusal"
[ -e $P/a.txt ] && pass "a.txt still there" || fail "a.txt deleted"
$T screenshot -o $S/btw2-follow-up.png --pixel-ratio 2 >/dev/null

# 3. Esc closes; the main transcript never shows the side chat; /btw reopens it.
$T press escape >/dev/null; sleep 0.5
screen | grep -q "btw · side chat" && fail "esc closes"
screen | grep -q "which files are here" && fail "side chat leaked into the main transcript" || pass "main transcript untouched"
send "/btw"; $T wait "btw · side chat" --timeout 5000 >/dev/null && screen | grep -q "› delete a.txt" && pass "/btw reopens the side chat" || fail "reopen"
$T press escape >/dev/null; sleep 0.3

# 4. It is saved in the session as a custom entry, which never reaches the model.
grep -rq "which files are here" $W/sessions && grep -rq '"customType":"b4agent-btw"' $W/sessions && pass "saved as a custom entry" || fail "persisted"
$T close >/dev/null 2>&1
echo "ALL PASSED"
