/**
 * Multi-model send: one prompt, one new thread per selected model, each in its
 * own fresh worktree off the same base branch. Shared by web, desktop and
 * mobile; the composer adds only presentation (confirmation, which panes open).
 *
 * Every target is an ordinary first send of a new draft thread through the
 * shared send engine, with `requireWorktree`, so the node fails a target
 * instead of running it in the project checkout (and advertises that with
 * `requiredWorktreeBootstrap`). What this module adds is identity: a target's
 * thread id is derived from the draft, the submission and the model, and its
 * message (so its command id) from that thread and the attempt. Sending a
 * target again therefore cannot create a second thread for it, and an
 * uncertain target sent again as the identical command is answered by the
 * node from its receipt or its still-running first attempt.
 */
import type {
  AgentTokenMode,
  ComposerSourceControlContext,
  EnvironmentApi,
  ModelSelection,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
} from "@ryco/contracts";
import { CommandId, MessageId, ThreadId, type ProjectId } from "@ryco/contracts/base-schemas";
import { createModelSelection } from "@ryco/shared/model";

import { RpcRequestRefusedError } from "../../rpc/protocol.ts";
import { RpcTransportDisposedError } from "../../rpc/wsTransport.ts";
import { MULTI_MODEL_SEND_MAX_TARGETS, modelMultiSelectKey } from "./modelMultiSelect.ts";
import { isSetupProviderInstance, type ProviderInstanceEntry } from "./providerInstances.ts";
import { getComposerProviderState } from "./providerState.ts";
import {
  buildSendTurnBootstrap,
  commitSendTurnDispatch,
  type SendTurnBootstrap,
  type SendTurnDispatchAttachment,
} from "./sendEngine.ts";

// ---------------------------------------------------------------------------
// Deterministic identities
// ---------------------------------------------------------------------------

/**
 * A UUID-shaped id (RFC 9562 version 8) hashed from `seed` with cyrb128. Pure
 * and synchronous, so React Native needs no crypto. Not a security boundary:
 * it only has to keep one draft's targets apart from every other thread.
 */
function deterministicUuid(seed: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const hex = [h1, h2, h3, h4].map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The thread a target starts: the same for every attempt of one submission. */
export function deriveMultiModelSendThreadId(input: {
  readonly draftId: string;
  readonly submissionId: string;
  readonly target: Pick<ModelSelection, "instanceId" | "model">;
}): ThreadId {
  return ThreadId.make(
    deterministicUuid(
      JSON.stringify([
        "multi-model-send",
        input.draftId,
        input.submissionId,
        input.target.instanceId,
        input.target.model,
      ]),
    ),
  );
}

/** The message of one attempt; a new attempt is a new message and so a new command. */
export function deriveMultiModelSendMessageId(threadId: ThreadId, attempt: number): MessageId {
  return MessageId.make(deterministicUuid(JSON.stringify(["message", threadId, attempt])));
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type MultiModelSendTargetResolution =
  | {
      readonly ok: true;
      /** The selection with the options the provider accepts for dispatch. */
      readonly modelSelection: ModelSelection;
      /** For the provider's prompt formatting (`formatOutgoingPrompt`). */
      readonly promptEffort: string | null;
      readonly entry: ProviderInstanceEntry;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Checks one selection against the live provider catalog, exactly: a target is
 * never moved to another instance or model. The selection's options are
 * normalized the way the composer normalizes its own before a send.
 */
export function resolveMultiModelSendTarget(input: {
  readonly selection: ModelSelection;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly prompt: string;
}): MultiModelSendTargetResolution {
  const { selection } = input;
  const entry = input.entries.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!entry || !isSetupProviderInstance(entry)) {
    return { ok: false, reason: `${entry?.displayName ?? selection.instanceId} is unavailable.` };
  }
  const model = entry.models.find((candidate) => candidate.slug === selection.model);
  if (!model) {
    return { ok: false, reason: `${selection.model} is not available on ${entry.displayName}.` };
  }
  const state = getComposerProviderState({
    provider: entry.driverKind,
    model: model.slug,
    models: entry.models,
    prompt: input.prompt,
    modelOptions: selection.options,
  });
  return {
    ok: true,
    modelSelection: createModelSelection(
      entry.instanceId,
      model.slug,
      state.modelOptionsForDispatch,
    ),
    promptEffort: state.promptEffort,
    entry,
  };
}

export interface MultiModelSendTargetInput {
  /** Resolved for dispatch (`resolveMultiModelSendTarget`). */
  readonly modelSelection: ModelSelection;
  /** The prompt as this provider and effort take it (`formatOutgoingPrompt`). */
  readonly outgoingMessageText: string;
  /** Normalized for this provider (plan and ask modes are per provider). */
  readonly interactionMode: ProviderInteractionMode;
  readonly providerDriver?: ProviderDriverKind | undefined;
  /** Defaults to the send's title. */
  readonly title?: string | undefined;
  /**
   * This target's own attachments. Required when the send uses streamed
   * uploads: an upload token is claimed by one command, so each target needs
   * its own upload. Absent, the send's shared (inline) attachments go out.
   */
  readonly turnAttachments?: ReadonlyArray<SendTurnDispatchAttachment> | undefined;
}

export interface MultiModelSendInput {
  readonly draftId: string;
  /**
   * Minted once per send and kept for its retries. A later send from the same
   * draft (the composer stays open) takes a new one, so it starts new threads.
   */
  readonly submissionId: string;
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  /** Every target's worktree starts here. */
  readonly baseBranch: string;
  readonly fetchOrigin?: boolean | undefined;
  /** The project's (or node's) branch prefix; each attempt gets a fresh temporary branch. */
  readonly worktreeBranchPrefix?: string | undefined;
  /**
   * As in the normal new-thread send: undefined lets a node with project
   * preferences resolve the project's choice itself; an older node is told true.
   */
  readonly runSetupScript?: boolean | undefined;
  readonly title: string;
  readonly runtimeMode: RuntimeMode;
  readonly tokenMode: AgentTokenMode;
  /** Shared attachments; inline only (see `MultiModelSendTargetInput.turnAttachments`). */
  readonly turnAttachments: ReadonlyArray<SendTurnDispatchAttachment>;
  readonly sourceControlContexts: ReadonlyArray<ComposerSourceControlContext>;
  readonly createdAt: string;
  readonly targets: ReadonlyArray<MultiModelSendTargetInput>;
}

/** One target's first send, complete: what `commitSendTurnDispatch` sends for it. */
export interface MultiModelSendTargetPlan {
  readonly key: string;
  readonly attempt: number;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly providerDriver: ProviderDriverKind | null;
  readonly outgoingMessageText: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly tokenMode: AgentTokenMode;
  readonly turnAttachments: ReadonlyArray<SendTurnDispatchAttachment>;
  readonly sourceControlContexts: ReadonlyArray<ComposerSourceControlContext>;
  /** The turn's start; the thread's own creation time stays the send's. */
  readonly createdAt: string;
  readonly bootstrap: NonNullable<SendTurnBootstrap>;
}

/** Rejects a send that cannot go out as asked; nothing has been sent yet. */
function assertMultiModelSendInput(input: MultiModelSendInput): void {
  if (input.targets.length === 0) throw new Error("Choose at least one model.");
  if (input.targets.length > MULTI_MODEL_SEND_MAX_TARGETS) {
    throw new Error(`Choose at most ${MULTI_MODEL_SEND_MAX_TARGETS} models.`);
  }
  if (input.baseBranch.trim().length === 0) {
    throw new Error("Choose a base branch for the new worktrees.");
  }
  const keys = new Set<string>();
  const uploadTokens = new Set<string>();
  for (const target of input.targets) {
    const key = modelMultiSelectKey(target.modelSelection);
    if (keys.has(key)) throw new Error("Each model can be chosen once.");
    keys.add(key);
    for (const attachment of target.turnAttachments ?? input.turnAttachments) {
      if (attachment.uploadToken === undefined) continue;
      if (uploadTokens.has(attachment.uploadToken)) {
        throw new Error(`Upload '${attachment.name}' once for each model.`);
      }
      uploadTokens.add(attachment.uploadToken);
    }
  }
}

/** Plans one target's attempt: its thread is fixed, its message and branch are the attempt's. */
export function planMultiModelSendTarget(
  input: MultiModelSendInput,
  target: MultiModelSendTargetInput,
  options: { readonly attempt: number; readonly createdAt: string },
): MultiModelSendTargetPlan {
  const threadId = deriveMultiModelSendThreadId({
    draftId: input.draftId,
    submissionId: input.submissionId,
    target: target.modelSelection,
  });
  const messageId = deriveMultiModelSendMessageId(threadId, options.attempt);
  const title = target.title ?? input.title;
  const bootstrap = buildSendTurnBootstrap({
    requireWorktree: true,
    isLocalDraftThread: true,
    baseBranchForWorktree: input.baseBranch,
    fetchOrigin: input.fetchOrigin,
    runSetupScript: input.runSetupScript,
    // A fresh temporary branch per attempt: a failed attempt may leave its
    // branch behind, and the next one must not collide with it.
    worktreeBranchName: null,
    worktreeBranchPrefix: input.worktreeBranchPrefix,
    shouldMaterializeLegacyBranchWorktree: false,
    projectId: input.projectId,
    projectCwd: input.projectCwd,
    title,
    threadCreateModelSelection: target.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: target.interactionMode,
    tokenMode: input.tokenMode,
    // The node names the thread's branch and path after the worktree it makes.
    activeThreadBranch: null,
    worktreePath: null,
    threadCreatedAt: input.createdAt,
  });
  if (!bootstrap) throw new Error("A multi-model send needs a worktree bootstrap.");
  return {
    key: modelMultiSelectKey(target.modelSelection),
    attempt: options.attempt,
    threadId,
    messageId,
    commandId: CommandId.make(`multi-model-send:${threadId}:${messageId}`),
    title,
    modelSelection: target.modelSelection,
    providerDriver: target.providerDriver ?? null,
    outgoingMessageText: target.outgoingMessageText,
    interactionMode: target.interactionMode,
    runtimeMode: input.runtimeMode,
    tokenMode: input.tokenMode,
    turnAttachments: target.turnAttachments ?? input.turnAttachments,
    sourceControlContexts: input.sourceControlContexts,
    createdAt: options.createdAt,
    bootstrap,
  };
}

/** Plans every target's first attempt, in selection order. Throws before anything is sent. */
export function planMultiModelSend(
  input: MultiModelSendInput,
): ReadonlyArray<MultiModelSendTargetPlan> {
  assertMultiModelSendInput(input);
  return input.targets.map((target) =>
    planMultiModelSendTarget(input, target, { attempt: 1, createdAt: input.createdAt }),
  );
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type MultiModelSendTargetStatus =
  | { readonly kind: "pending" }
  | { readonly kind: "dispatching" }
  /** The node accepted the turn start, or the client sees the target's thread. */
  | { readonly kind: "started" }
  /** Nothing of this target exists on the node: sending it again is safe. */
  | { readonly kind: "not-created"; readonly message: string }
  /**
   * The request may have run. Only an explicit retry sends it again, as the
   * identical command, after the user had the chance to check its thread.
   */
  | { readonly kind: "uncertain"; readonly message: string };

export type MultiModelSendFailure = Extract<
  MultiModelSendTargetStatus,
  { readonly kind: "not-created" | "uncertain" }
>;

export const MULTI_MODEL_SEND_UNCERTAIN_MESSAGE =
  "Ryco could not confirm whether this model started. Check its thread before sending it again.";

function hasTag(error: unknown, tag: string): boolean {
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === tag;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not start this model.";
}

/**
 * Classifies a failed attempt. `sent` is whether its turn start left this
 * client (`onBeforeTurnStart` ran); a failure before that (readiness changed,
 * invalid input) sent nothing. A refusal by this client or the node's access
 * check also ran nothing, so it keeps an earlier attempt's uncertainty. The
 * node's typed answer is definite: the turn did not start, and a failed
 * bootstrap deletes the thread it created. Anything else, a lost connection
 * or an unconfirmed hosted replay above all, may have run.
 */
export function classifyMultiModelSendFailure(input: {
  readonly error: unknown;
  readonly sent: boolean;
  readonly previous: MultiModelSendTargetStatus;
}): MultiModelSendFailure {
  const { error } = input;
  const ranNothing =
    !input.sent ||
    error instanceof RpcRequestRefusedError ||
    error instanceof RpcTransportDisposedError ||
    hasTag(error, "AuthRpcError");
  if (ranNothing) {
    return input.previous.kind === "uncertain"
      ? input.previous
      : { kind: "not-created", message: errorMessage(error) };
  }
  if (hasTag(error, "OrchestrationDispatchCommandError")) {
    return { kind: "not-created", message: errorMessage(error) };
  }
  return { kind: "uncertain", message: MULTI_MODEL_SEND_UNCERTAIN_MESSAGE };
}

export interface MultiModelSendDispatchDeps {
  readonly api: EnvironmentApi;
  /** `captureReviewedSendReadiness` for this send; rechecked before each turn start. */
  readonly assertMutationReady?: (() => void) | undefined;
  /**
   * Whether the client's live shell already holds this thread. A target whose
   * thread exists started (perhaps on an attempt whose answer was lost) and is
   * never sent again.
   */
  readonly threadExists: (threadId: ThreadId) => boolean;
}

type DispatchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly sent: boolean };

async function dispatchMultiModelSendTarget(
  plan: MultiModelSendTargetPlan,
  deps: MultiModelSendDispatchDeps,
): Promise<DispatchResult> {
  let sent = false;
  try {
    await commitSendTurnDispatch({
      api: deps.api,
      ...(deps.assertMutationReady ? { assertMutationReady: deps.assertMutationReady } : {}),
      providerDriver: plan.providerDriver,
      threadId: plan.threadId,
      isFirstMessage: true,
      isServerThread: false,
      title: plan.title,
      messageId: plan.messageId,
      commandId: plan.commandId,
      outgoingMessageText: plan.outgoingMessageText,
      turnAttachments: plan.turnAttachments,
      modelSelection: plan.modelSelection,
      runtimeMode: plan.runtimeMode,
      interactionMode: plan.interactionMode,
      tokenMode: plan.tokenMode,
      bootstrap: plan.bootstrap,
      sourceControlContexts: plan.sourceControlContexts,
      createdAt: plan.createdAt,
      // Only a server thread's first send writes a title; these threads are new.
      newCommandId: () => CommandId.make(`${plan.commandId}:meta`),
      beginLocalDispatch: () => {},
      persistThreadSettingsForNextTurn: async () => {},
      onBeforeTurnStart: () => {
        sent = true;
      },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error, sent };
  }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export interface MultiModelSendTargetState {
  readonly plan: MultiModelSendTargetPlan;
  readonly status: MultiModelSendTargetStatus;
}

export interface MultiModelSendSnapshot {
  readonly draftId: string;
  readonly submissionId: string;
  /** In selection order. */
  readonly targets: ReadonlyArray<MultiModelSendTargetState>;
}

export interface MultiModelSendTracker {
  readonly read: () => MultiModelSendSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Sends every target that is safe to send, all at once: those never sent
   * and those whose last attempt created nothing (as a new attempt). A
   * started, uncertain or in-flight target is left alone.
   */
  readonly send: (deps: MultiModelSendDispatchDeps) => Promise<MultiModelSendSnapshot>;
  /**
   * Sends one uncertain target again, as the identical command: the node
   * answers it from its receipt or joins its still-running first attempt, and
   * its thread id stays the same either way. Only for an explicit user action.
   */
  readonly retryUncertain: (
    key: string,
    deps: MultiModelSendDispatchDeps,
  ) => Promise<MultiModelSendSnapshot>;
  /** Marks every settled, unstarted target whose thread exists as started. */
  readonly reconcile: (threadExists: (threadId: ThreadId) => boolean) => void;
}

/**
 * Tracks one submission's targets from plan to outcome. Keep it for as long as
 * the draft can retry (outlive the composer's mount), and start a new one,
 * with a new submission id, for the draft's next send.
 */
export function createMultiModelSendTracker(
  input: MultiModelSendInput,
  options: { readonly now?: () => string } = {},
): MultiModelSendTracker {
  const now = options.now ?? (() => new Date().toISOString());
  const plans = planMultiModelSend(input);
  const targetInputs = new Map(
    input.targets.map((target) => [modelMultiSelectKey(target.modelSelection), target] as const),
  );
  let snapshot: MultiModelSendSnapshot = {
    draftId: input.draftId,
    submissionId: input.submissionId,
    targets: plans.map((plan) => ({ plan, status: { kind: "pending" } })),
  };
  const listeners = new Set<() => void>();

  const update = (
    change: (target: MultiModelSendTargetState) => MultiModelSendTargetState,
  ): void => {
    let changed = false;
    const targets = snapshot.targets.map((target) => {
      const next = change(target);
      if (next !== target) changed = true;
      return next;
    });
    if (!changed) return;
    snapshot = { ...snapshot, targets };
    for (const listener of listeners) listener();
  };
  const setTarget = (key: string, next: MultiModelSendTargetState) =>
    update((target) => (target.plan.key === key ? next : target));

  const reconcile = (threadExists: (threadId: ThreadId) => boolean) =>
    update((target) =>
      target.status.kind !== "started" &&
      target.status.kind !== "dispatching" &&
      threadExists(target.plan.threadId)
        ? { ...target, status: { kind: "started" } }
        : target,
    );

  const run = async (
    target: MultiModelSendTargetState,
    deps: MultiModelSendDispatchDeps,
  ): Promise<void> => {
    const previous = target.status;
    setTarget(target.plan.key, { plan: target.plan, status: { kind: "dispatching" } });
    const result = await dispatchMultiModelSendTarget(target.plan, deps);
    setTarget(target.plan.key, {
      plan: target.plan,
      status: result.ok
        ? { kind: "started" }
        : classifyMultiModelSendFailure({ error: result.error, sent: result.sent, previous }),
    });
  };

  return {
    read: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send: async (deps) => {
      reconcile(deps.threadExists);
      const due = snapshot.targets.flatMap((target): MultiModelSendTargetState[] => {
        if (target.status.kind === "pending") return [target];
        if (target.status.kind !== "not-created") return [];
        const targetInput = targetInputs.get(target.plan.key);
        if (!targetInput) return [];
        // The node created nothing: a new attempt, under a new command id.
        return [
          {
            plan: planMultiModelSendTarget(input, targetInput, {
              attempt: target.plan.attempt + 1,
              createdAt: now(),
            }),
            status: target.status,
          },
        ];
      });
      await Promise.all(due.map((target) => run(target, deps)));
      return snapshot;
    },
    retryUncertain: async (key, deps) => {
      reconcile(deps.threadExists);
      const target = snapshot.targets.find((candidate) => candidate.plan.key === key);
      if (target?.status.kind === "uncertain") await run(target, deps);
      return snapshot;
    },
    reconcile,
  };
}

export interface MultiModelSendSummary {
  readonly started: ReadonlyArray<MultiModelSendTargetState>;
  readonly notCreated: ReadonlyArray<MultiModelSendTargetState>;
  readonly uncertain: ReadonlyArray<MultiModelSendTargetState>;
  /** Pending or dispatching. */
  readonly unsettled: ReadonlyArray<MultiModelSendTargetState>;
}

export function summarizeMultiModelSend(snapshot: MultiModelSendSnapshot): MultiModelSendSummary {
  const by = (kinds: ReadonlyArray<MultiModelSendTargetStatus["kind"]>) =>
    snapshot.targets.filter((target) => kinds.includes(target.status.kind));
  return {
    started: by(["started"]),
    notCreated: by(["not-created"]),
    uncertain: by(["uncertain"]),
    unsettled: by(["pending", "dispatching"]),
  };
}
