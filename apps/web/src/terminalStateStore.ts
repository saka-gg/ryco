import {
  createTerminalStateStore,
  type TerminalStateStore,
} from "@ryco/client-runtime/state/terminal";

import { isHostedHubMode } from "./env";
import { resolveStorage } from "./lib/storage";
import {
  isWebPerfProfileEnabled,
  readWebPerfNow,
  recordWebPerfPayload,
} from "./perf/perfInstrumentation";

export * from "@ryco/client-runtime/state/terminal";

const webTerminalStorage = resolveStorage(
  typeof window !== "undefined" && !isHostedHubMode() ? window.localStorage : undefined,
);

export const useTerminalStateStore: TerminalStateStore = createTerminalStateStore({
  storage: {
    getItem: (name) => webTerminalStorage.getItem(name) as string | null | Promise<string | null>,
    // Bind the synchronous localStorage writes directly so persist middleware
    // commits on the same tick as HEAD (which passed resolveStorage(...) to
    // Zustand). Async wrappers would defer the write by a microtask.
    setItem: (name, value) => {
      webTerminalStorage.setItem(name, value);
    },
    removeItem: (name) => {
      webTerminalStorage.removeItem(name);
    },
  },
  observability: {
    enabled: isWebPerfProfileEnabled,
    now: readWebPerfNow,
    record: (label, event, durationMs) => recordWebPerfPayload(label, event, { durationMs }),
  },
});
