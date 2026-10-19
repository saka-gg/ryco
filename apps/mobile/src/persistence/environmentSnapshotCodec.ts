import type { EnvironmentId } from "@ryco/contracts";
import { WorktreeId } from "@ryco/contracts/worktree";
import { projectKindOf } from "@ryco/shared/projectKind";
import {
  createThreadContentCapture,
  decodeCachedEnvironmentContent,
  isArchivedThreadStub,
  isThreadLineage,
  selectThreadsForContentCache,
  trimContentToBudget,
  type CachedThreadContent,
  type CapturedThreadContent,
  type ThreadContentCapture,
} from "@ryco/client-runtime/state/threads";
import {
  MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT,
  MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
  MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT,
  MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES,
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  type WorkspaceMetadataSnapshot,
  type WorkspaceThreadMetadata,
} from "@ryco/client-runtime/state/workspace";

import { payloadByteLength } from "./snapshotDb";
import type {
  ArchivedThreadStub,
  CachedEnvironmentShellSnapshot,
  EnvironmentState,
  Project,
  SidebarThreadOrStub,
  SidebarWorktreeSummary,
  ThreadShellOrStub,
} from "../state/threadsRuntime";

/**
 * The typed record layer over snapshotDb: versioned per-environment snapshot
 * records with an explicit schemaVersion literal, so a downgraded client (or a
 * record written by a future client) fails to decode and is discarded instead
 * of being mis-read as current. Version history:
 *
 * v1 — initial: projects, worktrees, and thread shell/sidebar-summary pairs,
 *      with sessions and background liveness stripped at capture so a cached
 *      row can never claim live activity.
 * v2 — an archived thread the shell listed as a stub (`ArchivedThreadStub`)
 *      is stored as that stub in both halves. A v1 reader would take a stub
 *      for a full shell, so v2 records are discarded by it; v2 readers still
 *      read v1 records, which only hold full shells.
 * v3 — an optional `content` map of bounded recent message text by thread id,
 *      kept for display only. A v2 reader discards v3 records; v3 readers still
 *      read v1 and v2 records, which carry no content.
 */
export const ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION = 3;
/** Older record versions this client still reads. */
const READABLE_LEGACY_SCHEMA_VERSIONS: ReadonlySet<unknown> = new Set([1, 2]);

export interface StoredEnvironmentSnapshotThread {
  /** An archived thread's stub is the same stub in both halves. */
  readonly shell: ThreadShellOrStub;
  readonly summary: SidebarThreadOrStub;
}

export interface StoredEnvironmentSnapshot {
  /** Records are written as the current version; a legacy one decodes as is. */
  readonly schemaVersion: typeof ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION | 1 | 2;
  readonly environmentId: EnvironmentId;
  readonly capturedAt: number;
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly threads: ReadonlyArray<StoredEnvironmentSnapshotThread>;
  /**
   * Recent message text by thread id, for display while no connection is ready.
   * Never a replay baseline, session or dispatch queue.
   */
  readonly content?: Readonly<Record<string, CachedThreadContent>>;
}

/**
 * Per-environment bounds, applied at capture. The total-across-environments
 * budget is enforced separately with the shared eviction policy
 * (`planEvictionsToCapacity`) over the stored rows.
 */
export const MAX_SNAPSHOT_THREADS_PER_ENVIRONMENT = MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT;
export const MAX_SNAPSHOT_PAYLOAD_BYTES_PER_ENVIRONMENT =
  MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT;
/**
 * The message text one environment's record may carry: an equal share of the
 * total cache budget. Without it a record could fill its whole payload cap with
 * text, and the least recently written rows would be evicted whole (shell
 * included) to make room. The record's own cap still bounds shell and text
 * together, and text is trimmed first.
 */
export const MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT = Math.floor(
  MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES / MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
);

/** Per-environment bounds a capture is held to. */
export interface EnvironmentSnapshotCaps {
  readonly maxThreads: number;
  readonly maxPayloadBytes: number;
  /** Defaults to `MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT`. */
  readonly maxContentBytes?: number;
}

const DEFAULT_SNAPSHOT_CAPS: EnvironmentSnapshotCaps = {
  maxThreads: MAX_SNAPSHOT_THREADS_PER_ENVIRONMENT,
  maxPayloadBytes: MAX_SNAPSHOT_PAYLOAD_BYTES_PER_ENVIRONMENT,
};

function threadActivityAt(summary: SidebarThreadOrStub): string {
  return summary.updatedAt ?? summary.latestUserMessageAt ?? summary.createdAt;
}

function threadRecency(summary: SidebarThreadOrStub): number {
  const timestamp = Date.parse(threadActivityAt(summary));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Snapshot the settled shell projection of one environment out of the shared
 * threads store. Sessions and background liveness are stripped here — the
 * persisted form is only ever rendered as last-known state.
 */
export function captureEnvironmentSnapshotRecord(
  environmentState: EnvironmentState,
  environmentId: EnvironmentId,
  capturedAt: number,
): StoredEnvironmentSnapshot {
  const projects = environmentState.projectIds.flatMap((projectId) => {
    const project = environmentState.projectById[projectId];
    return project ? [project] : [];
  });
  const worktrees = (environmentState.worktreeIds ?? []).flatMap((worktreeId) => {
    const worktree = environmentState.worktreeById?.[worktreeId];
    return worktree ? [worktree] : [];
  });
  const threads = environmentState.threadIds.flatMap((threadId) => {
    const shell = environmentState.threadShellById[threadId];
    const summary = environmentState.sidebarThreadSummaryById[threadId];
    if (!shell || !summary) return [];
    return [{ shell, summary: withoutLiveState(summary) }];
  });
  return {
    schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    capturedAt,
    projects,
    worktrees,
    threads,
  };
}

/** A cached row never claims live activity; a stub claims none to begin with. */
function withoutLiveState(summary: SidebarThreadOrStub): SidebarThreadOrStub {
  return isArchivedThreadStub(summary)
    ? summary
    : { ...summary, session: null, backgroundLiveness: null };
}

/**
 * The order threads are dropped in to meet the per-environment bounds:
 * archived first, then oldest. The sort is stable, so ties keep store order.
 */
function threadDropOrder<T extends StoredEnvironmentSnapshotThread>(
  threads: ReadonlyArray<T>,
): T[] {
  return threads.toSorted((left, right) => {
    const archivedDelta =
      Number(right.shell.archivedAt !== null) - Number(left.shell.archivedAt !== null);
    if (archivedDelta !== 0) return archivedDelta;
    return threadRecency(left.summary) - threadRecency(right.summary);
  });
}

/** Applies the thread-count cap, keeping the survivors in their original order. */
function boundThreadCount<T extends StoredEnvironmentSnapshotThread>(
  threads: ReadonlyArray<T>,
  maxThreads: number,
): ReadonlyArray<T> {
  if (threads.length <= maxThreads) return threads;
  const dropped = new Set(threadDropOrder(threads).slice(0, threads.length - maxThreads));
  return threads.filter((thread) => !dropped.has(thread));
}

/** One byte-cap round: drops a quarter of the threads (at least one). */
function dropByteCapRound<T extends StoredEnvironmentSnapshotThread>(
  threads: ReadonlyArray<T>,
): T[] {
  const dropCount = Math.max(1, Math.ceil(threads.length / 4));
  const dropped = new Set(threadDropOrder(threads).slice(0, dropCount));
  return threads.filter((thread) => !dropped.has(thread));
}

/**
 * The bytes a record gains before its first content entry (`,"content":`).
 * `trimContentToBudget` counts them as part of the record's body.
 */
const CONTENT_KEY_BYTES = payloadByteLength(',"content":');

/** The serialized `content` object's length: its braces, entries and the commas between them. */
function contentObjectBytes(entries: ReadonlyArray<CapturedThreadContent>): number {
  let bytes = 2 + Math.max(0, entries.length - 1);
  for (const entry of entries) bytes += entry.entryBytes;
  return bytes;
}

/**
 * The display content worth keeping for an environment, least recently active
 * first, which is the order `trimContentToBudget` drops in. Mobile records no
 * per-thread visit, so a thread's own latest activity stands in for it. Only
 * threads whose message list changed since the previous capture through
 * `capture` are captured again.
 */
export function captureEnvironmentContentCandidates(
  environmentState: EnvironmentState,
  environmentId: EnvironmentId,
  capture: ThreadContentCapture,
): ReadonlyArray<CapturedThreadContent> {
  return capture.capture(
    environmentId,
    environmentState,
    selectThreadsForContentCache({
      threadIds: environmentState.threadIds,
      hasMessages: (threadId) => (environmentState.messageIdsByThreadId[threadId]?.length ?? 0) > 0,
      routedThreadId: null,
      lastVisitedAt: (threadId) => {
        const summary = environmentState.sidebarThreadSummaryById[threadId];
        return summary ? threadActivityAt(summary) : null;
      },
    }),
  );
}

/**
 * The candidates a record keeps: those of threads the record lists, dropping
 * the least recently active while the text would exceed its own cap or the
 * record would exceed the payload cap. Content is trimmed after the shell has
 * been bounded, so it never costs the record a thread. `bodyBytes` is the UTF-8
 * length of the record without content.
 */
function keepContentWithinBudget(input: {
  readonly candidates: ReadonlyArray<CapturedThreadContent>;
  readonly threadIds: ReadonlySet<string>;
  readonly bodyBytes: number;
  readonly caps: EnvironmentSnapshotCaps;
}): CapturedThreadContent[] {
  const bodyBytes = input.bodyBytes + CONTENT_KEY_BYTES;
  return trimContentToBudget({
    bodyBytes,
    entries: input.candidates.filter((entry) => input.threadIds.has(entry.threadId)),
    budgetBytes: Math.min(
      input.caps.maxPayloadBytes,
      bodyBytes + (input.caps.maxContentBytes ?? MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT),
    ),
  });
}

/**
 * Enforce the per-environment bounds by dropping threads — archived first,
 * then oldest — while preserving the survivors' original order. The byte cap
 * re-serializes after each trim round; projects and worktrees are never
 * dropped (they are small and the interface renders from them). The UTF-8
 * length is measured once per round and returned, so the store does not measure
 * the same payload again. Display `content` candidates are then trimmed to the
 * same cap, the least recently active first; a stored `content` is replaced by
 * what they leave.
 */
export function boundStoredEnvironmentSnapshot(
  record: StoredEnvironmentSnapshot,
  caps: EnvironmentSnapshotCaps = DEFAULT_SNAPSHOT_CAPS,
  contentCandidates: ReadonlyArray<CapturedThreadContent> = [],
): {
  readonly record: StoredEnvironmentSnapshot;
  readonly payload: string;
  readonly payloadBytes: number;
} {
  const { content: _storedContent, ...base } = record;
  let threads = boundThreadCount(record.threads, caps.maxThreads);
  let payload = JSON.stringify({ ...base, threads });
  let payloadBytes = payloadByteLength(payload);
  while (payloadBytes > caps.maxPayloadBytes && threads.length > 0) {
    threads = dropByteCapRound(threads);
    payload = JSON.stringify({ ...base, threads });
    payloadBytes = payloadByteLength(payload);
  }
  const kept = keepContentWithinBudget({
    candidates: contentCandidates,
    threadIds: new Set(threads.map((thread) => thread.shell.id)),
    bodyBytes: payloadBytes,
    caps,
  });
  if (kept.length === 0) return { record: { ...base, threads }, payload, payloadBytes };
  const withContent: StoredEnvironmentSnapshot = {
    ...base,
    threads,
    content: Object.fromEntries(kept.map((entry) => [entry.threadId, entry.content])),
  };
  const contentPayload = JSON.stringify(withContent);
  return {
    record: withContent,
    payload: contentPayload,
    payloadBytes: payloadByteLength(contentPayload),
  };
}

interface SerializedThreadFragment {
  /** The store objects the fragment was serialized from. */
  readonly shell: ThreadShellOrStub;
  readonly summary: SidebarThreadOrStub;
  readonly json: string;
  readonly bytes: number;
}

export interface EnvironmentSnapshotSerializer {
  /**
   * Captures and bounds one environment exactly like
   * `boundStoredEnvironmentSnapshot(captureEnvironmentSnapshotRecord(...))`,
   * with a byte-identical payload, but serializes and measures only threads
   * whose shell or summary changed since the previous call. With
   * `options.content`, recent message text is kept too, as
   * `boundStoredEnvironmentSnapshot` does for the candidates of
   * `captureEnvironmentContentCandidates`, re-capturing only threads whose
   * messages changed.
   */
  readonly serialize: (
    environmentState: EnvironmentState,
    environmentId: EnvironmentId,
    capturedAt: number,
    options?: { readonly content?: boolean },
  ) => {
    readonly payload: string;
    readonly payloadBytes: number;
    readonly threads: number;
    /** Threads whose message text the payload carries. */
    readonly contentThreads: number;
  };
  /** Threads serialized from scratch over this serializer's lifetime (tests). */
  readonly serializedThreadCount: () => number;
}

/**
 * Incremental serializer for one environment's snapshot. While an agent runs,
 * the shell stream replaces the active thread's shell and summary (a fresh
 * `updatedAt`) several times a second, so every capture used to stringify and
 * measure the whole environment (up to the byte cap) for a change to one row.
 * Each thread's JSON fragment and UTF-8 length are kept by identity of its
 * store objects; a capture re-serializes only the rows that changed and joins
 * the rest, and the byte cap is enforced on the summed fragment lengths. Display
 * content is incremental the same way: a thread's captured text and its JSON
 * are kept until its message list changes.
 */
export function createEnvironmentSnapshotSerializer(
  caps: EnvironmentSnapshotCaps = DEFAULT_SNAPSHOT_CAPS,
): EnvironmentSnapshotSerializer {
  let fragments = new Map<string, SerializedThreadFragment>();
  let serializedThreads = 0;
  const contentCapture = createThreadContentCapture();
  /** Each captured thread's `"id":content` JSON; captured entries are reused while unchanged. */
  const contentEntryJsons = new WeakMap<CapturedThreadContent, string>();
  const contentEntryJson = (entry: CapturedThreadContent): string => {
    let json = contentEntryJsons.get(entry);
    if (json === undefined) {
      json = `${JSON.stringify(entry.threadId)}:${JSON.stringify(entry.content)}`;
      contentEntryJsons.set(entry, json);
    }
    return json;
  };

  const fragmentFor = (shell: ThreadShellOrStub, summary: SidebarThreadOrStub) => {
    const cached = fragments.get(shell.id);
    if (cached !== undefined && cached.shell === shell && cached.summary === summary) {
      return cached;
    }
    const thread: StoredEnvironmentSnapshotThread = { shell, summary: withoutLiveState(summary) };
    const json = JSON.stringify(thread);
    serializedThreads += 1;
    return { shell, summary, json, bytes: payloadByteLength(json) };
  };

  const serialize: EnvironmentSnapshotSerializer["serialize"] = (
    environmentState,
    environmentId,
    capturedAt,
    options,
  ) => {
    const record = captureEnvironmentSnapshotRecord(
      { ...environmentState, threadIds: [] },
      environmentId,
      capturedAt,
    );
    const candidates: StoredEnvironmentSnapshotThread[] = [];
    for (const threadId of environmentState.threadIds) {
      const shell = environmentState.threadShellById[threadId];
      const summary = environmentState.sidebarThreadSummaryById[threadId];
      if (!shell || !summary) continue;
      candidates.push({ shell, summary });
    }
    // The count cap needs only archive state and recency, so it runs before
    // anything is serialized: threads beyond it are neither stringified nor
    // retained. The drop order and rounds match `boundStoredEnvironmentSnapshot`.
    const nextFragments = new Map<string, SerializedThreadFragment>();
    let kept: SerializedThreadFragment[] = [];
    for (const { shell, summary } of boundThreadCount(candidates, caps.maxThreads)) {
      const fragment = fragmentFor(shell, summary);
      nextFragments.set(shell.id, fragment);
      kept.push(fragment);
    }
    // Threads that left the environment or the count cap drop their fragments.
    fragments = nextFragments;

    // `JSON.stringify` of the record with no threads ends in `"threads":[]}`;
    // the fragments go between the brackets, so the assembled payload is the
    // record's own serialization.
    const envelope = JSON.stringify(record);
    const prefix = envelope.slice(0, -2);
    const suffix = envelope.slice(-2);
    // Every join point is an ASCII character, so the UTF-8 length of the whole
    // is the sum of its parts.
    const envelopeBytes = payloadByteLength(envelope);
    const payloadBytesOf = (candidates: ReadonlyArray<SerializedThreadFragment>) => {
      let bytes = envelopeBytes + Math.max(0, candidates.length - 1);
      for (const fragment of candidates) bytes += fragment.bytes;
      return bytes;
    };
    let payloadBytes = payloadBytesOf(kept);
    while (payloadBytes > caps.maxPayloadBytes && kept.length > 0) {
      kept = dropByteCapRound(kept);
      payloadBytes = payloadBytesOf(kept);
    }
    const threadsJson = kept.map((fragment) => fragment.json).join(",");
    let content: ReadonlyArray<CapturedThreadContent> = [];
    if (options?.content) {
      content = keepContentWithinBudget({
        candidates: captureEnvironmentContentCandidates(
          environmentState,
          environmentId,
          contentCapture,
        ),
        threadIds: new Set(kept.map((fragment) => fragment.shell.id)),
        bodyBytes: payloadBytes,
        caps,
      });
    } else {
      // Nothing is kept while the setting is off, in memory either.
      contentCapture.forget(environmentId);
    }
    if (content.length === 0) {
      return {
        payload: `${prefix}${threadsJson}${suffix}`,
        payloadBytes,
        threads: kept.length,
        contentThreads: 0,
      };
    }
    // `content` follows `threads`, the record's last key, so the suffix's
    // closing brace moves to the end of the content object.
    return {
      payload: `${prefix}${threadsJson}${suffix.slice(0, -1)},"content":{${content
        .map(contentEntryJson)
        .join(",")}}}`,
      payloadBytes: payloadBytes + CONTENT_KEY_BYTES + contentObjectBytes(content),
      threads: kept.length,
      contentThreads: content.length,
    };
  };

  return { serialize, serializedThreadCount: () => serializedThreads };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidProject(value: unknown, environmentId: string): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    value.environmentId === environmentId &&
    typeof value.name === "string" &&
    typeof value.cwd === "string"
  );
}

function isValidWorktree(value: unknown, environmentId: string): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    value.environmentId === environmentId &&
    isNonEmptyString(value.projectId)
  );
}

function isValidThread(value: unknown, environmentId: string, mayHoldStubs: boolean): boolean {
  if (!isRecord(value) || !isRecord(value.shell) || !isRecord(value.summary)) return false;
  const shell = value.shell;
  const summary = value.summary;
  const identityValid =
    isNonEmptyString(shell.id) &&
    shell.environmentId === environmentId &&
    isNonEmptyString(shell.projectId) &&
    summary.id === shell.id &&
    summary.environmentId === environmentId;
  if (!identityValid) return false;
  const shellIsStub = shell.shellDetail === "archived-stub";
  const summaryIsStub = summary.shellDetail === "archived-stub";
  if (!shellIsStub && !summaryIsStub) return true;
  // A stub is stored whole (both halves) and archived; v1 never held one.
  return (
    mayHoldStubs &&
    shellIsStub &&
    summaryIsStub &&
    isNonEmptyString(shell.archivedAt) &&
    isNonEmptyString(shell.title) &&
    isNonEmptyString(shell.createdAt) &&
    isNonEmptyString(shell.updatedAt)
  );
}

/**
 * Strict envelope decode: version literal, embedded identity, and per-row
 * identity checks. Any mismatch — including a schemaVersion bump in either
 * direction — makes the whole record invalid; the caller deletes the row and
 * treats it as a cache miss.
 */
export function decodeStoredEnvironmentSnapshot(
  raw: string,
  environmentId: EnvironmentId,
): StoredEnvironmentSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const current = value.schemaVersion === ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION;
  if (!current && !READABLE_LEGACY_SCHEMA_VERSIONS.has(value.schemaVersion)) return null;
  if (value.environmentId !== environmentId) return null;
  if (typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) return null;
  const { projects, worktrees, threads } = value;
  if (!Array.isArray(projects) || !Array.isArray(worktrees) || !Array.isArray(threads)) {
    return null;
  }
  if (!projects.every((project) => isValidProject(project, environmentId))) return null;
  if (!worktrees.every((worktree) => isValidWorktree(worktree, environmentId))) return null;
  if (!threads.every((thread) => isValidThread(thread, environmentId, value.schemaVersion !== 1))) {
    return null;
  }
  // Content is a display extra: an entry that does not decode is dropped, not the record.
  const { content: storedContent, ...rest } = value;
  const content = current
    ? decodeCachedEnvironmentContent(
        { content: storedContent },
        new Set(threads.map((thread) => thread.shell.id as string)),
      )
    : {};
  return {
    ...(rest as unknown as StoredEnvironmentSnapshot),
    ...(Object.keys(content).length > 0 ? { content } : {}),
  };
}

/**
 * Whether a stored payload may carry message text, judged from the raw string so
 * a launch need not parse every row to find out. `withoutStoredContent` decides.
 */
export function mayHoldStoredContent(raw: string): boolean {
  return raw.includes('"content":');
}

/**
 * A stored payload without its `content`, or null when it holds none (or is not
 * a record). The rest of the record is kept as written.
 */
export function withoutStoredContent(raw: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Object.hasOwn(value, "content")) return null;
  const { content: _content, ...rest } = value;
  return JSON.stringify(rest);
}

/**
 * The record as the threads store hydrates it. Stored message text is handed
 * over only with `includeContent`; it is shown as last-known display state and
 * live data replaces it.
 */
export function toCachedEnvironmentShellSnapshot(
  record: StoredEnvironmentSnapshot,
  options: { readonly includeContent: boolean },
): CachedEnvironmentShellSnapshot {
  const { content } = record;
  return {
    capturedAt: record.capturedAt,
    projects: record.projects,
    worktrees: record.worktrees,
    threads:
      options.includeContent && content
        ? record.threads.map((thread) => {
            const threadContent = content[thread.shell.id];
            return threadContent ? { ...thread, content: threadContent } : thread;
          })
        : record.threads,
  };
}

/**
 * Compatibility projection from the existing v1 Mobile record to the shared
 * metadata-only domain. The SQLite payload stays byte-compatible in this wave.
 */
export function toWorkspaceMetadataSnapshot(
  record: StoredEnvironmentSnapshot,
): WorkspaceMetadataSnapshot {
  return {
    schemaVersion: WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
    environmentId: record.environmentId,
    capturedAt: record.capturedAt,
    projects: record.projects.map((project) => ({
      environmentId: project.environmentId,
      id: project.id,
      kind: projectKindOf(project),
      name: project.name,
      cwd: project.cwd,
      repositoryIdentity: project.repositoryIdentity ?? null,
      createdAt: project.createdAt ?? null,
      updatedAt: project.updatedAt ?? null,
    })),
    worktrees: record.worktrees.map((worktree) => ({
      environmentId: worktree.environmentId,
      id: worktree.id,
      projectId: worktree.projectId,
      title: worktree.title ?? null,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      workItemLabel: worktree.workItemKey ?? worktree.workItemTitle ?? null,
      pullRequestNumber: worktree.prNumber,
      archivedAt: worktree.archivedAt,
      updatedAt: worktree.updatedAt,
    })),
    threads: record.threads.map(({ shell, summary }) =>
      isArchivedThreadStub(shell)
        ? {
            environmentId: shell.environmentId,
            id: shell.id,
            projectId: shell.projectId,
            worktreeId: shell.worktreeId ? WorktreeId.make(shell.worktreeId) : null,
            title: shell.title,
            createdAt: shell.createdAt,
            updatedAt: shell.updatedAt,
            archivedAt: shell.archivedAt,
            // Unknown for a stub, and marked so (`shellDetail`) rather than read.
            modelSelection: null,
            providerDriver: null,
            branch: shell.branch,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
            deliveryUnknown: false,
            ...(isThreadLineage(shell.lineage) ? { lineage: shell.lineage } : {}),
            latestUserMessageAt: shell.latestUserMessageAt,
            shellDetail: "archived-stub" as const,
          }
        : toFullThreadMetadata(shell, summary),
    ),
  };
}

function toFullThreadMetadata(
  shell: Exclude<ThreadShellOrStub, ArchivedThreadStub>,
  storedSummary: SidebarThreadOrStub,
): WorkspaceThreadMetadata {
  // A full shell is always stored with its full summary (`isValidThread`).
  const summary = isArchivedThreadStub(storedSummary) ? null : storedSummary;
  return {
    environmentId: shell.environmentId,
    id: shell.id,
    projectId: shell.projectId,
    worktreeId: summary?.worktreeId ? WorktreeId.make(summary.worktreeId) : null,
    title: shell.title,
    createdAt: shell.createdAt,
    updatedAt: summary?.updatedAt ?? shell.updatedAt ?? null,
    archivedAt: shell.archivedAt,
    modelSelection: summary?.modelSelection ?? shell.modelSelection,
    providerDriver: summary?.providerDriver ?? null,
    branch: shell.branch,
    hasPendingApprovals: summary?.hasPendingApprovals ?? false,
    hasPendingUserInput: summary?.hasPendingUserInput ?? false,
    hasActionableProposedPlan: summary?.hasActionableProposedPlan ?? false,
    deliveryUnknown: false,
    // Stored shells come from storage: keep lineage only when well formed.
    ...(isThreadLineage(shell.lineage) ? { lineage: shell.lineage } : {}),
  };
}
