import { parseScopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  applyThreadPin,
  requestThreadPinChange as requestSharedThreadPinChange,
  toggleThreadPin as toggleSharedThreadPin,
  type ThreadPinChangeDependencies,
  type ThreadPinChangeResult,
  type ThreadPinStore,
} from "@ryco/client-runtime/state/threads/threadPins";
import { sidebarUndo } from "./sidebarUndo";
import { stackedThreadToast } from "./components/ui/toastHelpers";
import { toastManager } from "./components/ui/toastManager";
import { readLocalApi } from "./localApi";
import { useUiStateStore } from "./uiStateStore";

export type { ThreadPinChangeResult };

export interface ThreadPinCommandPresentation {
  readonly disabled: boolean;
  readonly pinned: boolean;
  readonly title: string;
  readonly description: string | undefined;
}

export function resolveThreadPinCommandPresentation(input: {
  readonly threadKey: string | null;
  readonly pinned: boolean;
}): ThreadPinCommandPresentation {
  if (!input.threadKey) {
    return {
      disabled: true,
      pinned: false,
      title: "Pin current thread",
      description: "Open a thread to pin or unpin it.",
    };
  }
  return {
    disabled: false,
    pinned: input.pinned,
    title: input.pinned ? "Unpin current thread" : "Pin current thread",
    description: undefined,
  };
}

const defaultDependencies: ThreadPinChangeDependencies = {
  isPinned: (threadKey) => uiStatePinStore.isPinned(threadKey),
  setPinned: (threadKey, pinned) => {
    const target = parseScopedThreadKey(threadKey);
    if (!target) return;
    applyThreadPin({ target, threadKey, pinned }, uiStatePinStore, sidebarUndo);
  },
  confirm: async (message) => {
    const localApi = readLocalApi();
    return localApi ? localApi.dialogs.confirm(message) : window.confirm(message);
  },
  failed: (error) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not update pin",
        description: error instanceof Error ? error.message : "The request failed.",
      }),
    ),
};

const uiStatePinStore: ThreadPinStore = {
  isPinned: (threadKey) => useUiStateStore.getState().pinnedThreadKeys[threadKey] === true,
  setPinned: (threadKey, pinned) => useUiStateStore.getState().setThreadPinned(threadKey, pinned),
  subscribe: (listener) => useUiStateStore.subscribe(listener),
};

export function requestThreadPinChange(
  input: Parameters<typeof requestSharedThreadPinChange>[0],
  dependencies: ThreadPinChangeDependencies = defaultDependencies,
): Promise<ThreadPinChangeResult> {
  return requestSharedThreadPinChange(input, { ...defaultDependencies, ...dependencies });
}

export function toggleThreadPin(
  input: Parameters<typeof toggleSharedThreadPin>[0],
  dependencies: ThreadPinChangeDependencies = defaultDependencies,
): Promise<ThreadPinChangeResult> {
  return toggleSharedThreadPin(input, { ...defaultDependencies, ...dependencies });
}
