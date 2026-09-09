/**
 * rpc-result-consumption.test.ts — pi-tasks#62.
 *
 * An RPC-spawned background agent (pi-tasks' `TaskExecute`) is not part of any
 * join group, so it nudges the parent individually when it finishes. The caller
 * joins it on the `subagents:completed` event instead — and used to have no way
 * to say the result had been read, because `get_subagent_result`, the only
 * consuming path, is a tool the *parent model* calls, not something reachable
 * over the bus. The held notification therefore landed on top of an answer the
 * parent had already given, costing a turn to dismiss.
 *
 * `subagents:rpc:consume` closes that: it is the bus-side half of what
 * `get_subagent_result` does when it hands a result back. These tests drive the
 * real extension, so what they pin is the actual delivery path — the notification
 * fires for an unjoined agent, and does not for a consumed one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

/** pi-subagents holds a completion notification for NUDGE_HOLD_MS (200ms). */
const PAST_THE_HOLD_MS = 400;

/**
 * Like `boot-extension.ts`'s `makePi`, but with a bus that actually dispatches:
 * these tests are about what a second extension sees and sends on it.
 */
function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  const bus = {
    emit: vi.fn((event: string, data: unknown) => {
      for (const h of [...(handlers.get(event) ?? [])]) h(data);
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter(h => h !== handler));
    }),
  };
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: bus,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, bus };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
    isIdle: () => true,
    ...overrides,
  } as any;
}

const notifications = (pi: any): unknown[] =>
  pi.sendMessage.mock.calls.filter((c: any[]) => c[0]?.customType === "subagent-notification");

describe("subagents:rpc:consume", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-consume-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-consume-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, outputTranscript: false, defaultJoinMode: "async" }),
    );
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Boot the real extension with its RPC handlers bound, as session_start does. */
  async function boot(ctxOverrides?: Record<string, unknown>) {
    const booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx(ctxOverrides));
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    return booted;
  }

  /** Spawn a background agent over the bus, the way pi-tasks' TaskExecute does. */
  async function spawnOverRpc(bus: ReturnType<typeof makePi>["bus"], requestId: string): Promise<string> {
    let id = "";
    bus.on(`subagents:rpc:spawn:reply:${requestId}`, (reply: any) => { id = reply.data.id; });
    bus.emit("subagents:rpc:spawn", {
      requestId,
      type: "general-purpose",
      prompt: "go",
      options: { description: "task #1", isBackground: true },
    });
    await vi.waitFor(() => expect(id).toBeTruthy());
    return id;
  }

  /** Spawn through the registered Agent tool and return its public result id. */
  async function spawnOverTool(tools: Map<string, any>, toolCallId: string, name?: string): Promise<string> {
    const started = await tools.get("Agent").execute(
      toolCallId,
      {
        prompt: "go",
        description: toolCallId,
        name,
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );
    const id = String(started.content[0].text).match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();
    return id as string;
  }

  /** Keep each mocked child running until its resolver is called. */
  function deferredRuns(): Array<() => void> {
    const resolvers: Array<() => void> = [];
    vi.mocked(runAgent).mockImplementation(
      () => new Promise((resolve) => {
        const index = resolvers.length + 1;
        const session = { messages: [], subscribe: vi.fn(() => vi.fn()), dispose: vi.fn() };
        resolvers.push(() => resolve({ responseText: `GROUP_RESULT_${index}`, session } as any));
      }) as any,
    );
    return resolvers;
  }

  /** Resume a completed record through the registered Agent tool. */
  async function resumeOverTool(tools: Map<string, any>, id: string, toolCallId: string): Promise<void> {
    await tools.get("Agent").execute(
      toolCallId,
      {
        prompt: "continue",
        description: toolCallId,
        subagent_type: "general-purpose",
        resume: id,
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );
  }

  it.each(["print", "json"])("delivers after the hold in busy %s mode", async (mode) => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "ONE_SHOT_AGENT_OK" } as any);
    const { pi, bus } = await boot({ mode, isIdle: () => false });

    await spawnOverRpc(bus, `req-spawn-${mode}`);
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    expect(notifications(pi)).toHaveLength(1);
  });

  it("suppresses a tool-spawned notification consumed after the hold while the parent is busy", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "TOOL_AGENT_OK" } as any);
    let idle = false;
    const { pi, tools, lifecycle } = await boot({ isIdle: () => idle });

    const id = await spawnOverTool(tools, "tc-tool-spawn");

    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    const result = await tools.get("get_subagent_result").execute(
      "tc-tool-result",
      { agent_id: id },
      undefined,
      undefined,
      ctx(),
    );
    expect(String(result.content[0].text)).toContain("TOOL_AGENT_OK");

    idle = true;
    await lifecycle.get("agent_settled")?.();
    expect(notifications(pi)).toEqual([]);
  });

  it("suppresses an RPC notification consumed after the hold while the parent is busy", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "RPC_AGENT_OK" } as any);
    let idle = false;
    const { pi, bus, lifecycle } = await boot({ isIdle: () => idle });

    const id = await spawnOverRpc(bus, "req-spawn-delayed-consume");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    expect(notifications(pi)).toEqual([]);

    bus.emit("subagents:rpc:consume", { requestId: "req-consume-delayed", agentId: id });
    idle = true;
    await lifecycle.get("agent_settled")?.();
    expect(notifications(pi)).toEqual([]);
  });

  it("delivers an unconsumed held notification exactly once at agent_settled", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "UNCONSUMED_AGENT_OK" } as any);
    let idle = false;
    const { pi, bus, lifecycle } = await boot({ isIdle: () => idle });

    await spawnOverRpc(bus, "req-spawn-unconsumed");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    expect(notifications(pi)).toEqual([]);
    expect(lifecycle.has("agent_end")).toBe(false);
    expect(lifecycle.has("turn_end")).toBe(false);

    idle = true;
    await lifecycle.get("agent_settled")?.();
    await lifecycle.get("agent_settled")?.();
    expect(notifications(pi)).toHaveLength(1);
  });

  it("cancels an idle-parent notification inside the hold window", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "IDLE_AGENT_OK" } as any);
    const { pi, bus } = await boot();

    const id = await spawnOverRpc(bus, "req-spawn-idle-cancel");
    await new Promise(r => setTimeout(r, 50));
    bus.emit("subagents:rpc:consume", { requestId: "req-consume-idle", agentId: id });
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    expect(notifications(pi)).toEqual([]);
  });

  it("cancels by the canonical record id when a plain alias consumes the result", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "ALIASED_AGENT_OK" } as any);
    let idle = false;
    const { pi, tools, lifecycle } = await boot({ isIdle: () => idle });

    const id = await spawnOverTool(tools, "tc-alias-spawn", "smoke-child");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    await tools.get("get_subagent_result").execute(
      "tc-alias-result",
      { agent_id: "smoke-child" },
      undefined,
      undefined,
      ctx(),
    );

    // A later resume un-consumes the reused record. The old completion send
    // must already be gone rather than relying only on its send-time check.
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    registry.getRecord(id).resultConsumed = false;
    idle = true;
    await lifecycle.get("agent_settled")?.();
    expect(notifications(pi)).toEqual([]);
  });

  it("discards held notifications on shutdown", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "SHUTDOWN_AGENT_OK" } as any);
    let idle = false;
    const { pi, bus, lifecycle } = await boot({ isIdle: () => idle });

    await spawnOverRpc(bus, "req-spawn-shutdown");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    await shutdown?.();
    shutdown = undefined;

    idle = true;
    await lifecycle.get("agent_settled")?.();
    expect(notifications(pi)).toEqual([]);
  });

  it("filters consumed members from a held group notification", async () => {
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, outputTranscript: false, defaultJoinMode: "group" }),
    );
    const resolvers = deferredRuns();
    let idle = false;
    const { pi, tools, lifecycle } = await boot({ isIdle: () => idle });

    const [first, second] = await Promise.all([
      spawnOverTool(tools, "tc-group-first"),
      spawnOverTool(tools, "tc-group-second"),
    ]);
    await new Promise(r => setTimeout(r, 150));
    for (const resolve of resolvers) resolve();
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    await tools.get("get_subagent_result").execute(
      "tc-group-consume-first",
      { agent_id: first },
      undefined,
      undefined,
      ctx(),
    );
    idle = true;
    await lifecycle.get("agent_settled")?.();

    const sent = notifications(pi);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain(first);
    expect(JSON.stringify(sent[0])).toContain(second);
  });

  it("drops a held group notification when every member was consumed", async () => {
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, outputTranscript: false, defaultJoinMode: "group" }),
    );
    const resolvers = deferredRuns();
    let idle = false;
    const { pi, tools, lifecycle } = await boot({ isIdle: () => idle });

    const ids = await Promise.all([
      spawnOverTool(tools, "tc-group-all-first"),
      spawnOverTool(tools, "tc-group-all-second"),
    ]);
    await new Promise(r => setTimeout(r, 150));
    for (const resolve of resolvers) resolve();
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    for (const id of ids) {
      await tools.get("get_subagent_result").execute(
        `tc-group-consume-${id}`,
        { agent_id: id },
        undefined,
        undefined,
        ctx(),
      );
    }
    idle = true;
    await lifecycle.get("agent_settled")?.();
    expect(notifications(pi)).toEqual([]);
  });

  it("keeps a genuinely unconsumed group member when a consumed sibling resumes", async () => {
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, outputTranscript: false, defaultJoinMode: "group" }),
    );
    const resolvers = deferredRuns();
    let idle = false;
    const { pi, tools, lifecycle } = await boot({ isIdle: () => idle });

    const [resumed, unread] = await Promise.all([
      spawnOverTool(tools, "tc-group-resume-consumed"),
      spawnOverTool(tools, "tc-group-resume-unread"),
    ]);
    await new Promise(r => setTimeout(r, 150));
    for (const resolve of resolvers) resolve();
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    await tools.get("get_subagent_result").execute(
      "tc-group-read-before-resume",
      { agent_id: resumed },
      undefined,
      undefined,
      ctx(),
    );
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    await resumeOverTool(tools, resumed, "tc-group-resume-running");

    idle = true;
    await lifecycle.get("agent_settled")?.();

    const sent = notifications(pi);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain(resumed);
    expect(JSON.stringify(sent[0])).toContain(unread);
  });

  it("does not resurrect a fully consumed group and still notifies for the resumed completion", async () => {
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, outputTranscript: false, defaultJoinMode: "group" }),
    );
    const resolvers = deferredRuns();
    let idle = false;
    const { pi, tools, lifecycle } = await boot({ isIdle: () => idle });

    const ids = await Promise.all([
      spawnOverTool(tools, "tc-group-resume-all-first"),
      spawnOverTool(tools, "tc-group-resume-all-second"),
    ]);
    await new Promise(r => setTimeout(r, 150));
    for (const resolve of resolvers) resolve();
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    for (const id of ids) {
      await tools.get("get_subagent_result").execute(
        `tc-group-read-before-resume-${id}`,
        { agent_id: id },
        undefined,
        undefined,
        ctx(),
      );
    }

    let finishResume: (() => void) | undefined;
    vi.mocked(resumeAgent).mockImplementation(
      () => new Promise((resolve) => {
        finishResume = () => resolve({ text: "RESUMED_RESULT", failure: undefined });
      }),
    );
    await resumeOverTool(tools, ids[0], "tc-group-resume-after-all-read");

    idle = true;
    await lifecycle.get("agent_settled")?.();
    expect(notifications(pi)).toEqual([]);

    idle = false;
    finishResume?.();
    await vi.waitFor(() => expect(vi.mocked(resumeAgent)).toHaveResolved());
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    idle = true;
    await lifecycle.get("agent_settled")?.();

    const sent = notifications(pi);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("RESUMED_RESULT");
  });

  it("notifies for an RPC-spawned agent nobody consumed", async () => {
    // The behaviour that makes the notification worth keeping: an unread result
    // is the caller's only signal that the agent finished.
    vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
    const { pi, bus } = await boot();

    await spawnOverRpc(bus, "req-spawn-1");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    expect(notifications(pi)).toHaveLength(1);
  });

  it("suppresses the notification once the caller consumes the result", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
    const { pi, bus } = await boot();

    // Join the agent the way pi-tasks does — off the lifecycle event, not the tool.
    bus.on("subagents:completed", (data: unknown) => {
      bus.emit("subagents:rpc:consume", { requestId: "req-consume", agentId: (data as { id: string }).id });
    });

    await spawnOverRpc(bus, "req-spawn-2");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    expect(notifications(pi)).toEqual([]);
  });

  it("refuses to consume an agent that is still running", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const { bus } = await boot();

    const id = await spawnOverRpc(bus, "req-spawn-3");
    const reply = vi.fn();
    bus.on("subagents:rpc:consume:reply:req-consume-running", reply);
    bus.emit("subagents:rpc:consume", { requestId: "req-consume-running", agentId: id });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found or still running" });
  });

  it("reports an unknown agent rather than silently succeeding", async () => {
    const { bus } = await boot();
    const reply = vi.fn();
    bus.on("subagents:rpc:consume:reply:req-consume-unknown", reply);
    bus.emit("subagents:rpc:consume", { requestId: "req-consume-unknown", agentId: "no-such-agent" });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found or still running" });
  });
});
