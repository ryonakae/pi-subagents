import { getSupportedThinkingLevels, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "./model-resolver.js";
import type { JevCandidate, JevSettings } from "./settings.js";

const JEV_ENDPOINTS = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
} as const;
const ABSTAIN_ID = "abstain";
const MAX_CHOICE_OPTIONS = 255;

export interface JevSelectorInput {
  task: string;
  role: string;
  guide: string;
  config: JevSettings;
  registry: ModelRegistry;
  fixedModel?: { provider: string; id: string };
  fixedEffort?: ThinkingLevel;
  enabledModels?: ReadonlySet<string>;
  signal?: AbortSignal;
  getOpenRouterApiKey?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}

export type JevSelectionResult =
  | { kind: "fixed" }
  | { kind: "fallback"; warning?: string }
  | {
      kind: "selected";
      model: ReturnType<ModelRegistry["find"]>;
      modelId: string;
      effort: ThinkingLevel;
      source: "deterministic" | "jev";
    };

interface EligibleCandidate {
  candidate: JevCandidate;
  model: ReturnType<ModelRegistry["find"]>;
  modelId: string;
}

/** Select only fields the caller left unspecified. */
export async function selectJevCandidate(input: JevSelectorInput): Promise<JevSelectionResult> {
  if (!input.config.enabled) return { kind: "fallback" };
  if (input.fixedModel !== undefined && input.fixedEffort !== undefined) return { kind: "fixed" };

  if (!input.guide.trim()) {
    return { kind: "fallback", warning: "Jev model selection skipped: model selection guide is missing or empty." };
  }

  const eligible = eligibleCandidates(input);
  if (eligible.length === 0) {
    return { kind: "fallback", warning: "Jev model selection skipped: no eligible candidates." };
  }
  if (eligible.length === 1) return selected(eligible[0], "deterministic");
  if (eligible.length + 1 > MAX_CHOICE_OPTIONS) {
    return {
      kind: "fallback",
      warning: `Jev model selection skipped: ${eligible.length + 1} Choice options exceed the 255-option limit.`,
    };
  }

  const criteria: Record<string, unknown> = {};
  const candidates = eligible.map(({ candidate }, index) => {
    const id = candidateId(index);
    criteria[id] = candidate;
    return id;
  });
  criteria[ABSTAIN_ID] = "None of the candidates is suitable; ask the actual parent agent to decide.";

  const body = JSON.stringify({
    state: { task: input.task, role: input.role, guide: input.guide, candidates },
    model: input.config.model,
    questions: {
      selection: {
        type: "choice",
        instructions: "Select the best eligible model and effort pair for this delegated task, or abstain.",
        criteria,
      },
    },
  });
  if (Buffer.byteLength(body, "utf8") > input.config.maxRequestBytes) {
    return {
      kind: "fallback",
      warning: `Jev model selection skipped: request exceeds maxRequestBytes (${input.config.maxRequestBytes}).`,
    };
  }

  let apiKey: string | undefined;
  if (input.config.provider === "openrouter") {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Jev selection aborted");
    if (input.getOpenRouterApiKey === undefined) {
      return { kind: "fallback", warning: "Jev model selection skipped: OpenRouter authentication is unavailable." };
    }
    try {
      apiKey = await input.getOpenRouterApiKey();
    } catch {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Jev selection aborted");
      return { kind: "fallback", warning: "Jev model selection failed: OpenRouter authentication could not be resolved." };
    }
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Jev selection aborted");
    if (!apiKey) {
      return { kind: "fallback", warning: "Jev model selection skipped: OpenRouter authentication is unavailable." };
    }
  } else {
    apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
      return { kind: "fallback", warning: "Jev model selection skipped: TYPESAFE_API_KEY is not set." };
    }
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Jev request timed out"));
  }, input.config.timeoutMs);
  const onAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await (input.fetch ?? fetch)(JEV_ENDPOINTS[input.config.provider], {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });
    const fetchInterruption = interruptionFallback(input.signal, timedOut, input.config.timeoutMs);
    if (fetchInterruption !== undefined) return fetchInterruption;
    if (!response.ok) return httpFallback(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const bodyInterruption = interruptionFallback(input.signal, timedOut, input.config.timeoutMs);
      if (bodyInterruption !== undefined) return bodyInterruption;
      return { kind: "fallback", warning: "Jev model selection failed: response was not valid JSON." };
    }
    const bodyInterruption = interruptionFallback(input.signal, timedOut, input.config.timeoutMs);
    if (bodyInterruption !== undefined) return bodyInterruption;
    const answer = choiceAnswer(payload);
    if (answer === undefined) {
      return { kind: "fallback", warning: "Jev model selection failed: response did not match the Choice contract." };
    }
    if (answer.choice === ABSTAIN_ID) {
      return { kind: "fallback", warning: "Jev abstained from model selection; parent selection required." };
    }
    if (answer.confidence < input.config.minConfidence) {
      return {
        kind: "fallback",
        warning: `Jev model selection confidence ${answer.confidence.toFixed(3)} is below ${input.config.minConfidence}.`,
      };
    }
    const index = /^candidate_(\d+)$/.exec(answer.choice)?.[1];
    const choice = index === undefined ? undefined : eligible[Number(index) - 1];
    if (choice === undefined) {
      return { kind: "fallback", warning: "Jev model selection failed: response selected an unknown candidate." };
    }
    return selected(choice, "jev");
  } catch {
    const interruption = interruptionFallback(input.signal, timedOut, input.config.timeoutMs);
    if (interruption !== undefined) return interruption;
    return { kind: "fallback", warning: "Jev model selection request failed; parent selection required." };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function interruptionFallback(
  signal: AbortSignal | undefined,
  timedOut: boolean,
  timeoutMs: number,
): Extract<JevSelectionResult, { kind: "fallback" }> | undefined {
  if (signal?.aborted) throw signal.reason ?? new Error("Jev selection aborted");
  if (!timedOut) return undefined;
  return {
    kind: "fallback",
    warning: `Jev model selection timed out after ${timeoutMs}ms; parent selection required.`,
  };
}

function eligibleCandidates(input: JevSelectorInput): EligibleCandidate[] {
  const availableModels = input.registry.getAvailable?.() ?? input.registry.getAll();
  const available = new Set(
    availableModels.map(model => `${model.provider}/${model.id}`.toLowerCase()),
  );
  const fixedModelId = input.fixedModel === undefined
    ? undefined
    : `${input.fixedModel.provider}/${input.fixedModel.id}`.toLowerCase();
  const seen = new Set<string>();

  return input.config.candidates.flatMap(candidate => {
    const modelId = candidate.model.toLowerCase();
    const slash = candidate.model.indexOf("/");
    if (slash < 1 || slash === candidate.model.length - 1) return [];
    if (!available.has(modelId)) return [];
    if (input.enabledModels !== undefined && !input.enabledModels.has(modelId)) return [];
    if (fixedModelId !== undefined && fixedModelId !== modelId) return [];
    if (input.fixedEffort !== undefined && input.fixedEffort !== candidate.effort) return [];
    const model = input.registry.find(candidate.model.slice(0, slash), candidate.model.slice(slash + 1));
    if (model === undefined || !getSupportedThinkingLevels(model).includes(candidate.effort)) return [];
    const pair = `${modelId}:${candidate.effort}`;
    if (seen.has(pair)) return [];
    seen.add(pair);
    return [{ candidate, model, modelId: candidate.model }];
  });
}

function selected(candidate: EligibleCandidate, source: "deterministic" | "jev"): JevSelectionResult {
  return {
    kind: "selected",
    model: candidate.model,
    modelId: candidate.modelId,
    effort: candidate.candidate.effort,
    source,
  };
}

function candidateId(index: number): string {
  return `candidate_${index + 1}`;
}

function choiceAnswer(payload: unknown): { choice: string; confidence: number } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const answers = (payload as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined;
  const answer = (answers as Record<string, unknown>).selection;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  const record = answer as Record<string, unknown>;
  if (record.type !== "choice" || typeof record.choice !== "string") return undefined;
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)
    || record.confidence < 0 || record.confidence > 1) return undefined;
  if (!record.probabilities || typeof record.probabilities !== "object" || Array.isArray(record.probabilities)) {
    return undefined;
  }
  for (const probability of Object.values(record.probabilities as Record<string, unknown>)) {
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return undefined;
    }
  }
  return { choice: record.choice, confidence: record.confidence };
}

function httpFallback(status: number): JevSelectionResult {
  const reason = status === 401 || status === 403
    ? "authentication was rejected"
    : status === 429
      ? "rate limit exceeded"
      : status >= 500
        ? "service unavailable"
        : `HTTP ${status}`;
  return { kind: "fallback", warning: `Jev model selection failed: ${reason}; parent selection required.` };
}
