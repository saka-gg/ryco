import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type {
  AgentControlProposalId,
  AgentControlProposalView,
  EnvironmentId,
} from "@ryco/contracts";
import type { AgentControlClientExecutionCheck } from "@ryco/client-runtime/state/agentControl";

import type {
  AgentControlClientExecutionInput,
  AgentControlClientExecutionPreviewState,
  AgentControlClientExecutor,
  AgentControlCopyExecutorSource,
} from "@ryco/client-runtime/projectCopy/agentControlExecutor";

export type {
  AgentControlClientExecutionInput,
  AgentControlClientExecutionPreview,
  AgentControlClientExecutionPreviewState,
  AgentControlClientExecutionPreviews,
  AgentControlClientExecutor,
} from "@ryco/client-runtime/projectCopy/agentControlExecutor";

/** Overrides the app's executor below it (tests and previews); null keeps the app's. */
export const AgentControlClientExecutorContext = createContext<AgentControlClientExecutor | null>(
  null,
);

/*
 * The app's executor (`projectNodes/agentControlCopyExecutor`) is not in the
 * app shell's graph: it loads the first time a card asks whether it can
 * approve a client-executed proposal. Until then a stand-in answers no and
 * starts the load; the loaded executor then replaces it, and its `subscribe`
 * hands out a new one whenever its answers change, so the cards re-render.
 */
let loadedSource: AgentControlCopyExecutorSource | null = null;
let loading: Promise<AgentControlCopyExecutorSource> | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of Array.from(listeners)) listener();
}

function loadAppExecutor(): Promise<AgentControlCopyExecutorSource> {
  loading ??= import("../projectNodes/agentControlCopyExecutor").then(
    (module) => {
      const source = module.startAgentControlCopyExecutor();
      loadedSource = source;
      source.subscribe(notifyListeners);
      notifyListeners();
      return source;
    },
    (error: unknown) => {
      // The next card that asks tries again.
      loading = null;
      throw error;
    },
  );
  return loading;
}

const LOADING_EXECUTOR: AgentControlClientExecutor = {
  canExecute: () => {
    void loadAppExecutor().catch(() => undefined);
    return false;
  },
  approve: async (input) => (await loadAppExecutor()).getExecutor().approve(input),
};

function subscribeAppExecutor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readAppExecutor(): AgentControlClientExecutor {
  return loadedSource?.getExecutor() ?? LOADING_EXECUTOR;
}

/** The executor a provider sets, else the app's (loaded on first need). */
export function useAgentControlClientExecutor(): AgentControlClientExecutor | null {
  const provided = useContext(AgentControlClientExecutorContext);
  const app = useSyncExternalStore(subscribeAppExecutor, readAppExecutor, readAppExecutor);
  return provided ?? app;
}

const NO_PREVIEWS = {
  subscribe: () => () => undefined,
  read: () => null,
} as const;

/**
 * The preview of a client-executed proposal while `enabled` (a pending card
 * this client can approve): loads it on first need and follows it. Null when
 * the executor shows none.
 */
export function useAgentControlClientExecutionPreview(
  executor: AgentControlClientExecutor | null,
  input: AgentControlClientExecutionInput,
  enabled: boolean,
): AgentControlClientExecutionPreviewState | null {
  const previews = enabled ? (executor?.previews ?? null) : null;
  const { proposalId } = input.proposal;
  const source = previews ?? NO_PREVIEWS;
  const read = () => source.read(proposalId);
  const state = useSyncExternalStore(source.subscribe, read, read);
  const missing = previews !== null && state === null;
  const { environmentId, proposal } = input;
  useEffect(() => {
    if (missing && previews) previews.load({ environmentId, proposal });
  }, [missing, previews, environmentId, proposal]);
  return previews === null ? null : (state ?? { status: "loading" });
}
