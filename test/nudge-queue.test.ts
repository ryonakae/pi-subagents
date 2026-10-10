import type { CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOLD_MS, NudgeQueue } from "../src/nudge-queue.js";

const draft = (content: string): CustomMessageEntryDraft => ({ type: "custom_message", customType: "subagent-notification", content, display: true });

describe("NudgeQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers once after the hold when idle", () => {
    const deliver = vi.fn();
    const queue = new NudgeQueue(() => true, deliver);
    queue.schedule("agent", () => draft("result"));
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    queue.flush();
    expect(deliver.mock.calls).toEqual([[[draft("result")]]]);
  });

  it("keeps busy drafts cancellable and delivers them once after becoming idle", () => {
    const deliver = vi.fn();
    let idle = false;
    const queue = new NudgeQueue(() => idle, deliver);
    queue.schedule("agent", () => draft("result"));
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    queue.flush();
    expect(deliver).not.toHaveBeenCalled();
    idle = true;
    queue.flush();
    queue.flush();
    expect(deliver.mock.calls).toEqual([[[draft("result")]]]);
  });

  it("cancels sends inside the hold and after they become due", () => {
    const queue = new NudgeQueue(() => false, vi.fn());
    queue.schedule("pending", () => draft("pending"));
    queue.cancel("pending");
    queue.schedule("due", () => draft("due"));
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    queue.cancel("due");
    expect(queue.take()).toEqual([]);
  });

  it("replaces an earlier draft with the same canonical key", () => {
    const deliver = vi.fn();
    const queue = new NudgeQueue(() => true, deliver);
    queue.schedule("agent", () => draft("stale"));
    queue.schedule("agent", () => draft("current"));
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    expect(deliver.mock.calls).toEqual([[[draft("current")]]]);
  });

  it("takes pending and due drafts at a boundary without waiting for idle", () => {
    const deliver = vi.fn();
    const queue = new NudgeQueue(() => false, deliver);
    queue.schedule("due", () => draft("due"));
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    queue.schedule("pending", () => draft("pending"));
    expect(queue.take()).toEqual([draft("due"), draft("pending")]);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    expect(queue.take()).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("filters consumed or stale drafts at delivery", () => {
    const queue = new NudgeQueue(() => false, vi.fn());
    queue.schedule("consumed", () => undefined);
    queue.schedule("current", () => draft("current"));
    expect(queue.take()).toEqual([draft("current")]);
  });

  it("continues delivery after a stale builder throws", () => {
    const queue = new NudgeQueue(() => false, vi.fn());
    queue.schedule("stale", () => { throw new Error("stale session"); });
    queue.schedule("current", () => draft("current"));
    expect(queue.take()).toEqual([draft("current")]);
  });

  it("clears a replaced session without disabling the next session", () => {
    const queue = new NudgeQueue(() => false, vi.fn());
    queue.schedule("old", () => draft("old"));
    queue.clear();
    queue.schedule("new", () => draft("new"));
    expect(queue.take()).toEqual([draft("new")]);
  });

  it("drops pending and due drafts on dispose and rejects later schedules", () => {
    const deliver = vi.fn();
    const queue = new NudgeQueue(() => false, deliver);
    queue.schedule("due", () => draft("due"));
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    queue.schedule("pending", () => draft("pending"));
    queue.dispose();
    queue.schedule("later", () => draft("later"));
    vi.advanceTimersByTime(DEFAULT_HOLD_MS * 2);
    queue.flush();
    expect(queue.take()).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });
});
