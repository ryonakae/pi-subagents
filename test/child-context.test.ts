import { describe, expect, it, vi } from "vitest";
import {
  CHILD_CONTEXT_KEY,
  getChildContextAccessor,
  inChildSessionContext,
  runInChildSessionContext,
} from "../src/child-context.js";
import subagentsExtension from "../src/index.js";

describe("child session async context", () => {
  it("is scoped to the child async branch", async () => {
    expect(inChildSessionContext()).toBe(false);
    await runInChildSessionContext(async () => {
      expect(inChildSessionContext()).toBe(true);
      await Promise.resolve();
      expect(inChildSessionContext()).toBe(true);
    });
    expect(inChildSessionContext()).toBe(false);
  });

  it("publishes one read-only versioned accessor for cross-extension consumers", () => {
    const accessor = getChildContextAccessor();
    expect(accessor).toBe((globalThis as Record<symbol, unknown>)[CHILD_CONTEXT_KEY]);
    expect(accessor).toEqual({ version: 1, isChildSession: expect.any(Function) });
    expect(Object.isFrozen(accessor)).toBe(true);
    expect(getChildContextAccessor()).toBe(accessor);
  });

  it("does not share child state with concurrent main work", async () => {
    let releaseChild!: () => void;
    const held = new Promise<void>(resolve => { releaseChild = resolve; });
    const child = runInChildSessionContext(async () => {
      expect(getChildContextAccessor().isChildSession()).toBe(true);
      await held;
      expect(getChildContextAccessor().isChildSession()).toBe(true);
    });

    await Promise.resolve();
    expect(getChildContextAccessor().isChildSession()).toBe(false);
    releaseChild();
    await child;
    expect(getChildContextAccessor().isChildSession()).toBe(false);
  });

  it("prevents a child resource load from creating another extension manager", async () => {
    const pi = new Proxy({}, {
      get: vi.fn(() => {
        throw new Error("child extension factory must be a no-op");
      }),
    });

    await runInChildSessionContext(async () => {
      expect(() => subagentsExtension(pi as any)).not.toThrow();
    });
  });
});
