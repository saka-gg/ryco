import { create } from "zustand";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProjectId,
  ThreadId,
  type AgentTokenMode,
  type EnvironmentApi,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ServerConfig,
  type ComposerSourceControlContext,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { prefixWorktreeBranch } from "@ryco/shared/git";
import type { EnvironmentConnection } from "../../connection/connection.ts";
import { captureReviewedSendReadiness } from "./sendReadiness.ts";
import type { KVService } from "../../platform/index.ts";
import { deriveProviderInstanceEntries } from "./providerInstances.ts";
import { getComposerProviderState } from "./providerState.ts";
import { normalizeInteractionModeForProviderTarget } from "./providerSelectionPolicy.ts";
import {
  buildSendTurnBootstrap,
  commitSendTurnDispatch,
  type SendTurnDispatchAttachment,
} from "./sendEngine.ts";

export const BATCH_LAUNCH_MAX_TARGETS = 4;
export const BATCH_LAUNCH_CONCURRENCY = 2;
export const BATCH_LAUNCH_MAX_HISTORY = 128;
export const BATCH_LAUNCH_MAX_LEDGER_BYTES = 256 * 1024;
const STORAGE_KEY = "ryco:batch-launches:v1";
const Destination = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: ModelSelection,
  label: Schema.String,
  status: Schema.Literals([
    "queued",
    "preparing",
    "dispatching",
    "launched",
    "failed",
    "uncertain",
    "cancelled",
  ]),
  error: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
});
const Batch = Schema.Struct({
  id: Schema.String,
  ownerKey: Schema.String,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  createdAt: Schema.String,
  cancelled: Schema.Boolean,
  destinations: Schema.Array(Destination),
});
const Ledger = Schema.Struct({ version: Schema.Literal(1), batches: Schema.Array(Batch) });
export type BatchLaunchDestination = typeof Destination.Type;
export type BatchLaunch = typeof Batch.Type;

export function batchSelectionKey(selection: ModelSelection): string {
  return JSON.stringify([
    selection.instanceId,
    selection.model,
    (selection.options ?? []).toSorted((a, b) => a.id.localeCompare(b.id)),
  ]);
}

/** Exact identity: never fall back to another provider or model for a batch target. */
export function normalizeBatchSelection(
  selection: ModelSelection,
  providers: readonly ServerProvider[],
  prompt: string,
) {
  const entry = deriveProviderInstanceEntries(providers).find(
    (entry) => entry.instanceId === selection.instanceId,
  );
  if (
    !entry?.enabled ||
    !entry.installed ||
    !entry.isAvailable ||
    entry.status !== "ready" ||
    entry.snapshot.auth.status === "unauthenticated" ||
    !entry.models.some((model) => model.slug === selection.model)
  ) {
    throw new Error(`Provider/model unavailable: ${selection.instanceId} / ${selection.model}`);
  }
  const state = getComposerProviderState({
    provider: entry.driverKind,
    model: selection.model,
    models: entry.models,
    prompt,
    modelOptions: selection.options,
  });
  return {
    selection: createModelSelection(
      entry.instanceId,
      selection.model,
      state.modelOptionsForDispatch,
    ),
    entry,
  };
}

export function createBatchLaunch(input: {
  id: string;
  ownerKey: string;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  selections: readonly ModelSelection[];
  providers: readonly ServerProvider[];
  prompt: string;
  isGitRepo: boolean;
  baseBranch: string | null;
  createdAt: string;
}): BatchLaunch {
  if (!input.isGitRepo || !input.baseBranch)
    throw new Error("Batch launch requires a Git project with a base branch.");
  const seen = new Set<string>();
  const destinations = input.selections.map((raw, index): BatchLaunchDestination => {
    const { selection, entry } = normalizeBatchSelection(raw, input.providers, input.prompt);
    const key = batchSelectionKey(selection);
    if (seen.has(key)) throw new Error("Each batch selection must be unique.");
    seen.add(key);
    return {
      threadId: ThreadId.make(`batch-${input.id}-${index}`),
      messageId: MessageId.make(`batch-${input.id}-${index}`),
      modelSelection: selection,
      label: `${entry.displayName} · ${entry.models.find((model) => model.slug === selection.model)?.name ?? selection.model}`,
      status: "queued",
      error: null,
      attempts: 0,
    };
  });
  if (destinations.length < 2 || destinations.length > BATCH_LAUNCH_MAX_TARGETS) {
    throw new Error(`Choose between 2 and ${BATCH_LAUNCH_MAX_TARGETS} selections.`);
  }
  return {
    id: input.id,
    ownerKey: input.ownerKey,
    environmentId: input.environmentId,
    projectId: input.projectId,
    createdAt: input.createdAt,
    cancelled: false,
    destinations,
  };
}

export function captureBatchLaunchReadiness(
  environmentId: EnvironmentId,
  readConnection: () => EnvironmentConnection | null,
) {
  return captureReviewedSendReadiness(
    environmentId,
    readConnection,
    "The connection changed while preparing this comparison. Reconnect and retry safe failures; your draft is retained.",
  );
}

export interface BatchLaunchPorts {
  /** Must capture and recheck the authoritative connection/shell generation and node. */
  assertMutationReady(): void;
  /** An explicit safe retry may capture a NEW live generation; never repin within a run. */
  captureMutationReadiness?: () => () => void;
  prepare(
    destination: BatchLaunchDestination,
    signal: AbortSignal,
    assertMutationReady: () => void,
  ): Promise<() => Promise<void>>;
}
export interface BatchLaunchState {
  batches: readonly BatchLaunch[];
  hydrated: boolean;
  storageError: string | null;
}

/**
 * A write-ahead launch ledger. Only failures before dispatch are retryable. A
 * transport error is uncertain even if its text says "failed": it cannot prove
 * no worktree/turn was accepted. Reload never replays a destination. Metadata
 * is persisted; prompts, upload tokens, and attachment bytes remain in drafts.
 */
export interface BatchLaunchLock {
  exclusive<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

/** Native has one JS owner. Web must inject a cross-tab lock, not this adapter. */
const nativeLocks = new WeakMap<KVService, BatchLaunchLock>();
export function inProcessBatchLaunchLock(storage: KVService): BatchLaunchLock {
  const existing = nativeLocks.get(storage);
  if (existing) return existing;
  const tails = new Map<string, Promise<unknown>>();
  const lock: BatchLaunchLock = {
    exclusive: async (name, operation) => {
      const previous = tails.get(name) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(operation);
      tails.set(name, next);
      try {
        return await next;
      } finally {
        if (tails.get(name) === next) tails.delete(name);
      }
    },
  };
  nativeLocks.set(storage, lock);
  return lock;
}

export function createBatchLaunchStore(
  storage: KVService,
  lock = inProcessBatchLaunchLock(storage),
) {
  const useStore = create<BatchLaunchState>(() => ({
    batches: [],
    hydrated: false,
    storageError: null,
  }));
  const running = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  let nextSlot = 0;
  const readLedger = async (): Promise<readonly BatchLaunch[]> => {
    const raw = await storage.getItem(STORAGE_KEY);
    if (raw && new TextEncoder().encode(raw).byteLength > BATCH_LAUNCH_MAX_LEDGER_BYTES)
      throw new Error("Oversized ledger");
    const ledger = raw ? Schema.decodeUnknownSync(Ledger)(JSON.parse(raw)) : { batches: [] };
    if (
      ledger.batches.length > BATCH_LAUNCH_MAX_HISTORY ||
      ledger.batches.some(
        (batch) =>
          batch.destinations.length < 2 || batch.destinations.length > BATCH_LAUNCH_MAX_TARGETS,
      )
    )
      throw new Error("Invalid ledger bounds");
    return ledger.batches;
  };
  const publish = (batches: readonly BatchLaunch[]) =>
    useStore.setState({
      hydrated: true,
      batches: batches.map((batch) => ({
        ...batch,
        destinations: batch.destinations.map((target) => ({
          ...target,
          // Another owner may still finish this attempt. Never turn its fence into a safe retry.
          status:
            (target.status === "dispatching" || target.status === "preparing") &&
            !controllers.has(target.threadId)
              ? ("uncertain" as const)
              : target.status,
        })),
      })),
    });
  const refresh = async () => {
    try {
      await lock.exclusive(STORAGE_KEY, async () => publish(await readLedger()));
    } catch {
      useStore.setState({
        hydrated: true,
        storageError:
          "Launch history is unavailable. Batch launch is blocked to prevent duplicates.",
      });
    }
  };
  const ready = refresh();
  // Every mutation reads durable history under the SAME cross-context lock. Stale
  // hydrated snapshots never overwrite another tab's accepted history or source claim.
  const transact = async <T>(
    change: (batches: readonly BatchLaunch[]) => { batches: readonly BatchLaunch[]; result: T },
  ) => {
    await ready;
    if (useStore.getState().storageError) throw new Error(useStore.getState().storageError!);
    return lock.exclusive(STORAGE_KEY, async () => {
      try {
        const { batches, result } = change(await readLedger());
        const value = JSON.stringify({ version: 1, batches });
        if (new TextEncoder().encode(value).byteLength > BATCH_LAUNCH_MAX_LEDGER_BYTES)
          throw new Error("Launch history exceeds its storage limit.");
        await storage.setItem(STORAGE_KEY, value);
        publish(batches);
        return result;
      } catch (error) {
        // Input rejection leaves storage healthy; durable read/write failure fences launches.
        if (!(error instanceof BatchInputError))
          useStore.setState({
            storageError: "Launch history could not be saved. Reload once storage is available.",
          });
        throw error;
      }
    });
  };
  const mutate = async (id: string, change: (batch: BatchLaunch) => BatchLaunch) =>
    transact((batches) => ({
      batches: batches.map((batch) => (batch.id === id ? change(batch) : batch)),
      result: undefined,
    }));
  const patch = (id: string, threadId: ThreadId, value: Partial<BatchLaunchDestination>) =>
    mutate(id, (batch) => ({
      ...batch,
      destinations: batch.destinations.map((target) =>
        target.threadId === threadId &&
        (target.status !== "launched" || value.status === "launched")
          ? { ...target, ...value }
          : target,
      ),
    }));
  const add = (batch: BatchLaunch) =>
    transact((batches) => {
      const existing = batches.find(
        (item) =>
          item.id === batch.id ||
          (item.ownerKey === batch.ownerKey && item.environmentId === batch.environmentId),
      );
      if (existing && existing.ownerKey === `completed:${existing.id}`)
        throw new BatchInputError("This comparison is complete. Start with a fresh source draft.");
      if (existing) return { batches, result: existing };
      const next = [...batches, batch];
      const unresolved = next
        .flatMap((item) => item.destinations)
        .filter((target) => !["launched", "cancelled"].includes(target.status)).length;
      // Completed markers fence stale source drafts after interrupted cleanup.
      // Refuse overflow; eviction would require durable source retirement first.
      if (
        next.length > BATCH_LAUNCH_MAX_HISTORY ||
        new TextEncoder().encode(JSON.stringify({ version: 1, batches: next })).byteLength +
          unresolved * 8192 >
          BATCH_LAUNCH_MAX_LEDGER_BYTES
      )
        throw new BatchInputError(
          "Batch launch history is full. Existing results remain available.",
        );
      return { batches: next, result: batch };
    });
  const run = (id: string, ports: BatchLaunchPorts): Promise<void> => {
    const active = running.get(id);
    if (active) return active;
    const result = (async () => {
      await ready;
      await refresh();
      const batch = useStore.getState().batches.find((item) => item.id === id);
      if (!batch || batch.cancelled || useStore.getState().storageError) return;
      // The explicit run/retry pins one current authority generation for its entire lifetime.
      const assertMutationReady = ports.captureMutationReadiness?.() ?? ports.assertMutationReady;
      await Promise.all(
        batch.destinations
          .filter((target) => target.status === "queued" || target.status === "failed")
          .map((target) =>
            lock.exclusive(`${STORAGE_KEY}:slot:${nextSlot++ % BATCH_LAUNCH_CONCURRENCY}`, () =>
              lock.exclusive(`${STORAGE_KEY}:target:${target.threadId}`, async () => {
                const controller = new AbortController();
                controllers.set(target.threadId, controller);
                let crossedDispatchBoundary = false;
                let claimed = false;
                try {
                  const current = await transact((batches) => {
                    const source = batches.find((item) => item.id === id);
                    const destination = source?.destinations.find(
                      (item) => item.threadId === target.threadId,
                    );
                    if (
                      !source ||
                      source.cancelled ||
                      !destination ||
                      !["queued", "failed"].includes(destination.status)
                    )
                      return { batches, result: null };
                    const prepared = {
                      ...destination,
                      status: "preparing" as const,
                      error: null,
                      attempts: destination.attempts + 1,
                    };
                    return {
                      batches: batches.map((item) =>
                        item.id !== id
                          ? item
                          : {
                              ...item,
                              destinations: item.destinations.map((dest) =>
                                dest.threadId === target.threadId ? prepared : dest,
                              ),
                            },
                      ),
                      result: prepared,
                    };
                  });
                  if (!current) return;
                  claimed = true;
                  assertMutationReady();
                  const dispatch = await ports.prepare(
                    current,
                    controller.signal,
                    assertMutationReady,
                  );
                  assertMutationReady();
                  const allowed = await transact((batches) => {
                    const source = batches.find((item) => item.id === id);
                    const destination = source?.destinations.find(
                      (item) => item.threadId === target.threadId,
                    );
                    if (
                      controller.signal.aborted ||
                      source?.cancelled ||
                      destination?.status !== "preparing"
                    )
                      return { batches, result: false };
                    return {
                      batches: batches.map((item) =>
                        item.id !== id
                          ? item
                          : {
                              ...item,
                              destinations: item.destinations.map((dest) =>
                                dest.threadId === target.threadId
                                  ? { ...dest, status: "dispatching" as const }
                                  : dest,
                              ),
                            },
                      ),
                      result: true,
                    };
                  });
                  if (!allowed) return;
                  if (controller.signal.aborted) {
                    await patch(id, target.threadId, { status: "cancelled" });
                    return;
                  }
                  assertMutationReady();
                  crossedDispatchBoundary = true;
                  await dispatch();
                  await patch(id, target.threadId, { status: "launched", error: null });
                } catch (error) {
                  if (claimed)
                    await mutate(id, (batch) => ({
                      ...batch,
                      destinations: batch.destinations.map((dest) =>
                        dest.threadId !== target.threadId || dest.status === "launched"
                          ? dest
                          : {
                              ...dest,
                              status: crossedDispatchBoundary
                                ? "uncertain"
                                : batch.cancelled || controller.signal.aborted
                                  ? "cancelled"
                                  : "failed",
                              error:
                                error instanceof Error
                                  ? error.message.slice(0, 1000)
                                  : "Launch failed.",
                            },
                      ),
                    })).catch(() => {});
                } finally {
                  controllers.delete(target.threadId);
                  if (useStore.getState().storageError) await refresh();
                }
              }),
            ),
          ),
      );
    })().finally(() => running.delete(id));
    running.set(id, result);
    return result;
  };
  const cancel = (id: string) =>
    mutate(id, (batch) => ({
      ...batch,
      cancelled: true,
      destinations: batch.destinations.map((target) => {
        controllers.get(target.threadId)?.abort();
        return ["queued", "failed", "preparing"].includes(target.status)
          ? { ...target, status: "cancelled" as const }
          : target;
      }),
    }));
  const reconcile = (
    id: string,
    evidence: readonly { threadId: ThreadId; messageId: MessageId; worktreePath: string | null }[],
  ) =>
    mutate(id, (batch) => ({
      ...batch,
      destinations: batch.destinations.map((target) =>
        ["uncertain", "dispatching"].includes(target.status) &&
        evidence.some(
          (item) =>
            item.threadId === target.threadId &&
            item.messageId === target.messageId &&
            item.worktreePath !== null,
        )
          ? { ...target, status: "launched" as const, error: null }
          : target,
      ),
    }));
  const isTerminal = (batch: BatchLaunch) =>
    batch.destinations.every((target) => ["launched", "cancelled"].includes(target.status));
  const releaseSource = (id: string) =>
    transact((batches) => {
      const batch = batches.find((item) => item.id === id);
      const released = !!batch && isTerminal(batch);
      return {
        batches: batches.map((item) =>
          item.id === id && released ? { ...item, ownerKey: `completed:${item.id}` } : item,
        ),
        result: released,
      };
    });
  // Read the durable marker, not a component's hydrated snapshot. Draft cleanup
  // can fail or be interrupted after release; that must never revive accepted IDs.
  const isSourceReleased = async (source: {
    id: string;
    environmentId: EnvironmentId;
    projectId: ProjectId;
  }) => {
    await ready;
    if (useStore.getState().storageError) throw new Error(useStore.getState().storageError!);
    return lock.exclusive(STORAGE_KEY, async () =>
      (await readLedger()).some(
        (batch) =>
          batch.id === source.id &&
          batch.environmentId === source.environmentId &&
          batch.projectId === source.projectId &&
          batch.ownerKey === `completed:${batch.id}` &&
          isTerminal(batch),
      ),
    );
  };
  return { useStore, ready, refresh, add, run, cancel, reconcile, releaseSource, isSourceReleased };
}
class BatchInputError extends Error {}

/** Exact anchored history lookup, independent of how many assistant responses followed the prompt. */
export async function readBatchResultEvidence(input: {
  api: EnvironmentApi;
  batch: BatchLaunch;
  destination: BatchLaunchDestination;
  assertMutationReady: () => void;
}) {
  const { api, batch, destination, assertMutationReady } = input;
  assertMutationReady();
  if (!api.orchestration.getThreadWindow || !api.orchestration.getThreadHistoryPage)
    throw new Error("Authoritative thread history unavailable.");
  const snapshot = await api.orchestration.getThreadWindow({
    threadId: destination.threadId,
    limits: { messages: 1, activities: 40, checkpoints: 1, proposedPlans: 1 },
  });
  assertMutationReady();
  const evidence = deriveBatchResultEvidence(batch, destination, snapshot.thread);
  if (!evidence || evidence.accepted) return evidence;
  const history = await api.orchestration.getThreadHistoryPage({
    threadId: destination.threadId,
    collection: "messages",
    mode: { kind: "around", anchorId: destination.messageId },
    limit: 1,
  });
  assertMutationReady();
  return {
    ...evidence,
    accepted:
      history.collection === "messages" &&
      history.items.some(
        (message) => message.id === destination.messageId && message.role === "user",
      ),
  };
}

/** Normal bootstrap and send path, shared by web/desktop/native. No setup logic here. */
export async function prepareBatchDestination(input: {
  api: EnvironmentApi;
  batch: BatchLaunch;
  destination: BatchLaunchDestination;
  providers: readonly ServerProvider[];
  prompt: string;
  projectCwd: string;
  baseBranch: string;
  fetchOrigin?: boolean;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  tokenMode: AgentTokenMode;
  sourceControlContexts: readonly ComposerSourceControlContext[];
  attachments: readonly SendTurnDispatchAttachment[];
  assertMutationReady: () => void;
  /** Integration seam for readEffectiveProjectPreferences; no duplicated resolver. */
  readProjectPreferences?: (input: {
    api: EnvironmentApi;
    config: ServerConfig;
    projectId: ProjectId;
  }) => Promise<{
    worktreeBranchPrefix: { value: string };
    runSetupScript: { value: boolean };
  } | null>;
}): Promise<() => Promise<void>> {
  input.assertMutationReady();
  if (!input.api.server?.getConfig) throw new Error("Node settings unavailable.");
  const config = await input.api.server.getConfig();
  input.assertMutationReady();
  if (config.environment.capabilities.requiredWorktreeBootstrap !== true)
    throw new Error(
      "This node does not support required-worktree batch launches. Update the node before retrying.",
    );
  if (config.environment.environmentId !== input.batch.environmentId)
    throw new Error("The batch target node changed.");
  const { selection, entry } = normalizeBatchSelection(
    input.destination.modelSelection,
    config.providers,
    input.prompt,
  );
  if (batchSelectionKey(selection) !== batchSelectionKey(input.destination.modelSelection))
    throw new Error("Model capabilities changed. The original selection is retained.");
  input.assertMutationReady();
  if (
    "projectPreferences" in config.environment.capabilities &&
    config.environment.capabilities.projectPreferences === true &&
    !input.readProjectPreferences
  )
    throw new Error(
      "Project preferences resolver is unavailable. Launch is blocked until integration is ready.",
    );
  const preferences = await input.readProjectPreferences?.({
    api: input.api,
    config,
    projectId: input.batch.projectId,
  });
  if (
    "projectPreferences" in config.environment.capabilities &&
    config.environment.capabilities.projectPreferences === true &&
    !preferences
  )
    throw new Error("The capable node did not return effective project preferences.");
  input.assertMutationReady();
  const interactionMode =
    entry.snapshot.showInteractionModeToggle === false
      ? "default"
      : normalizeInteractionModeForProviderTarget(
          input.interactionMode,
          entry.snapshot.supportsAskMode ?? false,
        );
  const title = input.prompt.trim().slice(0, 120) || "Compare models";
  const bootstrap = buildSendTurnBootstrap({
    requireWorktree: true,
    isLocalDraftThread: true,
    projectId: input.batch.projectId,
    runSetupScript: preferences?.runSetupScript.value ?? true,
    projectCwd: input.projectCwd,
    title,
    threadCreateModelSelection: selection,
    runtimeMode: input.runtimeMode,
    interactionMode,
    tokenMode: input.tokenMode,
    baseBranchForWorktree: input.baseBranch,
    fetchOrigin: input.fetchOrigin,
    worktreeBranchName: prefixWorktreeBranch(
      `batch-${input.batch.id}-${input.destination.threadId.split("-").at(-1)}`,
      preferences?.worktreeBranchPrefix.value ?? config.settings.worktreeBranchPrefix,
    ),
    shouldMaterializeLegacyBranchWorktree: false,
    activeThreadBranch: null,
    worktreePath: null,
    threadCreatedAt: input.batch.createdAt,
  });
  return () => {
    input.assertMutationReady();
    return commitSendTurnDispatch({
      api: input.api,
      threadId: input.destination.threadId,
      messageId: input.destination.messageId,
      isFirstMessage: true,
      isServerThread: false,
      title,
      outgoingMessageText: input.prompt,
      turnAttachments: input.attachments,
      modelSelection: selection,
      runtimeMode: input.runtimeMode,
      interactionMode,
      tokenMode: input.tokenMode,
      bootstrap,
      sourceControlContexts: input.sourceControlContexts,
      // Only the optional first-message title command uses this port. Batch
      // destinations are new threads, so that branch is currently unreachable.
      createdAt: input.batch.createdAt,
      newCommandId: () => CommandId.make(`batch:${input.destination.threadId}:title`),
      beginLocalDispatch: () => {},
      persistThreadSettingsForNextTurn: async () => {},
      assertMutationReady: input.assertMutationReady,
    });
  };
}

/** Evidence is bounded, attributed to the exact node/project/thread, and never implies tests passed. */
export function deriveBatchResultEvidence(
  batch: BatchLaunch,
  target: BatchLaunchDestination,
  thread: import("@ryco/contracts").OrchestrationThread,
) {
  if (
    thread.id !== target.threadId ||
    thread.projectId !== batch.projectId ||
    thread.deletedAt !== null
  )
    return null;
  const checkpoint = thread.checkpoints.at(-1);
  const usage = thread.activities
    .toReversed()
    .find((activity) => activity.kind === "context-window.updated")?.payload;
  const rawTokens =
    usage && typeof usage === "object" && "totalProcessedTokens" in usage
      ? usage.totalProcessedTokens
      : null;
  return {
    threadId: thread.id,
    messageId: target.messageId,
    worktreePath: thread.worktreePath,
    accepted: thread.messages.some(
      (message) => message.id === target.messageId && message.role === "user",
    ),
    status: thread.latestTurn?.state ?? thread.session?.status ?? "No turn evidence",
    files: checkpoint?.status === "ready" ? checkpoint.files.length : null,
    additions:
      checkpoint?.status === "ready"
        ? checkpoint.files.reduce((sum, file) => sum + file.additions, 0)
        : null,
    deletions:
      checkpoint?.status === "ready"
        ? checkpoint.files.reduce((sum, file) => sum + file.deletions, 0)
        : null,
    tokens:
      typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens >= 0
        ? rawTokens
        : null,
  };
}
