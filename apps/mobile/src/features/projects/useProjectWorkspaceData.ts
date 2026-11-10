import {
  type DiskUsageReading,
  readDiskUsageProgressively,
} from "@ryco/client-runtime/projectSettings/diskUsage";
import type { EnvironmentId, ProjectId, WorkspaceLifecycleSummary } from "@ryco/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { projectDiskUsageMirror, projectWorkspacesMirror } from "../../rpc/projectSettingsAtoms";
import { useSavedMirror } from "../../rpc/useMobileQuery";

export type ProjectWorkspaceInspection =
  | { readonly status: "unavailable" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly summaries: readonly WorkspaceLifecycleSummary[];
      /** A newer inspection is running; these are the previous results. */
      readonly refreshing: boolean;
    };

type SettledInspection = Exclude<ProjectWorkspaceInspection, { status: "unavailable" | "loading" }>;
type SettledDisk = Exclude<DiskUsageReading, { status: "loading" }>;

const failureMessage = (reason: unknown) =>
  reason instanceof Error && reason.message
    ? reason.message
    : "The workspaces could not be inspected.";

/** The latest answer for this request, the previous one (refreshing) meanwhile, else loading. */
function currentInspection(
  settled: { readonly requestKey: string; readonly value: SettledInspection } | null,
  requestKey: string,
): ProjectWorkspaceInspection {
  if (!settled) return { status: "loading" };
  if (settled.value.status !== "ready") {
    return settled.requestKey === requestKey ? settled.value : { status: "loading" };
  }
  return { ...settled.value, refreshing: settled.requestKey !== requestKey };
}

function currentDisk(
  settled: { readonly requestKey: string; readonly value: SettledDisk } | null,
  requestKey: string,
): DiskUsageReading {
  if (!settled) return { status: "loading" };
  if (settled.requestKey === requestKey) return settled.value;
  return settled.value.status === "ready"
    ? { ...settled.value, refreshing: true }
    : { status: "loading" };
}

/**
 * The machine's inspection of a project's workspaces (Git state, conversations, allowed actions)
 * and what each takes on disk. Inspection runs Git per workspace, so it re-runs only when the
 * workspace set changes (`signature`), after a change made here (`refresh`), or when asked to
 * measure again (`remeasure`, which alone makes the machine measure afresh); earlier results stay
 * on screen meanwhile. A machine that predates either, or a reader who may not inspect, reads
 * `unavailable`.
 */
export function useProjectWorkspaceData(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly signature: string;
  readonly enabled: boolean;
}): {
  readonly inspection: ProjectWorkspaceInspection;
  readonly disk: DiskUsageReading;
  readonly refresh: () => void;
  readonly remeasure: () => void;
} {
  const api = useEnvironmentApi(input.environmentId);
  const lifecycle = input.enabled ? api?.lifecycle : undefined;
  const diskUsage = lifecycle?.diskUsage;
  const [revision, setRevision] = useState(0);
  const [measureNonce, setMeasureNonce] = useState(0);
  const sentMeasureNonce = useRef(measureNonce);
  const scope = `${input.environmentId}\u0000${input.projectId}\u0000`;
  const requestKey = `${scope}${input.signature}\u0000${revision}`;
  const diskKey = `${requestKey}\u0000${measureNonce}`;
  const [inspected, setInspected] = useState<{
    readonly requestKey: string;
    readonly value: SettledInspection;
  } | null>(null);
  const [measured, setMeasured] = useState<{
    readonly requestKey: string;
    readonly value: SettledDisk;
  } | null>(null);
  const { projectId } = input;

  useEffect(() => {
    if (!lifecycle) return;
    let cancelled = false;
    lifecycle.listWorkspaces({ projectId }).then(
      (summaries) => {
        if (!cancelled) {
          setInspected({ requestKey, value: { status: "ready", summaries, refreshing: false } });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setInspected({ requestKey, value: { status: "error", message: failureMessage(reason) } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [lifecycle, projectId, requestKey]);

  useEffect(() => {
    if (!diskUsage) return;
    // Only the read a remeasure starts measures afresh; later reads use the machine's cache.
    const refresh = measureNonce !== sentMeasureNonce.current;
    sentMeasureNonce.current = measureNonce;
    // The machine's last figures at once, as refreshing while it measures afresh.
    return readDiskUsageProgressively({
      read: diskUsage,
      projectId,
      refresh,
      onResult: (result, final) =>
        setMeasured({
          requestKey: diskKey,
          value: { status: "ready", workspaces: result.workspaces, refreshing: !final },
        }),
      onError: () => setMeasured({ requestKey: diskKey, value: { status: "unavailable" } }),
    });
  }, [diskKey, diskUsage, measureNonce, projectId]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const remeasure = useCallback(() => setMeasureNonce((value) => value + 1), []);

  const ownInspection = inspected && inspected.requestKey.startsWith(scope) ? inspected : null;
  const ownDisk = measured && measured.requestKey.startsWith(scope) ? measured : null;
  // The last answers kept on this device stand in, as refreshing, until the machine answers.
  const mirrorInput = { environmentId: input.environmentId, projectId };
  const savedWorkspaces = useSavedMirror(
    projectWorkspacesMirror,
    mirrorInput,
    ownInspection?.value.status === "ready" ? ownInspection.value.summaries : null,
  ).data;
  const savedDisk = useSavedMirror(
    projectDiskUsageMirror,
    mirrorInput,
    ownDisk?.value.status === "ready" ? ownDisk.value.workspaces : null,
  ).data;
  const inspection: ProjectWorkspaceInspection = lifecycle
    ? currentInspection(ownInspection, requestKey)
    : { status: "unavailable" };
  const disk: DiskUsageReading = diskUsage
    ? currentDisk(ownDisk, diskKey)
    : { status: "unavailable" };
  return {
    inspection:
      inspection.status === "loading" && savedWorkspaces !== null
        ? { status: "ready", summaries: savedWorkspaces, refreshing: true }
        : inspection,
    disk:
      disk.status === "loading" && savedDisk !== null
        ? { status: "ready", workspaces: savedDisk, refreshing: true }
        : disk,
    refresh,
    remeasure,
  };
}
