#!/bin/bash
# End-to-end: subdirectory AGENTS.md on demand and memory, in a real terminal,
# driven by tuistory and the scripted model. A probe extension (written to the
# temp dir) saves each request's full transcript, system message included, so
# the checks read what the model was actually sent. Prints PASS/FAIL per step.
#
#   tests/e2e/context.sh            (from anywhere)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4ctx-e2e.XXXX); P=$W/proj; T="npx --prefix $R tuistory -s ctx-e2e"
cat > $W/script.json <<JSON
{
  "read y": [{ "tool": "read", "args": { "path": "sub/y.ts" } }],
  "read y again": [{ "tool": "read", "args": { "path": "sub/y.ts" } }],
  "cd and test": [{ "tool": "bash", "args": { "command": "cd sub/deep && cat z.ts" } }],
  "read outside": [{ "tool": "read", "args": { "path": "$W/outside/o.ts" } }]
}
JSON
cat > $W/probe.ts <<TS
import { writeFileSync } from "node:fs";
export default function probe(pi: any) {
  let n = 0;
  pi.on("context_with_system", (e: any) => { writeFileSync("$W/request-" + ++n + ".json", JSON.stringify(e.messages)); });
}
TS
cat > $W/launch.sh <<SH
#!/bin/bash
cd $P
export B4AGENT_HOME=$W/home B4_SCRIPT=$W/script.json PI_CODING_AGENT_SESSION_DIR=$W/sessions PI_CODING_AGENT_DIR=$W/agent
exec "$R/node_modules/.bin/pi" -ne -ns --offline -e "$R/src/extension/index.ts" -e "$R/tests/e2e/scripted-model.ts" -e "$W/probe.ts" --model script/agent
SH
chmod +x $W/launch.sh
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; $T snapshot --trim 2>/dev/null | tail -25; $T close >/dev/null 2>&1; exit 1; }
send() { $T press ctrl u >/dev/null; $T type "$1" >/dev/null; $T press enter >/dev/null; }
last() { ls -t $W/request-*.json | head -1; }
# How often a marker appears in the tool results of the newest request (the scripted model's echoes don't count).
count() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).filter(m=>m.role==="toolResult");
console.log(m.map(r=>JSON.stringify(r.content)).join("").split(process.argv[2]).length-1)' "$(last)" "$1"; }

mkdir -p $P/sub/deep $W/outside $W/home/memory $W/agent
echo "root rules" > $P/AGENTS.md
printf 'SUBRULES-7f3 use tabs here\n<!-- HIDDEN-COMMENT -->\n' > $P/sub/AGENTS.md
echo "DEEPRULES-91c" > $P/sub/deep/CLAUDE.md
echo "y" > $P/sub/y.ts; echo "z" > $P/sub/deep/z.ts; echo "o" > $W/outside/o.ts
echo "OUTSIDERULES" > $W/outside/AGENTS.md
echo "- [Prefers pnpm](user_pnpm.md): MEMPNPM-42 use pnpm, never npm" > $W/home/memory/MEMORY.md
cd $P && git init -q -b main && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null

$T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/launch.sh -s ctx-e2e --cols 120 --rows 40 --background --timeout 15000 >/dev/null
$T wait "auto mode" --timeout 20000 >/dev/null || fail "start"

# 1. A nested AGENTS.md is appended to the read result, comments stripped; the memory section is in the request.
send "read y"; $T wait "RESULT read OK" --timeout 15000 >/dev/null || fail "read y"
sleep 0.5
[ "$(count 'SUBRULES-7f3')" = 1 ] && pass "sub/AGENTS.md appended to the tool result once" || fail "nested injection ($(count 'SUBRULES-7f3'))"
grep -q 'nested-instructions path=\\"sub/AGENTS.md\\"' "$(last)" && pass "wrapped in <nested-instructions path=\"sub/AGENTS.md\">" || fail "tag"
grep -q HIDDEN-COMMENT "$(last)" && fail "html comment leaked" || pass "HTML comment stripped"
grep -q '<memory>' "$(last)" && grep -q 'MEMPNPM-42' "$(last)" && pass "memory section with the global index in the request" || fail "memory section"
grep -q 'Save a memory when' "$(last)" && pass "save guidance in the main agent's section" || fail "save guidance"
$T wait "SUBRULES-7f3" --timeout 3000 >/dev/null && pass "the model saw it (scripted echo on screen)" || fail "echo"

# 2. The same read again: nothing new appended; still exactly one copy in the transcript.
send "read y again"; $T wait "RESULT read OK" --timeout 15000 >/dev/null; sleep 1
[ "$(count 'SUBRULES-7f3')" = 1 ] && pass "second read: not appended again" || fail "re-injected ($(count 'SUBRULES-7f3'))"

# 3. bash with a cd prefix brings in the deeper CLAUDE.md only (sub/AGENTS.md is already there).
send "cd and test"; $T wait "RESULT bash OK" --timeout 15000 >/dev/null || fail "bash"; sleep 0.5
[ "$(count 'DEEPRULES-91c')" = 1 ] && [ "$(count 'SUBRULES-7f3')" = 1 ] && pass "cd prefix loads sub/deep/CLAUDE.md once, nothing repeated" || fail "cd prefix"

# 4. Paths outside cwd load nothing.
send "read outside"; $T wait "RESULT read OK" --timeout 15000 >/dev/null || fail "outside"; sleep 0.5
grep -q OUTSIDERULES "$(last)" && fail "outside AGENTS.md loaded" || pass "outside cwd: nothing loaded"

# 5. The memory section is byte-stable across every request of the session.
node -e '
const fs=require("fs"),d=process.argv[1];
const sys=fs.readdirSync(d).filter(f=>f.startsWith("request-")).map(f=>JSON.parse(fs.readFileSync(d+"/"+f,"utf8"))[0]);
const mem=sys.map(m=>JSON.stringify(m).match(/<memory>[\s\S]*?<\/memory>/)?.[0]);
process.exit(mem.length>3 && mem.every(x=>x && x===mem[0]) ? 0 : 1);' $W && pass "memory section identical in all requests" || fail "memory section changed"

$T close >/dev/null 2>&1
echo "ALL PASSED"
