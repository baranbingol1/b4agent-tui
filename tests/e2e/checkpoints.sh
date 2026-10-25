#!/bin/bash
# End-to-end checkpoint scenario in a real terminal, driven by tuistory and the
# scripted model: two agent runs, your own edits in between, then /rewind,
# undo, and Pi's /tree in both directions. Prints PASS/FAIL per step.
#
#   tests/e2e/checkpoints.sh            (from anywhere; screenshots go to dist/shots)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4cp-e2e.XXXX); P=$W/proj; S=$R/dist/shots; T="npx --prefix $R tuistory -s cp"
mkdir -p $S
cat > $W/script.json <<'JSON'
{
  "first change": [{ "tool": "bash", "args": { "command": "echo a2 > src/a.ts && rm src/b.ts" } }],
  "second change": [
    { "tool": "write", "args": { "path": "src/new.ts", "content": "export const n = 1;\n" } },
    { "tool": "bash", "args": { "command": "echo c-agent > src/c.ts" } }
  ]
}
JSON
cat > $W/launch.sh <<SH
#!/bin/bash
cd $P
export B4AGENT_HOME=$W/home B4_SCRIPT=$W/script.json PI_CODING_AGENT_SESSION_DIR=$W/sessions
exec "$R/node_modules/.bin/pi" -ne -ns -nc --offline -e "$R/src/extension/index.ts" -e "$R/tests/e2e/scripted-model.ts" --model script/agent
SH
chmod +x $W/launch.sh
check() { local got; got=$(cd $P && for f in a b c new; do printf '%s=%s ' $f "$(cat src/$f.ts 2>/dev/null | head -c 20 || true)"; done); if [ "$got" = "$1" ]; then echo "PASS $2"; else echo "FAIL $2: got [$got] want [$1]"; exit 1; fi; }
screen() { $T snapshot --trim 2>/dev/null; }
pick_tree() { $T press ctrl u >/dev/null; $T type "/tree" >/dev/null; $T press enter >/dev/null; sleep 1.5; for _ in $(seq $2); do $T press $1 >/dev/null; done; $T press enter >/dev/null; sleep 1; screen | grep -q "Summarize branch" && $T press enter >/dev/null; }

mkdir -p $P/src $W/home && cd $P && git init -q -b main && echo a1 > src/a.ts && echo b1 > src/b.ts && echo c1 > src/c.ts && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null
$T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/launch.sh -s cp --cols 110 --rows 36 --background --timeout 15000 >/dev/null
$T wait "auto mode" --timeout 20000 >/dev/null
$T type "first change" >/dev/null; $T press enter >/dev/null; $T wait "RESULT bash OK" --timeout 20000 >/dev/null
echo c-user > $P/src/c.ts                       # you edit c.ts between runs
$T type "second change" >/dev/null; $T press enter >/dev/null; $T wait "RESULT write OK" --timeout 20000 >/dev/null; sleep 1
echo a-user > $P/src/a.ts                       # and a.ts after the agent's last edit to it
check "a=a-user b= c=c-agent new=export const n = 1; " "setup"

# 1. /rewind to before "first change": code + conversation, a.ts conflict -> restore anyway
$T type "/rewind" >/dev/null; $T press enter >/dev/null; $T wait "Rewind to before" --timeout 15000 >/dev/null
$T press down >/dev/null; $T press enter >/dev/null; $T wait "The agent changed 4 files" --timeout 15000 >/dev/null
$T press enter >/dev/null; $T wait "src/a.ts" --timeout 15000 >/dev/null; screen | grep -q "1 of these files changed after" || { echo "FAIL no conflict prompt"; exit 1; }
$T press enter >/dev/null; $T wait "Restored 4 files" --timeout 15000 >/dev/null || { echo "FAIL no restored notice"; exit 1; }
check "a=a1 b=b1 c=c-user new= " "rewind keeps your c.ts edit made between runs"
screen | tail -7 | grep -q "first change" && echo "PASS prompt refilled with the message" || { echo "FAIL prompt not refilled"; exit 1; }
$T screenshot -o $S/7-rewound.png --pixel-ratio 2 >/dev/null

# 2. undo: files and conversation come back
$T press ctrl u >/dev/null; $T type "/rewind" >/dev/null; $T press enter >/dev/null; $T wait "Undo the last file rewind" --timeout 15000 >/dev/null; $T press enter >/dev/null
$T wait "Put back 4 files and the conversation" --timeout 15000 >/dev/null || { echo "FAIL undo notice"; exit 1; }
check "a=a-user b= c=c-agent new=export const n = 1; " "undo restores files"
screen | grep -q "RESULT write OK" && echo "PASS undo restores the conversation" || { echo "FAIL conversation not restored"; exit 1; }

# 3. /tree to before "second change": offers only that turn's files, no conflict
pick_tree up 3; $T wait "Also restore files" --timeout 15000 >/dev/null || { echo "FAIL no offer"; exit 1; }
screen | grep -q "The agent changed 2 files" && ! screen | grep -q "src/a.ts" && echo "PASS offer lists c.ts and new.ts only" || { echo "FAIL offer:"; screen | grep -A6 "Also restore"; exit 1; }
$T screenshot -o $S/8-tree-offer.png --pixel-ratio 2 >/dev/null
$T press down >/dev/null; $T press enter >/dev/null; $T wait "Restored 2 files" --timeout 15000 >/dev/null || { echo "FAIL no notice after tree"; exit 1; }
check "a=a-user b= c=c-user new= " "tree restore leaves a.ts alone"

# 4. /tree forward to the end of run 2: redo
pick_tree down 4; $T wait "Also restore files" --timeout 15000 >/dev/null || { echo "FAIL no redo offer"; exit 1; }
$T press down >/dev/null; $T press enter >/dev/null; $T wait "Restored 2 files" --timeout 15000 >/dev/null
check "a=a-user b= c=c-agent new=export const n = 1; " "tree forward redoes run 2"
(cd $P && git status --porcelain --ignored | grep -v "^ M\|^ D\|^??" ) && echo "WARN unexpected git state"
$T close >/dev/null; rm -rf $W
echo ALL PASSED
