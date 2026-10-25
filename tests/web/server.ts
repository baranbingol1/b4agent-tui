/** A local HTTP server with the pages the web tests need, counting hits per path. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";

export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A one-page PDF with a text layer and a title, built by hand with a correct xref table. */
export function tinyPdf(text: string, title = "Tiny PDF"): Buffer {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title (${title}) >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>Widget docs</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article><h1>Configuring widgets</h1>
<p>${"Widgets are configured with a JSON file that lives next to the project root. ".repeat(6)}</p>
<h2>Options</h2>
<table><thead><tr><th>Option</th><th>Default</th></tr></thead><tbody><tr><td>size</td><td>3</td></tr></tbody></table>
<pre><code>widget --size 3</code></pre>
<p>See <a href="/docs/next">the next page</a>.</p>
</article><footer>Copyright</footer><script>alert(1)</script></body></html>`;

/** 2000 numbered lines of 32 characters: 64,000 characters of markdown. */
export const LONG_MD = Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(4, "0")} of the long document.\n`).join("");

export interface TestServer {
  port: number;
  hits: Map<string, number>;
  close(): Promise<void>;
  url(path: string, host?: string): string;
}

export async function startServer(): Promise<TestServer> {
  const hits = new Map<string, number>();
  let port = 0;
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const host = (req.headers.host ?? "").split(":")[0];
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    switch (path) {
      case "/article":
        return send(200, "text/html; charset=utf-8", ARTICLE);
      case "/md":
        return send(200, "text/markdown; charset=utf-8", LONG_MD);
      case "/accept":
        return send(200, "text/plain", String(req.headers.accept));
      case "/md-html":
        return send(200, "text/markdown", ARTICLE);
      case "/cross":
        return send(302, "text/plain", "", { location: `http://other.test:${port}/target` });
      case "/same":
        return send(301, "text/plain", "", { location: "/article" });
      case "/www":
        return send(302, "text/plain", "", { location: `http://www.site.test:${port}/article` });
      case "/port":
        return send(302, "text/plain", "", { location: `http://${host}:${port + 1}/target` });
      case "/loop":
        return send(302, "text/plain", "", { location: "/loop" });
      case "/target":
        return send(200, "text/plain", "you reached the target");
      case "/missing":
        return send(404, "text/html", "<h1>Not found</h1>");
      case "/cf":
        return send(403, "text/html", "<html><title>Just a moment...</title></html>", { "cf-mitigated": "challenge", server: "cloudflare" });
      case "/cf-page":
        return send(503, "text/html", "<html><head><title>Just a moment...</title></head><body><div id=challenge-platform></div></body></html>", { server: "cloudflare" });
      case "/turkish":
        // "Türkçe ğşıöç" in ISO-8859-9.
        return send(200, "text/plain; charset=iso-8859-9", Buffer.from([0x54, 0xfc, 0x72, 0x6b, 0xe7, 0x65, 0x20, 0xf0, 0xfe, 0xfd, 0xf6, 0xe7]));
      case "/meta-charset":
        return send(200, "text/html", Buffer.concat([Buffer.from(`<html><head><meta charset="windows-1252"><title>Euro</title></head><body><article><p>Price: 5 `), Buffer.from([0x80]), Buffer.from(` ${"and more text about prices in euros. ".repeat(10)}</p></article></body></html>`)]));
      case "/bom":
        return send(200, "text/plain", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo utf-16", "utf16le")]));
      case "/pdf":
        return send(200, "application/pdf", tinyPdf("Hello from a PDF"));
      case "/png":
        return send(200, "image/png", PNG_1X1);
      case "/bomb": {
        const gz = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x61));
        return send(200, "text/plain", gz, { "content-encoding": "gzip" });
      }
      case "/busy":
        if ((hits.get(path) ?? 0) === 1) return send(429, "text/plain", "slow down", { "retry-after": "0" });
        return send(200, "text/plain", "ok after retry");
      case "/alt":
        return send(200, "text/html", `<html><head><title>Alt</title><link rel="alternate" type="text/markdown" href="/alt.md"></head><body>${ARTICLE}</body></html>`);
      case "/alt.md":
        return send(200, "text/markdown", `# The markdown version\n\n${"Clean markdown served by the site itself. ".repeat(5)}`);
      case "/spa":
        return send(200, "text/html", `<html><head><title>App</title></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`);
      case "/llms.txt":
        return send(200, "text/plain", `# App\n\n${"The app's documentation index for language models. ".repeat(5)}`);
      case "/json":
        return send(200, "application/json", `{"a":1,"b":[1,2]}`);
      case "/flaky":
        // Fails once, then works: errors must not be cached.
        if ((hits.get(path) ?? 0) === 1) return send(500, "text/plain", "boom");
        return send(200, "text/plain", "recovered");
      default:
        return send(404, "text/plain", "no such page");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    url: (p, host = "127.0.0.1") => `http://${host}:${port}${p}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A resolver for the fake hosts the tests use: every name maps to loopback unless listed. */
export function fakeResolver(map: Record<string, string> = {}) {
  return async (host: string) => {
    const address = map[host] ?? (/(^|\.)(site|other)\.test$/.test(host) ? "127.0.0.1" : undefined);
    if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
}
