/** Pure path helpers shared by the history tools and their permission rule. */
import { posix, resolve } from "node:path";

/** Pi's folder name for a cwd under `<agentDir>/sessions` (getDefaultSessionDirPath in Pi 1.3's session-manager.js). */
export function sessionDirName(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** Whether a session started in `cwd` belongs to the project at `root`. */
export function inProject(cwd: string, root: string): boolean {
  return Boolean(cwd) && inside(posix.normalize(cwd), posix.normalize(root));
}
