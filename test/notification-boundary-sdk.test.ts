import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { type AgentSession, AgentSessionRuntime, type BoundaryResult, type BoundaryState, type CustomMessageEntry, createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionContext, runPrintMode, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import type { NotificationDetails } from "../src/types.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe("completion notifications through Pi's public SDK boundaries", () => {
  let cwd: string;
  let home: string;
  let previousCwd: string;
  let previousHome: string | undefined;
  let previousAgentDir: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;
  let session: AgentSession | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-boundary-sdk-"));
    home = mkdtempSync(join(tmpdir(), "pi-boundary-sdk-home-"));
    previousCwd = process.cwd();
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = home;
    process.chdir(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "worker.md"), "---\ntools: none\nextensions: false\nskills: false\npersist_session: false\n---\nReturn the job result.");
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, workflowsEnabled: false, outputTranscript: false, defaultJoinMode: "group" }));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });

  afterEach(async () => {
    await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    session = undefined;
    faux.unregister();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  async function boot(mode: ExtensionContext["mode"], respond: (context: Context) => Promise<ReturnType<typeof fauxAssistantMessage>>, extensions: Array<(pi: ExtensionAPI) => void> = []) {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const step: FauxResponseStep = context => respond(context);
    faux.setResponses(Array.from({ length: 20 }, () => step));
    const loader = new DefaultResourceLoader({
      cwd, agentDir: home,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [...extensions.slice(0, 1), subagentsExtension, ...extensions.slice(1)],
      systemPromptOverride: () => "Delegate jobs, then report the results.",
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: home, model, modelRuntime: backend.modelRuntime,
      resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    }));
    const errors: string[] = [];
    await session.bindExtensions({ mode, onError: error => errors.push(error.error) });
    expect(loader.getExtensions().errors).toEqual([]);
    expect(session.getActiveToolNames()).toContain("Agent");
    const runtime = new AgentSessionRuntime(session, {
      cwd, agentDir: home, modelRuntime: backend.modelRuntime, resourceLoader: loader, settingsManager: session.settingsManager, diagnostics: [],
    }, async () => { throw new Error("Session replacement is not used by this print host."); });
    return { session, errors, runtime };
  }

  it.each([
    ["print", "turn_end"], ["json", "turn_end"],
    ["print", "agent_before_settle"], ["json", "agent_before_settle"],
  ] as const)("%s receives grouped results at %s before one-shot settlement", async (mode, boundary) => {
    const releaseChildren = deferred();
    const childrenCompleted = deferred();
    let completions = 0;
    let parentCalls = 0;
    const contexts: string[] = [];
    let observedDrafts = false;
    const { session: parent, errors } = await boot(mode, async context => {
      if (!getCurrentTools(context.messages).some(tool => tool.name === "Agent")) {
        await releaseChildren.promise;
        const label = JSON.stringify(context.messages).includes("JOB_ALPHA") ? "ALPHA" : "BETA";
        return fauxAssistantMessage([fauxText(`${label}_RESULT`)]);
      }
      contexts.push(JSON.stringify(context.messages));
      parentCalls++;
      if (parentCalls === 1) return fauxAssistantMessage([
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "JOB_ALPHA", description: "alpha", run_in_background: true }),
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "JOB_BETA", description: "beta", run_in_background: true }),
      ], { stopReason: "toolUse" });
      if (parentCalls === 2) {
        if (boundary === "turn_end") {
          releaseChildren.resolve();
          await childrenCompleted.promise;
        }
        return fauxAssistantMessage([fauxText("PRE_NOTIFICATION")]);
      }
      return fauxAssistantMessage([fauxText("RESULTS_REPORTED")]);
    }, [
      pi => {
        pi.events.on("subagents:completed", () => {
          if (++completions === 2) childrenCompleted.resolve();
        });
        pi.on("agent_end", async event => {
          if (boundary === "agent_before_settle" && JSON.stringify(event.messages).includes("PRE_NOTIFICATION")) {
            releaseChildren.resolve();
            await childrenCompleted.promise;
          }
        });
        const addOtherDraft = (event: BoundaryState): BoundaryResult => ({ entries: [...event.entries, { type: "custom", customType: "other-boundary-entry", data: "preserved" }] });
        if (boundary === "turn_end") pi.on("turn_end", addOtherDraft);
        else pi.on("agent_before_settle", addOtherDraft);
      },
      pi => {
        const observeDrafts = (event: BoundaryState) => {
          if (event.entries.some(entry => entry.type === "custom_message" && entry.customType === "subagent-notification")) {
            observedDrafts = event.continue && event.entries.some(entry => entry.type === "custom" && entry.customType === "other-boundary-entry");
          }
        };
        if (boundary === "turn_end") pi.on("turn_end", observeDrafts);
        else pi.on("agent_before_settle", observeDrafts);
      },
    ]);
    let settled = 0;
    const appended: string[] = [];
    parent.subscribe(event => {
      if (event.type === "agent_settled") settled++;
      if (event.type === "entry_appended") appended.push(event.entry.type);
    });

    await parent.prompt("Delegate two jobs.");

    expect(parentCalls).toBe(3);
    expect(contexts[1]).not.toContain("ALPHA_RESULT");
    expect(contexts[2]).toContain("ALPHA_RESULT");
    expect(contexts[2]).toContain("BETA_RESULT");
    const notifications = parent.sessionManager.getBranch().filter((entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === "subagent-notification");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ display: true });
    const details = notifications[0].details as NotificationDetails;
    expect([details, ...(details.others ?? [])].map(member => member.description).sort()).toEqual(["alpha", "beta"]);
    expect(appended).toContain("custom_message");
    expect(observedDrafts).toBe(true);
    expect(parent.getLastAssistantText()).toBe("RESULTS_REPORTED");
    expect(settled).toBe(1);
    expect(errors).toEqual([]);
  });

  it.each(["invalid", "remove"] as const)("recovers a notification discarded once by a later %s handler at the next boundary", async rejection => {
    const releaseChild = deferred();
    const childCompleted = deferred();
    let parentCalls = 0;
    let discarded = false;
    let proposedDetails: unknown;
    const contexts: string[] = [];
    const { session: parent, errors } = await boot("print", async context => {
      if (!getCurrentTools(context.messages).some(tool => tool.name === "Agent")) {
        await releaseChild.promise;
        return fauxAssistantMessage([fauxText("RECOVERED_CHILD_RESULT")]);
      }
      contexts.push(JSON.stringify(context.messages));
      if (++parentCalls === 1) return fauxAssistantMessage([
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "JOB", description: "job", run_in_background: true }),
      ], { stopReason: "toolUse" });
      if (parentCalls === 2) {
        releaseChild.resolve();
        await childCompleted.promise;
        return fauxAssistantMessage([fauxText("PRE_NOTIFICATION")]);
      }
      return fauxAssistantMessage([fauxText("RECOVERED_RESULT_REPORTED")]);
    }, [
      pi => { pi.events.on("subagents:completed", () => childCompleted.resolve()); },
      pi => {
        pi.on("turn_end", event => {
          const notification = event.entries.find(entry => entry.type === "custom_message" && entry.customType === "subagent-notification");
          if (!notification || discarded) return;
          discarded = true;
          return rejection === "invalid"
            ? { entries: [...event.entries, { type: "context_edit", targetId: "missing-entry", replacement: null }] }
            : { entries: event.entries.filter(entry => entry !== notification), continue: false };
        });
        pi.on("agent_before_settle", event => {
          const notification = event.entries.find(entry => entry.type === "custom_message" && entry.customType === "subagent-notification");
          if (notification?.type === "custom_message") proposedDetails = notification.details;
        });
      },
    ]);

    await parent.prompt("Delegate the job.");

    expect(discarded).toBe(true);
    expect(parentCalls).toBe(3);
    expect(contexts[2]).toContain("RECOVERED_CHILD_RESULT");
    const notifications = parent.sessionManager.getBranch().filter((entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === "subagent-notification");
    expect(notifications).toHaveLength(1);
    expect(proposedDetails).toBeDefined();
    expect(notifications[0].details).toBe(proposedDetails);
    expect(parent.getLastAssistantText()).toBe("RECOVERED_RESULT_REPORTED");
    if (rejection === "invalid") expect(errors).toEqual([expect.stringContaining("Invalid boundary entries")]);
    else expect(errors).toEqual([]);
  });

  it.each([false, true])("a later RPC consumer owns removal of an already proposed notification (remove=%s)", async remove => {
    const releaseChild = deferred();
    const childCompleted = deferred();
    let parentCalls = 0;
    let consumed = false;
    const { session: parent, errors } = await boot("rpc", async context => {
      if (!getCurrentTools(context.messages).some(tool => tool.name === "Agent")) {
        await releaseChild.promise;
        return fauxAssistantMessage([fauxText("LATE_CONSUMED_CHILD_RESULT")]);
      }
      if (++parentCalls === 1) return fauxAssistantMessage([
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "JOB", description: "job", run_in_background: true }),
      ], { stopReason: "toolUse" });
      if (parentCalls === 2) {
        releaseChild.resolve();
        await childCompleted.promise;
      }
      return fauxAssistantMessage([fauxText("CONSUMER_REPORTED")]);
    }, [
      pi => { pi.events.on("subagents:completed", () => childCompleted.resolve()); },
      pi => {
        pi.on("turn_end", async event => {
          const notification = event.entries.find(entry => entry.type === "custom_message" && entry.customType === "subagent-notification");
          if (consumed || notification?.type !== "custom_message") return;
          const reply = vi.fn();
          pi.events.on("subagents:rpc:consume:reply:late-consume", reply);
          pi.events.emit("subagents:rpc:consume", { requestId: "late-consume", agentId: (notification.details as NotificationDetails).id });
          await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: true }));
          consumed = true;
          if (remove) return { entries: event.entries.filter(entry => entry !== notification), continue: false };
        });
      },
    ]);

    await parent.prompt("Delegate the job.");

    expect(consumed).toBe(true);
    expect(parentCalls).toBe(remove ? 2 : 3);
    expect(parent.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-notification")).toHaveLength(remove ? 0 : 1);
    expect(errors).toEqual([]);
  });

  it("bounds retries against a later handler that always removes notifications and recovers on explicit input", async () => {
    const releaseChild = deferred();
    const childCompleted = deferred();
    let parentCalls = 0;
    let reject = true;
    let proposals = 0;
    let resultVisible = false;
    const { session: parent, errors } = await boot("print", async context => {
      if (!getCurrentTools(context.messages).some(tool => tool.name === "Agent")) {
        await releaseChild.promise;
        return fauxAssistantMessage([fauxText("BOUNDED_CHILD_RESULT")]);
      }
      if (++parentCalls > 8) throw new Error("Unbounded notification continuation");
      if (parentCalls === 1) return fauxAssistantMessage([
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "JOB", description: "job", run_in_background: true }),
      ], { stopReason: "toolUse" });
      if (parentCalls === 2) {
        releaseChild.resolve();
        await childCompleted.promise;
      }
      resultVisible = JSON.stringify(context.messages).includes("BOUNDED_CHILD_RESULT");
      return fauxAssistantMessage([fauxText("PARENT_FINISHED")]);
    }, [
      pi => { pi.events.on("subagents:completed", () => childCompleted.resolve()); },
      pi => {
        const discard = (event: BoundaryState): BoundaryResult | undefined => {
          if (!reject || !event.entries.some(entry => entry.type === "custom_message" && entry.customType === "subagent-notification")) return;
          proposals++;
          return { entries: [
            ...event.entries.filter(entry => entry.type !== "custom_message" || entry.customType !== "subagent-notification"),
            { type: "custom_message", customType: "other-continuation", content: "Continue independent work.", display: false },
          ] };
        };
        pi.on("turn_end", discard);
        pi.on("agent_before_settle", discard);
      },
    ]);

    await parent.prompt("Delegate the job.");
    expect(parentCalls).toBe(4);
    expect(proposals).toBe(2);
    expect(resultVisible).toBe(false);
    expect(parent.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-notification")).toHaveLength(0);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(parentCalls).toBe(4);

    reject = false;
    await parent.prompt("Try the held result explicitly.");
    expect(parentCalls).toBe(6);
    expect(resultVisible).toBe(true);
    expect(parent.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-notification")).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("keeps a completion pending when the parent is aborted during tool execution despite a completed turn outcome", async () => {
    const releaseChild = deferred();
    const childCompleted = deferred();
    let parentCalls = 0;
    const abortedBoundaries: Array<{ outcome: string; aborted: boolean; notifications: number; continue: boolean }> = [];
    const contexts: string[] = [];
    const { session: parent, errors } = await boot("print", async context => {
      if (!getCurrentTools(context.messages).some(tool => tool.name === "Agent")) {
        await releaseChild.promise;
        return fauxAssistantMessage([fauxText("ABORT_HELD_CHILD_RESULT")]);
      }
      contexts.push(JSON.stringify(context.messages));
      if (++parentCalls === 1) return fauxAssistantMessage([
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "JOB", description: "job", run_in_background: true }),
      ], { stopReason: "toolUse" });
      if (parentCalls === 2) return fauxAssistantMessage([fauxToolCall("AbortDuringTools", {})], { stopReason: "toolUse" });
      return fauxAssistantMessage([fauxText("EXPLICIT_RUN_REPORTED")]);
    }, [
      pi => {
        pi.events.on("subagents:completed", () => childCompleted.resolve());
        pi.registerTool({
          name: "AbortDuringTools", label: "Abort during tools", description: "Abort after the child finishes.", parameters: Type.Object({}),
          execute: async (_id, _params, _signal, _onUpdate, ctx) => {
            releaseChild.resolve();
            await childCompleted.promise;
            ctx.abort();
            return { content: [{ type: "text", text: "TOOL_FINISHED" }], details: undefined };
          },
        });
      },
      pi => {
        pi.on("turn_end", (event, ctx) => {
          if (ctx.signal?.aborted) abortedBoundaries.push({
            outcome: event.outcome, aborted: true, continue: event.continue,
            notifications: event.entries.filter(entry => entry.type === "custom_message" && entry.customType === "subagent-notification").length,
          });
        });
      },
    ]);

    await parent.prompt("Delegate, then abort during tools.");
    expect(abortedBoundaries).toContainEqual({ outcome: "completed", aborted: true, notifications: 0, continue: false });
    expect(abortedBoundaries.every(boundary => boundary.notifications === 0 && !boundary.continue)).toBe(true);
    const callsAtAbort = parentCalls;
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(parentCalls).toBe(callsAtAbort);
    expect(parent.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-notification")).toHaveLength(0);

    await parent.prompt("Continue explicitly.");
    expect(parentCalls).toBe(callsAtAbort + 2);
    expect(contexts.at(-1)).toContain("ABORT_HELD_CHILD_RESULT");
    expect(parent.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-notification")).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it.each([false, true])("print host collects a child finishing in a later before_settle handler before dispose (abort=%s)", async abort => {
    const releaseChild = deferred();
    const childCompleted = deferred();
    let parentCalls = 0;
    let released = false;
    let disposedText: string | undefined;
    let disposedNotifications = -1;
    let resultVisible = false;
    const { session: parent, runtime, errors } = await boot("print", async context => {
      if (!getCurrentTools(context.messages).some(tool => tool.name === "Agent")) {
        await releaseChild.promise;
        return fauxAssistantMessage([fauxText("LATE_SETTLEMENT_CHILD_RESULT")]);
      }
      if (++parentCalls === 1) return fauxAssistantMessage([
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "JOB", description: "job", run_in_background: true }),
      ], { stopReason: "toolUse" });
      if (parentCalls === 2) return fauxAssistantMessage([fauxText("PRE_NOTIFICATION")]);
      resultVisible = JSON.stringify(context.messages).includes("LATE_SETTLEMENT_CHILD_RESULT");
      return fauxAssistantMessage([fauxText("LATE_RESULT_REPORTED")]);
    }, [
      pi => { pi.events.on("subagents:completed", () => childCompleted.resolve()); },
      pi => {
        pi.on("agent_before_settle", async (_event, ctx) => {
          if (released) return;
          released = true;
          releaseChild.resolve();
          await childCompleted.promise;
          if (abort) ctx.abort();
        });
      },
    ]);
    runtime.setBeforeSessionInvalidate(() => {
      disposedText = parent.getLastAssistantText();
      disposedNotifications = parent.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-notification").length;
    });

    expect(await runPrintMode(runtime, { mode: "text", initialMessage: "Delegate the job." })).toBe(0);
    session = undefined;

    expect(released).toBe(true);
    expect(parentCalls).toBe(abort ? 2 : 3);
    expect(resultVisible).toBe(!abort);
    expect(disposedNotifications).toBe(abort ? 0 : 1);
    expect(disposedText).toBe(abort ? "PRE_NOTIFICATION" : "LATE_RESULT_REPORTED");
    expect(errors).toEqual([]);
  });

  it.each([false, true])("filters same-turn consumption after every parallel sibling tool finishes (consume all=%s)", async consumeAll => {
    const releaseChildren = deferred();
    const childrenCompleted = deferred();
    let completions = 0;
    let parentCalls = 0;
    let siblingFinished = false;
    const contexts: string[] = [];
    const { session: parent, errors } = await boot("rpc", async context => {
      if (!getCurrentTools(context.messages).some(tool => tool.name === "Agent")) {
        await releaseChildren.promise;
        return fauxAssistantMessage([fauxText(JSON.stringify(context.messages).includes("JOB_ALPHA") ? "ALPHA_RESULT" : "BETA_RESULT")]);
      }
      contexts.push(JSON.stringify(context.messages));
      if (++parentCalls === 1) return fauxAssistantMessage([
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "JOB_ALPHA", description: "alpha", run_in_background: true }),
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "JOB_BETA", description: "beta", run_in_background: true }),
      ], { stopReason: "toolUse" });
      if (parentCalls === 2) {
        const ids = context.messages.filter(message => message.role === "toolResult" && message.toolName === "Agent")
          .map(message => {
            const id = JSON.stringify(message.content).match(/Agent ID: ([a-z0-9-]+)/)?.[1];
            if (!id) throw new Error("Missing child ID in public Agent result");
            return id;
          });
        expect(ids).toHaveLength(2);
        return fauxAssistantMessage([
          fauxToolCall("get_subagent_result", { agent_id: ids[0], wait: true }),
          ...(consumeAll ? [fauxToolCall("get_subagent_result", { agent_id: ids[1], wait: true })] : []),
          fauxToolCall("FinishSibling", {}),
        ], { stopReason: "toolUse" });
      }
      expect(siblingFinished).toBe(true);
      return fauxAssistantMessage([fauxText("ALL_RESULTS_REPORTED")]);
    }, [pi => {
      pi.events.on("subagents:completed", () => { if (++completions === 2) childrenCompleted.resolve(); });
      pi.registerTool({
        name: "FinishSibling", label: "Finish sibling", description: "Finish independent work.", parameters: Type.Object({}),
        execute: async () => {
          releaseChildren.resolve();
          await childrenCompleted.promise;
          siblingFinished = true;
          return { content: [{ type: "text", text: "SIBLING_FINISHED" }], details: undefined };
        },
      });
    }]);

    await parent.prompt("Delegate, collect, and report.");

    expect(parentCalls).toBe(3);
    expect(contexts[2]).toContain("ALPHA_RESULT");
    expect(contexts[2]).toContain("BETA_RESULT");
    const entries = parent.sessionManager.getBranch();
    const notifications = entries.filter((entry): entry is CustomMessageEntry => entry.type === "custom_message" && entry.customType === "subagent-notification");
    expect(notifications).toHaveLength(consumeAll ? 0 : 1);
    if (!consumeAll) {
      const details = notifications[0].details as NotificationDetails;
      expect(details.description).toBe("beta");
      expect(details.others).toBeUndefined();
      const notificationIndex = entries.indexOf(notifications[0]);
      const siblingIndex = entries.findIndex(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "FinishSibling");
      expect(notificationIndex).toBeGreaterThan(siblingIndex);
    }
    expect(parent.getLastAssistantText()).toBe("ALL_RESULTS_REPORTED");
    expect(errors).toEqual([]);
  });
});
