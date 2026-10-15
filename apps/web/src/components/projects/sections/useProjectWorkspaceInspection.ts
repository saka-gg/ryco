import {
  ProjectId,
  type EnvironmentId,
  type LifecycleSuggestions,
  type WorkspaceLifecycleSummary,
} from "@ryco/contracts";
import { useCallback, useEffect, useState } from "react";

import { readLifecycleApi, useWorkspaceLifecycleChanges } from "../../../workspaceLifecycle";

export type WorkspaceInspection =
  | { readonly status: "unavailable" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly summaries: readonly WorkspaceLifecycleSummary[];
      /** Null when suggestions failed on their own; the workspaces still show. */
      readonly suggestions: LifecycleSuggestions | null;
      /** A newer inspection is running; these are the previous results. */
      readonly refreshing: boolean;
    };

type Settled =
  | Exclude<WorkspaceInspection, { readonly status: "unavailable" | "loading" | "ready" }>
  | Omit<Extract<WorkspaceInspection, { readonly status: "ready" }>, "suggestions">;

const errorMessage = (reason: unknown, fallback: string) =>
  reason instanceof Error && reason.message ? reason.message : fallback;

/**
 * The server's inspection of a checkout's workspaces (Git state, conversations,
 * which lifecycle actions are allowed) and the device's cleanup suggestions.
 * Inspection runs Git per workspace, so it re-runs only when the workspace set
 * changes (`signature`), after any lifecycle action, or when asked; earlier
 * results stay on screen meanwhile. The workspaces show as soon as they are
 * inspected: suggestions inspect every project's checkouts and fill in when
 * they arrive.
 */
export function useProjectWorkspaceInspection(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly signature: string;
  /** The reader may inspect workspaces (hosted viewers may not); off means unavailable. */
  readonly enabled: boolean;
  /** The reader may read cleanup suggestions; off just leaves them out. */
  readonly suggestionsEnabled: boolean;
}): { readonly inspection: WorkspaceInspection; readonly reinspect: () => void } {
  const { environmentId, projectId, signature, suggestionsEnabled } = input;
  const lifecycle = input.enabled ? readLifecycleApi(environmentId) : undefined;
  const revision = useWorkspaceLifecycleChanges((state) => state.revision);
  const [nonce, setNonce] = useState(0);
  const scopeKey = `${environmentId}\u0000${projectId}`;
  const requestKey = `${scopeKey}\u0000${signature}\u0000${revision}\u0000${nonce}`;
  const [settled, setSettled] = useState<{
    readonly scopeKey: string;
    readonly requestKey: string;
    readonly value: Settled;
  } | null>(null);
  const [settledSuggestions, setSettledSuggestions] = useState<{
    readonly scopeKey: string;
    /** Null when suggestions failed on their own. */
    readonly value: LifecycleSuggestions | null;
  } | null>(null);

  useEffect(() => {
    if (!lifecycle) return;
    let cancelled = false;
    void lifecycle.listWorkspaces({ projectId: ProjectId.make(projectId) }).then(
      (summaries) => {
        if (cancelled) return;
        setSettled({
          scopeKey,
          requestKey,
          value: { status: "ready", summaries, refreshing: false },
        });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setSettled({
          scopeKey,
          requestKey,
          value: {
            status: "error",
            message: errorMessage(reason, "The workspaces could not be inspected."),
          },
        });
      },
    );
    if (suggestionsEnabled) {
      void lifecycle.suggestions({}).then(
        (value) => {
          if (!cancelled) setSettledSuggestions({ scopeKey, value });
        },
        () => {
          if (!cancelled) setSettledSuggestions({ scopeKey, value: null });
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [lifecycle, projectId, requestKey, scopeKey, suggestionsEnabled]);

  const reinspect = useCallback(() => setNonce((value) => value + 1), []);

  // The latest suggestions of this scope (earlier ones while newer are read).
  const suggestions =
    suggestionsEnabled && settledSuggestions?.scopeKey === scopeKey
      ? settledSuggestions.value
      : null;
  let inspection: WorkspaceInspection;
  if (!lifecycle) inspection = { status: "unavailable" };
  else if (!settled || settled.scopeKey !== scopeKey) inspection = { status: "loading" };
  else if (settled.value.status !== "ready")
    inspection = settled.requestKey === requestKey ? settled.value : { status: "loading" };
  else
    inspection = {
      ...settled.value,
      suggestions,
      refreshing: settled.requestKey !== requestKey,
    };
  return { inspection, reinspect };
}
