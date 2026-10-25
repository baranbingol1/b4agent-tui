import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type PainterRegistry, paint, pickBackend } from "../../src/painter/backend.js";
import { loadReferences, saveImage } from "../../src/painter/files.js";
import { buildImageRequest, chatgptAccountId, errorMessage, imageFileName, parseImageResponse, pngSize, slugify } from "../../src/painter/request.js";

/** A 1x1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const TOKEN = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-123", chatgpt_plan_type: "pro" } });

const tmp = mkdtempSync(join(tmpdir(), "painter-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("buildImageRequest", () => {
  it("matches Codex CLI's generation body (codex-rs/ext/image-generation/src/tool.rs)", () => {
    expect(buildImageRequest({ prompt: "a red fox" })).toEqual({
      path: "images/generations",
      body: { prompt: "a red fox", background: "opaque", model: "gpt-image-2", quality: "auto", size: "auto" },
    });
  });
  it("turns references into an edit with inline data URLs, and keeps options", () => {
    const r = buildImageRequest({ prompt: "add a hat", images: ["data:image/png;base64,Zm9v"], transparent: true, quality: "low", size: "1024x1024" });
    expect(r.path).toBe("images/edits");
    expect(r.body).toEqual({ images: [{ image_url: "data:image/png;base64,Zm9v" }], prompt: "add a hat", background: "transparent", model: "gpt-image-2", quality: "low", size: "1024x1024" });
  });
  it("an empty reference list is a generation, more than 5 is refused", () => {
    expect(buildImageRequest({ prompt: "x", images: [] }).path).toBe("images/generations");
    expect(() => buildImageRequest({ prompt: "x", images: Array(6).fill("data:image/png;base64,AA") })).toThrow(/at most 5/);
  });
});

describe("responses", () => {
  it("decodes the recorded Codex response shape (codex-api/src/endpoint/images.rs test)", () => {
    const img = parseImageResponse({ created: 1778832973, background: "opaque", data: [{ b64_json: PNG }], output_format: "png", quality: "medium", size: "1024x1536" });
    expect([img.mime, img.ext, img.size, img.quality, pngSize(img.bytes)]).toEqual(["image/png", "png", "1024x1536", "medium", "1x1"]);
  });
  it("refuses a response without data, or with bytes that aren't an image", () => {
    expect(() => parseImageResponse({ created: 1 })).toThrow(/no image data/);
    expect(() => parseImageResponse({ data: [{ b64_json: Buffer.from("<html>").toString("base64") }] })).toThrow(/not a PNG/);
  });
  it("prefers error.message, and falls back to the text", () => {
    expect(errorMessage(400, JSON.stringify({ error: { message: "Your request was rejected", code: "x" } }))).toBe("HTTP 400: Your request was rejected");
    expect(errorMessage(404, JSON.stringify({ detail: "Not Found" }))).toBe("HTTP 404: Not Found");
    expect(errorMessage(502, "<html>bad gateway</html>")).toBe("HTTP 502: <html>bad gateway</html>");
  });
  it("reads the account id from the token, as Pi's Codex provider does", () => {
    expect(chatgptAccountId(TOKEN)).toBe("acc-123");
    expect(chatgptAccountId("not-a-jwt")).toBeUndefined();
  });
});

describe("file names", () => {
  const day = new Date(2026, 9, 21, 23, 30);
  it("slugs titles: ascii words, accents folded, at most 40 chars on a word boundary", () => {
    expect(slugify("Login page — hero image!")).toBe("login-page-hero-image");
    expect(slugify("Çiçekli düğün davetiyesi")).toBe("cicekli-dugun-davetiyesi");
    expect(slugify("a watercolor fox sitting in a snowy forest at dawn, soft light")).toBe("a-watercolor-fox-sitting-in-a-snowy");
    expect(slugify("日本語")).toBe("image");
  });
  it("names YYYY-MM-DD-slug.ext with the local date, numbered on a clash", () => {
    expect(imageFileName("Fox", "png", day)).toBe("2026-10-21-fox.png");
    expect(imageFileName("Fox", "png", day, 3)).toBe("2026-10-21-fox-3.png");
  });
  it("never overwrites an earlier image", () => {
    const dir = join(tmp, "images");
    const a = saveImage(dir, "Fox", "png", Buffer.from(PNG, "base64"), day);
    const b = saveImage(dir, "Fox", "png", Buffer.from("second"), day);
    expect([a.endsWith("2026-10-21-fox.png"), b.endsWith("2026-10-21-fox-2.png")]).toEqual([true, true]);
    expect(readFileSync(a).toString("base64")).toBe(PNG);
  });
  it("loads references as data URLs by content, not extension", () => {
    writeFileSync(join(tmp, "ref.jpg"), Buffer.from(PNG, "base64"));
    writeFileSync(join(tmp, "notes.png"), "hello");
    expect(loadReferences(["ref.jpg"], tmp)).toEqual([`data:image/png;base64,${PNG}`]);
    expect(() => loadReferences(["notes.png"], tmp)).toThrow(/not a PNG/);
    expect(() => loadReferences(["missing.png"], tmp)).toThrow(/not found/);
  });
});

function registry(over: Partial<{ codex: boolean; openai: "key" | "oauth" | false; openrouter: boolean; baseUrl: string }> = {}): PainterRegistry {
  const o = { codex: true, openai: false as const, openrouter: false, baseUrl: "https://chatgpt.com/backend-api", ...over };
  const models = [
    { provider: "openai-codex", id: "gpt-6.1-sol", baseUrl: o.baseUrl },
    { provider: "openai", id: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1" },
  ];
  return {
    getAll: () => models as never,
    getProviderAuthStatus: (p) => ({ configured: p === "openai-codex" ? o.codex : p === "openai" ? Boolean(o.openai) : p === "openrouter" ? o.openrouter : false }),
    getProviderAuth: async (p) => (p === "openai-codex" && o.codex ? { auth: { apiKey: TOKEN } } : p === "openai" && o.openai ? { auth: { apiKey: "sk-test" } } : undefined),
    getProvider: () => undefined,
    isUsingOAuth: (m) => m.provider === "openai-codex" || (m.provider === "openai" && o.openai === "oauth"),
    getModelOfType: () => (o.openrouter ? ({ id: "openai/gpt-image-2" } as never) : undefined),
    generateImages: async () => ({ api: "x", provider: "openrouter", model: "m", output: [{ type: "image", data: PNG, mimeType: "image/png" }], stopReason: "stop", timestamp: 0 }) as never,
  };
}

describe("backends", () => {
  it("picks the ChatGPT login first, then an OpenAI key (not the OpenAI OAuth login), then OpenRouter", () => {
    expect(pickBackend(registry())).toBe("codex");
    expect(pickBackend(registry({ codex: false, openai: "key", openrouter: true }))).toBe("openai");
    expect(pickBackend(registry({ codex: false, openai: "oauth", openrouter: true }))).toBe("openrouter");
    expect(pickBackend(registry({ codex: false, openai: "oauth" }))).toBeUndefined();
  });

  it("posts Codex CLI's request to the Codex backend, honouring a base URL override", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }), { headers: { "x-codex-imagegen-request-id": "req-1", "x-codex-primary-used-percent": "17" } });
    }) as unknown as typeof fetch;
    const out = await paint(registry({ baseUrl: "http://127.0.0.1:9/backend-api/" }), "codex", { prompt: "fox", images: [`data:image/png;base64,${PNG}`] }, { fetch: fake });
    expect(calls[0]!.url).toBe("http://127.0.0.1:9/backend-api/codex/images/edits");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect([h.Authorization, h["chatgpt-account-id"], h.originator]).toEqual([`Bearer ${TOKEN}`, "acc-123", "pi"]);
    expect(h["x-codex-image-turn-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(calls[0]!.init.body as string).model).toBe("gpt-image-2");
    expect([out.requestId, out.headers?.["x-codex-primary-used-percent"]]).toEqual(["req-1", "17"]);
  });

  it("sends the same body to the OpenAI Images API with the key", async () => {
    let seen = "";
    const fake = (async (url: string, init: RequestInit) => {
      seen = `${url} ${(init.headers as Record<string, string>).Authorization}`;
      return new Response(JSON.stringify({ data: [{ b64_json: PNG }] }));
    }) as unknown as typeof fetch;
    await paint(registry({ codex: false, openai: "key" }), "openai", { prompt: "fox" }, { fetch: fake });
    expect(seen).toBe("https://api.openai.com/v1/images/generations Bearer sk-test");
  });

  it("reports a usage limit with a pointer to /usage and the request id", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ error: { message: "You've hit your usage limit." } }), { status: 429, headers: { "x-codex-imagegen-request-id": "req-9" } })) as unknown as typeof fetch;
    await expect(paint(registry(), "codex", { prompt: "fox" }, { fetch: fake })).rejects.toThrow(/HTTP 429: You've hit your usage limit\. \(usage limit: \/usage.*\[request req-9\]/);
  });

  it("goes through Pi's image API for OpenRouter", async () => {
    const out = await paint(registry({ codex: false, openrouter: true }), "openrouter", { prompt: "fox" });
    expect([out.backend, out.mime]).toEqual(["openrouter", "image/png"]);
  });
});
