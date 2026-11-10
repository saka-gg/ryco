import { create } from "zustand";

import {
  addOptimisticMessage,
  settleOptimisticMessages,
  updateOptimisticMessage,
  type OptimisticMessagesByThreadKey,
  type OptimisticUserMessage,
} from "./optimisticUserMessagesModel";

export * from "./optimisticUserMessagesModel";

// In memory only: a send that never got through is restored to the composer, and one that
// did is on the node. Nothing node-owned outlives the process here.
interface OptimisticUserMessagesState {
  readonly byThreadKey: OptimisticMessagesByThreadKey;
}

export const useOptimisticUserMessagesStore = create<OptimisticUserMessagesState>(() => ({
  byThreadKey: {},
}));

const NO_MESSAGES: ReadonlyArray<OptimisticUserMessage> = [];

function write(next: (state: OptimisticMessagesByThreadKey) => OptimisticMessagesByThreadKey) {
  const current = useOptimisticUserMessagesStore.getState().byThreadKey;
  const updated = next(current);
  if (updated !== current) useOptimisticUserMessagesStore.setState({ byThreadKey: updated });
}

export function addOptimisticUserMessage(threadKey: string, entry: OptimisticUserMessage): void {
  write((state) => addOptimisticMessage(state, threadKey, entry));
}

/** The node took the turn: the bubble waits for the echo. */
export function markOptimisticUserMessageDispatched(threadKey: string, messageId: string): void {
  write((state) =>
    updateOptimisticMessage(state, threadKey, messageId, (entry) =>
      entry.phase === "sending" ? { ...entry, phase: "dispatched" } : entry,
    ),
  );
}

/** Kept, hidden, for the screen to restore when it comes back. */
export function failOptimisticUserMessage(
  threadKey: string,
  messageId: string,
  error: string,
): void {
  write((state) =>
    updateOptimisticMessage(state, threadKey, messageId, (entry) => ({
      ...entry,
      phase: "failed",
      error,
    })),
  );
}

export function removeOptimisticUserMessage(threadKey: string, messageId: string): void {
  write((state) => updateOptimisticMessage(state, threadKey, messageId, () => null));
}

export function settleOptimisticUserMessages(
  threadKey: string,
  serverMessageIds: ReadonlySet<string>,
): void {
  write((state) => settleOptimisticMessages(state, threadKey, serverMessageIds));
}

/** Takes the thread's failed sends out of the store, oldest first. */
export function takeFailedOptimisticUserMessages(
  threadKey: string,
): ReadonlyArray<OptimisticUserMessage> {
  const failed = (useOptimisticUserMessagesStore.getState().byThreadKey[threadKey] ?? []).filter(
    (entry) => entry.phase === "failed",
  );
  for (const entry of failed) removeOptimisticUserMessage(threadKey, entry.message.id);
  return failed;
}

export function useOptimisticUserMessages(threadKey: string): ReadonlyArray<OptimisticUserMessage> {
  return useOptimisticUserMessagesStore((state) => state.byThreadKey[threadKey] ?? NO_MESSAGES);
}

/** Whether the message is a send the node has not echoed yet (the timeline's pending style). */
export function useIsOptimisticUserMessage(threadKey: string, messageId: string): boolean {
  return useOptimisticUserMessagesStore(
    (state) =>
      state.byThreadKey[threadKey]?.some(
        (entry) => entry.message.id === messageId && entry.phase !== "failed",
      ) ?? false,
  );
}

export function resetOptimisticUserMessagesForTests(): void {
  useOptimisticUserMessagesStore.setState({ byThreadKey: {} });
}
