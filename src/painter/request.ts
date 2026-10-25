/**
 * Painter requests (plan section 8): the native Codex images endpoints, the
 * same route Codex CLI's image tool uses, and the OpenAI Images API, which
 * takes the same JSON body.
 *
 * Shapes from openai/codex (Apache-2.0), read 2026-10-21:
 * - `codex-rs/codex-api/src/images.rs`: `ImageGenerationRequest` / `ImageEditRequest`
 *   ({prompt, background?, model, n?, quality?, size?} plus `images: [{image_url} | {file_id}]`
 *   for edits) and `ImageResponse` ({created, data: [{b64_json, generation_id?}], background?, quality?, size?}).
 * - `codex-rs/codex-api/src/endpoint/images.rs`: POST `images/generations` and `images/edits`
 *   under the provider base (`https://chatgpt.com/backend-api/codex`); the backend's request id
 *   comes back in `x-codex-imagegen-request-id`.
 * - `codex-rs/ext/image-generation/src/backend.rs`: the `x-codex-image-turn-id` header.
 * - `codex-rs/ext/image-generation/src/tool.rs`: model `gpt-image-2`, quality and size `auto`,
 *   background opaque unless transparent was asked for, at most 5 reference images, sent inline
 *   as data URLs.
 * Hermes's `plugins/image_gen/openai-codex` (NousResearch/hermes-agent) posts the same body.
 */
import { randomUUID } from "node:crypto";

export const IMAGE_MODEL = "gpt-image-2";
export const MAX_REFERENCE_IMAGES = 5;
/** The Images API's limit on one `image_url` data URL. */
export const MAX_DATA_URL_CHARS = 20_971_520;

export type Quality = "low" | "medium" | "high" | "auto";
export type Size = "auto" | "1024x1024" | "1536x1024" | "1024x1536";

export interface PaintArgs {
  prompt: string;
  transparent?: boolean;
  quality?: Quality;
  size?: Size;
  /** Data URLs of the reference images; any present makes it an edit. */
  images?: string[];
}

export interface ImageRequest {
  /** `images/generations` or `images/edits`, relative to the endpoint base. */
  path: "images/generations" | "images/edits";
  body: Record<string, unknown>;
}

/** The JSON body Codex CLI sends, field for field. */
export function buildImageRequest(a: PaintArgs, model = IMAGE_MODEL): ImageRequest {
  const body: Record<string, unknown> = {
    prompt: a.prompt,
    background: a.transparent ? "transparent" : "opaque",
    model,
    quality: a.quality ?? "auto",
    size: a.size ?? "auto",
  };
  if (a.images?.length) {
    if (a.images.length > MAX_REFERENCE_IMAGES) throw new Error(`at most ${MAX_REFERENCE_IMAGES} reference images`);
    return { path: "images/edits", body: { images: a.images.map((image_url) => ({ image_url })), ...body } };
  }
  return { path: "images/generations", body };
}

/** The ChatGPT account id from the access token's claims, as Pi's Codex provider reads it. */
export function chatgptAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

/** Headers for the Codex backend: Pi's own Codex headers plus the image turn id Codex CLI sends. */
export function codexImageHeaders(token: string, accountId: string, turnId = randomUUID()): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    originator: "pi",
    "content-type": "application/json",
    "x-codex-image-turn-id": turnId,
  };
}

export interface ParsedImage {
  bytes: Buffer;
  mime: string;
  ext: string;
  /** What the backend says it made; it may not honour the requested size or quality. */
  size?: string;
  quality?: string;
}

/** Decodes the first image of an Images API response, or throws with what was wrong. */
export function parseImageResponse(json: unknown): ParsedImage {
  const r = (json ?? {}) as { data?: { b64_json?: unknown }[]; output_format?: unknown; size?: unknown; quality?: unknown };
  const b64 = Array.isArray(r.data) ? r.data[0]?.b64_json : undefined;
  if (typeof b64 !== "string" || !b64) throw new Error("the response had no image data");
  const bytes = Buffer.from(b64, "base64");
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("the response's image data is not a PNG, JPEG, WebP or GIF");
  return { bytes, ...kind, ...(typeof r.size === "string" ? { size: r.size } : {}), ...(typeof r.quality === "string" ? { quality: r.quality } : {}) };
}

/** The image type from its magic bytes. */
export function sniffImage(b: Buffer): { mime: string; ext: string } | undefined {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6))) return { mime: "image/gif", ext: "gif" };
  return undefined;
}

/** Pixel size of a PNG, from its IHDR chunk. */
export function pngSize(b: Buffer): string | undefined {
  if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

/** A short error from an error body: `error.message` when it is JSON, else the start of the text. */
export function errorMessage(status: number, text: string): string {
  let msg = text.trim();
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; detail?: unknown };
    const m = typeof j.error === "string" ? j.error : j.error?.message ?? j.detail;
    if (typeof m === "string" && m.trim()) msg = m.trim();
  } catch {
    // not JSON
  }
  return `HTTP ${status}${msg ? `: ${msg.slice(0, 500)}` : ""}`;
}

/** `a-red-fox-at-dawn` from a title or prompt: lowercase ASCII words, at most 40 characters. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= 40) return s || "image";
  const cut = s.slice(0, 41);
  const at = cut.lastIndexOf("-");
  return (at >= 12 ? cut.slice(0, at) : s.slice(0, 40)).replace(/-+$/, "");
}

/** `YYYY-MM-DD-<slug>.<ext>`, with the local date; `-2`, `-3`... are added by the caller on a clash. */
export function imageFileName(title: string, ext: string, now = new Date(), n = 1): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${d}-${slugify(title)}${n > 1 ? `-${n}` : ""}.${ext}`;
}
