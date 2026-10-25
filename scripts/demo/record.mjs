#!/usr/bin/env node
/**
 * Records a terminal demo for the blog: runs a scene (JSON) in a real PTY with
 * tuistory, saves a PNG whenever the screen changes, and writes timeline.json
 * (frames with timestamps, plus named marks the composer uses for the camera).
 *
 *   node scripts/demo/record.mjs <scene.json> <out-dir>
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchTerminal } from "tuistory";
import { renderTerminalToImage } from "ghostty-opentui/image";

const [sceneFile, out] = process.argv.slice(2);
const scene = JSON.parse(readFileSync(sceneFile, "utf8"));
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "frames"), { recursive: true });

const cols = scene.cols ?? 100, rows = scene.rows ?? 30;
const session = await launchTerminal({
  command: scene.command[0], args: scene.command.slice(1), cols, rows,
  cwd: scene.cwd, env: { ...process.env, ...(scene.env ?? {}) }, waitForData: true, waitForDataTimeout: 20000,
});

const t0 = Date.now();
const frames = [];
const marks = [];
let last = "";
let busy = false;
let stopped = false;
const RENDER = { fontSize: 15, lineHeight: 1.45, devicePixelRatio: 2, theme: { background: "#16161a", text: "#d9d6cf" } };

async function capture() {
  if (busy) return;
  busy = true;
  try {
    const data = session.getTerminalData();
    const key = createHash("sha1").update(JSON.stringify(data)).digest("hex");
    if (key !== last) {
      last = key;
      const t = Date.now() - t0;
      // The renderer swaps inverse spans' colors but then fills both defaults back in, so
      // default-colored inverse (pi-tui's text selection) would vanish: resolve it here.
      for (const line of data.lines ?? []) for (const sp of line.spans ?? []) {
        if (!(sp.flags & 16)) continue;
        const fg = sp.fg ?? RENDER.theme.text, bg = sp.bg ?? RENDER.theme.background;
        sp.fg = bg; sp.bg = fg; sp.flags &= ~16;
      }
      const png = await renderTerminalToImage(data, RENDER);
      const file = `frames/${String(frames.length).padStart(5, "0")}.png`;
      writeFileSync(join(out, file), png);
      frames.push({ file, t });
    }
  } finally { busy = false; }
}
const timer = setInterval(() => { if (!stopped) void capture(); }, 50);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const s of scene.steps) {
  // `when`: run this step only if the screen shows the text (e.g. a dialog the model may or may not open).
  if (s.when && !(await session.text({ immediate: true })).includes(s.when)) continue;
  if (s.mark) marks.push({ name: s.mark, t: Date.now() - t0 });
  if (s.sleep) await sleep(s.sleep);
  if (s.type !== undefined) for (const ch of s.type) { session.writeRaw(ch); await sleep(s.speed ?? 28 + Math.random() * 30); }
  if (s.press) {
    // Key marks let the composer show a keystroke badge (enter and arrows only when asked to).
    const keys = [].concat(s.press);
    if (s.badge ?? !(keys.length === 1 && ["enter", "up", "down", "left", "right"].includes(keys[0]))) marks.push({ name: `key:${keys.join("+")}`, t: Date.now() - t0 });
    await session.press(s.press); await sleep(120);
  }
  if (s.raw) { session.writeRaw(s.raw); await sleep(80); }
  if (s.wait) {
    const deadline = Date.now() + (s.timeout ?? 120000);
    const re = s.wait.startsWith("/") ? new RegExp(s.wait.slice(1, s.wait.lastIndexOf("/")), s.wait.slice(s.wait.lastIndexOf("/") + 1)) : undefined;
    for (;;) {
      const text = await session.text({ immediate: true });
      if (re ? re.test(text) : text.includes(s.wait)) break;
      if (Date.now() > deadline) { console.error(`timeout waiting for ${s.wait}\n${text}`); process.exitCode = 1; break; }
      await sleep(150);
    }
    if (process.exitCode) break;
  }
  if (s.auto) {
    // Answers dialogs as they come: when the screen shows a key of `auto` and has been still for
    // `look` ms (so a viewer can read it), presses that key's keys; stops once `until` shows.
    const deadline = Date.now() + (s.timeout ?? 400000);
    let seen = 0;
    for (;;) {
      const text = await session.text({ immediate: true });
      if (text.includes(s.until)) break;
      if (Date.now() > deadline) { console.error(`timeout in auto step\n${text}`); process.exitCode = 1; break; }
      const hit = Object.keys(s.auto).find((k) => text.includes(k));
      if (!hit) seen = 0;
      else if (!seen) seen = Date.now();
      const look = s.look ?? 1800;
      if (hit && (Date.now() - t0 - (frames.at(-1)?.t ?? 0) >= look || Date.now() - seen >= look * 2)) {
        const shown = Math.max(seen, t0 + (frames.at(-1)?.t ?? 0)) - t0;
        for (const k of [].concat(s.auto[hit])) { await session.press(k); await sleep(700); }
        await sleep(600);
        // A hold window: the composer plays it at normal speed even inside a fast range.
        marks.push({ name: `hold${marks.length}a`, t: shown - 1200 }, { name: `hold${marks.length}b`, t: Date.now() - t0 });
        seen = 0;
      }
      await sleep(200);
    }
    if (process.exitCode) break;
  }
  if (s.settle) {
    // Waits until the screen has not changed for `settle` ms (the spinner stops when a run ends).
    const deadline = Date.now() + (s.timeout ?? 300000);
    await sleep(s.settle);
    while (Date.now() - t0 - (frames.at(-1)?.t ?? 0) < s.settle) {
      if (Date.now() > deadline) { console.error(`timeout settling at step ${JSON.stringify(s)}`); process.exitCode = 1; break; }
      await sleep(200);
    }
    if (process.exitCode) break;
    if (s.as) marks.push({ name: s.as, t: frames.at(-1).t });
  }
}
await sleep(scene.tail ?? 400);
await capture();
stopped = true;
clearInterval(timer);
while (busy) await sleep(20);
writeFileSync(join(out, "timeline.json"), JSON.stringify({ cols, rows, frames, marks, end: Date.now() - t0 }, null, 1));
session.close();
console.log(`${frames.length} frames, ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}`);
process.exit(process.exitCode ?? 0);
