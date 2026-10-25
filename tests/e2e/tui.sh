#!/bin/bash
# End-to-end b4agent TUI pieces in a real terminal, driven by tuistory, the
# scripted model and tests/tui/probe.ts (a faux openai-codex reasoning model,
# a focus probe chip, and a chip counting the bells and titles written):
# the header and 3-line footer with chips, the changes chip and /changes, the
# theme picker, the Pac-Man spinner, the jobs chip, autotitle, focus reports in
# fullscreen and inline mode, the bell, the cold-cache hint after Tab, and a
# byte-stable environment prompt section. Prints PASS/FAIL per step;
# screenshots go to dist/shots.
#
#   tests/e2e/tui.sh            (from anywhere)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); W=$(mktemp -d /tmp/b4tui-e2e.XXXX); P=$W/proj; S=$R/dist/shots; SESSION=tui-a; T="npx --prefix $R tuistory -s $SESSION"
mkdir -p $S $W/agent $W/agent-inline $W/home
# The launcher's keybindings: Tab changes the effort.
echo '{ "app.thinking.cycle": "tab", "tui.input.tab": "shift+right" }' | tee $W/agent/keybindings.json > $W/agent-inline/keybindings.json
# Inline mode, with a bundled theme saved: Pi can't load it at startup without --theme, b4agent puts it back.
echo '{ "tuiMode": "regular", "theme": "nord" }' > $W/agent-inline/settings.json
# Titles come from the faux GPT (no small model has a login here).
echo '{ "models": { "roles": { "title": ["openai-codex/gpt-faux"] } } }' > $W/home/b4agent.json
cat > $W/script.json <<'JSON'
{
  "work": [[{ "tool": "edit", "args": { "path": "a.txt", "edits": [{ "oldText": "hello", "newText": "bye\nnew line" }] } }]],
  "slow": [[{ "tool": "bash", "args": { "command": "sleep 4; echo slept" } }]],
  "quick": [[{ "tool": "bash", "args": { "command": "echo quick" } }]],
  "bg": [[{ "tool": "bash", "args": { "command": "sleep 6; echo bg-done", "background": true } }]]
}
JSON
launcher() { # name, agent dir, model args
  cat > $W/$1.sh <<SH
#!/bin/bash
cd $P
export B4AGENT_HOME=$W/home B4_SCRIPT=$W/script.json PI_CODING_AGENT_SESSION_DIR=$W/sessions-$1 PI_CODING_AGENT_DIR=$2
exec "$R/node_modules/.bin/pi" -ne -ns -nc --offline -e "$R/src/extension/index.ts" -e "$R/tests/e2e/scripted-model.ts" -e "$R/tests/tui/probe.ts" $3
SH
  chmod +x $W/$1.sh
}
launcher a $W/agent "--model script/agent"
# With --theme (what the b4agent command should pass), the theme saved by the first session loads at startup.
launcher gpt $W/agent "--theme $R/themes --model openai-codex/gpt-faux --thinking medium"
launcher inline $W/agent-inline "--model script/agent"

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; $T snapshot --trim 2>/dev/null | tail -30; $T close >/dev/null 2>&1; exit 1; }
screen() { $T snapshot --trim 2>/dev/null; }
footer() { screen | tail -3; }
send() { $T press ctrl u >/dev/null; $T type "$1" >/dev/null; $T press enter >/dev/null; }
# Slash commands: the first Enter may only accept the autocomplete entry.
command() { $T press ctrl u >/dev/null; $T type "$1" >/dev/null; sleep 0.3; $T press enter >/dev/null; sleep 0.3; screen | tail -6 | grep -qF "$1" && $T press enter >/dev/null; sleep 0.5; }
start() { SESSION=$1; T="npx --prefix $R tuistory -s $SESSION"; $T close >/dev/null 2>&1; npx --prefix $R tuistory launch $W/$2.sh -s $SESSION --cols 110 --rows 40 --background --timeout 15000 >/dev/null; $T wait "auto mode" --timeout 20000 >/dev/null || fail "start $2"; sleep 0.5; }

cd $W && mkdir -p $P && cd $P && git init -q -b main && echo hello > a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null

# ---------------------------------------------------------------- fullscreen
start tui-a a

# 1. Header (wordmark, tip, keys, what loaded) and the footer: where, usage | model, chips.
screen | grep -q "██████╗ ██╗  ██╗ █████╗" && screen | grep -q "TIP " && screen | grep -q "shift+tab spec mode" && pass "header" || fail "header"
footer | head -1 | grep -q "proj (main)$" && footer | tail -1 | grep -q "^auto mode" && footer | sed -n 2p | grep -q "0% context .*(script) agent$" && pass "footer: three lines" || fail "footer lines"
$T screenshot -o $S/t1-default.png --pixel-ratio 2 >/dev/null

# 2. An edit adds the changes chip; autotitle names the session from the faux model.
send "work"; $T wait "RESULT edit OK" --timeout 15000 >/dev/null || fail "edit run"
$T wait "Δ1 +2 −1" --timeout 5000 >/dev/null && footer | tail -1 | grep -q "^auto mode · Δ1 +2 −1" && pass "changes chip after the permission mode" || fail "changes chip"
$T wait "Footer chips for the faux run" --timeout 10000 >/dev/null && footer | head -1 | grep -q "(main) • Footer chips for the faux run" && pass "autotitle names the session" || fail "autotitle"

# 3. /changes lists the file.
command "/changes"; $T wait "Changes on this branch: 1 file, +2 −1" --timeout 5000 >/dev/null && screen | grep -q "+2 −1  a.txt" && pass "/changes table" || fail "/changes"
$T screenshot -o $S/t4-changes.png --pixel-ratio 2 >/dev/null
$T press q >/dev/null; sleep 0.4; ! screen | grep -q "Press any key to close" && pass "any key closes /changes" || fail "/changes close"

# 4. /theme: b4agent is the default; arrows preview, Enter keeps one and saves it, Esc goes back.
command "/theme"; $T wait "IBM Carbon blues" --timeout 5000 >/dev/null || fail "picker"
screen | grep -q "→ b4agent .*(current)" && screen | grep -q "dracula .*it rhymes with spectacular" && pass "picker lists the pack, b4agent current" || fail "picker current"
$T screenshot -o $S/t2-picker.png --pixel-ratio 2 >/dev/null
for i in 1 2 3 4 5 6 7 8 9; do $T press down >/dev/null; done; sleep 0.3
screen | grep -q "→ dracula" || fail "picker move"
$T press enter >/dev/null; $T wait "Theme: dracula" --timeout 5000 >/dev/null && grep -q '"theme": "dracula"' $W/agent/settings.json && pass "enter applies and saves dracula" || fail "theme save"
$T screenshot -o $S/t3-dracula.png --pixel-ratio 2 >/dev/null
command "/theme"; $T wait "→ dracula" --timeout 5000 >/dev/null || fail "picker again"; $T press down >/dev/null; sleep 0.3; screen | grep -q "→ rose-pine" || fail "preview move"; $T press escape >/dev/null; sleep 0.4
grep -q '"theme": "dracula"' $W/agent/settings.json && command "/theme" && screen | grep -q "→ dracula .*(current)" && pass "esc keeps the saved theme" || fail "theme esc"
$T press escape >/dev/null

# 5. Spinner: Pac-Man and a Turkish word while it works; the title shows ⚙.
send "slow"; $T wait "esc to interrupt" --timeout 8000 >/dev/null
line=$(screen | grep "esc to interrupt" | head -1)
echo "$line" | grep -q "[ᗧᗤ○]" && echo "$line" | grep -qi "yorum\|ediyorum\|yapıyorum" && pass "pac-man spinner with a Turkish word" || fail "spinner: $line"
footer | grep -q 'title ⚙ b4agent — Footer chips for the faux run — proj' && pass "title shows ⚙ while working" || fail "working title"
$T wait "RESULT bash OK: slept" --timeout 15000 >/dev/null || fail "slow run"
sleep 0.5; ! screen | grep -q "esc to interrupt" && footer | grep -q 'title ✓ b4agent' && pass "spinner gone, title ✓ when done" || fail "done title"
footer | grep -q "bells 0" && pass "no bell while focused" || fail "bell while focused"

# 6. Jobs chip while a background job runs.
send "bg"; $T wait "1 job running" --timeout 10000 >/dev/null && pass "jobs chip" || fail "jobs chip"
for i in $(seq 40); do footer | grep -q "job running" || break; sleep 0.5; done
! footer | grep -q "job running" && screen | grep -q "bash-1.*done\|bash-1 finished\|bash-1.*exit" && pass "jobs chip clears when the job ends" || fail "jobs chip clear"

# 7. Focus reports (DEC 1004) reach b4agent in fullscreen, where Pi's viewport consumes them before onTerminalInput.
$T type $'\e[O' >/dev/null; $T wait "probe: away" --timeout 3000 >/dev/null && pass "focus out seen in fullscreen" || fail "focus out"
$T type $'\e[I' >/dev/null; $T wait "probe: back" --timeout 3000 >/dev/null && pass "focus in seen in fullscreen" || fail "focus in"

# 8. The bell rings for a run that ends while the window is unfocused, and not for one that ends focused.
send "slow"; sleep 1; $T type $'\e[O' >/dev/null; $T wait "probe: away" --timeout 3000 >/dev/null
$T wait "bells 1" --timeout 15000 >/dev/null && pass "bell when the run ends unfocused" || fail "bell away"
$T type $'\e[I' >/dev/null; send "quick"; $T wait "RESULT bash OK: quick" --timeout 10000 >/dev/null; sleep 0.5
footer | grep -q "bells 1" && pass "no bell for a focused run" || fail "bell focused"

# 9. The environment section went out once and was never resent across the turns (byte-stable).
f=$(ls $W/sessions-a/*.jsonl | head -1)
[ "$(grep -o '<environment>' "$f" | wc -l)" = 1 ] && grep -q 'Date: 20' "$f" && pass "environment section sent once over $(grep -c '"role":"user"' "$f") turns" || fail "environment section"
$T close >/dev/null 2>&1

# ---------------------------------------------------------- cold cache (GPT)
start tui-gpt gpt
! screen | grep -q "Failed to load theme" && command "/theme" && screen | grep -q "→ dracula .*(current)" && pass "saved theme loads at startup with --theme" || fail "saved theme with --theme"
$T press escape >/dev/null
send "hello"; $T wait "FAUX REPLY to hello" --timeout 15000 >/dev/null || fail "gpt reply"
sleep 0.5; ! footer | grep -q "cold cache" && pass "no hint before an effort change" || fail "early hint"
$T press tab >/dev/null; sleep 0.5
footer | grep -q "gpt-faux • high · cold cache" && pass "tab mid-conversation shows cold cache" || fail "cold cache hint"
$T screenshot -o $S/t5-cold-cache.png --pixel-ratio 2 >/dev/null
send "again"; $T wait "FAUX REPLY to again" --timeout 15000 >/dev/null; sleep 0.5
! footer | grep -q "cold cache" && pass "hint gone after the next turn" || fail "hint after turn"
# high -> off, minimal, low (cold) -> medium: warm again, sent a minute ago.
$T press tab >/dev/null; sleep 0.3; footer | grep -q "thinking off · cold cache" || fail "cold after tab to off"
for i in 1 2 3; do $T press tab >/dev/null; sleep 0.3; done
footer | grep -q "gpt-faux • medium" && ! footer | grep -q "cold cache" && pass "back to a recently used effort: no hint" || fail "warm effort"
$T close >/dev/null 2>&1

# ------------------------------------------------------------------- inline
start tui-inline inline
$T type "ab" >/dev/null; $T type $'\e[O' >/dev/null; $T wait "probe: away" --timeout 3000 >/dev/null || fail "inline focus out"
$T type $'\e[I' >/dev/null; $T type "cd" >/dev/null; $T wait "probe: back" --timeout 3000 >/dev/null || fail "inline focus in"
screen | grep -qx "abcd" && ! screen | grep -q "\[O\|\[I" && pass "inline: focus reports tracked and kept out of the editor" || fail "inline editor"
command "/theme"; screen | grep -q "→ nord .*(current)" && pass "a saved bundled theme is put back without --theme" || fail "saved theme fallback"
$T press escape >/dev/null
$T close >/dev/null 2>&1

echo "ALL PASSED"
