import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { b4agentDir } from "../permissions/config.js";
import { BACKEND_LABEL, type BackendKind, paint, pickBackend, type PainterRegistry } from "../painter/backend.js";
import { imagesDir, loadReferences, saveImage } from "../painter/files.js";
import { pngSize } from "../painter/request.js";
import { recordRateLimitHeaders } from "./usage.js";

/**
 * painter (plan section 8): image generation and edits with gpt-image-2.
 * Registered on session start, and only when a backend has credentials
 * (src/painter/backend.ts). Main agent and subagents alike.
 */

const Params = Type.Object({
  prompt: Type.String({ description: "What to draw, or for an edit what to change. Pass the user's own wording for the subject and style; add only what they left implicit (layout, text to render exactly, aspect)." }),
  name: Type.Optional(Type.String({ description: "A short title for the file name, e.g. 'login page hero'. Defaults to the prompt's first words." })),
  reference_images: Type.Optional(
    Type.Array(Type.String(), { maxItems: 5, description: "Up to 5 image paths (PNG, JPEG, WebP, GIF) to edit or use as references. Any present makes this an edit." }),
  ),
  transparent_background: Type.Optional(Type.Boolean({ description: "Transparent background (for icons, logos, sprites). Default false." })),
  size: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("1024x1024"), Type.Literal("1536x1024"), Type.Literal("1024x1536")], { description: "Default auto." })),
  quality: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "Default auto. low is faster for drafts." })),
});

const DESCRIPTION =
  "Generate an image with gpt-image-2, or edit images given as reference_images. " +
  "Only use it when the user asks for an image (a picture, icon, logo, illustration, mockup, diagram as an image, or an edit of one): " +
  "image generation uses the user's plan limits 3 to 5 times faster than a normal turn, and API keys pay per image. " +
  "Don't use it for diagrams that can be text (Mermaid, SVG code, ASCII). " +
  "The image is saved outside the repository and the result gives its path; copy it into the repository only when the user asks, to the place they name. One image per call.";

export default function painter(pi: ExtensionAPI) {
  let registered = false;
  pi.on("session_start", (_e, ctx) => {
    if (registered) return;
    const reg = ctx.modelRegistry as unknown as PainterRegistry;
    if (!pickBackend(reg)) return;
    registered = true;
    pi.registerTool({
      name: "painter",
      label: "painter",
      description: DESCRIPTION,
      promptSnippet: "Generate or edit an image (only when the user asks for one)",
      parameters: Params,
      async execute(_id, params, signal, onUpdate, ctx) {
        const reg = ctx.modelRegistry as unknown as PainterRegistry;
        const backend: BackendKind | undefined = pickBackend(reg);
        const fail = (msg: string) => ({ content: [{ type: "text" as const, text: `painter failed: ${msg}` }], details: { error: msg }, isError: true });
        if (!backend) return fail("no image backend is configured any more (log in to openai-codex, or set an OpenAI or OpenRouter key)");
        let images: string[] = [];
        try {
          images = loadReferences(params.reference_images ?? [], ctx.cwd);
        } catch (e) {
          return fail((e as Error).message);
        }
        onUpdate?.({ content: [{ type: "text", text: `painting via ${BACKEND_LABEL[backend]}...` }], details: {} });
        try {
          const out = await paint(
            reg,
            backend,
            {
              prompt: params.prompt,
              ...(params.transparent_background ? { transparent: true } : {}),
              ...(params.size ? { size: params.size } : {}),
              ...(params.quality ? { quality: params.quality } : {}),
              images,
            },
            signal ? { signal } : {},
          );
          if (out.headers) recordRateLimitHeaders(out.headers);
          const path = saveImage(imagesDir(b4agentDir(), ctx.cwd), params.name?.trim() || params.prompt, out.ext, out.bytes);
          const px = out.mime === "image/png" ? pngSize(out.bytes) : undefined;
          const facts = [px ?? out.size, `${Math.round(out.bytes.length / 1024)} KB`, images.length ? `edit of ${images.length} image${images.length > 1 ? "s" : ""}` : undefined, `via ${BACKEND_LABEL[backend]}`].filter(Boolean).join(", ");
          return {
            content: [
              { type: "text" as const, text: `Saved ${path} (${facts}). It is outside the repository; copy it in only if the user asks.` },
              { type: "image" as const, data: out.bytes.toString("base64"), mimeType: out.mime },
            ],
            details: { path, backend, ...(out.requestId ? { requestId: out.requestId } : {}) },
          };
        } catch (e) {
          const err = e as Error;
          return fail(err.name === "TimeoutError" ? "no answer within 5 minutes" : err.message);
        }
      },
      renderCall(args, theme) {
        const a = args as { prompt?: string; reference_images?: string[] };
        const edit = a.reference_images?.length ? theme.fg("muted", ` (edit ${a.reference_images.length})`) : "";
        return new Text(theme.fg("toolTitle", theme.bold("painter ")) + theme.fg("muted", (a.prompt ?? "").replace(/\s+/g, " ").slice(0, 120)) + edit, 0, 0);
      },
    });
  });
}
