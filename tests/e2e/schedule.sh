#!/bin/bash
# End-to-end durable schedules and the self-paced /loop fallback wakeup, in a
# real terminal with tuistory and the scripted model:
#   1. a session sets a durable one-shot and a durable /loop, then quits;
#   2. two sessions open at once in the same project: exactly one picks the
#      jobs up and fires each missed run once, flagged "missed";
#   3. the self-paced /loop: fallback armed and fired, the loop ending after
#      a fallback round that doesn't reschedule, clear_schedule stopping it,
#      and the agent's own wakeup keeping it going.
#
#   tests/e2e/schedule.sh            (from anywhere)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4sched-e2e.XXXX); P=$W/proj; H=$W/home
TU="npx --prefix $R tuistory"
mkdir -p $W/agent $H
# A 6-second fallback instead of 20 minutes.
echo '{ "schedule": { "fallbackWakeupMinutes": 0.1 } }' > $H/b4agent.json
cat > $W/script.json <<'JSON'
{
  "dur": [{ "tool": "set_schedule", "args": { "delay_seconds": 20, "prompt": "durable check", "durable": true } }],
  "durable check": [{ "tool": "bash", "args": { "command": "echo durable-ran" } }],
  "loopcheck": [{ "tool": "bash", "args": { "command": "echo loop-ran" } }],
  "selfpaced": [],
  "selfstop": [{ "tool": "clear_schedule", "args": {} }],
  "selfwake": [{ "tool": "set_schedule", "args": { "delay_seconds": 5, "prompt": "selfwake again" } }],
  "[scheduled by main": [{ "tool": "bash", "args": { "command": "echo wake-ran" } }],
  "[scheduled by the user's /loop": [{ "tool": "bash", "args": { "command": "echo fallback-ran" } }]
}
JSON
cat > $W/launch.sh <<SH
#!/bin/bash
cd $P
export B4AGENT_HOME=$H B4_SCRIPT=$W/script.json PI_CODING_AGENT_SESSION_DIR=$W/sessions PI_CODING_AGENT_DIR=$W/agent
exec "$R/node_modules/.bin/pi" -ne -ns -nc --offline -e "$R/src/extension/index.ts" -e "$R/tests/e2e/scripted-model.ts" --model script/agent
SH
chmod +x $W/launch.sh
SESSIONS="sched-a sched-b sched-c sched-d"
cleanup() { for s in $SESSIONS; do $TU -s $s close >/dev/null 2>&1; done; }
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; for s in $SESSIONS; do $TU -s $s snapshot --trim 2>/dev/null | tail -25 | sed "s/^/[$s] /"; done; cleanup; exit 1; }
screen() { $TU -s $1 snapshot --trim 2>/dev/null; }
send() { $TU -s $1 press ctrl u >/dev/null; $TU -s $1 type "$2" >/dev/null; $TU -s $1 press enter >/dev/null; }
launch() { $TU launch $W/launch.sh -s $1 --cols 120 --rows 40 --background --timeout 15000 >/dev/null; }
quit() { send $1 "/quit"; sleep 1.5; $TU -s $1 close >/dev/null 2>&1; }
file() { ls $H/projects/*/schedules.json 2>/dev/null | head -1; }
# Node one-liners over schedules.json and the session files (one JSON entry per line).
entries() { f=$(file); [ -n "$f" ] && node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries;console.log(eval(process.argv[2]))' "$f" "$1" || echo none; }
fires() { grep -rh '"customType":"b4agent-scheduled"' $W/sessions 2>/dev/null | grep -F -- "$1" | grep -cF -- "${2:-}"; }
# Waits up to $3 seconds for $2 scheduled runs matching $1.
until_fires() { for _ in $(seq $3); do [ "$(fires "$1")" -ge $2 ] && return 0; sleep 1; done; return 1; }

mkdir -p $P && cd $P && git init -q -b main && echo hello > a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null
cleanup

# 1. Set a durable one-shot and a durable /loop, then quit before either is due again.
launch sched-a; $TU -s sched-a wait "auto mode" --timeout 20000 >/dev/null || fail "start a"
send sched-a "dur"; $TU -s sched-a wait "RESULT set_schedule OK" --timeout 10000 >/dev/null && screen sched-a | grep -q "durable" && pass "set_schedule durable: true" || fail "set durable"
send sched-a "/loop --durable 1m loopcheck"; $TU -s sched-a wait "RESULT bash OK: loop-ran" --timeout 15000 >/dev/null && pass "/loop --durable runs now" || fail "durable loop first run"
screen sched-a | grep -q "Allow " && fail "a permission dialog came up for b4agent's own write"
[ "$(entries 'e.length')" = 2 ] && [ "$(entries 'e.every(x=>x.holder)')" = true ] && pass "both saved to schedules.json, held by the open session" || fail "schedules.json while open: $(cat $(file) 2>/dev/null)"
quit sched-a
[ "$(entries 'e.length + ":" + e.some(x=>x.holder)')" = "2:false" ] && pass "quitting keeps them and releases the hold" || fail "after quit: $(cat $(file) 2>/dev/null)"
ls $H/projects/*/schedules.json.lock >/dev/null 2>&1 && fail "lock file left behind"
# The one-shot falls due while no session is open; move the loop's next run into the past too (a minute passing).
sleep 20
f=$(file); node -e 'const fs=require("fs"),f=process.argv[1],d=JSON.parse(fs.readFileSync(f,"utf8"));for(const e of d.entries)if(e.job.rule)e.job.nextAt=Date.now()-5000;fs.writeFileSync(f,JSON.stringify(d))' "$f"

# 2. Two sessions open at once: one takes both jobs and fires each missed run once.
launch sched-b & launch sched-c & wait
$TU -s sched-b wait "auto mode" --timeout 20000 >/dev/null || fail "start b"
$TU -s sched-c wait "auto mode" --timeout 20000 >/dev/null || fail "start c"
sleep 8
WIN=""; for s in sched-b sched-c; do screen $s | grep -q "Picked up 2 durable schedules" && WIN="$WIN $s"; done
WIN=$(echo $WIN)
[ -n "$WIN" ] && [ "$(echo $WIN | wc -w)" = 1 ] && pass "exactly one of the two new sessions picked them up ($WIN)" || fail "pick-up went to: '$WIN'"
[ "$(fires 'durable check' missed)" = 1 ] && [ "$(fires loopcheck missed)" = 1 ] && pass "each missed run fired once, flagged missed" || fail "missed fires: durable $(fires 'durable check' missed), loop $(fires loopcheck missed)"
screen $WIN | grep -q "missed: it was due" && pass "the provenance line says missed" || fail "no missed provenance on screen"
$TU -s $WIN wait "RESULT bash OK: durable-ran" --timeout 10000 >/dev/null && pass "the missed one-shot ran" || fail "missed one-shot didn't run"
[ "$(entries 'e.length + ":" + !!e[0].job.rule + ":" + (e[0].job.nextAt > Date.now()) + ":" + !!e[0].holder')" = "1:true:true:true" ] && pass "the one-shot left the file; the loop re-armed in the future, held" || fail "file after pick-up: $(cat $(file) 2>/dev/null)"
send $WIN "/loop stop all"; $TU -s $WIN wait "Stopped" --timeout 5000 >/dev/null
[ -z "$(file)" ] && pass "/loop stop removes it from the file" || fail "file after stop: $(cat $(file) 2>/dev/null)"
quit sched-b; quit sched-c

# 3. The self-paced /loop and its fallback wakeup (6 s here).
launch sched-d; $TU -s sched-d wait "auto mode" --timeout 20000 >/dev/null || fail "start d"
send sched-d "/loop selfpaced"; $TU -s sched-d wait "no next wakeup was set" --timeout 10000 >/dev/null && pass "a round with no wakeup arms the fallback" || fail "fallback not armed"
$TU -s sched-d wait "RESULT bash OK: fallback-ran" --timeout 15000 >/dev/null && pass "the fallback wakeup fires" || fail "fallback didn't fire"
$TU -s sched-d wait "the fallback round didn't schedule another" --timeout 10000 >/dev/null && pass "the loop ends after a fallback round that doesn't reschedule" || fail "loop didn't end"
[ "$(fires 'fallback wakeup')" = 1 ] || fail "fallback fired $(fires 'fallback wakeup') times"

send sched-d "/loop selfstop"; $TU -s sched-d wait "The self-paced /loop has ended" --timeout 10000 >/dev/null || fail "clear_schedule didn't end the loop"
sleep 9
[ "$(fires 'fallback wakeup')" = 1 ] && pass "clear_schedule ends the loop with no fallback" || fail "a fallback came after clear_schedule"

send sched-d "/loop selfwake"; $TU -s sched-d wait "RESULT set_schedule OK" --timeout 10000 >/dev/null || fail "selfwake set_schedule"
$TU -s sched-d wait "RESULT bash OK: wake-ran" --timeout 15000 >/dev/null && pass "the agent's own wakeup keeps the loop going (no fallback meanwhile)" || fail "own wakeup didn't run"
[ "$(fires 'fallback wakeup')" = 1 ] || fail "a fallback fired while the agent's wakeup was pending"
until_fires 'fallback wakeup' 2 20 && $TU -s sched-d wait "RESULT bash OK: fallback-ran" --timeout 10000 >/dev/null && sleep 2 && [ "$(fires 'fallback wakeup')" = 2 ] && pass "after a round that sets nothing, the fallback comes, then the loop ends" || fail "second fallback: $(fires 'fallback wakeup')"
send sched-d "/loop list "; $TU -s sched-d wait "Nothing is scheduled" --timeout 5000 >/dev/null && pass "nothing is left scheduled" || fail "something left after the loop ended"
screen sched-d | grep -q "Allow " && fail "a permission dialog came up"
quit sched-d
echo "ALL PASS ($W)"
