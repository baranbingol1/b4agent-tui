/**
 * web_fetch and web_search verdicts (plan section 18, "Permissions" and
 * hardening point 2).
 *
 * web_fetch is a GET, so the risk is what the URL itself carries out
 * (exfiltration) and where the URL came from (an injected page steering the
 * agent):
 * - deny: credentials in the URL, over 2000 characters, not http(s);
 * - ask: a secret-looking or high-entropy path segment or query value, or a
 *   value of a secret environment variable (the reviewer can't clear these);
 * - allow: well-known documentation hosts (also in manual mode);
 * - auto: a URL that appeared in a user message or an earlier web_fetch or
 *   web_search result (Claude Code's remote-mode provenance rule);
 * - review: any other URL. In auto mode the reviewer judges it against the
 *   user's request; in manual mode the user is asked, with a grant per host.
 *
 * web_search sends a query to the same provider that already sees the whole
 * conversation, so it is allowed.
 */
import { redact } from "../review/input.js";
import type { PermissionContext, Verdict } from "../types.js";

export const MAX_URL_LENGTH = 2000;

/**
 * Documentation hosts fetched without asking in either mode (Claude Code
 * preapproves a similar list). Exact hosts only: subdomains are not covered.
 */
export const DOCS_HOSTS = new Set([
  "developer.mozilla.org", "nodejs.org", "docs.python.org", "peps.python.org", "docs.rs", "doc.rust-lang.org", "go.dev", "pkg.go.dev",
  "www.typescriptlang.org", "react.dev", "nextjs.org", "vuejs.org", "svelte.dev", "docs.djangoproject.com", "flask.palletsprojects.com",
  "docs.npmjs.com", "docs.github.com", "learn.microsoft.com", "kubernetes.io", "docs.docker.com", "man7.org", "en.cppreference.com",
  "docs.oracle.com", "developer.apple.com", "developer.android.com", "docs.aws.amazon.com", "www.postgresql.org", "dev.mysql.com",
  "sqlite.org", "www.sqlite.org", "redis.io", "git-scm.com", "docs.astral.sh", "docs.pytest.org", "numpy.org", "pandas.pydata.org",
  "pytorch.org", "docs.ruby-lang.org", "www.php.net", "kotlinlang.org", "docs.swift.org", "developer.hashicorp.com", "nginx.org",
  "tailwindcss.com", "vitejs.dev", "vite.dev", "vitest.dev", "jestjs.io", "eslint.org", "prettier.io", "webpack.js.org", "bun.sh",
  "deno.land", "docs.deno.com", "www.rfc-editor.org", "datatracker.ietf.org", "html.spec.whatwg.org", "tc39.es", "www.w3.org",
]);

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * A token that looks like a key or encoded data rather than a word, slug,
 * hash or id: at least 24 characters, at least three of lower, upper,
 * digit and symbol, and over 4.2 bits of entropy per character. Git SHAs and
 * UUIDs don't qualify (hex is two classes; a UUID's entropy is about 3.7).
 */
export function looksSecret(token: string): boolean {
  if (token.length < 24) return false;
  if (redact(token) !== token) return true;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(token)).length;
  return classes >= 3 && entropy(token) > 4.2;
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};

/** Why a URL looks like it carries data out, or undefined. */
export function exfiltrationReason(url: URL, env?: Readonly<Record<string, string | undefined>>): string | undefined {
  const full = decode(url.href);
  if (redact(full) !== full) return "the URL contains something that looks like a credential";
  for (const [k, v] of Object.entries(env ?? {})) {
    // Paths and short values (SSH_AUTH_SOCK, XDG_SESSION_TYPE) aren't secrets worth matching.
    if (!v || v.length < 12 || v.startsWith("/") || !SECRET_ENV.test(k)) continue;
    if (full.includes(v) || url.href.includes(encodeURIComponent(v))) return `the URL contains the value of $${k}`;
  }
  const tokens: string[] = [];
  for (const seg of url.pathname.split("/")) if (seg) tokens.push(decode(seg));
  for (const [k, v] of url.searchParams) tokens.push(k, v);
  if (url.hash) tokens.push(decode(url.hash.slice(1)));
  // Values hidden in a longer segment: split on separators that ids rarely contain.
  for (const t of [...tokens]) for (const part of t.split(/[.,;:=&\s]+/)) if (part !== t) tokens.push(part);
  const hit = tokens.find(looksSecret);
  if (hit) return `the URL carries a high-entropy value (${hit.slice(0, 6)}…, ${hit.length} characters), which could be data being sent out`;
  return undefined;
}

export function normalizeForMatch(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    let s = u.href;
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return undefined;
  }
}

export function classifyWebFetch(input: Record<string, unknown>, ctx: PermissionContext): Verdict {
  const raw = typeof input.url === "string" ? input.url.trim() : "";
  if (!raw) return { level: "review", rule: "web-fetch", reason: "web_fetch without a URL" };
  if (raw.length > MAX_URL_LENGTH) return { level: "deny", rule: "web-url-too-long", reason: `the URL is ${raw.length} characters long (limit ${MAX_URL_LENGTH})`, fix: "Fetch a shorter URL; long URLs are how data gets smuggled out." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { level: "review", rule: "web-fetch", reason: "web_fetch with an invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { level: "deny", rule: "web-scheme", reason: `web_fetch only fetches http and https, not ${url.protocol}`, fix: "Use read for local files." };
  if (url.username || url.password) return { level: "deny", rule: "web-credentials", reason: "the URL carries a username or password", fix: "Fetch the URL without credentials; web_fetch never sends them." };
  const exfil = exfiltrationReason(url, ctx.env);
  if (exfil) return { level: "ask", rule: "web-exfiltration", reason: `web_fetch ${url.host}: ${exfil}` };
  const host = url.hostname.toLowerCase();
  if (DOCS_HOSTS.has(host)) return { level: "allow", rule: "web-docs", reason: `${host} is a documentation site` };
  const key = normalizeForMatch(raw);
  if (key && ctx.seenUrl?.(key)) return { level: "auto", rule: "web-seen", reason: `GET ${url.host}: the URL came from the user or an earlier web result` };
  return { level: "review", rule: "web-unseen", reason: `GET ${url.host}: a URL the agent wrote itself (not from the user or a web result)` };
}

export function classifyWebSearch(): Verdict {
  return { level: "allow", rule: "web-search", reason: "web_search sends a query to the model provider, which already sees the conversation" };
}
