// FILE: nodePathQueries.ts
// Purpose: Reads a node's folders for the project pickers: its path hints (cached and shared by
//          every picker and dialog), a project's export inspection (cached briefly, so the copy
//          dialog's entry points can warm it), directory search, shallow annotations of one
//          listing, and the destination preview. All of them are project-copy RPCs, called only
//          when the node advertises `capabilities.projectCopy`.
// Layer: Web data hooks. Every read follows the node's current connection and fences answers
//        that arrive after their input changed.

import { useAtomValue } from "@effect/atom-react";
import {
  appAtomRegistry,
  createKeyedQueryRegistry,
  defineKeyedQueryByKey,
  KEY_SEP,
  type KeyedQueryByKey,
  type KeyedQueryEnabledInput,
} from "@ryco/client-runtime/rpc";
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
import {
  isPastStaleTime,
  type KeyedQueryState,
  LAST_RESULT_KEYED_QUERY_STATE_BUILDERS,
} from "../../rpc/keyedQueryState";
import { currentReadGuard, runWithReadRetry } from "../../rpc/readRetry";

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

/* ───────── Cached reads ───────── */

// What these reads showed on the former `queryClient` shim: data only while the
// last settled read succeeded.
const nodePathRegistry = createKeyedQueryRegistry<KeyedQueryState<unknown>>({
  labelPrefix: "project-nodes",
  accountScoped: true,
  ...LAST_RESULT_KEYED_QUERY_STATE_BUILDERS,
});

/**
 * Starts a read of `input` when its cache is stale (`force`: always, joining a
 * read in flight) without observing it, and settles once that read has.
 */
function readNodePath<TInput>(
  query: KeyedQueryByKey<TInput, unknown, KeyedQueryState<unknown>>,
  input: TInput,
  force: boolean,
): Promise<void> {
  query.watch(input)();
  const compositeKey = query.keyOf(input);
  if (force) return query.refreshAsync(compositeKey).then(() => undefined);
  const controller =
    compositeKey === null ? undefined : nodePathRegistry.controllers.get(compositeKey);
  return controller?.inFlightPromise ?? Promise.resolve();
}

/* ───────── Path hints ───────── */

const PATH_HINTS_STALE_TIME_MS = 60_000;

async function readNodePathHints(environmentId: EnvironmentId): Promise<NodePathHints> {
  const read = readEnvironmentApi(environmentId)?.projects.pathHints;
  if (!read) {
    throw new Error("This node is not connected.");
  }
  return read({});
}

const nodePathHintsQuery: KeyedQueryByKey<
  EnvironmentId | null,
  NodePathHints,
  KeyedQueryState<unknown>
> = defineKeyedQueryByKey<
  EnvironmentId | null,
  NodePathHints,
  KeyedQueryState<unknown>,
  Record<string, never>,
  EnvironmentId
>(
  nodePathRegistry,
  {
    label: "path-hints",
    staleTime: PATH_HINTS_STALE_TIME_MS,
    isEnabled: (environmentId): environmentId is EnvironmentId => environmentId !== null,
    buildKey: (environmentId) => environmentId,
    resolveEnvironmentId: (environmentId) => environmentId,
    createControllerFields: () => ({}),
    run: (environmentId) =>
      runWithReadRetry(
        () => readNodePathHints(environmentId),
        1,
        currentReadGuard(nodePathRegistry.controllers, nodePathHintsQuery.keyOf(environmentId)),
      ),
  },
  isPastStaleTime,
);

export interface NodeCachedReadState<T> extends KeyedQueryState<T> {
  /** The last settled read succeeded (its data shows). */
  readonly isSuccess: boolean;
}

function withSuccess<T>(state: KeyedQueryState<unknown>): NodeCachedReadState<T> {
  const typed = state as KeyedQueryState<T>;
  return { ...typed, isSuccess: !typed.isError && typed.data !== null };
}

/**
 * A node's home, separator, normal code directory and code roots. Cached per
 * node, so the node step, the folder picker and the copy dialog share one read.
 * While not `supported` (or not connected) nothing is read, but cached hints show.
 */
export function useNodePathHints(input: {
  readonly environmentId: EnvironmentId | null;
  /** The node advertises `capabilities.projectCopy`. */
  readonly supported: boolean;
}): NodeCachedReadState<NodePathHints> {
  const api = useNodeEnvironmentApi(input.environmentId);
  const environmentId = input.environmentId;
  const enabled = input.supported && api?.projects.pathHints !== undefined;
  useEffect(() => {
    if (!enabled) return;
    return nodePathHintsQuery.watch(environmentId);
  }, [enabled, environmentId]);
  return withSuccess(
    useAtomValue(nodePathHintsQuery.getAtom(nodePathHintsQuery.keyOf(environmentId))),
  );
}

/** Warms a node's path hints, e.g. when "Copy to another node…" is hovered. */
export function prefetchNodePathHints(environmentId: EnvironmentId): Promise<void> {
  return readNodePath(nodePathHintsQuery, environmentId, false);
}

/** The node's path hints when something already read them; this never asks the node. */
export function readCachedNodePathHints(environmentId: EnvironmentId): NodePathHints | null {
  const state = nodePathHintsQuery.getSnapshot(nodePathHintsQuery.keyOf(environmentId));
  return state.data as NodePathHints | null;
}

/**
 * Keeps a node's path hints cached and calls `listener` when they change.
 * Returns the stop.
 */
export function followNodePathHints(
  environmentId: EnvironmentId,
  listener: () => void,
): () => void {
  const release = nodePathHintsQuery.watch(environmentId);
  const unsubscribe = appAtomRegistry.subscribe(
    nodePathHintsQuery.getAtom(nodePathHintsQuery.keyOf(environmentId)),
    listener,
  );
  return () => {
    unsubscribe();
    release();
  };
}

/* ───────── Export inspection ───────── */

/**
 * How long a project's inspection (branch, changes, sizes) is reused: long
 * enough that hovering "Copy to another node…" warms the dialog, short enough
 * that it still shows what the working tree has now.
 */
export const EXPORT_INSPECT_STALE_TIME_MS = 20_000;

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

interface ExportInspectInput {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
}

type EnabledExportInspectInput = KeyedQueryEnabledInput<
  ExportInspectInput,
  "environmentId" | "projectId"
>;

/** An inspection with when it arrived, so the copy dialog can ask for a recent one. */
interface ReceivedExportInspection {
  readonly inspection: ProjectExportInspection;
  readonly receivedAt: number;
}

const exportInspectQuery = defineKeyedQueryByKey<
  ExportInspectInput,
  ReceivedExportInspection,
  KeyedQueryState<unknown>,
  Record<string, never>,
  EnabledExportInspectInput
>(
  nodePathRegistry,
  {
    label: "export-inspect",
    staleTime: EXPORT_INSPECT_STALE_TIME_MS,
    isEnabled: (input): input is EnabledExportInspectInput =>
      input.environmentId !== null && input.projectId !== null,
    buildKey: (input) => `${input.environmentId}${KEY_SEP}${input.projectId}`,
    resolveEnvironmentId: (input) => input.environmentId,
    createControllerFields: () => ({}),
    run: async (input) => ({
      inspection: await readExportInspection(input.environmentId, input.projectId),
      receivedAt: Date.now(),
    }),
  },
  isPastStaleTime,
);

export interface NodeExportInspectionState extends NodeCachedReadState<ProjectExportInspection> {
  /** When the shown inspection arrived; 0 when none shows. */
  readonly dataUpdatedAt: number;
}

/** `projects.exportInspect` of one project on its node, cached for a few seconds. */
export function useNodeExportInspection(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  /** The node advertises project copy and its API has the read. */
  readonly enabled: boolean;
}): NodeExportInspectionState {
  const { environmentId, projectId, enabled } = input;
  useEffect(() => {
    if (!enabled) return;
    return exportInspectQuery.watch({ environmentId, projectId });
  }, [enabled, environmentId, projectId]);
  const state = withSuccess<ReceivedExportInspection>(
    useAtomValue(
      exportInspectQuery.getAtom(exportInspectQuery.keyOf({ environmentId, projectId })),
    ),
  );
  return {
    ...state,
    data: state.data?.inspection ?? null,
    dataUpdatedAt: state.data?.receivedAt ?? 0,
  };
}

/** Reads a project's inspection again (a retry after it failed). */
export function refetchExportInspection(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<void> {
  return readNodePath(exportInspectQuery, { environmentId, projectId }, true);
}

/** Warms a project's inspection on a connected node; a fresh one is kept. */
export function prefetchExportInspection(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<void> {
  return readNodePath(exportInspectQuery, { environmentId, projectId }, false);
}

/** Caches a node's path hints as if read now. */
export function seedNodePathHintsForTests(
  environmentId: EnvironmentId,
  hints: NodePathHints,
): void {
  const compositeKey = nodePathHintsQuery.keyOf(environmentId);
  if (compositeKey === null) return;
  const controller = nodePathRegistry.controllers.get(compositeKey);
  if (controller) {
    controller.hasData = true;
    controller.lastFetchedAt = Date.now();
  }
  nodePathRegistry.setQueryState(
    compositeKey,
    LAST_RESULT_KEYED_QUERY_STATE_BUILDERS.buildSuccessState(hints),
  );
}

export function resetNodePathQueriesForTests(): void {
  nodePathRegistry.resetForTests();
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
