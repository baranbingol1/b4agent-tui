#!/usr/bin/env node
// Shows what changed upstream in a vendored item since its pinned commit
// (plan section 21), so updates are pulled in deliberately, never
// automatically.
//
//   node scripts/vendor-diff.mjs                 list the entries in vendor.json
//   node scripts/vendor-diff.mjs <name> [--stat] [--log]
//
// It keeps a blob-less bare clone of each upstream under
// $B4AGENT_VENDOR_CACHE (default: <tmpdir>/b4agent-vendor), fetches the
// upstream's default branch, and runs `git log` and `git diff <pinned>
// FETCH_HEAD -- <path>`. Only git runs: nothing from the upstream is
// executed. To take an update, port the changes you want into `dest`, then
// update `commit` and `localChanges` in vendor.json and the skill's
// UPSTREAM.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { entries } = JSON.parse(readFileSync(join(root, "vendor.json"), "utf8"));
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
const stat = args.includes("--stat");
const logOnly = args.includes("--log");

if (!name || args.includes("--help")) {
  if (args.includes("--help")) console.log("usage: node scripts/vendor-diff.mjs <name> [--stat] [--log]\n");
  for (const e of entries) console.log(`${e.name.padEnd(26)} ${e.repo}  ${e.path}  @ ${e.commit.slice(0, 12)}`);
  process.exit(0);
}
const entry = entries.find((e) => e.name === name);
if (!entry) {
  console.error(`vendor-diff: no entry "${name}" in vendor.json. Entries: ${entries.map((e) => e.name).join(", ")}`);
  process.exit(1);
}

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...a], { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const cacheRoot = process.env.B4AGENT_VENDOR_CACHE ?? join(tmpdir(), "b4agent-vendor");
const slug = entry.repo.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
const cache = join(cacheRoot, slug);

mkdirSync(cacheRoot, { recursive: true });
if (!existsSync(join(cache, "HEAD"))) {
  process.stderr.write(`Cloning ${entry.repo} (blobs on demand) into ${cache}\n`);
  execFileSync("git", ["clone", "--quiet", "--bare", "--filter=blob:none", entry.repo, cache], { env, stdio: ["ignore", "inherit", "inherit"] });
}
process.stderr.write(`Fetching ${entry.repo}\n`);
git(cache, "fetch", "--quiet", "--no-tags", "origin", "HEAD");
const head = git(cache, "rev-parse", "FETCH_HEAD").trim();
try {
  git(cache, "cat-file", "-e", `${entry.commit}^{commit}`);
} catch {
  git(cache, "fetch", "--quiet", "--no-tags", "origin", entry.commit);
}

console.log(`${entry.name}: ${entry.repo} ${entry.path}`);
console.log(`pinned   ${entry.commit}`);
console.log(`upstream ${head}`);
console.log(`local    ${entry.dest} (${entry.license})`);
console.log(`local changes: ${entry.localChanges}`);
if (entry.upstreamRemoved) console.log(`note: upstream removed this path in ${entry.upstreamRemoved}; the diff below shows the deletion.`);

const log = git(cache, "log", "--format=%h %cs %an  %s", `${entry.commit}..${head}`, "--", entry.path).trim();
console.log(`\nUpstream commits touching ${entry.path} since the pin: ${log ? log.split("\n").length : 0}`);
if (!log) {
  console.log("Nothing to pull.");
  process.exit(0);
}
console.log(log);
if (logOnly) process.exit(0);
console.log("");
process.stdout.write(git(cache, "diff", ...(stat ? ["--stat"] : []), entry.commit, head, "--", entry.path));
