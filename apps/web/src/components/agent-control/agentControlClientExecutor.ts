import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type {
  AgentControlProposalId,
  AgentControlProposalView,
  EnvironmentId,
} from "@ryco/contracts";
import type { AgentControlClientExecutionCheck } from "@ryco/client-runtime/state/agentControl";

import type { AgentControlCopyExecutorSource } from "../projectNodes/agentControlCopyExecutor";

/** One client-executed proposal of the node `environmentId` (the agent's node). */
export interface AgentControlClientExecutionInput {
  readonly environmentId: EnvironmentId;
  readonly proposal: AgentControlProposalView;
}

/**
 * What approving a client-executed proposal would do on its target, resolved
 * there before approval: the plan names the target's "default" folder and its
 * "default" model, this names the folder and the model.
 */
export interface AgentControlClientExecutionPreview {
  readonly targetLabel: string;
  /** The folder on the target; null when it could not be resolved. */
  readonly destination: {
    readonly path: string;
    /** "new folder", "empty folder", "renamed, folder exists" or "existing checkout". */
    readonly tag: string;
    /** How the folder was chosen, e.g. "Mac mini's code directory."; null when nothing to add. */
    readonly note: string | null;
  } | null;
  /**
   * What the copy sends when the plan's own words would mislead (a plain folder's files rather
   * than uncommitted changes); absent otherwise.
   */
  readonly sends?: string;
  /** The setup thread's model on the target; null when the request starts no thread. */
  readonly followUpModel: string | null;
  /** Why approving would fail now. Approving says the same and changes nothing. */
  readonly problem: string | null;
}

export type AgentControlClientExecutionPreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: AgentControlClientExecutionPreview };

/** Previews shared by every card of a proposal, resolved once each. */
export interface AgentControlClientExecutionPreviews {
  /** Starts resolving the proposal's preview, unless it has one or one is on its way. */
  readonly load: (input: AgentControlClientExecutionInput) => void;
  /** Null until `load` was called for it (or after it was dropped to be resolved again). */
  readonly read: (
    proposalId: AgentControlProposalId,
  ) => AgentControlClientExecutionPreviewState | null;
  readonly subscribe: (listener: () => void) => () => void;
}

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
  readonly approve: (input: AgentControlClientExecutionInput) => Promise<void>;
  /**
   * What approving would do on the target, for the card to show before
   * Approve. Approving refuses when it would do something other than the
   * preview the card last showed.
   */
  readonly previews?: AgentControlClientExecutionPreviews;
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
