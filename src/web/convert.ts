/**
 * Turning response bodies into text: charset detection (hardening point 4),
 * HTML to markdown with Readability and Turndown (ported from the old
 * b4agent's web extension, plus GFM tables), and PDF text through unpdf.
 * The heavy libraries are imported on first use.
 */

/** The charset from a Content-Type header, if any. */
export function headerCharset(contentType: string | undefined): string | undefined {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
  return m?.[1]?.toLowerCase();
}

function bomCharset(body: Uint8Array): string | undefined {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  return undefined;
}

/** `<meta charset>`, `<meta http-equiv content="…charset=…">` or `<?xml encoding>` in the first 4 KB. */
function sniffedCharset(body: Uint8Array): string | undefined {
  const head = Buffer.from(body.subarray(0, 4096)).toString("latin1");
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
  if (meta) return meta[1]!.toLowerCase();
  const xml = /^\s*<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_:.-]+)["']/i.exec(head);
  return xml?.[1]?.toLowerCase();
}

function validLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

/**
 * Content-Type charset, then BOM, then `<meta charset>` / XML declaration,
 * then UTF-8. Unknown labels fall through to the next source.
 */
export function detectCharset(body: Uint8Array, contentType: string | undefined): string {
  return validLabel(headerCharset(contentType)) ?? validLabel(bomCharset(body)) ?? validLabel(sniffedCharset(body)) ?? "utf-8";
}

export function decodeBody(body: Uint8Array, contentType: string | undefined): { text: string; charset: string } {
  const charset = detectCharset(body, contentType);
  return { text: new TextDecoder(charset).decode(body), charset };
}

/** Whether a body sent as markdown or plain text is really an HTML page (servers that ignore Accept, error pages). */
export function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 1024).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || /^<(head|body|meta|title|script|link)\b/.test(head);
}

export interface HtmlResult {
  title: string;
  markdown: string;
  text: string;
  /** `<link rel="alternate" type="text/markdown" href>`, resolved. */
  markdownAlternate?: string;
  /** Readability found no article and the whole body was converted. */
  fallback: boolean;
}

type TurndownLike = { turndown(html: string): string };
let turndownPromise: Promise<TurndownLike> | undefined;

async function turndown(): Promise<TurndownLike> {
  turndownPromise ??= (async () => {
    const [{ default: TurndownService }, gfm] = await Promise.all([import("turndown"), import("turndown-plugin-gfm")]);
    const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
    service.use(gfm.gfm);
    service.remove(["script", "style", "noscript", "iframe", "template"] as never);
    return service;
  })();
  return turndownPromise;
}

export async function htmlToMarkdown(html: string, url: string): Promise<HtmlResult> {
  const [{ JSDOM, VirtualConsole }, { Readability }, td] = await Promise.all([import("jsdom"), import("@mozilla/readability"), turndown()]);
  // No scripts, no subresources, and the page's console errors stay quiet.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  let markdownAlternate: string | undefined;
  for (const link of Array.from(doc.querySelectorAll('link[rel~="alternate"][href]'))) {
    if (/^text\/(x-)?markdown\b/i.test(link.getAttribute("type") ?? "")) {
      try {
        markdownAlternate = new URL(link.getAttribute("href")!, url).href;
        break;
      } catch {
        // ignore a broken href
      }
    }
  }
  const pageTitle = doc.title?.trim() || url;
  // Readability mutates the document, so the fallback needs its own copy of the body.
  const bodyHtml = doc.body?.innerHTML ?? html;
  const bodyText = doc.body?.textContent ?? "";
  const article = new Readability(doc, { charThreshold: 300 }).parse();
  try {
    if (article?.content && (article.textContent ?? "").trim().length >= 200) {
      return {
        title: article.title?.trim() || pageTitle,
        markdown: tidy(td.turndown(article.content)),
        text: tidyText(article.textContent ?? ""),
        ...(markdownAlternate ? { markdownAlternate } : {}),
        fallback: false,
      };
    }
    return { title: pageTitle, markdown: tidy(td.turndown(bodyHtml)), text: tidyText(bodyText), ...(markdownAlternate ? { markdownAlternate } : {}), fallback: true };
  } finally {
    dom.window.close();
  }
}

const tidy = (md: string) => md.replace(/\n{3,}/g, "\n\n").trim();
const tidyText = (t: string) => t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();

/** Rough markdown-to-text for format: "text" on markdown sources. */
export function markdownToText(md: string): string {
  return tidyText(
    md
      .replace(/```[^\n]*\n/g, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2"),
  );
}

/** Page text of a PDF, with a marker before each page. */
export async function pdfToText(body: Uint8Array): Promise<{ text: string; pages: number; title?: string }> {
  const { getDocumentProxy, extractText, getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(body));
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    let title: string | undefined;
    try {
      const meta = await getMeta(pdf);
      const t = (meta.info as Record<string, unknown> | undefined)?.Title;
      if (typeof t === "string" && t.trim()) title = t.trim();
    } catch {
      // metadata is optional
    }
    const out = text.map((p, i) => `--- page ${i + 1} of ${totalPages} ---\n\n${p.trim()}`).join("\n\n");
    return { text: out, pages: totalPages, ...(title ? { title } : {}) };
  } finally {
    // pdf.js documents have destroy() at runtime; unpdf's bundled types leave it out.
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}
