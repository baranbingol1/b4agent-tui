/**
 * web_fetch's pipeline (plan section 18): one URL to markdown, text, an
 * image or a saved file. Redirects follow only to the same host (point 3),
 * markdown is asked for first (point 5), challenges are reported rather than
 * dodged (point 9), and successful results are cached for 15 minutes in a
 * byte-capped LRU (point 10).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { TtlLru } from "./cache.js";
import { decodeBody, htmlToMarkdown, looksLikeHtml, markdownToText, pdfToText } from "./convert.js";
import { httpGet, type RawResponse } from "./http.js";
import type { Resolver } from "./ssrf.js";

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_URL_LENGTH = 2000;
export const MAX_REDIRECTS = 10;
export const IMAGE_INLINE_BYTES = 300 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const DEADLINE_MS = 5 * 60_000;
const ACCEPT = "text/markdown, text/html;q=0.9, */*;q=0.8";
/** An honest User-Agent: challenges are reported, not dodged with a browser's. */
export const USER_AGENT = "Mozilla/5.0 (compatible; b4agent-web-fetch/1.0)";
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type Source = "markdown" | "html" | "pdf" | "text" | "json" | "llms.txt";

export interface Page {
  kind: "page";
  url: string;
  status: number;
  contentType: string;
  title?: string;
  source: Source;
  markdown: string;
  text: string;
  notes: string[];
}
export interface ImageResult {
  kind: "image";
  url: string;
  contentType: string;
  bytes: number;
  path: string;
  /** Base64, when small enough to send inline. */
  data?: string;
  notes: string[];
}
export interface FileResult {
  kind: "file";
  url: string;
  contentType: string;
  bytes: number;
  path: string;
  notes: string[];
}
export interface RedirectResult {
  kind: "redirect";
  url: string;
  status: number;
  location: string;
  notes: string[];
}
export type FetchResult = Page | ImageResult | FileResult | RedirectResult;

export class WebFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebFetchError";
  }
}

export interface FetcherOptions {
  resolver?: Resolver;
  allowLoopback?: boolean;
  maxBytes?: number;
  tempDir?: string;
  /** Minimum gap between two requests to one host. */
  hostIntervalMs?: number;
  /** Cap on a 429's Retry-After wait before the single retry. */
  maxRetryWaitMs?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  now?: () => number;
}

export interface Fetcher {
  fetch(url: string, opts?: { signal?: AbortSignal }): Promise<{ result: FetchResult; cached: boolean }>;
  cache: TtlLru<FetchResult>;
}

/** Validates a model-supplied URL: absolute http(s), no credentials, at most 2000 characters. */
export function parseFetchUrl(raw: string): URL {
  const s = raw.trim();
  if (s.length > MAX_URL_LENGTH) throw new WebFetchError(`The URL is ${s.length} characters long; web_fetch refuses URLs over ${MAX_URL_LENGTH}.`);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new WebFetchError(`Not an absolute URL: ${s.slice(0, 200)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebFetchError(`Only http and https URLs can be fetched, not ${url.protocol}`);
  if (url.username || url.password) throw new WebFetchError("The URL carries a username or password; web_fetch never sends credentials.");
  url.hash = "";
  return url;
}

/** GitHub file pages are HTML around the file; the raw file is what's wanted. */
export function rewriteUrl(url: URL): { url: URL; note?: string } {
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (m) {
      const raw = new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
      return { url: raw, note: `GitHub file page rewritten to the raw file: ${raw.href}` };
    }
  }
  return { url };
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");
const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");

/**
 * Same scheme, same port, same host ignoring `www.`. An http to https upgrade
 * on default ports is allowed too: same host, stronger transport.
 */
export function redirectAllowed(from: URL, to: URL): boolean {
  if (to.protocol !== "http:" && to.protocol !== "https:") return false;
  if (to.username || to.password) return false;
  if (bareHost(from.hostname) !== bareHost(to.hostname)) return false;
  if (from.protocol === to.protocol) return port(from) === port(to);
  return from.protocol === "http:" && to.protocol === "https:" && !from.port && !to.port;
}

const header = (h: IncomingHttpHeaders, name: string) => {
  const v = h[name];
  return Array.isArray(v) ? v.join(", ") : (v ?? "");
};

/** A Cloudflare bot challenge rather than the page (`cf-mitigated`, or a 403/503 challenge page). */
export function isChallenge(status: number, headers: IncomingHttpHeaders, body: string): boolean {
  if (header(headers, "cf-mitigated").toLowerCase() === "challenge") return true;
  if ((status === 403 || status === 503 || status === 429) && /cloudflare/i.test(header(headers, "server"))) {
    return /just a moment|cf-chl|challenge-platform|cf_chl_opt|attention required/i.test(body.slice(0, 50_000));
  }
  return false;
}

function sniffType(body: Buffer): string | undefined {
  if (body.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (body[0] === 0x89 && body.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  const head = body.subarray(0, 2048).toString("utf8");
  if (looksLikeHtml(head)) return "text/html";
  // Mostly printable: text.
  const sample = body.subarray(0, 4096);
  let bad = 0;
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) bad++;
  return sample.length && bad / sample.length < 0.02 ? "text/plain" : undefined;
}

function retryAfterMs(h: IncomingHttpHeaders, now: number): number | undefined {
  const v = header(h, "retry-after").trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

const EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg",
  "application/zip": ".zip", "application/gzip": ".gz", "application/octet-stream": ".bin",
};

export function createFetcher(opts: FetcherOptions = {}): Fetcher {
  const now = opts.now ?? Date.now;
  const cache = new TtlLru<FetchResult>(CACHE_TTL_MS, CACHE_BYTES, now);
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const tempDir = opts.tempDir ?? join(tmpdir(), "b4agent-web");
  const hostInterval = opts.hostIntervalMs ?? 500;
  const nextSlot = new Map<string, number>();

  async function rateLimit(host: string, signal: AbortSignal): Promise<void> {
    const t = now();
    const slot = Math.max(t, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + hostInterval);
    if (slot > t) await sleep(slot - t, signal);
  }

  async function get(url: URL, signal: AbortSignal, accept = ACCEPT): Promise<RawResponse> {
    const send = async () => {
      await rateLimit(url.hostname, signal);
      return httpGet(url, {
        maxBytes,
        signal,
        timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
        headers: { accept, "user-agent": USER_AGENT, "accept-language": "en;q=1.0, *;q=0.5" },
        ...(opts.resolver ? { resolver: opts.resolver } : {}),
        ...(opts.allowLoopback ? { allowLoopback: true } : {}),
      });
    };
    let res = await send();
    if (res.status === 429) {
      const wait = Math.min(retryAfterMs(res.headers, now()) ?? 2000, opts.maxRetryWaitMs ?? 10_000);
      await sleep(wait, signal);
      res = await send();
    }
    return res;
  }

  function save(url: string, body: Buffer, contentType: string): string {
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update(url).digest("hex").slice(0, 16) + (EXT[contentType] ?? ".bin");
    const path = join(tempDir, name);
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  }

  /** Follows same-host redirects; returns the final response or the redirect it refused to follow. */
  async function follow(start: URL, signal: AbortSignal): Promise<RawResponse | RedirectResult> {
    let current = start;
    for (let hops = 0; ; hops++) {
      const res = await get(current, signal);
      const location = res.status >= 300 && res.status < 400 ? header(res.headers, "location") : "";
      if (!location) return res;
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new WebFetchError(`HTTP ${res.status} redirect with an invalid Location header from ${current.href}`);
      }
      next.hash = "";
      if (!redirectAllowed(start, next) || next.href.length > MAX_URL_LENGTH) {
        return { kind: "redirect", url: current.href, status: res.status, location: next.href.slice(0, MAX_URL_LENGTH), notes: [] };
      }
      if (hops + 1 >= MAX_REDIRECTS) throw new WebFetchError(`More than ${MAX_REDIRECTS} redirects starting at ${start.href}`);
      current = next;
    }
  }

  async function load(requested: URL, signal: AbortSignal): Promise<FetchResult> {
    const notes: string[] = [];
    const { url: target, note } = rewriteUrl(requested);
    if (note) notes.push(note);
    const res = await follow(target, signal);
    if ("kind" in res) return { ...res, notes };
    const finalUrl = res.url.href;
    if (finalUrl !== target.href) notes.push(`Redirected to ${finalUrl}`);
    let contentType = header(res.headers, "content-type").split(";")[0]!.trim().toLowerCase();
    const textForChecks = res.body.subarray(0, 50_000).toString("latin1");
    if (isChallenge(res.status, res.headers, textForChecks)) {
      throw new WebFetchError(
        `${finalUrl} answered with a Cloudflare bot challenge (HTTP ${res.status}). web_fetch doesn't run a browser or pretend to be one. Try another source (the project's GitHub repository or docs mirror, a web_search result), or ask the user to paste the page.`,
      );
    }
    if (res.status >= 400) throw new WebFetchError(`HTTP ${res.status} from ${finalUrl}`);
    if (res.status < 200 || res.status >= 300) throw new WebFetchError(`Unexpected HTTP ${res.status} from ${finalUrl}`);
    if (!contentType || contentType === "application/octet-stream" || contentType === "binary/octet-stream") contentType = sniffType(res.body) ?? (contentType || "application/octet-stream");
    if (res.truncated) notes.push(`The response was larger than ${Math.round(maxBytes / 1024 / 1024)} MB and was cut there.`);
    const ct = header(res.headers, "content-type");

    if (contentType === "application/pdf" || (contentType === "application/x-pdf")) {
      if (res.truncated) throw new WebFetchError(`The PDF at ${finalUrl} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB; web_fetch reads PDFs up to that size.`);
      let pdf: Awaited<ReturnType<typeof pdfToText>>;
      try {
        pdf = await pdfToText(res.body);
      } catch (e) {
        throw new WebFetchError(`Could not read the PDF at ${finalUrl}: ${(e as Error).message}`);
      }
      if (!pdf.text.replace(/--- page \d+ of \d+ ---/g, "").trim()) notes.push("The PDF has no text layer (scanned pages?); no text could be extracted.");
      notes.push(`PDF, ${pdf.pages} pages.`);
      return { kind: "page", url: finalUrl, status: res.status, contentType, ...(pdf.title ? { title: pdf.title } : {}), source: "pdf", markdown: pdf.text, text: pdf.text, notes };
    }

    if (contentType.startsWith("image/") || (!contentType.startsWith("text/") && !isTextual(contentType))) {
      if (res.truncated) throw new WebFetchError(`The file at ${finalUrl} (${contentType}) is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      const path = save(finalUrl, res.body, contentType);
      if (INLINE_IMAGE_TYPES.has(contentType)) {
        return {
          kind: "image", url: finalUrl, contentType, bytes: res.body.length, path,
          ...(res.body.length <= IMAGE_INLINE_BYTES ? { data: res.body.toString("base64") } : {}),
          notes,
        };
      }
      return { kind: "file", url: finalUrl, contentType, bytes: res.body.length, path, notes };
    }

    const { text: decoded } = decodeBody(res.body, ct);
    const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml" || ((contentType === "text/markdown" || contentType === "text/x-markdown" || contentType === "text/plain") && looksLikeHtml(decoded));
    if (!isHtml) {
      const source: Source = contentType.includes("markdown") ? "markdown" : contentType.includes("json") ? "json" : "text";
      const markdown = source === "json" ? prettyJson(decoded) : decoded;
      return { kind: "page", url: finalUrl, status: res.status, contentType, source, markdown, text: source === "markdown" ? markdownToText(markdown) : markdown, notes };
    }

    const html = await htmlToMarkdown(decoded, finalUrl);
    // A markdown version the site links to beats our conversion.
    if (html.markdownAlternate) {
      const alt = await tryMarkdown(new URL(html.markdownAlternate), new URL(finalUrl), signal);
      if (alt) {
        notes.push(`Used the page's markdown version: ${html.markdownAlternate}`);
        return { kind: "page", url: html.markdownAlternate, status: 200, contentType: "text/markdown", title: html.title, source: "markdown", markdown: alt, text: markdownToText(alt), notes };
      }
    }
    if (jsGated(html.markdown)) {
      const llms = await tryMarkdown(new URL("/llms.txt", finalUrl), new URL(finalUrl), signal);
      if (llms) {
        notes.push("The page needs JavaScript, which web_fetch doesn't run; this is the site's /llms.txt instead.");
        return { kind: "page", url: new URL("/llms.txt", finalUrl).href, status: 200, contentType: "text/plain", title: html.title, source: "llms.txt", markdown: llms, text: llms, notes };
      }
      notes.push("The page seems to need JavaScript, which web_fetch doesn't run; the content may be incomplete.");
    }
    if (html.fallback) notes.push("No main article was found; this is the whole page converted.");
    return { kind: "page", url: finalUrl, status: res.status, contentType, title: html.title, source: "html", markdown: html.markdown, text: html.text, notes };
  }

  /** A same-host markdown or text document, or undefined. Failures are quiet: this is only an improvement. */
  async function tryMarkdown(url: URL, origin: URL, signal: AbortSignal): Promise<string | undefined> {
    if ((url.protocol !== "https:" && url.protocol !== "http:") || bareHost(origin.hostname) !== bareHost(url.hostname)) return undefined;
    try {
      const res = await get(url, signal, "text/markdown, text/plain;q=0.9");
      if (res.status !== 200) return undefined;
      const type = header(res.headers, "content-type").toLowerCase();
      if (!/^text\/(markdown|x-markdown|plain)/.test(type)) return undefined;
      const { text } = decodeBody(res.body, type);
      return looksLikeHtml(text) || text.trim().length < 100 ? undefined : text;
    } catch (e) {
      if (signal.aborted) throw e;
      return undefined;
    }
  }

  return {
    cache,
    async fetch(raw, { signal } = {}) {
      const url = parseFetchUrl(raw);
      const key = url.href;
      const hit = cache.get(key);
      if (hit) return { result: hit, cached: true };
      const deadline = AbortSignal.timeout(opts.deadlineMs ?? DEADLINE_MS);
      const all = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let result: FetchResult;
      try {
        result = await load(url, all);
      } catch (e) {
        if (deadline.aborted && !signal?.aborted) throw new WebFetchError(`web_fetch gave up on ${url.href} after ${Math.round((opts.deadlineMs ?? DEADLINE_MS) / 1000)} s.`);
        throw e;
      }
      cache.set(key, result, sizeOf(result));
      return { result, cached: false };
    },
  };
}

function isTextual(ct: string): boolean {
  return /(json|xml|javascript|ecmascript|yaml|toml|csv|x-sh|x-python|markdown|graphql)/.test(ct);
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function jsGated(markdown: string): boolean {
  const t = markdown.trim();
  if (t.length < 300) return true;
  return t.length < 2000 && /(enable|requires?|turn on)\s+javascript|javascript (is )?(required|disabled)/i.test(t);
}

function sizeOf(r: FetchResult): number {
  if (r.kind === "page") return (r.markdown.length + r.text.length) * 2 + 1024;
  if (r.kind === "image") return (r.data?.length ?? 0) + 1024;
  return 1024;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
