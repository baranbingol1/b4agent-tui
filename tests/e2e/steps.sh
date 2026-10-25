#!/bin/bash
# End-to-end collapsed agent steps in a real terminal, driven by tuistory and
# the scripted model: a finished run folds into one summary line with the
# answer below it, Ctrl+O cycles grouped -> every step -> full output ->
# grouped, an error stays visible inside a folded group, a running group shows
# its current step, and a subagent's transcript uses the same view.
# Prints PASS/FAIL per step; screenshots go to dist/shots.
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4st-e2e.XXXX); P=$W/proj; S=$R/dist/shots; T="npx --prefix $R tuistory -s st"
mkdir -p $S
cat > $W/script.json <<JSON
{
  "work": [
    [{ "tool": "bash", "args": { "command": "echo one" } }, { "tool": "read", "args": { "path": "a.txt" } }],
    [{ "tool": "edit", "args": { "path": "a.txt", "edits": [{ "oldText": "hello", "newText": "bye\\nnew line" }] } }],
    [{ "tool": "bash", "args": { "command": "echo two" } }, { "tool": "read", "args": { "path": "b.txt" } }],
    [{ "tool": "bash", "args": { "command": "grep -n bye a.txt" } }]
  ],
  "broken": [
    [{ "tool": "bash", "args": { "command": "echo fine" } }],
    [{ "tool": "read", "args": { "path": "missing.txt" } }],
    [{ "tool": "bash", "args": { "command": "echo after" } }]
  ],
  "slow": [
    [{ "tool": "bash", "args": { "command": "echo first" } }],
    [{ "tool": "bash", "args": { "command": "sleep 5; echo slept" } }]
  ],
  "child work": [{ "tool": "agent", "args": { "type": "general", "prompt": "broken", "background": false } }]
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
fail() { echo "FAIL $1"; $T snapshot --trim 2>/dev/null | tail -40; $T close >/dev/null 2>&1; exit 1; }
screen() { $T snapshot --trim 2>/dev/null; }
send() { $T press ctrl u >/dev/null; $T type "$1" >/dev/null; $T press enter >/dev/null; }

mkdir -p $P $W/home && cd $P && git init -q -b main && echo hello > a.txt && echo world > b.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null
$T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/launch.sh -s st --cols 110 --rows 40 --background --timeout 15000 >/dev/null
$T wait "auto mode" --timeout 20000 >/dev/null || fail "start"

# 1. A finished run is one line, then the answer.
send "work"; $T wait "RESULT bash OK: 1:bye" --timeout 15000 >/dev/null || fail "run finished"
sleep 0.5
screen | grep -q "Ran 3 commands, read 2 files, edited 1 file (+2 -1) ›" && pass "one summary line" || fail "summary line"
screen | grep -q "echo one" && fail "steps hidden while collapsed" || pass "steps hidden while collapsed"
$T screenshot -o $S/s1-collapsed.png --pixel-ratio 2 >/dev/null

# 1b. Highlight-to-reference (fullscreen): drag over the answer (raw SGR mouse events), press r, it's quoted into the prompt; r again types r.
# Rows counted up from the footer, which is Pi's last row: once the screen has scrolled, tuistory's snapshot also holds a scrollback line above it.
ROW=$($T snapshot 2>/dev/null | awk -v rows=40 '/RESULT bash OK: 1:bye/ && !r { r = NR } /auto mode/ { f = NR } END { print rows - (f - r) }'); COL=$(screen | grep "RESULT bash OK: 1:bye" | head -1 | awk '{ print index($0, "RESULT") }')
$T type $'\e[<0;'"$COL;$ROW"'M' >/dev/null; $T type $'\e[<32;'"$((COL + 20));$ROW"'M' >/dev/null; $T type $'\e[<0;'"$((COL + 20));$ROW"'m' >/dev/null; sleep 0.3
$T press r >/dev/null; sleep 0.5
screen | grep -q "^> RESULT bash OK: 1:bye" && pass "r quotes the selection into the prompt" || fail "quote"
$T screenshot -o $S/s6-reference.png --pixel-ratio 2 >/dev/null
$T press r >/dev/null; sleep 0.3
screen | grep -qx "r" && pass "r without a selection types r" || fail "plain r"
$T press ctrl c >/dev/null; sleep 0.3
# (Before Ctrl+O on purpose: after Pi's expanded view toggles back, pi-tui 1.3.0 returns the text one row below the highlight, with or without b4agent.)

# 2. Ctrl+O shows every step, again shows full output, and a third time collapses.
$T press ctrl o >/dev/null; sleep 0.5
screen | grep -q "edit a.txt" && screen | grep -q "echo two" && ! screen | grep -q "edited 1 file (+2 -1) ›" && pass "ctrl+o shows every step" || fail "every step"
$T screenshot -o $S/s2-steps.png --pixel-ratio 2 >/dev/null
$T press ctrl o >/dev/null; sleep 0.5
screen | grep -q "Tool output: expanded" && pass "ctrl+o again: Pi's full output" || fail "full output"
$T press ctrl o >/dev/null; sleep 0.5
screen | grep -q "edited 1 file (+2 -1) ›" && ! screen | grep -q "echo one" && pass "ctrl+o a third time collapses" || fail "collapse again"

# 2b. Fullscreen (Pi's default tuiMode): a click on the summary opens that one group, a click on it again closes it.
$T click "Ran 3 commands" >/dev/null; sleep 0.5
screen | grep -q "edit a.txt" && pass "click opens one group" || fail "click open"
$T scroll up 20 >/dev/null; sleep 0.3
screen | grep -q "edited 1 file (+2 -1) ⌄" && $T click "Ran 3 commands" >/dev/null; sleep 0.3; $T scroll down 40 >/dev/null; sleep 0.5
screen | grep -q "edited 1 file (+2 -1) ›" && ! screen | grep -q "edit a.txt" && pass "click closes it again" || fail "click close"

# 3. An error inside a group stays visible under its summary line.
send "broken"; $T wait "RESULT bash OK: after" --timeout 15000 >/dev/null || fail "broken run"
sleep 0.5
screen | grep -q "Ran 2 commands, read 1 file · 1 failed ›" && screen | grep -q "missing.txt" && ! screen | grep -q "echo fine" && pass "failed step visible inside the folded group" || fail "error in group"
$T screenshot -o $S/s3-error.png --pixel-ratio 2 >/dev/null

# 4. A running group shows its current step.
# The running call stays folded (no flash of its full block before it collapses).
send "slow"; $T wait "now: bash sleep 5" --timeout 10000 >/dev/null && screen | grep -q "Working · ran 2 commands" && ! screen | grep -q '\$ sleep 5' && pass "running group shows the current step, folded" || { screen | tail -20; fail "running group"; }
$T screenshot -o $S/s4-running.png --pixel-ratio 2 >/dev/null
$T wait "RESULT bash OK: slept" --timeout 15000 >/dev/null || fail "slow run end"

# 5. A subagent's transcript uses the same compact view.
send "child work"; $T wait "general-1" --timeout 15000 >/dev/null || fail "child started"
$T wait "general-1 finished" --timeout 20000 >/dev/null || true
$T press ctrl u >/dev/null; $T press down >/dev/null; sleep 0.3; $T press enter >/dev/null
$T wait "Message @general-1" --timeout 5000 >/dev/null || fail "overlay"
sleep 0.5
screen | grep -q "Ran 2 commands, read 1 file · 1 failed ›" && screen | grep -q "missing.txt" && pass "subagent transcript is compact" || fail "overlay compact"
$T screenshot -o $S/s5-subagent.png --pixel-ratio 2 >/dev/null
$T press escape >/dev/null

$T close >/dev/null 2>&1
echo "ALL PASSED"
