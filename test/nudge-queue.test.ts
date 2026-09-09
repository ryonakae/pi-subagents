import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOLD_MS, NudgeQueue } from "../src/nudge-queue.js";

describe("NudgeQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers once after the hold when idle", () => {
    const send = vi.fn();
    const queue = new NudgeQueue(() => true);

    queue.schedule("agent", send);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    queue.flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("holds a due send while busy and flushes it once after becoming idle", () => {
    const send = vi.fn();
    let idle = false;
    const queue = new NudgeQueue(() => idle);

    queue.schedule("agent", send);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    queue.flush();
    expect(send).not.toHaveBeenCalled();

    idle = true;
    queue.flush();
    queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cancels sends both inside the hold and after they become due", () => {
    const pending = vi.fn();
    const held = vi.fn();
    const queue = new NudgeQueue(() => false);

    queue.schedule("pending", pending);
    queue.cancel("pending");
    queue.schedule("held", held);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    queue.cancel("held");
    queue.flush();

    expect(pending).not.toHaveBeenCalled();
    expect(held).not.toHaveBeenCalled();
  });

  it("replaces an earlier send with the same canonical key", () => {
    const stale = vi.fn();
    const current = vi.fn();
    const queue = new NudgeQueue(() => true);

    queue.schedule("agent", stale);
    queue.schedule("agent", current);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);

    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("keeps remaining sends cancellable when delivery makes the parent busy", () => {
    let idle = false;
    const first = vi.fn(() => { idle = false; });
    const second = vi.fn();
    const queue = new NudgeQueue(() => idle);

    queue.schedule("first", first);
    queue.schedule("second", second);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);

    idle = true;
    queue.flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    queue.cancel("second");
    idle = true;
    queue.flush();
    expect(second).not.toHaveBeenCalled();
  });

  it("continues flushing after a stale send throws", () => {
    const current = vi.fn();
    let idle = false;
    const queue = new NudgeQueue(() => idle);

    queue.schedule("stale", () => { throw new Error("stale session"); });
    queue.schedule("current", current);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);

    idle = true;
    expect(() => queue.flush()).not.toThrow();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("drops pending and held sends on dispose and rejects later schedules", () => {
    const held = vi.fn();
    const pending = vi.fn();
    const afterDispose = vi.fn();
    const queue = new NudgeQueue(() => false);

    queue.schedule("held", held);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    queue.schedule("pending", pending);
    queue.dispose();
    queue.schedule("later", afterDispose);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS * 2);
    queue.flush();

    expect(held).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(afterDispose).not.toHaveBeenCalled();
  });
});
