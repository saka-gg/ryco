import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import { selectEnvironmentState, useStore, type AppState } from "./store.ts";

/** The part of the threads store a waiter reads; `useStore` by default. */
export interface ThreadShellSource {
  readonly getState: () => AppState;
  readonly subscribe: (listener: (state: AppState) => void) => () => void;
}

export interface WaitForThreadShellInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly timeoutMs: number;
  /**
   * Also wait until the shell is attached to this worktree, for a thread the server created
   * together with its worktree, so navigation never shows it without its checkout.
   */
  readonly worktreeId?: string | null | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly store?: ThreadShellSource | undefined;
}

/**
 * Resolves true once the shell stream has delivered the thread (shell existence, not a started
 * turn: a fork or an import has history but no turn yet). Resolves false on timeout or abort so
 * the caller decides whether to navigate anyway. Subscribes to the store; never polls.
 */
export function waitForThreadShell(input: WaitForThreadShellInput): Promise<boolean> {
  const store = input.store ?? useStore;
  const ready = (state: AppState): boolean => {
    const shell = selectEnvironmentState(state, input.environmentId).threadShellById[
      input.threadId
    ];
    return (
      shell !== undefined && (input.worktreeId == null || shell.worktreeId === input.worktreeId)
    );
  };
  if (ready(store.getState())) return Promise.resolve(true);
  if (input.signal?.aborted) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(false);
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    unsubscribe = store.subscribe((state) => {
      if (ready(state)) finish(true);
    });
    // The shell can land between the first read and the subscription.
    if (ready(store.getState())) return finish(true);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(false), Math.max(0, input.timeoutMs));
  });
}
