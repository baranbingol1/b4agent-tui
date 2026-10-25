import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetcher, parseFetchUrl, redirectAllowed, rewriteUrl, type FetcherOptions, type FetchResult, type Page } from "../../src/web/fetch.js";
import { detectCharset } from "../../src/web/convert.js";
import { fakeResolver, LONG_MD, PNG_1X1, startServer, type TestServer } from "./server.js";

let srv: TestServer;
const temp = mkdtempSync(join(tmpdir(), "b4-web-test-"));
beforeAll(async () => {
  srv = await startServer();
});
afterAll(() => srv.close());

const make = (o: FetcherOptions = {}) => createFetcher({ resolver: fakeResolver(), allowLoopback: true, hostIntervalMs: 0, maxRetryWaitMs: 10, tempDir: temp, ...o });
const page = (r: FetchResult): Page => {
  if (r.kind !== "page") throw new Error(`expected a page, got ${r.kind}`);
  return r;
};
const site = (p: string) => srv.url(p, "site.test");

describe("SSRF guard through the fetcher", () => {
  it("refuses a DNS name that resolves to 127.0.0.1, without connecting", async () => {
    const f = make({ allowLoopback: false, resolver: fakeResolver({ "rebind.test": "127.0.0.1" }) });
    const before = srv.hits.get("/target") ?? 0;
    await expect(f.fetch(srv.url("/target", "rebind.test"))).rejects.toThrow(/rebind\.test resolves to 127\.0\.0\.1, which is a loopback address/);
    expect(srv.hits.get("/target") ?? 0).toBe(before);
  });

  it("refuses IPv4-mapped IPv6 loopback, in the form the URL parser normalizes to", async () => {
    const f = make({ allowLoopback: false });
    await expect(f.fetch(`http://[::ffff:127.0.0.1]:${srv.port}/target`)).rejects.toThrow(/IPv4-mapped IPv6 address of a loopback/);
    await expect(f.fetch(`http://2130706433:${srv.port}/target`)).rejects.toThrow(/loopback/);
    await expect(f.fetch(`http://169.254.169.254/latest/meta-data/`)).rejects.toThrow(/metadata/);
    await expect(f.fetch(`http://localhost:${srv.port}/target`)).rejects.toThrow(/loopback name/);
  });

  it("re-checks every redirect hop: a same-host hop can't reach a name that resolves inside", async () => {
    // site.test is public here; the redirect goes to www.site.test, which resolves to loopback.
    const f = make({ allowLoopback: false, resolver: fakeResolver({ "site.test": "93.184.216.34", "www.site.test": "127.0.0.1" }) });
    await expect(f.fetch(`http://www.site.test:${srv.port}/article`)).rejects.toThrow(/loopback/);
  });

  it("refuses credentials, other schemes and URLs over 2000 characters", () => {
    expect(() => parseFetchUrl("https://user:pw@example.com/")).toThrow(/username or password/);
    expect(() => parseFetchUrl("file:///etc/passwd")).toThrow(/http and https/);
    expect(() => parseFetchUrl(`https://example.com/${"a".repeat(2000)}`)).toThrow(/over 2000/);
  });
});

describe("redirects", () => {
  it("returns a cross-host redirect instead of following it", async () => {
    const before = srv.hits.get("/target") ?? 0;
    const { result } = await make().fetch(site("/cross"));
    expect(result).toMatchObject({ kind: "redirect", status: 302, location: srv.url("/target", "other.test") });
    expect(srv.hits.get("/target") ?? 0).toBe(before);
  });

  it("follows a same-host redirect and a www. one", async () => {
    expect(page((await make().fetch(site("/same"))).result).title).toBe("Widget docs");
    const www = page((await make().fetch(site("/www"))).result);
    expect(www.url).toBe(srv.url("/article", "www.site.test"));
    expect(www.notes.join(" ")).toMatch(/Redirected to/);
  });

  it("returns a redirect to another port, and stops a loop", async () => {
    expect((await make().fetch(site("/port"))).result.kind).toBe("redirect");
    await expect(make().fetch(site("/loop"))).rejects.toThrow(/More than 10 redirects/);
  });

  it("allows only same scheme, port and host (www.-insensitive), plus an http to https upgrade", () => {
    const u = (s: string) => new URL(s);
    expect(redirectAllowed(u("https://a.com/x"), u("https://www.a.com/y"))).toBe(true);
    expect(redirectAllowed(u("https://www.a.com/x"), u("https://a.com/y"))).toBe(true);
    expect(redirectAllowed(u("http://a.com/x"), u("https://a.com/x"))).toBe(true);
    expect(redirectAllowed(u("https://a.com/x"), u("http://a.com/x"))).toBe(false);
    expect(redirectAllowed(u("https://a.com/x"), u("https://a.com:8443/x"))).toBe(false);
    expect(redirectAllowed(u("https://a.com/x"), u("https://b.a.com/x"))).toBe(false);
    expect(redirectAllowed(u("https://a.com/x"), u("https://u:p@a.com/x"))).toBe(false);
  });
});

describe("content", () => {
  it("asks for markdown first and keeps a markdown body as is", async () => {
    expect(page((await make().fetch(site("/accept"))).result).markdown).toBe("text/markdown, text/html;q=0.9, */*;q=0.8");
    const md = page((await make().fetch(site("/md"))).result);
    expect(md.source).toBe("markdown");
    expect(md.markdown).toBe(LONG_MD);
  });

  it("converts HTML with Readability and Turndown: main content, GFM tables, fenced code, absolute links", async () => {
    const p = page((await make().fetch(site("/article"))).result);
    expect(p.source).toBe("html");
    expect(p.title).toBe("Widget docs");
    expect(p.markdown).toContain("| Option | Default |");
    expect(p.markdown).toContain("```\nwidget --size 3\n```");
    expect(p.markdown).toContain(`[the next page](${site("/docs/next")})`);
    expect(p.markdown).not.toMatch(/alert\(1\)|Copyright/);
  });

  it("treats a markdown response that is really HTML as HTML", async () => {
    expect(page((await make().fetch(site("/md-html"))).result).source).toBe("html");
  });

  it("uses the page's markdown alternate, and llms.txt for a JavaScript-only page", async () => {
    const alt = page((await make().fetch(site("/alt"))).result);
    expect(alt).toMatchObject({ source: "markdown", url: site("/alt.md") });
    expect(alt.markdown).toMatch(/^# The markdown version/);
    const spa = page((await make().fetch(site("/spa"))).result);
    expect(spa.source).toBe("llms.txt");
    expect(spa.notes.join(" ")).toMatch(/needs JavaScript/);
  });

  it("decodes charsets: header, then BOM, then <meta charset>", async () => {
    expect(page((await make().fetch(site("/turkish"))).result).markdown).toBe("Türkçe ğşıöç");
    expect(page((await make().fetch(site("/bom"))).result).markdown).toBe("héllo utf-16");
    expect(page((await make().fetch(site("/meta-charset"))).result).markdown).toContain("Price: 5 €");
    expect(detectCharset(Buffer.from("x"), "text/html; charset=bogus-charset")).toBe("utf-8");
  });

  it("extracts PDF text with unpdf", async () => {
    const p = page((await make().fetch(site("/pdf"))).result);
    expect(p).toMatchObject({ source: "pdf", title: "Tiny PDF" });
    expect(p.markdown).toContain("--- page 1 of 1 ---");
    expect(p.markdown).toContain("Hello from a PDF");
  });

  it("returns a small PNG inline and saves it", async () => {
    const { result } = await make().fetch(site("/png"));
    expect(result).toMatchObject({ kind: "image", contentType: "image/png", bytes: PNG_1X1.length, data: PNG_1X1.toString("base64") });
    if (result.kind === "image") expect(readFileSync(result.path)).toEqual(PNG_1X1);
  });

  it("pretty-prints JSON", async () => {
    expect(page((await make().fetch(site("/json"))).result).markdown).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  });

  it("caps the decompressed size, so a gzip bomb stops at the cap", async () => {
    const p = page((await make({ maxBytes: 1024 * 1024 }).fetch(site("/bomb"))).result);
    expect(p.markdown.length).toBe(1024 * 1024);
    expect(p.notes.join(" ")).toMatch(/larger than 1 MB/);
  });
});

describe("errors, challenges and retries", () => {
  it("reports a Cloudflare challenge instead of the challenge page", async () => {
    await expect(make().fetch(site("/cf"))).rejects.toThrow(/Cloudflare bot challenge \(HTTP 403\)/);
    await expect(make().fetch(site("/cf-page"))).rejects.toThrow(/Cloudflare bot challenge \(HTTP 503\)/);
  });

  it("reports HTTP errors", async () => {
    await expect(make().fetch(site("/missing"))).rejects.toThrow(/HTTP 404/);
  });

  it("retries once after a 429", async () => {
    expect(page((await make().fetch(site("/busy"))).result).markdown).toBe("ok after retry");
    expect(srv.hits.get("/busy")).toBe(2);
  });
});

describe("cache", () => {
  it("serves a repeat from the cache without a request", async () => {
    const f = make();
    const before = srv.hits.get("/article") ?? 0;
    const a = await f.fetch(site("/article"));
    const b = await f.fetch(`${site("/article")}#section`);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.result).toBe(a.result);
    expect((srv.hits.get("/article") ?? 0) - before).toBe(1);
  });

  it("expires after 15 minutes", async () => {
    let t = 1_000_000;
    const f = make({ now: () => t });
    await f.fetch(site("/json"));
    t += 14 * 60_000;
    expect((await f.fetch(site("/json"))).cached).toBe(true);
    t += 2 * 60_000;
    expect((await f.fetch(site("/json"))).cached).toBe(false);
  });

  it("never caches errors", async () => {
    const f = make();
    await expect(f.fetch(site("/flaky"))).rejects.toThrow(/HTTP 500/);
    expect(page((await f.fetch(site("/flaky"))).result).markdown).toBe("recovered");
  });
});

describe("rewrites", () => {
  it("turns GitHub blob pages into raw files", () => {
    expect(rewriteUrl(new URL("https://github.com/o/r/blob/main/src/a.ts")).url.href).toBe("https://raw.githubusercontent.com/o/r/main/src/a.ts");
    expect(rewriteUrl(new URL("https://github.com/o/r/tree/main/src")).url.href).toBe("https://github.com/o/r/tree/main/src");
  });
});
