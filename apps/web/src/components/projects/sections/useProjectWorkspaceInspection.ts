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

type Settled = Exclude<WorkspaceInspection, { readonly status: "unavailable" | "loading" }>;

const errorMessage = (reason: unknown, fallback: string) =>
  reason instanceof Error && reason.message ? reason.message : fallback;

/**
 * The server's inspection of a checkout's workspaces (Git state, conversations,
 * which lifecycle actions are allowed) and the device's cleanup suggestions.
 * Inspection runs Git per workspace, so it re-runs only when the workspace set
 * changes (`signature`), after any lifecycle action, or when asked; earlier
 * results stay on screen meanwhile.
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

  useEffect(() => {
    if (!lifecycle) return;
    let cancelled = false;
    void Promise.allSettled([
      lifecycle.listWorkspaces({ projectId: ProjectId.make(projectId) }),
      suggestionsEnabled ? lifecycle.suggestions({}) : Promise.resolve(null),
    ]).then(([listed, suggested]) => {
      if (cancelled) return;
      setSettled({
        scopeKey,
        requestKey,
        value:
          listed.status === "fulfilled"
            ? {
                status: "ready",
                summaries: listed.value,
                suggestions: suggested.status === "fulfilled" ? suggested.value : null,
                refreshing: false,
              }
            : {
                status: "error",
                message: errorMessage(listed.reason, "The workspaces could not be inspected."),
              },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [lifecycle, projectId, requestKey, scopeKey, suggestionsEnabled]);

  const reinspect = useCallback(() => setNonce((value) => value + 1), []);

  let inspection: WorkspaceInspection;
  if (!lifecycle) inspection = { status: "unavailable" };
  else if (!settled || settled.scopeKey !== scopeKey) inspection = { status: "loading" };
  else if (settled.requestKey === requestKey) inspection = settled.value;
  else if (settled.value.status === "ready") inspection = { ...settled.value, refreshing: true };
  else inspection = { status: "loading" };
  return { inspection, reinspect };
}
