/**
 * Where painted images go, and reference images for edits.
 * Images are saved under `~/.b4agent/projects/<repo>/images/YYYY-MM-DD-<slug>.<ext>`
 * (the checkpoint store's per-worktree folder); the agent copies one into the
 * repository only when asked.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { projectDir } from "../checkpoints/store.js";
import { gitInfo } from "../permissions/git.js";
import { imageFileName, MAX_DATA_URL_CHARS, MAX_REFERENCE_IMAGES, sniffImage } from "./request.js";

export function imagesDir(b4agentDir: string, cwd: string): string {
  return join(projectDir(b4agentDir, gitInfo(cwd).root ?? cwd), "images");
}

/** Writes the image without overwriting: `name.png`, then `name-2.png`, ... Returns the path. */
export function saveImage(dir: string, title: string, ext: string, bytes: Buffer, now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const path = join(dir, imageFileName(title, ext, now, n));
    try {
      writeFileSync(path, bytes, { flag: "wx" });
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n > 999) throw e;
    }
  }
}

/** Reference images as data URLs. Paths are relative to cwd; `~` is the home folder. */
export function loadReferences(paths: string[], cwd: string): string[] {
  if (paths.length > MAX_REFERENCE_IMAGES) throw new Error(`at most ${MAX_REFERENCE_IMAGES} reference images`);
  return paths.map((p) => {
    const abs = p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(cwd, p);
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      throw new Error(`reference image not found: ${p}`);
    }
    if (size > (MAX_DATA_URL_CHARS / 4) * 3 - 64) throw new Error(`reference image is over 15 MB: ${p}`);
    const bytes = readFileSync(abs);
    const kind = sniffImage(bytes);
    if (!kind) throw new Error(`reference image is not a PNG, JPEG, WebP or GIF: ${p}`);
    return `data:${kind.mime};base64,${bytes.toString("base64")}`;
  });
}
