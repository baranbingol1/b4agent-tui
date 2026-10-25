/**
 * One HTTP GET with the SSRF guard pinned into the connection, a streamed
 * byte cap applied after decompression (so a gzip bomb can't get past it),
 * and no redirect following: the caller applies the redirect policy.
 */
import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import zlib from "node:zlib";
import type { Transform } from "node:stream";
import { checkHostname, guardedLookup, type GuardOptions } from "./ssrf.js";

export interface RawResponse {
  url: URL;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body was cut at `maxBytes`. */
  truncated: boolean;
}

export interface GetOptions extends GuardOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes: number;
}

function decoder(encoding: string | undefined): Transform | undefined {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    case "zstd":
      return typeof zlib.createZstdDecompress === "function" ? zlib.createZstdDecompress() : undefined;
    default:
      return undefined;
  }
}

const ACCEPT_ENCODING = typeof zlib.createZstdDecompress === "function" ? "gzip, deflate, br, zstd" : "gzip, deflate, br";

export async function httpGet(url: URL, opts: GetOptions): Promise<RawResponse> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs can be fetched, not ${url.protocol}`);
  checkHostname(url.hostname, opts);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const lib = url.protocol === "https:" ? https : http;
  // A fresh agent per request: no keep-alive sockets bound to an earlier lookup, and no proxy from the environment.
  const agent = new lib.Agent({ keepAlive: false, lookup: guardedLookup(opts) as never });

  return new Promise<RawResponse>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        agent,
        headers: { "accept-encoding": ACCEPT_ENCODING, ...opts.headers },
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          agent.destroy();
          resolve({ url, status, headers: res.headers, body: Buffer.concat(chunks), truncated });
        };
        const status = res.statusCode ?? 0;
        // Redirect bodies are never read.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return finish();
        }
        const dec = decoder(res.headers["content-encoding"]);
        const stream = dec ? res.pipe(dec) : res;
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = opts.maxBytes - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            size += room;
            truncated = true;
            res.destroy();
            dec?.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on("end", finish);
        stream.on("error", (err) => (truncated ? undefined : reject(err)));
        res.on("error", (err) => (truncated ? undefined : reject(err)));
      },
    );
    req.on("error", (err) => {
      agent.destroy();
      if (timeout.aborted && !opts.signal?.aborted) reject(new Error(`Timed out after ${Math.round((opts.timeoutMs ?? 60_000) / 1000)} s fetching ${url.href}`));
      else reject(err);
    });
    req.end();
  });
}
