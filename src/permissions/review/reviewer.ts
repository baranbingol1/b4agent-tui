import { createHash } from "node:crypto";
import type { AssistantMessageEventStream, ClassifierModel, ClassifierApi, ClassifierContext, ClassifierResult, Context, Model, Api } from "@earendil-works/pi-ai";
import type { ReviewInput } from "./input.js";
import { combine, DEFAULT_THRESHOLDS, explain, JEV_MODEL, JEV_QUESTIONS, jevState, scoresFrom, type JevScores, type Thresholds } from "./jev.js";
import { forceTool, llmContext, parseDecision, type LlmDecision } from "./llm.js";
import { logSideUsage } from "../../usage-log.js";

/** The parts of Pi's ModelRegistry the reviewer uses. */
export interface ReviewModels {
  findOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
  find(provider: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(model: Model<Api>): boolean;
  classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: Record<string, unknown>): Promise<ClassifierResult>;
  streamSimple(model: Model<Api>, context: Context, options?: Record<string, unknown>): AssistantMessageEventStream;
}

export interface ReviewerOptions {
  /** Use Jev when TypeSafe credentials exist. */
  jev: boolean;
  /** `provider/id` of the LLM reviewer, or undefined for none. */
  llm?: string;
  llmReasoning?: "off" | "minimal" | "low" | "medium";
  thresholds?: Thresholds;
  jevTimeoutMs?: number;
  llmTimeoutMs?: number;
}

export interface ReviewResult {
  decision: "allow" | "ask";
  reason: string;
  by: "jev" | "llm" | "cache" | "none";
  scores?: JevScores;
  model?: string;
  ms: number;
  /** Errors from reviewers that were tried and failed. */
  errors?: string[];
}

export interface Reviewer {
  review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewResult>;
  /** Which reviewers are usable, for the status line and /permissions. */
  describe(): string;
}

export function createReviewer(models: ReviewModels, opts: ReviewerOptions): Reviewer {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const cache = new Map<string, ReviewResult>();

  const jevModel = () => {
    if (!opts.jev) return undefined;
    const base = models.findOfType("classifier", "typesafe", "jev-latest");
    // Pin the version: thresholds were tuned on it and the alias can move.
    return base && models.hasConfiguredAuth(base as unknown as Model<Api>) ? { ...base, id: JEV_MODEL } : undefined;
  };
  const llmModel = () => {
    if (!opts.llm) return undefined;
    const [provider, ...rest] = opts.llm.split("/");
    const m = provider ? models.find(provider, rest.join("/")) : undefined;
    return m && models.hasConfiguredAuth(m) ? m : undefined;
  };

  async function runJev(input: ReviewInput, signal?: AbortSignal): Promise<{ scores: JevScores } | { error: string }> {
    const model = jevModel();
    if (!model) return { error: "jev unavailable" };
    const r = await models.classify(model, { state: jevState(input), questions: JEV_QUESTIONS }, { signal, timeoutMs: opts.jevTimeoutMs ?? 6000, maxRetries: 1 });
    logSideUsage("reviewer-jev", `${model.provider}/${model.id}`, r.usage);
    if (r.stopReason !== "stop") return { error: `jev: ${r.errorMessage ?? r.stopReason}` };
    const scores = scoresFrom(r.answers);
    return scores ? { scores } : { error: "jev: incomplete answers" };
  }

  async function runLlm(input: ReviewInput, scores: JevScores | undefined, signal?: AbortSignal): Promise<(LlmDecision & { model: string }) | { error: string }> {
    const model = llmModel();
    if (!model) return { error: "llm reviewer unavailable" };
    const stream = models.streamSimple(model, llmContext(input, scores), {
      signal,
      reasoning: opts.llmReasoning ?? "low",
      timeoutMs: opts.llmTimeoutMs ?? 25_000,
      maxRetries: 1,
      cacheRetention: "none",
      onPayload: forceTool,
    });
    const reply = await stream.result();
    logSideUsage("reviewer-llm", `${model.provider}/${model.id}`, reply.usage);
    const parsed = parseDecision(reply);
    return "error" in parsed ? { error: `llm: ${parsed.error}` } : { ...parsed, model: `${model.provider}/${model.id}` };
  }

  return {
    describe() {
      const parts = [jevModel() && `Jev (${JEV_MODEL})`, llmModel() && opts.llm].filter(Boolean);
      return parts.length ? parts.join(", then ") : "none available";
    },

    async review(input, signal) {
      const start = Date.now();
      const key = fingerprint(input);
      const hit = cache.get(key);
      if (hit) return { ...hit, by: "cache", ms: 0 };
      const errors: string[] = [];
      const done = (r: Omit<ReviewResult, "ms" | "errors">): ReviewResult => {
        const out: ReviewResult = { ...r, ms: Date.now() - start, ...(errors.length ? { errors } : {}) };
        if (r.by !== "none") cache.set(key, out);
        return out;
      };

      let scores: JevScores | undefined;
      const j = await runJev(input, signal);
      if ("scores" in j) {
        scores = j.scores;
        const outcome = combine(scores, thresholds);
        if (outcome !== "escalate") return done({ decision: outcome, reason: explain(scores), by: "jev", scores, model: JEV_MODEL });
      } else errors.push(j.error);

      const l = await runLlm(input, scores, signal);
      if (!("error" in l)) return done({ decision: l.decision, reason: l.reason, by: "llm", model: l.model, ...(scores ? { scores } : {}) });
      errors.push(l.error);
      if (signal?.aborted) return done({ decision: "ask", reason: "review cancelled", by: "none" });
      return done({ decision: "ask", reason: scores ? `${explain(scores)}; the second reviewer failed` : "no reviewer could check this", by: "none", ...(scores ? { scores } : {}) });
    },
  };
}

/** Same action, same request: same answer. */
function fingerprint(input: ReviewInput): string {
  return createHash("sha256").update(JSON.stringify([input.action, input.user.latest, input.facts.can_undo])).digest("hex");
}
