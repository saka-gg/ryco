import {
  judgeCopyDestination,
  nodePathBasename,
  projectCopySourceCanonicalKey,
  resolveCopyDestination,
  type CopyDestinationRequest,
  type CopyDestinationSuggestion,
  type ProjectCopySourceFacts,
  type ProjectCopyTransport,
} from "@ryco/client-runtime/projectCopy";
import {
  copyExplicitDestinationPath,
  legacyCopyProject,
  legacySourceHints,
} from "@ryco/client-runtime/projectCopy/form";
import { catalogPlatformOs, type NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import type { Project } from "@ryco/client-runtime/state/threads";
import type { EnvironmentApi, EnvironmentId, ServerConfig } from "@ryco/contracts";
import type {
  NodePathHints,
  ProjectCheckRemoteAccessResult,
  ProjectExportInspection,
} from "@ryco/contracts/project-copy";
import { useEffect, useEffectEvent, useState } from "react";

import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { createProjectCopyNodeIo } from "@ryco/client-runtime/projectCopy/nodeIo";
import { acquireMobileNode } from "./mobileAcquireNode";
import { createMobileProjectCopyIo } from "./mobileCopyManager";

/**
 * The copy screen's reads, the phone's counterpart of the web dialog's
 * `useCopyProjectPlanning`: hold the two machines while the screen is open,
 * inspect the source checkout, read the destination's path hints and judge
 * the suggested folder, check the clone remote and read the destination's
 * config. What it decides from them is shared (`projectCopy/form`).
 */

/* ───────── A keyed async read ───────── */

export interface NodeReadState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
}

const IDLE_READ = { data: null, error: null, loading: false } as const;

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

/**
 * Reads `run` once per `key` (null: nothing to read). A newer key replaces
 * the answer of an older one; `refresh` reads the same key again.
 */
export function useNodeRead<T>(
  key: string | null,
  run: (() => Promise<T>) | null,
): NodeReadState<T> & { readonly refresh: () => void } {
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly round: number;
    readonly read: NodeReadState<T>;
  }>({ key: null, round: 0, read: IDLE_READ });
  const [round, setRound] = useState(0);
  // The latest `run` for the key; the key alone decides when to read.
  const read = useEffectEvent(() => (run === null ? null : run()));
  useEffect(() => {
    if (key === null) return;
    const pending = read();
    if (pending === null) return;
    let live = true;
    pending.then(
      (data) => {
        if (live) setState({ key, round, read: { data, error: null, loading: false } });
      },
      (cause: unknown) => {
        if (live) {
          setState({
            key,
            round,
            read: { data: null, error: errorText(cause, "Couldn't read it."), loading: false },
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [key, round]);
  const refresh = () => setRound((value) => value + 1);
  if (key === null) return { ...IDLE_READ, refresh };
  if (state.key !== key) return { data: null, error: null, loading: true, refresh };
  return { ...state.read, loading: state.read.loading || state.round !== round, refresh };
}

/** A key that changes when the node's connection does, so a reconnect reads again. */
const connectionIds = new WeakMap<EnvironmentApi, number>();
let nextConnectionId = 1;
function connectionKey(environmentId: EnvironmentId, api: EnvironmentApi | undefined): string {
  if (!api) return `${environmentId}\u0000-`;
  let id = connectionIds.get(api);
  if (id === undefined) {
    id = nextConnectionId;
    nextConnectionId += 1;
    connectionIds.set(api, id);
  }
  return `${environmentId}\u0000${id}`;
}

/* ───────── Holding a node ───────── */

export interface HeldNodeState {
  readonly status: "idle" | "holding" | "held" | "failed";
  readonly transport: ProjectCopyTransport | null;
  readonly error: string | null;
}

const IDLE_HOLD: HeldNodeState = { status: "idle", transport: null, error: null };

/** Holds `environmentId` while it is set (and the screen is mounted), to read from it. */
export function useHeldNode(environmentId: EnvironmentId | null): HeldNodeState {
  const [state, setState] = useState<{
    readonly key: EnvironmentId | null;
    readonly hold: HeldNodeState;
  }>({ key: null, hold: IDLE_HOLD });
  useEffect(() => {
    if (environmentId === null) return;
    const controller = new AbortController();
    let release: (() => void) | null = null;
    acquireMobileNode(environmentId, { purpose: "follow", signal: controller.signal }).then(
      (node) => {
        if (controller.signal.aborted) {
          node.release();
          return;
        }
        release = node.release;
        setState({
          key: environmentId,
          hold: { status: "held", transport: node.transport, error: null },
        });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          key: environmentId,
          hold: { status: "failed", transport: null, error: errorText(cause, "Couldn't connect.") },
        });
      },
    );
    return () => {
      controller.abort();
      release?.();
    };
  }, [environmentId]);
  if (environmentId === null) return IDLE_HOLD;
  return state.key === environmentId
    ? state.hold
    : { status: "holding", transport: null, error: null };
}

/* ───────── Path hints ───────── */

export function useNodePathHints(
  environmentId: EnvironmentId | null,
  supported: boolean,
): NodeReadState<NodePathHints> {
  const api = useEnvironmentApi(environmentId);
  const read = api?.projects.pathHints;
  return useNodeRead(
    environmentId !== null && supported && read
      ? `${connectionKey(environmentId, api)}\u0000hints`
      : null,
    read ? () => read({}) : null,
  );
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
  const api = useEnvironmentApi(environmentId);
  const support = node?.projectCopySupport ?? "unknown";
  const inspect = api?.projects.exportInspect;
  const inspection = useNodeRead<ProjectExportInspection>(
    project !== null && environmentId !== null && support === "yes" && inspect
      ? `${connectionKey(environmentId, api)}\u0000inspect\u0000${project.id}`
      : null,
    project && inspect ? () => inspect({ projectId: project.id }) : null,
  );
  const pathHints = useNodePathHints(environmentId, support === "yes");
  if (project === null || environmentId === null || node === null) {
    return {
      facts: null,
      hints: null,
      repositoryRoot: project?.cwd ?? "",
      error: null,
      retry: inspection.refresh,
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
      retry: inspection.refresh,
    };
  }
  const error =
    hold.status === "failed"
      ? hold.error
      : inspection.error
        ? `Couldn't read ${project.name} on ${node.label}: ${inspection.error}`
        : null;
  if (inspection.data === null) {
    return {
      facts: null,
      hints: null,
      repositoryRoot: project.cwd,
      error,
      retry: inspection.refresh,
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
    retry: inspection.refresh,
  };
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
 * Where the copy goes: the suggestion (the source's place under the
 * destination's home when it has it, else its code folder), or the parent
 * the user typed, previewed and judged on the destination.
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
  const api = useEnvironmentApi(environmentId);
  const hints = useNodePathHints(environmentId, input.supported).data;
  const preview = api?.projects.previewDestination;
  const sourceSeparator = source.hints?.pathSeparator ?? "/";
  const leaf = source.facts ? nodePathBasename(source.repositoryRoot, sourceSeparator) : null;
  const canonicalKey = source.facts ? projectCopySourceCanonicalKey(source.facts) : null;
  const request: CopyDestinationRequest | null =
    environmentId !== null && input.supported && preview && hints && source.facts && leaf !== null
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
    request && preview && hints
      ? async () => {
          const explicitPath = copyExplicitDestinationPath({
            exactPath,
            manualParent,
            leaf,
            pathSeparator: hints.pathSeparator,
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
  );
  return { hints, suggestion: read.data, leaf, error: read.error };
}

/** Whether the destination reaches the clone remote, checked once a destination is chosen. */
export function useCopyRemoteAccess(input: {
  readonly environmentId: EnvironmentId | null;
  readonly supported: boolean;
  readonly remoteUrl: string | null;
}): NodeReadState<ProjectCheckRemoteAccessResult> {
  const { environmentId, remoteUrl } = input;
  const api = useEnvironmentApi(environmentId);
  const check = api?.projects.checkRemoteAccess;
  return useNodeRead(
    environmentId !== null && input.supported && remoteUrl !== null && check
      ? `${connectionKey(environmentId, api)}\u0000remote\u0000${remoteUrl}`
      : null,
    check && remoteUrl !== null ? () => check({ remoteUrl }) : null,
  );
}

/** The destination's server config (its agents and default model), read once per connection. */
export function useCopyTargetConfig(
  environmentId: EnvironmentId | null,
  held: boolean,
): { readonly config: ServerConfig | null; readonly loading: boolean } {
  const api = useEnvironmentApi(environmentId);
  const read = useNodeRead(
    environmentId !== null && held ? `${connectionKey(environmentId, api)}\u0000config` : null,
    environmentId !== null ? () => readTargetConfig(environmentId) : null,
  );
  return { config: read.data, loading: read.loading || (environmentId !== null && !held) };
}

async function readTargetConfig(environmentId: EnvironmentId): Promise<ServerConfig | null> {
  const io = createMobileProjectCopyIo(createProjectCopyNodeIo);
  try {
    return await io.readServerConfig(environmentId);
  } finally {
    io.dispose();
  }
}
