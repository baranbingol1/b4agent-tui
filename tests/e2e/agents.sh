#!/bin/bash
# End-to-end subagent and background-job scenario in a real terminal, driven by
# tuistory and the scripted model: background delivery, the agent panel and its
# transcript, messaging a child, background bash and Ctrl+B, the stale-read
# guard, and a child's permission dialog. Prints PASS/FAIL per step.
#
#   tests/e2e/agents.sh            (from anywhere; screenshots go to dist/shots)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4ag-e2e.XXXX); P=$W/proj; S=$R/dist/shots; N=${B4_TUI_SESSION:-ag}; T="npx --prefix $R tuistory -s $N"
mkdir -p $S
cat > $W/script.json <<JSON
{
  "slow child": [{ "tool": "agent", "args": { "type": "worker", "prompt": "nap then report" } }],
  "nap then report": [[{ "tool": "bash", "args": { "command": "sleep 6; echo napped" } }], [{ "tool": "submit", "args": { "result": "napped well" } }]],
  "bg bash": [{ "tool": "bash", "args": { "command": "sleep 2; echo bgdone", "background": true } }],
  "fg bash": [{ "tool": "bash", "args": { "command": "sleep 8; echo late" } }],
  "read a": [{ "tool": "read", "args": { "path": "a.txt" } }],
  "edit a": [{ "tool": "edit", "args": { "path": "a.txt", "edits": [{ "oldText": "hello", "newText": "bye" }] } }],
  "risky child": [{ "tool": "agent", "args": { "type": "worker", "prompt": "write outside" } }],
  "write outside": [{ "tool": "write", "args": { "path": "$W/outside.txt", "content": "x" } }]
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
fail() { echo "FAIL $1"; $T snapshot --trim 2>/dev/null | tail -25; $T close >/dev/null 2>&1; exit 1; }
screen() { $T snapshot --trim 2>/dev/null; }
send() { $T press ctrl u >/dev/null; $T type "$1" >/dev/null; $T press enter >/dev/null; }

mkdir -p $P $W/home/agents && printf -- '---\nname: worker\ndescription: Test worker with the full toolset.\n---\nDo the brief.\n' > $W/home/agents/worker.md && cd $P && git init -q -b main && echo hello > a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null
$T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/launch.sh -s $N --cols 110 --rows 36 --background --timeout 15000 >/dev/null
$T wait "auto mode" --timeout 20000 >/dev/null || fail "start"

# 1. A background child shows in the panel; ↓ enters it, Enter opens its transcript, typing messages it.
send "slow child"; $T wait "Started worker-1" --timeout 15000 >/dev/null || fail "child started"
$T wait "worker-1" --timeout 5000 >/dev/null && screen | grep -q "↓ agents" && pass "panel row below the editor" || fail "panel row"
$T press down >/dev/null; sleep 0.3; screen | grep -q "enter open" && pass "↓ on an empty prompt enters the panel" || fail "enter panel"
$T screenshot -o $S/a1-panel.png --pixel-ratio 2 >/dev/null
$T press enter >/dev/null; $T wait "Message @worker-1" --timeout 5000 >/dev/null && pass "transcript overlay opens" || fail "overlay"
screen | grep -q "sleep 6" && pass "transcript shows the child's tool call" || fail "transcript content"
$T type "keep it short" >/dev/null; $T press enter >/dev/null; sleep 0.5
$T screenshot -o $S/a2-transcript.png --pixel-ratio 2 >/dev/null
screen | grep -q "› keep it short" && pass "typing in the transcript messages the child" || fail "steer child"
$T press escape >/dev/null; sleep 0.3; screen | grep -q "Message @worker-1" && fail "esc closes overlay" || pass "esc closes the transcript"

# 2. Its result arrives on its own and starts a main turn. The scripted child answers the last message it got,
#    so the result echoing the steer shows the steer reached it.
$T wait "worker-1 finished" --timeout 20000 >/dev/null && pass "result delivered to the idle main agent" || fail "delivery"
screen | grep -q "NO SCRIPT for: \[worker-1 finished\]" && pass "delivery started a main turn" || fail "main turn"
screen | grep -q "NO SCRIPT for: keep it short" && pass "the child acted on the steer" || fail "steer reached child"

# 3. Background bash: returns at once, then a message when it ends.
send "bg bash"; $T wait "Started background job bash-1" --timeout 10000 >/dev/null || fail "bg job start"
$T wait "background job bash-1 finished" --timeout 15000 >/dev/null && pass "background job end is delivered" || fail "bg job delivery"

# 4. Ctrl+B moves a running foreground command to the background.
send "fg bash"; sleep 1.5; $T press ctrl b >/dev/null
$T wait "Moved to the background as job bash-2" --timeout 8000 >/dev/null && pass "ctrl+b backgrounds a running command" || fail "ctrl+b"
$T wait "background job bash-2 finished" --timeout 15000 >/dev/null && screen | grep -q "late" && pass "the moved job still reports" || fail "moved job delivery"

# 5. Stale-read guard: an edit after the file changed on disk is refused.
send "read a"; $T wait "RESULT read OK" --timeout 10000 >/dev/null || fail "read"
sleep 1; echo "hello there" > $P/a.txt
send "edit a"; $T wait "RESULT edit ERROR" --timeout 10000 >/dev/null && screen | grep -q "was modified since you last read it" && pass "stale edit refused" || fail "stale guard"
grep -q "hello there" $P/a.txt && pass "file left as the user wrote it" || fail "file changed"

# 6. A child's permission ask reaches you, labelled, and the panel marks it.
send "risky child"; $T wait "Allow write?" --timeout 15000 >/dev/null && screen | grep -qF "[worker-2] Allow write?" && screen | grep -q "worker-2  needs you" && pass "child's dialog labelled with its name" || fail "child dialog"
$T screenshot -o $S/a3-child-ask.png --pixel-ratio 2 >/dev/null
$T press down >/dev/null; $T press down >/dev/null; $T press enter >/dev/null
$T wait "worker-2 finished" --timeout 15000 >/dev/null && pass "declined child finishes and reports" || fail "child after decline"
[ ! -e $W/outside.txt ] && pass "declined write didn't happen" || fail "outside write happened"

$T close >/dev/null 2>&1
echo "ALL PASSED"
