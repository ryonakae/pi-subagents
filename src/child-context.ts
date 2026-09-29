import { AsyncLocalStorage } from "node:async_hooks";

export const CHILD_CONTEXT_KEY = Symbol.for("pi-subagents:child-context");
const CHILD_CONTEXT_STORAGE_KEY = Symbol.for("pi-subagents:child-context-storage");

export interface ChildContextAccessor {
  readonly version: 1;
  readonly isChildSession: () => boolean;
}

/**
 * Marks resource loading/session construction performed for a subagent. This is
 * async-context-local so concurrent top-level extension work is unaffected.
 */
type GlobalRegistry = typeof globalThis & {
  [CHILD_CONTEXT_KEY]?: unknown;
  [CHILD_CONTEXT_STORAGE_KEY]?: unknown;
};

function sharedStorage(): AsyncLocalStorage<boolean> {
  const registry = globalThis as GlobalRegistry;
  const existing = registry[CHILD_CONTEXT_STORAGE_KEY];
  if (existing instanceof AsyncLocalStorage) return existing as AsyncLocalStorage<boolean>;
  const storage = new AsyncLocalStorage<boolean>();
  if (existing === undefined) registry[CHILD_CONTEXT_STORAGE_KEY] = storage;
  return registry[CHILD_CONTEXT_STORAGE_KEY] instanceof AsyncLocalStorage
    ? registry[CHILD_CONTEXT_STORAGE_KEY] as AsyncLocalStorage<boolean>
    : storage;
}

const childSessionContext = sharedStorage();
const localAccessor: ChildContextAccessor = Object.freeze({
  version: 1 as const,
  isChildSession: () => childSessionContext.getStore() === true,
});

function compatibleAccessor(value: unknown): ChildContextAccessor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { version?: unknown; isChildSession?: unknown };
  return candidate.version === 1 && typeof candidate.isChildSession === "function"
    ? candidate as ChildContextAccessor
    : undefined;
}

/** First compatible module instance wins, preserving identity across duplicate loads. */
export function getChildContextAccessor(): ChildContextAccessor {
  const registry = globalThis as GlobalRegistry;
  const existing = compatibleAccessor(registry[CHILD_CONTEXT_KEY]);
  if (existing !== undefined) return existing;
  if (registry[CHILD_CONTEXT_KEY] === undefined) registry[CHILD_CONTEXT_KEY] = localAccessor;
  return compatibleAccessor(registry[CHILD_CONTEXT_KEY]) ?? localAccessor;
}

// Publish during module initialization so another extension can capture it in
// its factory before any child session exists.
getChildContextAccessor();

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}
