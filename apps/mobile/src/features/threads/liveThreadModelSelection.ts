import {
  createThreadModelSelectionSync,
  dispatchThreadModelSelection,
  type ThreadModelSelectionView,
} from "@ryco/client-runtime/state/composer";
import type {
  CommandId,
  EnvironmentApi,
  ModelSelection,
  ServerConfig,
  ThreadId,
} from "@ryco/contracts";

/**
 * The task composer's model, effort and speed, shared live with the node's other clients
 * through the same sync web uses (`@ryco/client-runtime` `threadModelSelectionSync`): a pick is
 * stored on the thread when it is made, and a pick stored elsewhere replaces the one staged here.
 * Nodes without `liveThreadModelSelection` keep the staged pick until it is sent, as before.
 */
export const mobileThreadModelSelectionSync = createThreadModelSelectionSync();

export function liveThreadModelSelectionSupported(
  config: ServerConfig | null | undefined,
): boolean {
  return config?.environment.capabilities.liveThreadModelSelection === true;
}

/** The staged pick once the node shows `stored`: a pick of that instance gives way to it. */
export function stagedPickAfterStoredSelection(
  staged: ModelSelection | null,
  stored: ModelSelection,
): ModelSelection | null {
  return staged !== null && staged.instanceId === stored.instanceId ? null : staged;
}

export function mobileThreadModelSelectionView(input: {
  readonly api: () => EnvironmentApi;
  readonly threadId: ThreadId;
  readonly serverModelSelection: ModelSelection | null | undefined;
  readonly composerModelSelection: ModelSelection | null | undefined;
  readonly updateStaged: (update: (staged: ModelSelection | null) => ModelSelection | null) => void;
  readonly reportFailure: (message: string) => void;
  readonly newCommandId: () => CommandId;
}): ThreadModelSelectionView {
  return {
    serverModelSelection: input.serverModelSelection,
    composerModelSelection: input.composerModelSelection,
    show: (stored) =>
      input.updateStaged((staged) => stagedPickAfterStoredSelection(staged, stored)),
    persist: (modelSelection) =>
      dispatchThreadModelSelection(input.api(), {
        threadId: input.threadId,
        modelSelection,
        commandId: input.newCommandId(),
      }),
    reportFailure: (error) =>
      input.reportFailure(
        error instanceof Error ? error.message : "The model change did not reach the node.",
      ),
  };
}
