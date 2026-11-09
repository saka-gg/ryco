// FILE: useCopyProjectPlanning.ts
// Purpose: The reads behind the copy dialog's form: it holds the chosen source
//          and destination nodes while the form is open (an unknown node is
//          connected so its support becomes known, A23), inspects the source
//          (`projects.exportInspect`, A30), resolves the destination folder
//          (A35), checks the clone remote from the destination (A12) and reads
//          the destination's providers for the setup agent (A19). Planning
//          itself is the coordinator's (`planProjectCopyOptions`).
// Layer: Web data hooks for `CopyProjectDialog`; loaded with the dialog.

import {
  judgeCopyDestination,
  nodePathBasename,
  planProjectCopyOptions,
  projectCopySourceCanonicalKey,
  resolveCopyDestination,
  type CopyDestinationRequest,
  type CopyDestinationSuggestion,
  type ProjectCopyChoices,
  type ProjectCopyJobRecord,
  type ProjectCopyLegacyProject,
  type ProjectCopyOptionsPlan,
  type ProjectCopyRunPlan,
  type ProjectCopySourceFacts,
  type ProjectCopyTargetFacts,
  type ProjectCopyTransport,
} from "@ryco/client-runtime/projectCopy";
import { catalogPlatformOs, type NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import {
  DEFAULT_PROJECT_METADATA_DIR,
  type EnvironmentId,
  type ScopedProjectRef,
  type ServerConfig,
} from "@ryco/contracts";
import type { NodePathHints, ProjectCheckRemoteAccessResult } from "@ryco/contracts/project-copy";
import {
  copyExplicitDestinationPath,
  legacyCopyProject,
  legacySourceHints,
} from "@ryco/client-runtime/projectCopy/form";
import { useEffect, useMemo, useState } from "react";

import { acquireNode } from "../../environments/acquireNode";
import type { Project } from "../../types";
import { startManagedProjectCopy } from "./copyRuntime/copyManager";
import { createWebProjectCopyIo } from "./copyRuntime/webProjectCopyIo";
import {
  connectionKey,
  EXPORT_INSPECT_STALE_TIME_MS,
  useNodeEnvironmentApi,
  useNodeExportInspection,
  useNodePathHints,
  refetchExportInspection,
  useNodeRead,
  type NodeReadState,
} from "./nodePathQueries";

/* ───────── Services ───────── */

export interface CopyDialogNodeHold {
  readonly transport: ProjectCopyTransport;
  readonly release: () => void;
}

/** What the dialog does outside React; the app's by default, fakes in tests. */
export interface CopyDialogServices {
  /**
   * Holds a node while the form reads from it: a view's scope (`acquireNode`
   * with `follow`), which connects a node that is not connected yet.
   */
  readonly holdNode: (
    environmentId: EnvironmentId,
    signal: AbortSignal,
  ) => Promise<CopyDialogNodeHold>;
  /** The destination's server config, for the setup agent's providers and default model. */
  readonly readServerConfig: (environmentId: EnvironmentId) => Promise<ServerConfig | null>;
  /**
   * Starts the copy of the checkout `sourceRef`; the dialog shows its progress
   * (no toast until it hands it over). With `resume`, a copy whose upload
   * stopped when Ryco closed goes on with its ids instead of starting afresh.
   */
  readonly startCopy: (
    plan: ProjectCopyRunPlan,
    sourceRef: ScopedProjectRef | null,
    resume?: ProjectCopyJobRecord | null,
  ) => Promise<{ readonly copyId: string }>;
}

export const DEFAULT_COPY_DIALOG_SERVICES: CopyDialogServices = {
  holdNode: async (environmentId, signal) => {
    const node = await acquireNode(environmentId, { purpose: "follow", signal });
    return { transport: node.transport, release: node.release };
  },
  readServerConfig: async (environmentId) => {
    const io = createWebProjectCopyIo();
    try {
      return await io.readServerConfig(environmentId);
    } finally {
      io.dispose();
    }
  },
  startCopy: (plan, sourceRef, resume) =>
    startManagedProjectCopy({ plan, toast: false, sourceRef, resume: resume ?? null }),
};

/* ───────── Holding a node ───────── */

export interface HeldNodeState {
  readonly status: "idle" | "holding" | "held" | "failed";
  readonly transport: ProjectCopyTransport | null;
  readonly error: string | null;
}

const IDLE_HOLD: HeldNodeState = { status: "idle", transport: null, error: null };

/** Holds `environmentId` while it is set (and the form is mounted); releases it when it changes. */
export function useHeldNode(
  services: CopyDialogServices,
  environmentId: EnvironmentId | null,
): HeldNodeState {
  const [state, setState] = useState<{
    readonly key: EnvironmentId | null;
    readonly hold: HeldNodeState;
  }>({
    key: null,
    hold: IDLE_HOLD,
  });
  useEffect(() => {
    if (environmentId === null) return;
    const controller = new AbortController();
    let hold: CopyDialogNodeHold | null = null;
    // Until this answers, a node other than the last answered one reads as holding.
    services.holdNode(environmentId, controller.signal).then(
      (held) => {
        if (controller.signal.aborted) {
          held.release();
          return;
        }
        hold = held;
        setState({
          key: environmentId,
          hold: { status: "held", transport: held.transport, error: null },
        });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          key: environmentId,
          hold: {
            status: "failed",
            transport: null,
            error: cause instanceof Error && cause.message ? cause.message : "Couldn't connect.",
          },
        });
      },
    );
    return () => {
      controller.abort();
      hold?.release();
    };
  }, [environmentId, services]);
  if (environmentId === null) return IDLE_HOLD;
  return state.key === environmentId
    ? state.hold
    : { status: "holding", transport: null, error: null };
}

/* ───────── The source ───────── */

export interface CopySourceState {
  /** Null while the source is checked (connecting, inspecting) or when it failed. */
  readonly facts: ProjectCopySourceFacts | null;
  readonly hints: Pick<NodePathHints, "homeDirectory" | "pathSeparator"> | null;
  /** The repository directory on the source, whose name and place the copy mirrors. */
  readonly repositoryRoot: string;
  readonly error: string | null;
  readonly retry: () => void;
}

export function useCopySource(input: {
  readonly project: Project | null;
  readonly node: NodeCatalogEntry | null;
  readonly hold: HeldNodeState;
}): CopySourceState {
  const { project, node, hold } = input;
  const environmentId = project?.environmentId ?? null;
  const api = useNodeEnvironmentApi(environmentId);
  const support = node?.projectCopySupport ?? "unknown";
  const inspect = api?.projects.exportInspect;
  // Cached for a few seconds, so a dialog the entry point's hover warmed opens on it.
  const query = useNodeExportInspection({
    environmentId,
    projectId: project?.id ?? null,
    enabled: project !== null && support === "yes" && inspect !== undefined,
  });
  // Only an answer from shortly before the form opened, or since: the plan needs the
  // tree as it is, so an older cached one waits for the read it starts.
  const [openedAt] = useState(() => Date.now());
  const fresh =
    query.data !== undefined && query.dataUpdatedAt >= openedAt - EXPORT_INSPECT_STALE_TIME_MS;
  const inspectionData = fresh ? (query.data ?? null) : null;
  const inspectionError = query.isFetching ? null : query.error;
  const projectId = project?.id ?? null;
  const inspection = useMemo(
    () => ({
      data: inspectionData,
      error: inspectionError,
      retry: () => {
        if (environmentId !== null && projectId !== null) {
          void refetchExportInspection(environmentId, projectId);
        }
      },
    }),
    [environmentId, inspectionData, inspectionError, projectId],
  );
  const pathHints = useNodePathHints({ environmentId, supported: support === "yes" });
  return useMemo<CopySourceState>(() => {
    if (project === null || environmentId === null || node === null) {
      return {
        facts: null,
        hints: null,
        repositoryRoot: project?.cwd ?? "",
        error: null,
        retry: inspection.retry,
      };
    }
    if (support === "no" || (support === "yes" && !inspect && api !== undefined)) {
      return {
        facts: {
          kind: "legacy",
          environmentId,
          label: node.label,
          platformOs: catalogPlatformOs(node.platformOs),
          projectId: project.id,
          project: legacyCopyProject(project),
        },
        hints: legacySourceHints(project),
        repositoryRoot: project.repositoryIdentity?.rootPath ?? project.cwd,
        error: null,
        retry: inspection.retry,
      };
    }
    const error =
      hold.status === "failed"
        ? hold.error
        : inspection.error
          ? `Couldn't read ${project.name} on ${node.label}: ${inspection.error.message}`
          : null;
    if (inspection.data === null) {
      return {
        facts: null,
        hints: null,
        repositoryRoot: project.cwd,
        error,
        retry: inspection.retry,
      };
    }
    return {
      facts: {
        kind: "inspected",
        environmentId,
        label: node.label,
        platformOs: catalogPlatformOs(node.platformOs),
        transport: node.transport ?? hold.transport,
        checkoutPath: null,
        inspection: inspection.data,
      },
      hints: pathHints.data ?? legacySourceHints(project),
      repositoryRoot: inspection.data.repository.rootPath,
      error: null,
      retry: inspection.retry,
    };
  }, [api, environmentId, hold, inspect, inspection, node, pathHints.data, project, support]);
}

/* ───────── The destination ───────── */

export interface CopyDestinationState {
  readonly hints: NodePathHints | null;
  readonly suggestion: CopyDestinationSuggestion | null;
  /** The folder name the copy gets. */
  readonly leaf: string | null;
  readonly error: string | null;
}

/**
 * Where the copy goes: the A35 suggestion (the source's place under the
 * destination's home when it has it, else its code folder), or the parent the
 * user picked, previewed and judged on the destination.
 */
export function useCopyDestination(input: {
  readonly environmentId: EnvironmentId | null;
  readonly supported: boolean;
  readonly source: CopySourceState;
  readonly manualParent: string | null;
  /** A stopped copy's own folder: previewed as it is, never renamed. */
  readonly exactPath?: string | null;
}): CopyDestinationState {
  const { environmentId, source, manualParent } = input;
  const exactPath = input.exactPath ?? null;
  const api = useNodeEnvironmentApi(environmentId);
  const hints = useNodePathHints({ environmentId, supported: input.supported }).data ?? null;
  const preview = api?.projects.previewDestination;
  const sourceSeparator = source.hints?.pathSeparator ?? "/";
  const leaf = source.facts ? nodePathBasename(source.repositoryRoot, sourceSeparator) : null;
  const canonicalKey = source.facts ? projectCopySourceCanonicalKey(source.facts) : null;
  const ready =
    environmentId !== null && input.supported && preview !== undefined && hints !== null;
  const request: CopyDestinationRequest | null =
    ready && source.facts && leaf !== null
      ? {
          sourceRoot: source.repositoryRoot,
          sourceHints: source.hints,
          destHints: hints,
          leafName: leaf,
          placement: "mirror",
        }
      : null;
  const read = useNodeRead<CopyDestinationSuggestion | null>(
    request && environmentId
      ? [
          connectionKey(environmentId, api),
          "destination",
          source.repositoryRoot,
          source.hints?.homeDirectory ?? "",
          leaf,
          canonicalKey ?? "",
          manualParent ?? "",
          exactPath ?? "",
        ].join("\u0000")
      : null,
    request && preview
      ? async () => {
          const explicitPath = copyExplicitDestinationPath({
            exactPath,
            manualParent,
            leaf,
            pathSeparator: hints!.pathSeparator,
          });
          if (explicitPath !== null) {
            return judgeCopyDestination({
              preview: await preview({ path: explicitPath }),
              sourceCanonicalKey: canonicalKey,
              basis: "explicit",
            });
          }
          return resolveCopyDestination(request, { preview, sourceCanonicalKey: canonicalKey });
        }
      : null,
    { keepPrevious: false },
  );
  return {
    hints,
    suggestion: read.data,
    leaf,
    error: read.error ? read.error.message : null,
  };
}

/** Whether the destination reaches the clone remote, checked once a destination is chosen (A12). */
export function useCopyRemoteAccess(input: {
  readonly environmentId: EnvironmentId | null;
  readonly supported: boolean;
  readonly remoteUrl: string | null;
}): NodeReadState<ProjectCheckRemoteAccessResult> {
  const { environmentId, remoteUrl } = input;
  const api = useNodeEnvironmentApi(environmentId);
  const check = api?.projects.checkRemoteAccess;
  const active = environmentId !== null && input.supported && remoteUrl !== null && check;
  return useNodeRead(
    active ? `${connectionKey(environmentId, api)}\u0000remote\u0000${remoteUrl}` : null,
    active ? () => check({ remoteUrl }) : null,
    { keepPrevious: false },
  );
}

/** The destination's server config (providers and default model), read once per connection. */
export function useCopyTargetConfig(
  services: CopyDialogServices,
  environmentId: EnvironmentId | null,
  held: boolean,
): { readonly config: ServerConfig | null; readonly loading: boolean } {
  const api = useNodeEnvironmentApi(environmentId);
  const read = useNodeRead(
    environmentId !== null && held ? `${connectionKey(environmentId, api)}\u0000config` : null,
    environmentId !== null ? () => services.readServerConfig(environmentId) : null,
    { keepPrevious: false },
  );
  return { config: read.data, loading: read.isFetching || (environmentId !== null && !held) };
}

export {
  DEFAULT_COPY_USER_CHOICES,
  legacyCopyProject,
  planCopyOptions,
  type CopyUserChoices,
} from "@ryco/client-runtime/projectCopy/form";
