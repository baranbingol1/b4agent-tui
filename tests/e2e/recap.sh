#!/bin/bash
# End-to-end thread recap (plan section 3) in a real terminal, driven by
# tuistory with a 3-second away threshold and a faux model that answers each
# prompt and writes a recap when asked: no recap before 3 turns, a recap above
# the editor after 3 turns and no keystrokes, hidden on typing, never twice in
# a row, saved as a custom entry from the main model with cache reads, and
# shown again when the session is continued. Prints PASS/FAIL per step.
#
#   tests/e2e/recap.sh            (from anywhere; screenshots go to dist/shots)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4recap-e2e.XXXX); P=$W/proj; S=$R/dist/shots; T="npx --prefix $R tuistory -s recap-e2e"
mkdir -p $S $P $W/home
# The model: "answer to: <prompt>" for the main agent; for a recap request, line 1 and a Next: line from the prompts it saw.
cat > $W/model.ts <<'TS'
import { fauxAssistantMessage, fauxProvider, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "e2e", models: [{ id: "agent", name: "e2e agent" }] });
  const step: FauxResponseFactory = (context) => {
    const users = context.messages.filter((m) => m.role === "user").map((m) => text(m).trim());
    const last = users.at(-1) ?? "";
    if (!last.startsWith("[recap]")) return fauxAssistantMessage(fauxText(`answer to: ${last}`));
    const asked = users.slice(0, -1);
    return fauxAssistantMessage(fauxText(`Checked ${asked.join(", ")}: each prompt has an answer and nothing is pending.\nNext: say what follows "${asked.at(-1)}".`));
  };
  faux.setResponses(Array.from({ length: 200 }, () => step));
  pi.registerProvider(faux.provider);
}
TS
cat > $W/launch.sh <<SH
#!/bin/bash
cd $P
export B4AGENT_HOME=$W/home PI_CODING_AGENT_SESSION_DIR=$W/sessions PI_CODING_AGENT_DIR=$W/agent B4AGENT_RECAP_AWAY_SECONDS=3 B4AGENT_RECAP_LOG=$W/recap.log
exec "$R/node_modules/.bin/pi" -ne -ns -nc --offline -e "$R/src/extension/index.ts" -e "$W/model.ts" --model e2e/agent "\$@"
SH
chmod +x $W/launch.sh
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; $T snapshot --trim 2>/dev/null | tail -30; echo "--- recap.log"; cat $W/recap.log 2>/dev/null; $T close >/dev/null 2>&1; exit 1; }
screen() { $T snapshot --trim 2>/dev/null; }
send() { $T press ctrl u >/dev/null; $T type "$1" >/dev/null; $T press enter >/dev/null; }
launch() { $T close >/dev/null 2>&1; npx --prefix $R tuistory launch "$W/launch.sh $*" -s recap-e2e --cols 110 --rows 32 --background --timeout 15000 >/dev/null; $T wait "auto mode" --timeout 20000 >/dev/null || fail "start"; }

cd $P && git init -q -b main && echo hello > a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null
launch

# 1. Two turns, then away: too few turns for a recap.
send "alpha"; $T wait "answer to: alpha" --timeout 10000 >/dev/null || fail "turn 1"
send "beta"; $T wait "answer to: beta" --timeout 10000 >/dev/null || fail "turn 2"
sleep 4.5
screen | grep -q "✦ recap" && fail "no recap before 3 turns" || pass "no recap after 2 turns"
grep -q "skipped: fewer than 3 completed turns" $W/recap.log && pass "skip logged (fewer than 3 turns)" || fail "skip reason"

# 2. A third turn, then 3 s without keystrokes: the recap appears above the editor.
send "gamma"; $T wait "answer to: gamma" --timeout 10000 >/dev/null || fail "turn 3"
$T wait "✦ recap" --timeout 10000 >/dev/null && pass "recap appears after 3 turns and 3 s away" || fail "recap appears"
screen | grep -q "Checked alpha, beta, gamma" && screen | grep -q 'Next: say what follows "gamma"' && pass "line 1 and Next: shown" || fail "recap text"
# Above the editor: the recap line comes before the prompt box's bottom rows.
rl=$(screen | grep -n "✦ recap" | head -1 | cut -d: -f1); el=$(screen | grep -n "auto mode" | tail -1 | cut -d: -f1)
[ -n "$rl" ] && [ -n "$el" ] && [ "$rl" -lt "$el" ] && pass "rendered above the editor" || fail "placement"
$T screenshot -o $S/recap.png --pixel-ratio 2 >/dev/null

# 3. Saved as a custom entry from the main model, with cache reads; not in the conversation.
grep -rq '"customType":"recap"' $W/sessions && pass "saved with appendEntry(\"recap\")" || fail "persisted"
grep -rh '"customType":"recap"' $W/sessions | grep -q '"route":"main"' && pass "written by a side turn on the main model" || fail "route"
cr=$(grep -rh '"customType":"recap"' $W/sessions | grep -o '"cacheRead":[0-9]*' | head -1 | cut -d: -f2)
[ "${cr:-0}" -gt 0 ] && pass "recap request read $cr tokens from the main session's cache" || fail "cache reads"

# 4. Typing hides it; clearing the draft doesn't bring it back, and away again without a new turn writes nothing.
$T type "x" >/dev/null; sleep 0.5
screen | grep -q "✦ recap" && fail "typing hides the recap" || pass "typing hides the recap"
$T press ctrl u >/dev/null; sleep 4.5
screen | grep -q "✦ recap" && fail "never twice in a row" || pass "no second recap without a new turn"
[ "$(grep -rh '"customType":"recap"' $W/sessions | wc -l)" -eq 1 ] && pass "still one saved recap" || fail "one recap"

# 5. A new turn allows the next recap; a prompt hides it; a draft blocks one.
send "delta"; $T wait "answer to: delta" --timeout 10000 >/dev/null || fail "turn 4"
$T wait "Checked alpha, beta, gamma, delta" --timeout 10000 >/dev/null && pass "a new turn allows the next recap" || fail "second recap"
send "epsilon"; $T wait "answer to: epsilon" --timeout 10000 >/dev/null || fail "turn 5"
screen | grep -q "Checked alpha, beta, gamma, delta" && fail "typing and sending hide the recap" || pass "typing and sending a prompt hide the recap"
$T press ctrl u >/dev/null; $T type "draft in progress" >/dev/null; sleep 4.5
screen | grep -q "✦ recap" && fail "a draft blocks the recap" || pass "no recap while the editor has a draft"
grep -q "skipped: a draft in the editor" $W/recap.log && pass "skip logged (draft)" || fail "draft skip reason"
$T press ctrl u >/dev/null

# 6. Continue the session: with no new turn since the saved recap, it is shown right away.
send "zeta"; $T wait "answer to: zeta" --timeout 10000 >/dev/null || fail "turn 6"
$T wait "Checked alpha, beta, gamma, delta, epsilon, zeta" --timeout 10000 >/dev/null || fail "third recap"
launch -c
$T wait "Checked alpha, beta, gamma, delta, epsilon, zeta" --timeout 10000 >/dev/null && pass "continued session shows the saved recap" || fail "resume shows saved"
[ "$(grep -rh '"customType":"recap"' $W/sessions | wc -l)" -eq 3 ] && pass "resume reused it (no new recap)" || fail "resume generated anew"
$T close >/dev/null 2>&1
echo "ALL PASSED"
