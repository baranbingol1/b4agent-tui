#!/bin/bash
# End-to-end: settings-defined shell hooks (plan section 28) in print mode,
# through the built `b4agent` command (run `npm run build` first) with the
# scripted model and a probe that saves every request the model is sent.
# Covers: a PreToolUse hook blocking `rm` with a message the model sees (and
# its `if` filter letting `ls` through), a PostToolUse hook adding context,
# a Stop hook making the agent continue exactly once, SessionStart context,
# a hook's ask reaching the gate (headless: blocked), and a hook's allow not
# lifting a hard deny. Prints PASS/FAIL per step.
#
#   tests/e2e/hooks.sh            (from anywhere)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4hooks-e2e.XXXX); P=$W/proj
mkdir -p $P/build $W/home $W/agent $W/hooks
[ -f "$R/dist/src/cli.js" ] || { echo "FAIL build first: npm run build"; exit 1; }
# An empty login file, or the b4agent command copies your real Pi logins in on first run.
echo '{}' > $W/agent/auth.json
trap 'rm -rf $W' EXIT

# The hooks: plain sh, reading stdin like Claude Code hooks do.
cat > $W/hooks/no-rm.sh <<'SH'
#!/bin/sh
cat > /dev/null
echo "Blocked: use trash instead of rm (HOOKMSG-7)" >&2
exit 2
SH
cat > $W/hooks/post-write.sh <<'SH'
#!/bin/sh
cat > /dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"POSTCTX-3 gen.ts is generated; edit gen.template instead"}}'
SH
cat > $W/hooks/stop.sh <<SH
#!/bin/sh
IN=\$(cat)
echo "\$IN" >> $W/stop-calls.jsonl
case "\$IN" in *'"stop_hook_active":true'*) exit 0;; esac
case "\$IN" in *STOPME*) echo "STOPHOOK-9 check the build once more" >&2; exit 2;; esac
exit 0
SH
cat > $W/hooks/session-start.sh <<'SH'
#!/bin/sh
cat > /dev/null
echo "SESSCTX-1 the deploy target is staging"
SH
cat > $W/hooks/ask-touch.sh <<'SH'
#!/bin/sh
cat > /dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"ASKHOOK-4 touching files needs a human"}}'
SH
cat > $W/hooks/allow-all.sh <<'SH'
#!/bin/sh
cat > /dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"allow-all hook"}}'
SH
chmod +x $W/hooks/*.sh

cat > $W/home/b4agent.json <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "if": "Bash(rm *)", "command": "$W/hooks/no-rm.sh" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "if": "Bash(touch *)", "command": "$W/hooks/ask-touch.sh" }] },
      { "matcher": "bash", "hooks": [{ "type": "command", "if": "Bash(echo *)", "command": "$W/hooks/allow-all.sh" }] }
    ],
    "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "$W/hooks/post-write.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "$W/hooks/stop.sh" }] }],
    "SessionStart": [{ "matcher": "startup", "hooks": [{ "type": "command", "command": "\"\${CLAUDE_PROJECT_DIR}/../hooks/session-start.sh\"" }] }]
  }
}
JSON

cat > $W/script.json <<JSON
{
  "remove build": [{ "tool": "bash", "args": { "command": "rm -rf build" } }, { "tool": "bash", "args": { "command": "ls" } }],
  "write gen": [{ "tool": "write", "args": { "path": "gen.ts", "content": "export const x = 1;\n" } }],
  "STOPHOOK-9 check the build once more": [{ "tool": "bash", "args": { "command": "printf REBUILT-5" } }],
  "touch it": [{ "tool": "bash", "args": { "command": "touch asked.txt" } }],
  "guard": [{ "tool": "bash", "args": { "command": "echo pwned >> $W/home/permissions.log" } }]
}
JSON
cat > $W/probe.ts <<TS
import { writeFileSync } from "node:fs";
export default function probe(pi: any) {
  pi.on("context_with_system", (e: any) => { writeFileSync("$W/request-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".json", JSON.stringify(e.messages)); writeFileSync("$W/tools.json", JSON.stringify(pi.getActiveTools())); });
}
TS
cd $P && git init -q -b main && echo "x" > build/out.txt && echo "build" > .gitignore && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; echo "$OUT" | tail -15; exit 1; }
run() { rm -f $W/request-*.json; OUT=$(cd $P && B4AGENT_HOME=$W/home B4_SCRIPT=$W/script.json PI_CODING_AGENT_SESSION_DIR=$W/sessions PI_CODING_AGENT_DIR=$W/agent \
  timeout 60 node "$R/dist/src/cli.js" -ne -ns -nc --offline --no-themes -e "$R/tests/e2e/scripted-model.ts" -e "$W/probe.ts" --model script/agent -p "$1" 2>&1); }
# Every request of the last run, joined.
requests() { cat $W/request-*.json 2>/dev/null; }

# 1. PreToolUse blocks rm; the model sees the hook's stderr; ls (outside the `if`) runs.
run "remove build"
echo "$OUT" | grep -q "RESULT bash ERROR: PreToolUse:Bash hook \[.*no-rm.sh\] blocked this call: Blocked: use trash instead of rm (HOOKMSG-7)" && pass "PreToolUse exit 2 blocks rm; the model got the reason" || fail "rm block"
[ -f $P/build/out.txt ] && pass "build/ still there" || fail "rm ran"
echo "$OUT" | grep -q "RESULT bash OK: build" && pass "ls didn't match Bash(rm *) and ran" || fail "ls"

# 2. PostToolUse adds context to the write result.
run "write gen"
echo "$OUT" | grep -q "RESULT write OK: .*POSTCTX-3 gen.ts is generated" && pass "PostToolUse additionalContext next to the tool result (model echo)" || fail "post context"
requests | grep -q 'PostToolUse hook additional context:\\nPOSTCTX-3' && pass "in the request the model was sent" || fail "post context request"
requests | grep -q 'SESSCTX-1 the deploy target is staging' && pass "SessionStart stdout reached the first request (\${CLAUDE_PROJECT_DIR} expanded)" || fail "session start"
# Before the prompt, as in Claude Code (the scripted model answers the last user-side message, so step 1 relies on this too).
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).map(m=>JSON.stringify(m));
const s=m.findIndex(x=>x.includes("SESSCTX-1")), u=m.findIndex(x=>x.includes("write gen"));
process.exit(s>=0&&u>s?0:1)' "$(ls $W/request-*.json | head -1)" && pass "SessionStart context sits before the first prompt" || fail "session start order"

# 3. A Stop hook continues the agent once; the second Stop sees stop_hook_active and lets it end.
rm -f $W/stop-calls.jsonl
run "STOPME please"
[ "$(wc -l < $W/stop-calls.jsonl)" = 2 ] && pass "Stop hook ran twice (block, then allow)" || fail "stop calls: $(wc -l < $W/stop-calls.jsonl)"
head -1 $W/stop-calls.jsonl | grep -q '"stop_hook_active":false' && sed -n 2p $W/stop-calls.jsonl | grep -q '"stop_hook_active":true' && pass "stop_hook_active false, then true" || fail "stop_hook_active"
echo "$OUT" | grep -q "RESULT bash OK: REBUILT-5" && pass "the agent continued with the hook's reason and acted on it" || fail "continue"
requests | grep -q 'Stop hook feedback:\\nSTOPHOOK-9' && pass "the reason went to the model as a message" || fail "stop feedback in request"
[ "$(grep -c '"hook_event_name":"Stop"' $W/stop-calls.jsonl)" = 2 ] && grep -q '"last_assistant_message":"NO SCRIPT for: STOPME please"' $W/stop-calls.jsonl && pass "Stop input carries last_assistant_message" || fail "stop input"

# 4. A hook's ask reaches the gate: headless, nobody can answer, so it's blocked.
run "touch it"
[ ! -e $P/asked.txt ] && echo "$OUT" | grep -q "needs the user's approval (a PreToolUse hook asks for confirmation: ASKHOOK-4" && pass "hook ask → user dialog → blocked headless" || fail "ask"

# 5. A hook's allow never lifts a hard deny.
run "guard"
# The gate's audit log records the command; the write itself would add a line that is just "pwned".
! grep -qx pwned $W/home/permissions.log && echo "$OUT" | grep -q "Blocked by b4agent's permission gate (own-guard)" && pass "hook allow doesn't override the hard deny" || fail "hard deny"

# 6. Print mode exits cleanly when the after-edit diagnostics check outlives the session.
node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));c.diagnostics={enabled:true,command:"sleep 2"};require("fs").writeFileSync(f,JSON.stringify(c))' $W/home/b4agent.json
run "write gen"; CODE=$?
[ $CODE = 0 ] && ! echo "$OUT" | grep -q "ctx is stale" && pass "print mode exits 0 with a diagnostics check still running" || fail "diagnostics after exit (code $CODE)"

# 7. Headless: no one can answer, so the interactive-only tools are gone and the prompt says so.
run "write gen"
! grep -q '"ask_user"\|"agent_create"' $W/tools.json && grep -q '"bash"' $W/tools.json && pass "print mode drops ask_user and agent_create" || fail "headless tools: $(cat $W/tools.json)"
requests | grep -q 'Nobody is watching this session' && pass "print mode adds the headless section" || fail "headless section"
