import type { EnvironmentId } from "@ryco/contracts";
import { WorktreeId } from "@ryco/contracts/worktree";
import { projectKindOf } from "@ryco/shared/projectKind";
import {
  captureThreadReadContent,
  decodeCachedEnvironmentContent,
  decodeThreadReadContent,
  isArchivedThreadStub,
  isThreadLineage,
  selectThreadsForContentCache,
  trimContentToBudget,
  type CachedThreadContent,
} from "@ryco/client-runtime/state/threads";
import {
  captureOpenPromptActivities,
  decodeOpenPromptActivities,
} from "@ryco/client-runtime/state/threads/threadBodyCache";
import {
  MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT,
  MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
  MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT,
  MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES,
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  type WorkspaceMetadataSnapshot,
  type WorkspaceThreadMetadata,
} from "@ryco/client-runtime/state/workspace";
import type { OrchestrationThreadActivity } from "@ryco/contracts";

import { payloadByteLength, payloadHash } from "./snapshotDb";
import type {
  ArchivedThreadStub,
  EnvironmentState,
  Project,
  SidebarThreadOrStub,
  SidebarWorktreeSummary,
  ThreadShellOrStub,
} from "../state/threadsRuntime";
import { isObjectLike, isRecord } from "@ryco/shared/unknownValue";

/**
 * The typed record layer over snapshotDb, with an explicit schemaVersion
 * literal so a downgraded client (or a record written by a future client)
 * fails to decode and is discarded instead of being mis-read as current.
 * Version history:
 *
 * v1 — initial: one row per machine with projects, worktrees, and thread
 *      shell/sidebar-summary pairs, with sessions and background liveness
 *      stripped at capture so a cached row can never claim live activity.
 * v2 — an archived thread the shell listed as a stub (`ArchivedThreadStub`)
 *      is stored as that stub in both halves.
 * v3 — an optional `content` map of bounded recent message text by thread id,
 *      kept for display only.
 * v4 — rows: an envelope per machine (projects, worktrees; its capture time is
 *      the row's `updated_at`), one row per thread (`{shell, summary}`, read at
 *      launch) and one body row per thread with saved text and open cards
 *      (read when the thread opens). v1 to v3 rows are read once and moved.
 */
export const ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION = 4;
/** Single-row record versions this client still moves into rows. */
const LEGACY_SCHEMA_VERSIONS: ReadonlySet<unknown> = new Set([1, 2, 3]);

export interface StoredEnvironmentSnapshotThread {
  /** An archived thread's stub is the same stub in both halves. */
  readonly shell: ThreadShellOrStub;
  readonly summary: SidebarThreadOrStub;
}

/** A machine's single-row record (v1 to v3), read once to move it into rows. */
export interface StoredEnvironmentSnapshot {
  readonly schemaVersion: 1 | 2 | 3;
  readonly environmentId: EnvironmentId;
  readonly capturedAt: number;
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly threads: ReadonlyArray<StoredEnvironmentSnapshotThread>;
  /** Recent message text by thread id (v3), for display only. */
  readonly content?: Readonly<Record<string, CachedThreadContent>>;
}

/** A machine's envelope row (v4): what its threads hang under. */
export interface StoredEnvironmentEnvelope {
  readonly schemaVersion: typeof ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION;
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
}

/**
 * One thread's saved body: its recent message text and the cards still open
 * when it was saved. Display only; never a replay baseline.
 */
export interface StoredThreadBody {
  readonly content: CachedThreadContent | null;
  readonly prompts: ReadonlyArray<OrchestrationThreadActivity>;
}

/**
 * Per-environment bounds, applied at capture. The total-across-environments
 * budget is enforced separately with the shared eviction policy
 * (`planEvictionsToCapacity`) over each machine's summed row sizes.
 */
export const MAX_SNAPSHOT_THREADS_PER_ENVIRONMENT = MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT;
export const MAX_SNAPSHOT_PAYLOAD_BYTES_PER_ENVIRONMENT =
  MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT;
/**
 * The bodies one machine may keep: an equal share of the total cache budget.
 * Without it a machine could fill its whole cap with text, and the least
 * recently written machines would be evicted whole (threads included) to make
 * room. The machine's own cap still bounds threads and bodies together, and
 * bodies are trimmed first.
 */
export const MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT = Math.floor(
  MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES / MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
);

/** Per-environment bounds a capture is held to. */
export interface EnvironmentSnapshotCaps {
  readonly maxThreads: number;
  /** Envelope, thread rows and bodies together. */
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

/** One stored row as a capture hands it to the database. */
export interface EnvironmentRowFragment {
  readonly threadId: string;
  readonly payload: string;
  /** UTF-8 length of `payload`. */
  readonly bytes: number;
  readonly hash: number;
}

export interface EnvironmentBodyFragment extends EnvironmentRowFragment {
  /** The thread window's sequence when the body was saved, or null. */
  readonly sequence: number | null;
}

/** One machine's rows as a capture produced them, within its bounds. */
export interface EnvironmentRows {
  readonly envelope: { readonly payload: string; readonly bytes: number };
  /** Kept threads in store order. */
  readonly threads: ReadonlyArray<EnvironmentRowFragment>;
  /** Kept bodies, least recently active first. */
  readonly bodies: ReadonlyArray<EnvironmentBodyFragment>;
  readonly projectCount: number;
  /** Envelope, threads and bodies together. */
  readonly bytes: number;
}

function envelopeOf(
  environmentState: Pick<
    EnvironmentState,
    "projectIds" | "projectById" | "worktreeIds" | "worktreeById"
  >,
  environmentId: EnvironmentId,
): StoredEnvironmentEnvelope {
  return {
    schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    projects: environmentState.projectIds.flatMap((projectId) => {
      const project = environmentState.projectById[projectId];
      return project ? [project] : [];
    }),
    worktrees: (environmentState.worktreeIds ?? []).flatMap((worktreeId) => {
      const worktree = environmentState.worktreeById?.[worktreeId];
      return worktree ? [worktree] : [];
    }),
  };
}

function rowFragment(threadId: string, payload: string): EnvironmentRowFragment {
  return { threadId, payload, bytes: payloadByteLength(payload), hash: payloadHash(payload) };
}

function threadPayload(thread: StoredEnvironmentSnapshotThread): string {
  return JSON.stringify({ shell: thread.shell, summary: withoutLiveState(thread.summary) });
}

/** A body's stored form, or null when it holds nothing to show. */
export function encodeStoredThreadBody(body: StoredThreadBody): string | null {
  const messages = body.content?.messages ?? [];
  if (messages.length === 0 && body.prompts.length === 0) return null;
  return JSON.stringify(
    body.prompts.length === 0 ? { messages } : { messages, prompts: body.prompts },
  );
}

/** A stored body as this build reads it, or null when it does not decode. */
export function decodeStoredThreadBody(raw: string): StoredThreadBody | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const decoded = decodeThreadReadContent({ messages: value.messages ?? [] });
  const content = decoded !== null && decoded.messages.length > 0 ? decoded : null;
  const prompts = decodeOpenPromptActivities(value.prompts);
  // Nothing to show is no body.
  return content === null && prompts.length === 0 ? null : { content, prompts };
}

/**
 * The bodies a machine keeps: those of threads it keeps, dropping the least
 * recently active while they would exceed their own cap or the machine would
 * exceed its cap. Bodies are trimmed after the threads have been bounded, so
 * they never cost the machine a thread.
 */
function keepBodiesWithinBudget<T extends { readonly bytes: number }>(
  bodies: ReadonlyArray<T>,
  shellBytes: number,
  caps: EnvironmentSnapshotCaps,
): T[] {
  return trimContentToBudget({
    bodyBytes: shellBytes,
    entries: bodies.map((body) => ({ body, entryBytes: body.bytes })),
    budgetBytes: Math.min(
      caps.maxPayloadBytes,
      shellBytes + (caps.maxContentBytes ?? MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT),
    ),
  }).map((entry) => entry.body);
}

interface SerializedThreadFragment extends EnvironmentRowFragment {
  /** The store objects the fragment was serialized from. */
  readonly shell: ThreadShellOrStub;
  readonly summary: SidebarThreadOrStub;
}

interface SerializedBodyFragment {
  readonly messageIds: unknown;
  readonly messages: unknown;
  readonly activityIds: unknown;
  readonly activities: unknown;
  /** Null when the thread holds nothing to save. */
  readonly row: EnvironmentRowFragment | null;
}

export interface EnvironmentRowSerializer {
  /**
   * One machine's rows within its bounds. Only threads whose shell or summary
   * changed since the previous call are serialized again, and only bodies whose
   * messages or activities changed are captured again. With `options.content`
   * bodies are kept (recent text and open cards), each with the sequence
   * `options.readSequence` reports for it.
   */
  readonly serialize: (
    environmentState: EnvironmentState,
    environmentId: EnvironmentId,
    options?: {
      readonly content?: boolean;
      readonly readSequence?: (threadId: string) => number | null;
    },
  ) => EnvironmentRows;
  /** Threads serialized from scratch over this serializer's lifetime (tests). */
  readonly serializedThreadCount: () => number;
  /** Bodies captured from scratch over this serializer's lifetime (tests). */
  readonly serializedBodyCount: () => number;
}

/**
 * Incremental serializer for one machine's rows. While an agent runs, the
 * shell stream replaces the active thread's shell and summary several times a
 * second; each thread's row is kept by identity of its store objects, so a
 * capture serializes and measures only rows that changed, and the byte cap is
 * enforced on the summed row lengths. Bodies are incremental the same way.
 */
export function createEnvironmentRowSerializer(
  caps: EnvironmentSnapshotCaps = DEFAULT_SNAPSHOT_CAPS,
): EnvironmentRowSerializer {
  let fragments = new Map<string, SerializedThreadFragment>();
  let bodyFragments = new Map<string, SerializedBodyFragment>();
  let envelope: { readonly source: StoredEnvironmentEnvelope; readonly json: string } | null = null;
  let serializedThreads = 0;
  let serializedBodies = 0;

  const fragmentFor = (shell: ThreadShellOrStub, summary: SidebarThreadOrStub) => {
    const cached = fragments.get(shell.id);
    if (cached !== undefined && cached.shell === shell && cached.summary === summary) {
      return cached;
    }
    serializedThreads += 1;
    return { ...rowFragment(shell.id, threadPayload({ shell, summary })), shell, summary };
  };

  const bodyFor = (environmentState: EnvironmentState, threadId: string) => {
    const id = threadId as keyof EnvironmentState["messageByThreadId"];
    const messageIds = environmentState.messageIdsByThreadId[id];
    const messages = environmentState.messageByThreadId[id];
    const activityIds = environmentState.activityIdsByThreadId[id];
    const activities = environmentState.activityByThreadId[id];
    const cached = bodyFragments.get(threadId);
    if (
      cached !== undefined &&
      cached.messageIds === messageIds &&
      cached.messages === messages &&
      cached.activityIds === activityIds &&
      cached.activities === activities
    ) {
      return cached;
    }
    serializedBodies += 1;
    const payload = encodeStoredThreadBody({
      content: captureThreadReadContent(
        (messageIds ?? []).flatMap((messageId) => messages?.[messageId] ?? []),
      ),
      prompts: captureOpenPromptActivities(
        (activityIds ?? []).flatMap((activityId) => activities?.[activityId] ?? []),
      ),
    });
    return {
      messageIds,
      messages,
      activityIds,
      activities,
      row: payload === null ? null : rowFragment(threadId, payload),
    };
  };

  const serialize: EnvironmentRowSerializer["serialize"] = (
    environmentState,
    environmentId,
    options,
  ) => {
    const nextEnvelope = envelopeOf(environmentState, environmentId);
    if (
      envelope === null ||
      envelope.source.projects.length !== nextEnvelope.projects.length ||
      envelope.source.worktrees.length !== nextEnvelope.worktrees.length ||
      envelope.source.projects.some((project, index) => project !== nextEnvelope.projects[index]) ||
      envelope.source.worktrees.some(
        (worktree, index) => worktree !== nextEnvelope.worktrees[index],
      )
    ) {
      envelope = { source: nextEnvelope, json: JSON.stringify(nextEnvelope) };
    }
    const envelopeBytes = payloadByteLength(envelope.json);

    const candidates: StoredEnvironmentSnapshotThread[] = [];
    for (const threadId of environmentState.threadIds) {
      const shell = environmentState.threadShellById[threadId];
      const summary = environmentState.sidebarThreadSummaryById[threadId];
      if (!shell || !summary) continue;
      candidates.push({ shell, summary });
    }
    // The count cap needs only archive state and recency, so it runs before
    // anything is serialized: threads beyond it are neither stringified nor
    // retained.
    const nextFragments = new Map<string, SerializedThreadFragment>();
    let kept: SerializedThreadFragment[] = [];
    for (const { shell, summary } of boundThreadCount(candidates, caps.maxThreads)) {
      const fragment = fragmentFor(shell, summary);
      nextFragments.set(shell.id, fragment);
      kept.push(fragment);
    }
    fragments = nextFragments;
    const shellBytesOf = (threads: ReadonlyArray<SerializedThreadFragment>) => {
      let bytes = envelopeBytes;
      for (const fragment of threads) bytes += fragment.bytes;
      return bytes;
    };
    let shellBytes = shellBytesOf(kept);
    while (shellBytes > caps.maxPayloadBytes && kept.length > 0) {
      kept = dropByteCapRound(kept);
      shellBytes = shellBytesOf(kept);
    }

    let bodies: EnvironmentBodyFragment[] = [];
    if (options?.content) {
      const keptIds = new Set(kept.map((fragment) => fragment.shell.id as string));
      const selected = selectThreadsForContentCache({
        threadIds: environmentState.threadIds.filter((threadId) => keptIds.has(threadId)),
        hasMessages: (threadId) =>
          (environmentState.messageIdsByThreadId[threadId]?.length ?? 0) > 0,
        routedThreadId: null,
        lastVisitedAt: (threadId) => {
          const summary = environmentState.sidebarThreadSummaryById[threadId];
          return summary ? threadActivityAt(summary) : null;
        },
      });
      const nextBodies = new Map<string, SerializedBodyFragment>();
      const rows: EnvironmentRowFragment[] = [];
      for (const threadId of selected) {
        const body = bodyFor(environmentState, threadId);
        nextBodies.set(threadId, body);
        if (body.row !== null) rows.push(body.row);
      }
      bodyFragments = nextBodies;
      bodies = keepBodiesWithinBudget(rows, shellBytes, caps).map((row) => ({
        threadId: row.threadId,
        payload: row.payload,
        bytes: row.bytes,
        hash: row.hash,
        sequence: options.readSequence?.(row.threadId) ?? null,
      }));
    } else {
      // Nothing is kept while the setting is off, in memory either.
      bodyFragments = new Map();
    }
    let bytes = shellBytes;
    for (const body of bodies) bytes += body.bytes;
    return {
      envelope: { payload: envelope.json, bytes: envelopeBytes },
      threads: kept,
      bodies,
      projectCount: nextEnvelope.projects.length,
      bytes,
    };
  };

  return {
    serialize,
    serializedThreadCount: () => serializedThreads,
    serializedBodyCount: () => serializedBodies,
  };
}

/**
 * A single-row record (v1 to v3) as rows, for the one-time move to the row
 * layout. The record was bounded when it was written; its text becomes bodies.
 */
export function environmentRowsFromLegacyRecord(
  record: StoredEnvironmentSnapshot,
): EnvironmentRows {
  const envelope = JSON.stringify({
    schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
    environmentId: record.environmentId,
    projects: record.projects,
    worktrees: record.worktrees,
  } satisfies StoredEnvironmentEnvelope);
  const envelopeBytes = payloadByteLength(envelope);
  const threads = record.threads.map((thread) =>
    rowFragment(thread.shell.id, threadPayload(thread)),
  );
  const bodies = Object.entries(record.content ?? {}).flatMap(([threadId, content]) => {
    const payload = encodeStoredThreadBody({ content, prompts: [] });
    return payload === null ? [] : [{ ...rowFragment(threadId, payload), sequence: null }];
  });
  let bytes = envelopeBytes;
  for (const row of [...threads, ...bodies]) bytes += row.bytes;
  return {
    envelope: { payload: envelope, bytes: envelopeBytes },
    threads,
    bodies,
    projectCount: record.projects.length,
    bytes,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidProject(value: unknown, environmentId: string): boolean {
  return (
    isObjectLike(value) &&
    isNonEmptyString(value.id) &&
    value.environmentId === environmentId &&
    typeof value.name === "string" &&
    typeof value.cwd === "string"
  );
}

function isValidWorktree(value: unknown, environmentId: string): boolean {
  return (
    isObjectLike(value) &&
    isNonEmptyString(value.id) &&
    value.environmentId === environmentId &&
    isNonEmptyString(value.projectId)
  );
}

function isValidThread(value: unknown, environmentId: string, mayHoldStubs: boolean): boolean {
  if (!isObjectLike(value) || !isObjectLike(value.shell) || !isObjectLike(value.summary))
    return false;
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
 * Strict decode of a single-row record (v1 to v3): version literal, embedded
 * identity, and per-row identity checks. Any mismatch makes the whole record
 * invalid; the caller deletes the row and treats it as a cache miss.
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
  if (!isObjectLike(value)) return null;
  if (!LEGACY_SCHEMA_VERSIONS.has(value.schemaVersion)) return null;
  const current = value.schemaVersion === 3;
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

/** A machine's envelope row as this build reads it, or null (discard the machine's rows). */
export function decodeStoredEnvironmentEnvelope(
  raw: string,
  environmentId: EnvironmentId,
): StoredEnvironmentEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObjectLike(value)) return null;
  if (value.schemaVersion !== ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION) return null;
  if (value.environmentId !== environmentId) return null;
  const { projects, worktrees } = value;
  if (!Array.isArray(projects) || !Array.isArray(worktrees)) return null;
  if (!projects.every((project) => isValidProject(project, environmentId))) return null;
  if (!worktrees.every((worktree) => isValidWorktree(worktree, environmentId))) return null;
  return value as unknown as StoredEnvironmentEnvelope;
}

/** One thread row as this build reads it, or null (that thread is left out). */
export function decodeStoredEnvironmentThread(
  raw: string,
  environmentId: EnvironmentId,
): StoredEnvironmentSnapshotThread | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return isValidThread(value, environmentId, true)
    ? (value as unknown as StoredEnvironmentSnapshotThread)
    : null;
}

/**
 * Compatibility projection from a single-row Mobile record to the shared
 * metadata-only domain.
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
