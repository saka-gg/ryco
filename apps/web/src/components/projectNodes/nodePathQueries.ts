// FILE: nodePathQueries.ts
// Purpose: Reads a node's folders for the project pickers: its path hints (cached and shared by
//          every picker and dialog), a project's export inspection (cached briefly, so the copy
//          dialog's entry points can warm it), directory search, shallow annotations of one
//          listing, and the destination preview. All of them are project-copy RPCs, called only
//          when the node advertises `capabilities.projectCopy`.
// Layer: Web data hooks. Every read follows the node's current connection and fences answers
//        that arrive after their input changed.

import type { EnvironmentApi, EnvironmentId, ProjectId } from "@ryco/contracts";
import type {
  FilesystemDirectoryMatch,
  FilesystemSearchDirectoriesResult,
  NodePathHints,
  ProjectDestinationPreview,
  ProjectExportInspection,
} from "@ryco/contracts/project-copy";
import { useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore } from "react";

import { readEnvironmentApi, readEnvironmentApiForConnection } from "../../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { normalizeProjectPathForComparison } from "@ryco/shared/projectPaths";
import { defaultQueryClient, useQuery, type QueryKey } from "../../rpc/queryClient";

/** The node's environment API on its current connection; undefined while it is not connected. */
export function useNodeEnvironmentApi(
  environmentId: EnvironmentId | null,
): EnvironmentApi | undefined {
  const connection = useSyncExternalStore(
    subscribeEnvironmentConnections,
    () => (environmentId === null ? null : readEnvironmentConnection(environmentId)),
    () => null,
  );
  return useMemo(
    () =>
      environmentId === null
        ? undefined
        : readEnvironmentApiForConnection(environmentId, connection?.client ?? null),
    [connection, environmentId],
  );
}

/* ───────── Path hints ───────── */

const PATH_HINTS_STALE_TIME_MS = 60_000;

export function nodePathHintsQueryKey(environmentId: EnvironmentId): QueryKey {
  return ["project-nodes", "path-hints", environmentId];
}

async function readNodePathHints(environmentId: EnvironmentId): Promise<NodePathHints> {
  const read = readEnvironmentApi(environmentId)?.projects.pathHints;
  if (!read) {
    throw new Error("This node is not connected.");
  }
  return read({});
}

/**
 * A node's home, separator, normal code directory and code roots. Cached per
 * node, so the node step, the folder picker and the copy dialog share one read.
 */
export function useNodePathHints(input: {
  readonly environmentId: EnvironmentId | null;
  /** The node advertises `capabilities.projectCopy`. */
  readonly supported: boolean;
}) {
  const api = useNodeEnvironmentApi(input.environmentId);
  const environmentId = input.environmentId;
  const enabled =
    environmentId !== null && input.supported && api?.projects.pathHints !== undefined;
  return useQuery({
    queryKey:
      environmentId === null
        ? ["project-nodes", "path-hints", null]
        : nodePathHintsQueryKey(environmentId),
    queryFn: () => readNodePathHints(environmentId!),
    environmentId,
    enabled,
    staleTime: PATH_HINTS_STALE_TIME_MS,
    retry: 1,
  });
}

/** Warms a node's path hints, e.g. when "Copy to another node…" is hovered. */
export function prefetchNodePathHints(environmentId: EnvironmentId): Promise<void> {
  return defaultQueryClient.prefetchQuery({
    queryKey: nodePathHintsQueryKey(environmentId),
    queryFn: () => readNodePathHints(environmentId),
    staleTime: PATH_HINTS_STALE_TIME_MS,
  });
}

/* ───────── Export inspection ───────── */

/**
 * How long a project's inspection (branch, changes, sizes) is reused: long
 * enough that hovering "Copy to another node…" warms the dialog, short enough
 * that it still shows what the working tree has now.
 */
export const EXPORT_INSPECT_STALE_TIME_MS = 20_000;

export function exportInspectQueryKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): QueryKey {
  return ["project-nodes", "export-inspect", environmentId, projectId];
}

async function readExportInspection(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<ProjectExportInspection> {
  const inspect = readEnvironmentApi(environmentId)?.projects.exportInspect;
  if (!inspect) {
    throw new Error("This node is not connected.");
  }
  return inspect({ projectId });
}

/** `projects.exportInspect` of one project on its node, cached for a few seconds. */
export function useNodeExportInspection(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  /** The node advertises project copy and its API has the read. */
  readonly enabled: boolean;
}) {
  const { environmentId, projectId } = input;
  return useQuery({
    queryKey:
      environmentId === null || projectId === null
        ? ["project-nodes", "export-inspect", null]
        : exportInspectQueryKey(environmentId, projectId),
    queryFn: () => readExportInspection(environmentId!, projectId!),
    environmentId,
    enabled: input.enabled && environmentId !== null && projectId !== null,
    staleTime: EXPORT_INSPECT_STALE_TIME_MS,
    retry: false,
  });
}

/** Reads a project's inspection again (a retry after it failed). */
export function refetchExportInspection(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<void> {
  return defaultQueryClient.prefetchQuery({
    queryKey: exportInspectQueryKey(environmentId, projectId),
    queryFn: () => readExportInspection(environmentId, projectId),
    staleTime: 0,
    retry: false,
  });
}

/** Warms a project's inspection on a connected node; a fresh one is kept. */
export function prefetchExportInspection(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<void> {
  return defaultQueryClient.prefetchQuery({
    queryKey: exportInspectQueryKey(environmentId, projectId),
    queryFn: () => readExportInspection(environmentId, projectId),
    staleTime: EXPORT_INSPECT_STALE_TIME_MS,
    retry: false,
  });
}

/* ───────── One-shot reads ───────── */

export interface NodeReadState<T> {
  readonly data: T | null;
  readonly error: Error | null;
  /** A read is in flight (with or without earlier data still shown). */
  readonly isFetching: boolean;
  readonly retry: () => void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

const connectionIds = new WeakMap<EnvironmentApi, number>();
let nextConnectionId = 0;

/**
 * A number per environment API object, so a read keyed on it runs again on a
 * new connection instead of keeping the previous connection's answer.
 */
export function connectionKey(
  environmentId: EnvironmentId,
  api: EnvironmentApi | undefined,
): string {
  if (!api) return `${environmentId}\u0000-`;
  let id = connectionIds.get(api);
  if (id === undefined) {
    nextConnectionId += 1;
    id = nextConnectionId;
    connectionIds.set(api, id);
  }
  return `${environmentId}\u0000${id}`;
}

/**
 * Runs `read` whenever `key` changes and keeps only the latest answer. With
 * `keepPrevious`, the last result stays visible while the next one loads (search
 * as you type); otherwise it clears. Shared by the pickers and the copy dialog;
 * key a read on `connectionKey` so it runs again on a new connection.
 */
export function useNodeRead<T>(
  key: string | null,
  read: (() => Promise<T>) | null,
  options: { readonly keepPrevious: boolean },
): NodeReadState<T> {
  const [attempt, setAttempt] = useState(0);
  // The last settled answer and the request it answers.
  const [settled, setSettled] = useState<{
    readonly key: string | null;
    readonly attempt: number;
    readonly data: T | null;
    readonly error: Error | null;
  }>({ key: null, attempt: 0, data: null, error: null });

  // The read for the current key; `attempt` only makes a retry run it again.
  const currentReadFor = useEffectEvent((_attempt: number) => read);
  const keepPrevious = options.keepPrevious;
  useEffect(() => {
    const currentRead = key === null ? null : currentReadFor(attempt);
    if (currentRead === null) return;
    let cancelled = false;
    // A read that throws before it returns a promise settles as a failure too.
    Promise.resolve()
      .then(currentRead)
      .then(
        (data) => {
          if (!cancelled) setSettled({ key, attempt, data, error: null });
        },
        (cause: unknown) => {
          if (cancelled) return;
          setSettled((previous) => ({
            key,
            attempt,
            data: keepPrevious || previous.key === key ? previous.data : null,
            error: toError(cause),
          }));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [attempt, keepPrevious, key]);

  // Until the answer for this key and attempt arrives, the request is in flight.
  const pending = settled.key !== key || settled.attempt !== attempt;
  const active = key !== null && read !== null;
  return useMemo(
    () => ({
      data: pending && !keepPrevious && settled.key !== key ? null : settled.data,
      error: pending ? null : settled.error,
      isFetching: pending && active,
      retry: () => setAttempt((value) => value + 1),
    }),
    [active, keepPrevious, key, pending, settled],
  );
}

/* ───────── Search ───────── */

export const FOLDER_SEARCH_LIMIT = 40;
const LISTING_ANNOTATION_LIMIT = 100;

/** Folders on the node matching `query` across its code roots (or `roots`). */
export function useNodeFolderSearch(input: {
  readonly environmentId: EnvironmentId;
  readonly api: EnvironmentApi | undefined;
  /** The debounced query; empty disables the search. */
  readonly query: string;
  readonly enabled: boolean;
}): NodeReadState<FilesystemSearchDirectoriesResult> {
  const search = input.api?.filesystem.searchDirectories;
  const query = input.query.trim();
  const active = input.enabled && search !== undefined && query.length > 0;
  return useNodeRead(
    active ? `${connectionKey(input.environmentId, input.api)}\u0000${query}` : null,
    active ? () => search({ query, limit: FOLDER_SEARCH_LIMIT }) : null,
    { keepPrevious: true },
  );
}

/**
 * The node's git repositories under its code roots, best first: the empty-query
 * listing of the roots puts repositories first.
 */
export function useNodeGitRepositories(input: {
  readonly environmentId: EnvironmentId;
  readonly api: EnvironmentApi | undefined;
  readonly enabled: boolean;
}): NodeReadState<ReadonlyArray<FilesystemDirectoryMatch>> {
  const search = input.api?.filesystem.searchDirectories;
  const active = input.enabled && search !== undefined;
  return useNodeRead(
    active ? `${connectionKey(input.environmentId, input.api)}\u0000repositories` : null,
    active
      ? async () =>
          (await search({ query: "", limit: FOLDER_SEARCH_LIMIT })).matches.filter(
            (match) => match.isGitRepository,
          )
      : null,
    { keepPrevious: false },
  );
}

/**
 * What the node knows about the folders of one listing (git branch, existing
 * project, repository), keyed by their comparison path. One shallow search of
 * the listed directory; the listing itself still comes from `filesystem.browse`.
 */
export function useNodeListingAnnotations(input: {
  readonly environmentId: EnvironmentId;
  readonly api: EnvironmentApi | undefined;
  /** The listed directory as the node resolved it (`browse.parentPath`); null while unknown. */
  readonly directory: string | null;
  readonly enabled: boolean;
}): ReadonlyMap<string, FilesystemDirectoryMatch> {
  const search = input.api?.filesystem.searchDirectories;
  const directory = input.directory;
  const active = input.enabled && search !== undefined && directory !== null;
  const state = useNodeRead(
    active ? `${connectionKey(input.environmentId, input.api)}\u0000${directory}` : null,
    active
      ? () =>
          search({ query: "", roots: [directory], maxDepth: 1, limit: LISTING_ANNOTATION_LIMIT })
      : null,
    { keepPrevious: false },
  );
  return useMemo(
    () =>
      new Map(
        (state.data?.matches ?? []).map(
          (match) => [normalizeProjectPathForComparison(match.path), match] as const,
        ),
      ),
    [state.data],
  );
}

/* ───────── Destination preview ───────── */

/** How the node judges a folder as a project destination: free, empty, a repository, refused. */
export function useNodeDestinationPreview(input: {
  readonly environmentId: EnvironmentId;
  readonly api: EnvironmentApi | undefined;
  /** The (debounced) destination; null disables the preview. */
  readonly path: string | null;
  readonly enabled: boolean;
}): NodeReadState<ProjectDestinationPreview> {
  const preview = input.api?.projects.previewDestination;
  const path = input.path?.trim() ?? "";
  const active = input.enabled && preview !== undefined && path.length > 0;
  return useNodeRead(
    active ? `${connectionKey(input.environmentId, input.api)}\u0000${path}` : null,
    active ? () => preview({ path }) : null,
    { keepPrevious: false },
  );
}
