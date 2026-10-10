/** Cancellable completion drafts; busy delivery belongs to Pi's boundaries. */
import type { CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";

export const DEFAULT_HOLD_MS = 200;

type PendingNudge = {
  build: () => CustomMessageEntryDraft | undefined;
  timer?: ReturnType<typeof setTimeout>;
  proposal?: CustomMessageEntryDraft;
  attempts: number;
};

export class NudgeQueue {
  private readonly pending = new Map<string, PendingNudge>();
  private disposed = false;

  constructor(
    private readonly isIdle: () => boolean,
    private readonly deliver: (entries: CustomMessageEntryDraft[]) => void,
    private readonly holdMs = DEFAULT_HOLD_MS,
  ) {}

  schedule(key: string, build: PendingNudge["build"], delay = this.holdMs): void {
    if (this.disposed) return;
    this.cancel(key);
    const nudge: PendingNudge = { build, attempts: 0 };
    this.pending.set(key, nudge);
    nudge.timer = setTimeout(() => {
      nudge.timer = undefined;
      this.flush();
    }, delay);
  }

  cancel(key: string): void {
    const nudge = this.pending.get(key);
    if (nudge?.timer !== undefined) clearTimeout(nudge.timer);
    this.pending.delete(key);
  }

  /** Safe boundaries need not wait out the idle cancellation hold. */
  take(includePending = true): CustomMessageEntryDraft[] {
    if (this.disposed) return [];
    const entries: CustomMessageEntryDraft[] = [];
    for (const [key, nudge] of this.pending) {
      if (nudge.attempts > 0 || (!includePending && nudge.timer !== undefined)) continue;
      this.cancel(key);
      try {
        const entry = nudge.build();
        if (entry) entries.push(entry);
      } catch {
        // A stale session must not prevent other completions from reaching Pi.
      }
    }
    return entries;
  }

  /** Later boundary handlers may discard drafts, so only persisted proposals commit. */
  confirm(isSaved: (entry: CustomMessageEntryDraft) => boolean): void {
    for (const [key, nudge] of this.pending) {
      if (!nudge.proposal) continue;
      if (isSaved(nudge.proposal)) this.cancel(key);
      else nudge.proposal = undefined;
    }
  }

  propose(): CustomMessageEntryDraft[] {
    if (this.disposed) return [];
    const entries: CustomMessageEntryDraft[] = [];
    for (const [key, nudge] of this.pending) {
      // Do not keep the parent running against an extension that always rejects.
      if (nudge.attempts >= 2) continue;
      if (nudge.timer !== undefined) clearTimeout(nudge.timer);
      nudge.timer = undefined;
      try {
        const entry = nudge.build();
        if (!entry) { this.cancel(key); continue; }
        nudge.proposal = entry;
        nudge.attempts++;
        entries.push(entry);
      } catch {
        this.cancel(key);
      }
    }
    return entries;
  }

  retry(): void {
    for (const nudge of this.pending.values()) nudge.attempts = 0;
  }

  flush(includePending = false): void {
    if (this.disposed || !this.isIdle()) return;
    const entries = this.take(includePending);
    if (entries.length > 0) this.deliver(entries);
  }

  clear(): void {
    for (const key of this.pending.keys()) this.cancel(key);
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}
