/**
 * Secrets never leave a past session through the history tools. The
 * credential patterns are the permission reviewer's (`redact` in
 * src/permissions/review/input.ts: private keys, OpenAI/GitHub/GitLab/Slack/
 * AWS/Google keys, JWTs, bearer tokens); on top of them, values assigned to a
 * secret-named variable or key (`OPENAI_API_KEY=…`, `"password": "…"`).
 * Applied to every piece of text before it is truncated (a cut through a
 * secret leaves a fragment no later pass recognizes; oh-my-pi's advisor
 * transcript does the same) and before anything reaches the small model.
 */
import { redact } from "../permissions/review/input.js";

/** `NAME=value`, `name: "value"`, `--password value` with a secret-looking name; the value needs a letter and a digit, so `token: string` and prose stay. */
const NAME = String.raw`[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|credential|private[_-]?key|auth)[A-Za-z0-9_-]*`;
const VALUE = String.raw`(?!process\.env|\$)([A-Za-z0-9_\-./+=~]{8,})`;
const ASSIGNED = new RegExp(String.raw`(\b${NAME}["']?\s*[:=]\s*["']?)${VALUE}`, "gi");
const FLAG = new RegExp(String.raw`(--${NAME}\s+["']?)${VALUE}`, "gi");

const keyLike = (v: string) => /[A-Za-z]/.test(v) && /[0-9]/.test(v);

export function scrub(s: string): string {
  const mask = (all: string, head: string, value: string) => (keyLike(value) ? `${head}[secret]` : all);
  return redact(s).replace(ASSIGNED, mask).replace(FLAG, mask);
}
