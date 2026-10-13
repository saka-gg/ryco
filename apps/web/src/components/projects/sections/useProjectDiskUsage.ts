import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import { ProjectId, WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { useHostedRpcCapability } from "../../../hostedHub/capabilities";
import { selectSidebarWorktreesForProjectRef, useStore } from "../../../store";
import { readLifecycleApi, useWorkspaceLifecycleChanges } from "../../../workspaceLifecycle";
import type { DiskUsageReading } from "./projectDiskUsage.logic";
import { workspaceInspectionSignature } from "./projectWorkspaces.logic";

/**
 * "Measure again", per checkout: every reader of that checkout (the settings
 * view's sections, the map) asks the device afresh together, so no surface
 * keeps showing the figures another one just replaced.
 */
const useDiskRemeasure = create<{
  readonly nonces: Readonly<Record<string, number>>;
  readonly remeasure: (scopeKey: string) => void;
}>((set) => ({
  nonces: {},
  remeasure: (scopeKey) =>
    set((state) => ({
      nonces: { ...state.nonces, [scopeKey]: (state.nonces[scopeKey] ?? 0) + 1 },
    })),
}));

/**
 * How much disk each of a checkout's workspaces takes on its device. The node
 * measures and caches; this reads again when the workspace set changes or after
 * a lifecycle action (both answered from the node's cache unless a checkout is
 * new), and `remeasure` asks the node to measure everything afresh. A node that
 * predates the measurement, or a reader who may not inspect workspaces, gets
 * `unavailable`.
 */
export function useProjectDiskUsage(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly signature: string;
  readonly enabled: boolean;
}): { readonly reading: DiskUsageReading; readonly remeasure: () => void } {
  const { environmentId, projectId, signature } = input;
  const diskUsage = input.enabled ? readLifecycleApi(environmentId)?.diskUsage : undefined;
  const revision = useWorkspaceLifecycleChanges((state) => state.revision);
  const scopeKey = `${environmentId}\u0000${projectId}`;
  const refreshNonce = useDiskRemeasure((state) => state.nonces[scopeKey] ?? 0);
  // Only the read a remeasure starts measures afresh; later reads use the cache again.
  const sentNonce = useRef(refreshNonce);
  const requestKey = `${scopeKey}\u0000${signature}\u0000${revision}\u0000${refreshNonce}`;
  const [settled, setSettled] = useState<{
    readonly scopeKey: string;
    readonly requestKey: string;
    readonly value: Exclude<DiskUsageReading, { readonly status: "loading" }>;
  } | null>(null);

  useEffect(() => {
    if (!diskUsage) return;
    let cancelled = false;
    const refresh = refreshNonce !== sentNonce.current;
    sentNonce.current = refreshNonce;
    diskUsage({ projectId: ProjectId.make(projectId), refresh }).then(
      (result) => {
        if (!cancelled)
          setSettled({
            scopeKey,
            requestKey,
            value: { status: "ready", workspaces: result.workspaces, refreshing: false },
          });
      },
      () => {
        if (!cancelled) setSettled({ scopeKey, requestKey, value: { status: "unavailable" } });
      },
    );
    return () => {
      cancelled = true;
    };
    // `requestKey` folds in the signature and lifecycle revision.
  }, [diskUsage, projectId, refreshNonce, requestKey, scopeKey]);

  const remeasure = useCallback(() => useDiskRemeasure.getState().remeasure(scopeKey), [scopeKey]);

  let reading: DiskUsageReading;
  if (!diskUsage) reading = { status: "unavailable" };
  else if (!settled || settled.scopeKey !== scopeKey) reading = { status: "loading" };
  else if (settled.requestKey === requestKey) reading = settled.value;
  else if (settled.value.status === "ready") reading = { ...settled.value, refreshing: true };
  else reading = { status: "loading" };
  return { reading, remeasure };
}

/** {@link useProjectDiskUsage} for one checkout, read again as its workspaces change. */
export function useCheckoutDiskUsage(member: {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}): { readonly reading: DiskUsageReading; readonly remeasure: () => void } {
  const ref = useMemo(
    () => scopeProjectRef(member.environmentId, member.id),
    [member.environmentId, member.id],
  );
  const worktrees = useStore(
    useShallow((state) => selectSidebarWorktreesForProjectRef(state, ref)),
  );
  const signature = useMemo(() => workspaceInspectionSignature(worktrees), [worktrees]);
  const capability = useHostedRpcCapability(WS_METHODS.lifecycleDiskUsage);
  return useProjectDiskUsage({
    environmentId: member.environmentId,
    projectId: member.id,
    signature,
    enabled: capability.allowed,
  });
}
