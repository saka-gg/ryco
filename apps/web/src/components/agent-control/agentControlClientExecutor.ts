import { createContext, useContext, useSyncExternalStore } from "react";
import type { AgentControlProposalView, EnvironmentId } from "@ryco/contracts";
import type { AgentControlClientExecutionCheck } from "@ryco/client-runtime/state/agentControl";

import type { AgentControlCopyExecutorSource } from "../projectNodes/agentControlCopyExecutor";

/**
 * Runs client-executed Agent Control proposals (`copyProjectToNode`) from this
 * client: it accepts with `executeOnClient` and then runs the copy against the
 * target. Without one (mobile-like) every such card shows "Approve in Ryco on
 * a computer connected to <target>" in place of Approve.
 */
export interface AgentControlClientExecutor {
  /** Whether this client can run a client-executed plan against `target` now. */
  readonly canExecute: AgentControlClientExecutionCheck;
  /**
   * Approves the proposal and runs it here. Rejects with an `Error` whose
   * message the card shows.
   */
  readonly approve: (input: {
    readonly environmentId: EnvironmentId;
    readonly proposal: AgentControlProposalView;
  }) => Promise<void>;
}

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
