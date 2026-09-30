import { describe, expect, it, vi } from "vitest";
import { selectJevCandidate } from "../src/jev-selector.js";
import type { JevSettings } from "../src/settings.js";

const sonnet = {
  provider: "anthropic",
  id: "claude-sonnet-4-6",
  name: "Sonnet 4.6",
  reasoning: true,
};
const opus = {
  provider: "anthropic",
  id: "claude-opus-4-6",
  name: "Opus 4.6",
  reasoning: true,
};

const baseConfig = (overrides: Partial<JevSettings> = {}): JevSettings => ({
  enabled: true,
  provider: "typesafe",
  model: "jev-1.13.0",
  timeoutMs: 5000,
  minConfidence: 0.7,
  maxRequestBytes: 65_536,
  candidates: [
    { model: "anthropic/claude-sonnet-4-6", effort: "low", description: "Routine work" },
    { model: "anthropic/claude-opus-4-6", effort: "high", description: "Complex work" },
  ],
  ...overrides,
});

const registry = {
  getAll: vi.fn(() => [sonnet, opus]),
  getAvailable: vi.fn(() => [sonnet, opus]),
  find: vi.fn((provider: string, id: string) =>
    [sonnet, opus].find(model => model.provider === provider && model.id === id)),
};

async function withApiKey<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-secret";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
}

function choiceResponse(choice: string, confidence = 0.9): Response {
  return new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      selection: {
        type: "choice",
        choice,
        confidence,
        probabilities: { candidate_1: 0.05, candidate_2: 0.9, abstain: 0.05 },
      },
    },
  }), { status: 200 });
}

describe("Jev model selector", () => {
  it("makes no request while disabled", async () => {
    const fetchFn = vi.fn();
    const getOpenRouterApiKey = vi.fn(async () => "unused-secret");

    const result = await selectJevCandidate({
      task: "Inspect the authentication flow",
      role: "Read-only explorer",
      guide: "Prefer the least expensive candidate that can complete the task.",
      config: baseConfig({ enabled: false, provider: "openrouter", model: "typesafe/jev-1.13" }),
      registry,
      getOpenRouterApiKey,
      fetch: fetchFn,
    });

    expect(result).toEqual({ kind: "fallback" });
    expect(getOpenRouterApiKey).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("makes no request when model and effort are both fixed", async () => {
    const fetchFn = vi.fn();
    const getOpenRouterApiKey = vi.fn(async () => "unused-secret");

    const result = await selectJevCandidate({
      task: "Implement the parser",
      role: "General implementation agent",
      guide: "Choose conservatively.",
      config: baseConfig({ provider: "openrouter", model: "typesafe/jev-1.13" }),
      registry,
      fixedModel: sonnet,
      fixedEffort: "low",
      getOpenRouterApiKey,
      fetch: fetchFn,
    });

    expect(result).toEqual({ kind: "fixed" });
    expect(getOpenRouterApiKey).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back without a request when no candidate survives availability, scope, and fixed constraints", async () => {
    const fetchFn = vi.fn();
    const getOpenRouterApiKey = vi.fn(async () => "unused-secret");

    const result = await selectJevCandidate({
      task: "Review the API",
      role: "Reviewer",
      guide: "Choose conservatively.",
      config: baseConfig({ provider: "openrouter", model: "typesafe/jev-1.13" }),
      registry,
      fixedEffort: "max",
      enabledModels: new Set(["anthropic/claude-sonnet-4-6"]),
      getOpenRouterApiKey,
      fetch: fetchFn,
    });

    expect(result.kind).toBe("fallback");
    expect(result).toMatchObject({ warning: expect.stringContaining("no eligible candidates") });
    expect(getOpenRouterApiKey).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats an explicitly configured empty model scope as zero eligible candidates", async () => {
    const fetchFn = vi.fn();

    const result = await selectJevCandidate({
      task: "Review the API",
      role: "Reviewer",
      guide: "Choose conservatively.",
      config: baseConfig(),
      registry,
      enabledModels: new Set(),
      fetch: fetchFn,
    });

    expect(result).toMatchObject({ kind: "fallback", warning: expect.stringContaining("no eligible candidates") });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("selects one eligible candidate deterministically without a request", async () => {
    const fetchFn = vi.fn();
    const getOpenRouterApiKey = vi.fn(async () => "unused-secret");

    const result = await selectJevCandidate({
      task: "Review the API",
      role: "Reviewer",
      guide: "Choose conservatively.",
      config: baseConfig({ provider: "openrouter", model: "typesafe/jev-1.13" }),
      registry,
      fixedModel: opus,
      getOpenRouterApiKey,
      fetch: fetchFn,
    });

    expect(result).toEqual({
      kind: "selected",
      model: opus,
      modelId: "anthropic/claude-opus-4-6",
      effort: "high",
      source: "deterministic",
    });
    expect(getOpenRouterApiKey).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends only task, role, guide, and candidates as state and applies a valid Choice response", async () => {
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "test-secret";
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        selection: {
          type: "choice",
          choice: "candidate_2",
          confidence: 0.91,
          probabilities: { candidate_1: 0.08, candidate_2: 0.91, abstain: 0.01 },
        },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    try {
      const result = await selectJevCandidate({
        task: "Implement OAuth callback validation",
        role: "Security-focused implementation agent",
        guide: "Prefer the least expensive option that can satisfy the task.",
        config: baseConfig(),
        registry,
        fetch: fetchFn,
      });

      expect(result).toEqual({
        kind: "selected",
        model: opus,
        modelId: "anthropic/claude-opus-4-6",
        effort: "high",
        source: "jev",
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Bearer test-secret",
          "Content-Type": "application/json",
        },
      });
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.state)).toEqual(["task", "role", "guide", "candidates"]);
      expect(body.state.task).toBe("Implement OAuth callback validation");
      expect(body.state).not.toHaveProperty("conversation");
      expect(body.questions.selection).toMatchObject({
        type: "choice",
        criteria: {
          candidate_1: expect.anything(),
          candidate_2: expect.anything(),
          abstain: expect.anything(),
        },
      });
    } finally {
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
    }
  });

  it("uses Pi OpenRouter authentication and the fixed OpenRouter SystemOne endpoint", async () => {
    const getOpenRouterApiKey = vi.fn(async () => "openrouter-synthetic-secret");
    const fetchFn = vi.fn(async () => choiceResponse("candidate_2"));

    const result = await selectJevCandidate({
      task: "Route this task",
      role: "Reviewer",
      guide: "Choose conservatively.",
      config: baseConfig({ provider: "openrouter", model: "typesafe/jev-1.13" }),
      registry,
      getOpenRouterApiKey,
      fetch: fetchFn,
    });

    expect(result).toMatchObject({ kind: "selected", modelId: "anthropic/claude-opus-4-6" });
    expect(getOpenRouterApiKey).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/systemone");
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer openrouter-synthetic-secret" },
    });
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "typesafe/jev-1.13" });
  });

  it("does not consult Pi OpenRouter authentication for TypeSafe", async () => {
    await withApiKey(async () => {
      const getOpenRouterApiKey = vi.fn(async () => "wrong-secret");
      const fetchFn = vi.fn(async () => choiceResponse("candidate_2"));

      await selectJevCandidate({
        task: "Route this task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig(),
        registry,
        getOpenRouterApiKey,
        fetch: fetchFn,
      });

      expect(getOpenRouterApiKey).not.toHaveBeenCalled();
      expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
      expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
        headers: { Authorization: "Bearer test-secret" },
      });
    });
  });

  it("does not reuse TypeSafe credentials when OpenRouter authentication is unavailable", async () => {
    await withApiKey(async () => {
      const fetchFn = vi.fn();
      const result = await selectJevCandidate({
        task: "Route this task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig({ provider: "openrouter", model: "typesafe/jev-1.13" }),
        registry,
        fetch: fetchFn,
      });

      expect(result).toMatchObject({ kind: "fallback", warning: expect.stringContaining("OpenRouter authentication") });
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  it("redacts OpenRouter authentication errors and sends no request", async () => {
    const fetchFn = vi.fn();
    const result = await selectJevCandidate({
      task: "private task",
      role: "Reviewer",
      guide: "Choose conservatively.",
      config: baseConfig({ provider: "openrouter", model: "typesafe/jev-1.13" }),
      registry,
      getOpenRouterApiKey: vi.fn(async () => { throw new Error("raw-auth-secret-sentinel"); }),
      fetch: fetchFn,
    });

    expect(result).toMatchObject({ kind: "fallback", warning: expect.stringContaining("OpenRouter authentication") });
    expect((result as { warning?: string }).warning).not.toContain("raw-auth-secret-sentinel");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not send after caller abort while OpenRouter authentication is pending", async () => {
    const controller = new AbortController();
    let resolveKey: ((key: string) => void) | undefined;
    const getOpenRouterApiKey = vi.fn(() => new Promise<string>(resolve => { resolveKey = resolve; }));
    const fetchFn = vi.fn();
    const selecting = selectJevCandidate({
      task: "private task",
      role: "Reviewer",
      guide: "Choose conservatively.",
      config: baseConfig({ provider: "openrouter", model: "typesafe/jev-1.13" }),
      registry,
      signal: controller.signal,
      getOpenRouterApiKey,
      fetch: fetchFn,
    });

    controller.abort(new Error("cancelled during authentication"));
    resolveKey?.("late-secret");

    await expect(selecting).rejects.toThrow("cancelled during authentication");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back on abstention, low confidence, and malformed typed responses without retrying", async () => {
    await withApiKey(async () => {
      for (const response of [
        choiceResponse("abstain"),
        choiceResponse("candidate_2", 0.2),
        new Response(JSON.stringify({ answers: { selection: { type: "choice", choice: "candidate_2" } } })),
      ]) {
        const fetchFn = vi.fn(async () => response);
        const result = await selectJevCandidate({
          task: "private task text",
          role: "Reviewer",
          guide: "Choose conservatively.",
          config: baseConfig(),
          registry,
          fetch: fetchFn,
        });
        expect(result.kind).toBe("fallback");
        expect((result as { warning?: string }).warning).not.toContain("private task text");
        expect(fetchFn).toHaveBeenCalledTimes(1);
      }
    });
  });

  it("rejects oversized requests and too many Choice options before fetch", async () => {
    await withApiKey(async () => {
      const fetchFn = vi.fn();
      const getOpenRouterApiKey = vi.fn(async () => "unused-secret");
      const oversized = await selectJevCandidate({
        task: "large task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig({ provider: "openrouter", model: "typesafe/jev-1.13", maxRequestBytes: 1 }),
        registry,
        getOpenRouterApiKey,
        fetch: fetchFn,
      });
      expect(oversized).toMatchObject({ kind: "fallback", warning: expect.stringContaining("maxRequestBytes") });

      const models = Array.from({ length: 255 }, (_, index) => ({
        provider: "provider",
        id: `model-${index}`,
        name: `Model ${index}`,
        reasoning: true,
      }));
      const largeRegistry = {
        getAll: vi.fn(() => models),
        getAvailable: vi.fn(() => models),
        find: vi.fn((provider: string, id: string) => models.find(model => model.provider === provider && model.id === id)),
      };
      const tooMany = await selectJevCandidate({
        task: "task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig({
          provider: "openrouter",
          model: "typesafe/jev-1.13",
          candidates: models.map(model => ({ model: `${model.provider}/${model.id}`, effort: "low" })),
        }),
        registry: largeRegistry,
        getOpenRouterApiKey,
        fetch: fetchFn,
      });
      expect(tooMany).toMatchObject({ kind: "fallback", warning: expect.stringContaining("255-option limit") });
      expect(getOpenRouterApiKey).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  it("times out once and falls back without exposing a response body", async () => {
    await withApiKey(async () => {
      const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      const result = await selectJevCandidate({
        task: "sensitive task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig({ timeoutMs: 5 }),
        registry,
        fetch: fetchFn,
      });
      expect(result).toMatchObject({ kind: "fallback", warning: expect.stringContaining("timed out") });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  it("checks timeout immediately after fetch resolves", async () => {
    await withApiKey(async () => {
      let resolveFetch: ((response: Response) => void) | undefined;
      const fetchFn = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
      const selecting = selectJevCandidate({
        task: "sensitive task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig({ timeoutMs: 5 }),
        registry,
        fetch: fetchFn,
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      resolveFetch?.(choiceResponse("candidate_2"));

      await expect(selecting).resolves.toMatchObject({
        kind: "fallback",
        warning: expect.stringContaining("timed out"),
      });
    });
  });

  it("classifies a timeout while the response body is pending", async () => {
    await withApiKey(async () => {
      const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      }) as Response);

      const result = await selectJevCandidate({
        task: "sensitive task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig({ timeoutMs: 5 }),
        registry,
        fetch: fetchFn,
      });

      expect(result).toMatchObject({ kind: "fallback", warning: expect.stringContaining("timed out") });
    });
  });

  it("checks timeout immediately after the response body resolves", async () => {
    await withApiKey(async () => {
      let resolveBody: ((payload: unknown) => void) | undefined;
      let bodyStarted: (() => void) | undefined;
      const started = new Promise<void>(resolve => { bodyStarted = resolve; });
      const payload = await choiceResponse("candidate_2").json();
      const fetchFn = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(resolve => {
          resolveBody = resolve;
          bodyStarted?.();
        }),
      }) as Response);
      const selecting = selectJevCandidate({
        task: "sensitive task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig({ timeoutMs: 5 }),
        registry,
        fetch: fetchFn,
      });

      await started;
      await new Promise(resolve => setTimeout(resolve, 10));
      resolveBody?.(payload);

      await expect(selecting).resolves.toMatchObject({
        kind: "fallback",
        warning: expect.stringContaining("timed out"),
      });
    });
  });

  it("checks caller abort immediately after fetch resolves", async () => {
    await withApiKey(async () => {
      const controller = new AbortController();
      let resolveFetch: ((response: Response) => void) | undefined;
      const fetchFn = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
      const selecting = selectJevCandidate({
        task: "task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig(),
        registry,
        signal: controller.signal,
        fetch: fetchFn,
      });

      controller.abort(new Error("user cancelled before fetch resolved"));
      resolveFetch?.(choiceResponse("candidate_2"));

      await expect(selecting).rejects.toThrow("user cancelled before fetch resolved");
    });
  });

  it("propagates caller abort instead of treating it as a fallback", async () => {
    await withApiKey(async () => {
      const controller = new AbortController();
      const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      const selecting = selectJevCandidate({
        task: "task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig(),
        registry,
        signal: controller.signal,
        fetch: fetchFn,
      });
      controller.abort(new Error("user cancelled"));
      await expect(selecting).rejects.toThrow("user cancelled");
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  it("propagates caller abort while the response body is pending", async () => {
    await withApiKey(async () => {
      const controller = new AbortController();
      let bodyStarted: (() => void) | undefined;
      const started = new Promise<void>(resolve => { bodyStarted = resolve; });
      const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>((_resolve, reject) => {
          bodyStarted?.();
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      }) as Response);
      const selecting = selectJevCandidate({
        task: "task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig(),
        registry,
        signal: controller.signal,
        fetch: fetchFn,
      });

      await started;
      controller.abort(new Error("user cancelled during body"));

      await expect(selecting).rejects.toThrow("user cancelled during body");
    });
  });

  it("checks caller abort immediately after the response body resolves", async () => {
    await withApiKey(async () => {
      const controller = new AbortController();
      let resolveBody: ((payload: unknown) => void) | undefined;
      let bodyStarted: (() => void) | undefined;
      const started = new Promise<void>(resolve => { bodyStarted = resolve; });
      const payload = await choiceResponse("candidate_2").json();
      const fetchFn = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(resolve => {
          resolveBody = resolve;
          bodyStarted?.();
        }),
      }) as Response);
      const selecting = selectJevCandidate({
        task: "task",
        role: "Reviewer",
        guide: "Choose conservatively.",
        config: baseConfig(),
        registry,
        signal: controller.signal,
        fetch: fetchFn,
      });

      await started;
      controller.abort(new Error("user cancelled before body resolved"));
      resolveBody?.(payload);

      await expect(selecting).rejects.toThrow("user cancelled before body resolved");
    });
  });
});
