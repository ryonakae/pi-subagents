/**
 * Delivery timing for cancellable completion notifications.
 *
 * Adapted from upstream PR #265 by vincelwt. A notification handed to Pi as a
 * follow-up while the parent is busy can no longer be withdrawn. Keeping due
 * sends here until the parent is idle preserves the cancellation window.
 */

export const DEFAULT_HOLD_MS = 200;

export class NudgeQueue {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly held = new Map<string, () => void>();
  private disposed = false;

  constructor(
    private readonly isIdle: () => boolean,
    private readonly holdMs = DEFAULT_HOLD_MS,
  ) {}

  schedule(key: string, send: () => void, delay = this.holdMs): void {
    if (this.disposed) return;
    this.cancel(key);
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      if (!this.isIdle()) {
        this.held.set(key, send);
        return;
      }
      this.deliver(send);
    }, delay));
  }

  cancel(key: string): void {
    const timer = this.pending.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pending.delete(key);
    }
    this.held.delete(key);
  }

  flush(): void {
    if (this.disposed) return;
    for (const [key, send] of [...this.held]) {
      if (!this.isIdle()) return;
      if (this.held.get(key) !== send) continue;
      this.held.delete(key);
      this.deliver(send);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.held.clear();
  }

  private deliver(send: () => void): void {
    try {
      send();
    } catch {
      // The record or session may have become stale while the send was held.
    }
  }
}
