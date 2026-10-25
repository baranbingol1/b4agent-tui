/**
 * Painter backends (plan section 8), in order:
 * 1. the `openai-codex` login (ChatGPT plan): the native Codex images endpoints;
 * 2. an OpenAI API key: the Images API, same body (paid per image);
 * 3. an OpenRouter key: Pi's own image API with `openai/gpt-image-2` (paid per image).
 * No backend: the painter tool isn't registered. A failing backend is reported, never
 * silently swapped for a paid one. No carrier model (a Responses call with the hosted
 * `image_generation` tool): that is what broke for Hermes when OpenAI withdrew the carrier.
 *
 * Credentials come from Pi's model registry, so the Codex token is refreshed by Pi and
 * a `models.json` base URL override (a proxy, or a test stub) applies here too.
 */
import type { Api, AuthResult, ImageApi, ImageModel, ImagesContext, AssistantImages, Model } from "@earendil-works/pi-ai";
import { buildImageRequest, chatgptAccountId, codexImageHeaders, errorMessage, IMAGE_MODEL, type PaintArgs, type ParsedImage, parseImageResponse, sniffImage } from "./request.js";

export const OPENROUTER_IMAGE_MODEL = "openai/gpt-image-2";

/** The parts of Pi's ModelRegistry the painter uses. */
export interface PainterRegistry {
  getAll(): Model<Api>[];
  getProviderAuthStatus(provider: string): { configured: boolean };
  getProviderAuth(provider: string): Promise<AuthResult | undefined>;
  getProvider(provider: string): { baseUrl?: string } | undefined;
  isUsingOAuth(model: Model<Api>): boolean;
  getModelOfType(type: "image", provider: string, modelId: string): ImageModel<ImageApi> | undefined;
  generateImages(model: ImageModel<ImageApi>, context: ImagesContext, options?: { signal?: AbortSignal }): Promise<AssistantImages>;
}

export type BackendKind = "codex" | "openai" | "openrouter";

export const BACKEND_LABEL: Record<BackendKind, string> = {
  codex: "ChatGPT plan (openai-codex login)",
  openai: "OpenAI API key (paid per image)",
  openrouter: "OpenRouter key (paid per image)",
};

/** The first configured backend, without any network call. */
export function pickBackend(reg: PainterRegistry): BackendKind | undefined {
  try {
    if (reg.getProviderAuthStatus("openai-codex").configured) return "codex";
    const openai = reg.getAll().find((m) => m.provider === "openai");
    // Pi's new `openai` OAuth login is scoped to api.openai.com chat; OpenAI lists image generation as unsupported for it.
    if (reg.getProviderAuthStatus("openai").configured && !(openai && reg.isUsingOAuth(openai))) return "openai";
    if (reg.getProviderAuthStatus("openrouter").configured && reg.getModelOfType("image", "openrouter", OPENROUTER_IMAGE_MODEL)) return "openrouter";
  } catch {
    // a registry that can't answer has no backend for us
  }
  return undefined;
}

function baseUrl(reg: PainterRegistry, provider: string, auth: AuthResult | undefined, fallback: string): string {
  const u = auth?.auth.baseUrl ?? reg.getAll().find((m) => m.provider === provider)?.baseUrl ?? reg.getProvider(provider)?.baseUrl ?? fallback;
  return u.replace(/\/+$/, "");
}

export interface Painted extends ParsedImage {
  backend: BackendKind;
  requestId?: string;
  /** Raw response headers of the Codex call (they carry the plan's rate-limit snapshot). */
  headers?: Record<string, string>;
}

export interface PaintOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** One image through the given backend. Throws with a message meant for the agent. */
export async function paint(reg: PainterRegistry, kind: BackendKind, args: PaintArgs, opts: PaintOptions = {}): Promise<Painted> {
  const doFetch = opts.fetch ?? fetch;
  if (kind === "openrouter") return paintOpenRouter(reg, args, opts.signal);
  const provider = kind === "codex" ? "openai-codex" : "openai";
  const auth = await reg.getProviderAuth(provider);
  const token = auth?.auth.apiKey;
  if (!token) throw new Error(kind === "codex" ? "the openai-codex login is missing or expired; run /login" : "no OpenAI API key");
  let url: string;
  let headers: Record<string, string>;
  const req = buildImageRequest(args);
  if (kind === "codex") {
    const account = chatgptAccountId(token);
    if (!account) throw new Error("the openai-codex token has no ChatGPT account id; run /login again");
    url = `${baseUrl(reg, provider, auth, "https://chatgpt.com/backend-api")}/codex/${req.path}`;
    headers = codexImageHeaders(token, account);
  } else {
    url = `${baseUrl(reg, provider, auth, "https://api.openai.com/v1")}/${req.path}`;
    headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  }
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000);
  const res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(req.body), signal });
  const text = await res.text();
  const requestId = res.headers.get("x-codex-imagegen-request-id") ?? res.headers.get("x-request-id") ?? undefined;
  const raw: Record<string, string> = {};
  res.headers.forEach((v, k) => (raw[k] = v));
  if (!res.ok) {
    const limit = res.status === 429 ? " (usage limit: /usage shows the plan's windows and reset times)" : "";
    throw new Error(`${errorMessage(res.status, text)}${limit}${requestId ? ` [request ${requestId}]` : ""}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`the response was not JSON: ${text.slice(0, 200)}`);
  }
  return { ...parseImageResponse(json), backend: kind, ...(requestId ? { requestId } : {}), headers: raw };
}

async function paintOpenRouter(reg: PainterRegistry, args: PaintArgs, signal?: AbortSignal): Promise<Painted> {
  const model = reg.getModelOfType("image", "openrouter", OPENROUTER_IMAGE_MODEL);
  if (!model) throw new Error(`OpenRouter has no ${OPENROUTER_IMAGE_MODEL} in Pi's catalog`);
  const input: ImagesContext["input"] = [{ type: "text", text: args.transparent ? `${args.prompt}\n\nTransparent background.` : args.prompt }];
  for (const url of args.images ?? []) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (m) input.push({ type: "image", mimeType: m[1]!, data: m[2]! });
  }
  const out = await reg.generateImages(model, { input }, signal ? { signal } : {});
  if (out.stopReason !== "stop") throw new Error(out.errorMessage ?? `OpenRouter stopped: ${out.stopReason}`);
  const img = out.output.find((c) => c.type === "image");
  if (!img || img.type !== "image") throw new Error("OpenRouter returned no image");
  const bytes = Buffer.from(img.data, "base64");
  const kind = sniffImage(bytes) ?? { mime: img.mimeType, ext: img.mimeType.split("/")[1] ?? "png" };
  return { bytes, ...kind, backend: "openrouter", ...(out.responseId ? { requestId: out.responseId } : {}) };
}

export { IMAGE_MODEL };
