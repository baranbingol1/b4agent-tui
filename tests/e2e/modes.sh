#!/bin/bash
# End-to-end spec mode, ask_user, Tab routing, schedules and /review in a real
# terminal, driven by tuistory and the scripted model, with the launcher's
# keybindings (Tab = effort, Shift+Right = Pi's Tab, Shift+Tab = spec mode).
#
#   tests/e2e/modes.sh            (from anywhere; screenshots go to dist/shots)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4md-e2e.XXXX); P=$W/proj; S=$R/dist/shots; T="npx --prefix $R tuistory -s md"
mkdir -p $S $W/agent
echo '{ "app.thinking.cycle": "tab", "tui.input.tab": "shift+right" }' > $W/agent/keybindings.json
cat > $W/script.json <<'JSON'
{
  "spec edit": [{ "tool": "write", "args": { "path": "a.txt", "content": "nope\n" } }],
  "spec ask": [{ "tool": "ask_user", "args": { "questions": [{ "id": "db", "header": "Storage", "question": "Which storage should it use?", "options": [{ "label": "SQLite (Recommended)", "description": "One file, no server" }, { "label": "Postgres" }] }] } }],
  "spec done": [{ "tool": "exit_spec", "args": { "title": "Say bye", "spec": "Change a.txt to say bye.\n\nVerify with cat a.txt." } }],
  "spec edit ok": [{ "tool": "write", "args": { "path": "a.txt", "content": "bye\n" } }],
  "sched": [{ "tool": "set_schedule", "args": { "delay_seconds": 5, "prompt": "wake check" } }],
  "[scheduled by main": [{ "tool": "bash", "args": { "command": "echo woke-up" } }]
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

mkdir -p $P $W/home && cd $P && git init -q -b main && echo hello > a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null
$T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/launch.sh -s md --cols 110 --rows 40 --background --timeout 15000 >/dev/null
$T wait "auto mode" --timeout 20000 >/dev/null || fail "start"

# 1. Tab routing: with the slash menu open, Tab still completes.
$T type "/rewi" >/dev/null; sleep 0.5; $T press tab >/dev/null; sleep 0.5
screen | grep -q "/rewind" && ! screen | grep -q "/rewi$" && pass "tab completes while the menu is open" || fail "tab completion"
$T press ctrl u >/dev/null

# 1b. Alt+M cycles the permission mode: auto, manual, yolo, back to auto.
$T press alt m >/dev/null; $T wait "manual mode" --timeout 5000 >/dev/null || fail "alt+m to manual"
$T press alt m >/dev/null; $T wait "YOLO mode" --timeout 5000 >/dev/null || fail "alt+m to yolo"
$T press alt m >/dev/null; $T wait "auto mode" --timeout 5000 >/dev/null && ! screen | grep -q "YOLO mode" && pass "alt+m cycles auto, manual, yolo" || fail "alt+m back to auto"

# 2. Shift+Tab enters spec mode; edits are refused by the gate.
$T press shift tab >/dev/null; $T wait "spec mode" --timeout 5000 >/dev/null && pass "shift+tab enters spec mode" || fail "spec toggle"
send "spec edit"; $T wait "RESULT write ERROR" --timeout 10000 >/dev/null && screen | grep -q "Spec mode is read-only" && pass "spec mode blocks writes" || fail "spec read-only"
grep -q hello $P/a.txt && pass "file untouched" || fail "file changed in spec mode"

# 3. ask_user: one question, pick the recommended option.
send "spec ask"; $T wait "Which storage should it use?" --timeout 10000 >/dev/null || fail "ask_user dialog"
$T screenshot -o $S/m1-ask-user.png --pixel-ratio 2 >/dev/null
$T press enter >/dev/null; $T wait "RESULT ask_user OK" --timeout 10000 >/dev/null && screen | grep -q 'SQLite (Recommended)' && pass "ask_user returns the answer" || fail "ask_user result"

# 4. exit_spec, Esc = keep iterating.
send "spec done"; $T wait "Proceed with auto mode" --timeout 10000 >/dev/null || fail "approval dialog"
$T screenshot -o $S/m2-exit-spec.png --pixel-ratio 2 >/dev/null
# exit_spec ends the run, so its result sits in the collapsed group: Ctrl+O shows every step.
$T press escape >/dev/null; $T wait "Presented 1 spec" --timeout 10000 >/dev/null; $T press ctrl o >/dev/null
$T wait "keep iterating" --timeout 10000 >/dev/null && screen | grep -q "spec mode" && pass "esc keeps iterating in spec mode" || fail "esc"
$T press ctrl o >/dev/null; $T press ctrl o >/dev/null

# 5. Proceed with auto mode: spec saved, mode off, writes work.
send "spec done"; $T wait "Proceed with auto mode" --timeout 10000 >/dev/null; $T press enter >/dev/null
$T wait "The user approved the spec" --timeout 10000 >/dev/null || fail "proceed"
ls $W/home/projects/*/specs/*-say-bye.md >/dev/null 2>&1 && pass "spec saved under ~/.b4agent/projects/<repo>/specs" || fail "spec file"
sleep 0.5; screen | tail -3 | grep -q "spec mode" && fail "spec mode still on" || pass "spec mode off after approval"
send "spec edit ok"; $T wait "RESULT write OK" --timeout 10000 >/dev/null && grep -q bye $P/a.txt && pass "writes work again" || fail "write after spec"

# 6. Proceed in a new chat: new session with the prompt typed, not sent.
$T press shift tab >/dev/null; $T wait "spec mode" --timeout 5000 >/dev/null
send "spec done"; $T wait "Proceed in a new chat" --timeout 10000 >/dev/null; $T press down >/dev/null; $T press enter >/dev/null
$T wait "please implement this spec:" --timeout 15000 >/dev/null && ! screen | grep -q "RESULT exit_spec" && pass "new chat with the prompt pre-filled" || fail "new chat"
$T screenshot -o $S/m3-new-chat.png --pixel-ratio 2 >/dev/null
$T press ctrl u >/dev/null

# 7. An agent schedules its own wakeup; it fires as a scheduled message.
send "sched"; $T wait "RESULT set_schedule OK" --timeout 10000 >/dev/null || fail "set_schedule"
send "/loop list"; $T wait "wakes main once" --timeout 5000 >/dev/null && pass "/loop list shows the agent's schedule" || fail "loop list"
$T wait "RESULT bash OK: woke-up" --timeout 20000 >/dev/null && screen | grep -q "scheduled by main" && pass "scheduled wakeup ran" || fail "wakeup"

# 8. /review expands into the reviewer brief.
send "/review"; $T wait "NO SCRIPT for: Review the uncommitted changes" --timeout 10000 >/dev/null && pass "/review sends the review brief" || fail "/review"

$T close >/dev/null 2>&1
echo "ALL PASSED"
