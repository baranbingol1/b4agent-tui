#!/bin/bash
# End-to-end agent_create and structured output in a real terminal, driven by
# tuistory and the scripted model: the agent_create dialog (approve, then
# reject with a reason), the new type started in the same run, a submit that
# fails the type's output schema and is retried, the submit reminders, and the
# new type in the session's agents prompt section. Prints PASS/FAIL per step.
#
#   tests/e2e/agents2.sh           (from anywhere; screenshots go to dist/shots)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4ag2-e2e.XXXX); P=$W/proj; S=$R/dist/shots; N=${B4_TUI_SESSION:-sub-ag2}; T="npx --prefix $R tuistory -s $N"
mkdir -p $S
# The type: counts things and must return { n: integer >= 0 }.
TYPE='---\nname: counter\ndescription: \"Counts things and returns the count.\"\nmodel: \"@smol\"\noutput:\n  type: object\n  required: [n]\n  properties:\n    n: { type: integer, minimum: 0 }\n  additionalProperties: false\n---\n\nYou count things. Finish with submit.\n'
cat > $W/script.json <<JSON
{
  "make type": [
    [{ "tool": "agent_create", "args": { "name": "counter", "scope": "global", "content": "$TYPE" } }],
    [{ "tool": "agent", "args": { "type": "counter", "prompt": "count files", "background": false } }]
  ],
  "count files": [[{ "tool": "submit", "args": { "result": "first try", "data": { "n": "three" } } }], [{ "tool": "submit", "args": { "result": "three files", "data": { "n": 3 } } }]],
  "make other": [[{ "tool": "agent_create", "args": { "name": "other", "scope": "global", "content": "---\nname: other\ndescription: \"Does other things.\"\n---\n\nYou do other things.\n" } }]],
  "lazy count": [[{ "tool": "agent", "args": { "type": "counter", "prompt": "count lazily", "background": false } }]],
  "[submit reminder 2/3]": [[{ "tool": "submit", "args": { "result": "seven after a nudge", "data": { "n": 7 } } }]]
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
$T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/launch.sh -s $N --cols 120 --rows 40 --background --timeout 15000 >/dev/null
$T wait "auto mode" --timeout 20000 >/dev/null || fail "start"

# 1. agent_create shows the exact file and waits for the user, even though auto mode runs edits without asking.
send "make type"; $T wait 'Create subagent type "counter"?' --timeout 15000 >/dev/null && pass "agent_create opens its dialog" || fail "dialog"
screen | grep -q "additionalProperties: false" && screen | grep -q "agents/counter.md (every project)" && pass "the dialog shows the file and where it goes" || fail "dialog content"
screen | grep -q "Reject and say why" && pass "approve and reject choices" || fail "choices"
[ ! -e $W/home/agents/counter.md ] && pass "nothing written before approval" || fail "written early"
$T screenshot -o $S/c1-agent-create.png --pixel-ratio 2 >/dev/null
$T press enter >/dev/null

# 2. Approved: saved, and the same run starts the new type; its first submit fails the schema, the retry passes.
$T wait "RESULT agent OK" --timeout 20000 >/dev/null || fail "agent call after create"
[ -e $W/home/agents/counter.md ] && pass "approved type saved" || fail "saved"
grep -rqF 'It is available now: start it with agent { type: \"counter\" }' $W/sessions && pass "agent_create reports the type as usable now" || fail "create result"
screen | grep -q 'RESULT agent OK: counter-1 (counter' && pass "new type started in the same session" || fail "new type usable"
screen | grep -q '"n": 3' && pass "parent got the data as JSON" || fail "data in result"
screen | grep -q "first try" && fail "rejected submit leaked into the result" || pass "the invalid submit was not the result"

# 3. The child saw the validation error: its transcript shows the failed submit.
$T press down >/dev/null; sleep 0.3; $T press enter >/dev/null
$T wait "Message @counter-1" --timeout 5000 >/dev/null || fail "transcript overlay"
screen | grep -q "data doesn.t match the output schema" && pass "the child got the schema error and retried" || fail "schema error in transcript"
$T screenshot -o $S/c2-schema-retry.png --pixel-ratio 2 >/dev/null
$T press escape >/dev/null; sleep 0.3

# 4. Reject with a reason: nothing written, the agent sees the reason.
send "make other"; $T wait 'Create subagent type "other"?' --timeout 15000 >/dev/null || fail "second dialog"
$T press down >/dev/null; $T press down >/dev/null; $T press down >/dev/null; $T press enter >/dev/null
$T wait "the agent sees this" --timeout 5000 >/dev/null || fail "reason prompt"
$T type "too vague" >/dev/null; $T press enter >/dev/null
$T wait "RESULT agent_create OK: The user rejected" --timeout 10000 >/dev/null && screen | grep -q "They said: too vague" && pass "rejection and reason reach the agent" || fail "reject result"
[ ! -e $W/home/agents/other.md ] && pass "rejected type not written" || fail "rejected type written"

# 5. A child that ends without submitting is reminded; it submits after the second reminder.
send "lazy count"; $T wait "RESULT agent OK: counter-2" --timeout 20000 >/dev/null || fail "lazy child"
screen | grep -q '"n": 7' && screen | grep -q "seven after a nudge" && pass "reminded child submitted its data" || fail "reminder result"
# The child's own session file holds the reminders it got.
n=$(python3 - "$W/sessions" <<'PY'
import json, pathlib, sys
for f in pathlib.Path(sys.argv[1]).rglob("*.agents/*.jsonl"):
    rows = [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
    if any("count lazily" in json.dumps(r) for r in rows):
        print(sum(1 for r in rows if r.get("type") == "custom_message" and r.get("customType") == "b4agent-submit-reminder"))
PY
)
[ "$n" = 2 ] && pass "two reminders, no third" || fail "reminder count ($n)"

# 6. Hot reload: after the save, the session's agents prompt section lists the new type (patched once).
n=$(python3 - "$W/sessions" <<'PY'
import json, pathlib, sys
main = [f for f in pathlib.Path(sys.argv[1]).rglob("*.jsonl") if ".agents" not in str(f.parent)]
rows = [json.loads(l) for f in main for l in f.read_text().splitlines() if l.strip()]
sections = [r["message"]["sections"]["agents"] for r in rows if r.get("type") == "message" and r["message"].get("role") == "system" and "agents" in (r["message"].get("sections") or {})]
print(len(sections), sum("- counter (structured output)" in s for s in sections))
PY
)
[ "$n" = "2 1" ] && pass "agents section patched once, with the new type" || fail "agents section (sections, with counter: $n)"

$T close >/dev/null 2>&1
echo "ALL PASSED"
