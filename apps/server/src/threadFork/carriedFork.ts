/**
 * A fork carried from another node (`threads.forkCarried`, docs/thread-forks.md).
 *
 * The client read a thread's conversation from its own node and carries it here. This node never
 * contacts the source node and nothing carried grants anything: the caller's own role here was
 * checked before this module runs, and the source fields are display-only provenance (they land
 * in the fork's `origin` and title, never in a lookup, an authorization or a network request).
 *
 * The request is checked (size, counts, shape, times, turn structure) before anything is read or
 * written. Acceptance then plans the destination with this node's own rules (`planCheckout`: its
 * worktree root, branch prefix and workspace access policy), after fetching the branch from this
 * node's own `origin`, and records the fork in the `thread_forks` ledger with the carried history
 * in its plan, before the run starts. From there the fork runs and recovers like any other: it
 * skips the provider copy (a carried fork always continues by context handoff, built here from
 * the carried messages) and publishes through `thread.fork.create`, where the carried text enters
 * only as inherited user and assistant messages.
 *
 * Loaded through `import()` by `ThreadForkLive` with the first carried fork. Boot-path modules
 * are type-only imports here: the layer hands its services and helpers over (`CarriedForkDeps`),
 * so this chunk imports no module of the server's boot path.
 *
 * @module carriedFork
 */
import {
  CARRIED_THREAD_HISTORY_MAX_BYTES,
  CARRIED_THREAD_HISTORY_MAX_MESSAGES,
  CARRIED_THREAD_HISTORY_MAX_PLANS,
  CARRIED_THREAD_HISTORY_MAX_TURN_OUTCOMES,
  CarriedThreadHistory,
  MessageId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  ThreadForkCarriedDestination,
  type ThreadForkAttemptState,
  type ThreadForkCarriedRequest,
  type ThreadForkCreateCommand,
  type ThreadForkDestination,
  ThreadForkError,
  type ThreadForkErrorReason,
  type ThreadForkKey,
  type ThreadForkOrigin,
  type ThreadForkResult,
  ThreadId,
  type TurnId,
  type WorktreeId,
} from "@ryco/contracts";
import { carriedForkRemoteBranch, pickCarriedForkInstance } from "@ryco/shared/carriedFork";
import { inheritedItemId } from "@ryco/shared/threadFork";
import { Effect, Exit, Option, Schema } from "effect";

import type { GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  ProjectionRepositoryError,
  ThreadForkRepositoryError,
} from "../persistence/Errors.ts";
import type { ThreadForkRepositoryShape } from "../persistence/Services/ThreadForks.ts";
import type { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import type { ServerSettingsShape } from "../serverSettings.ts";
import type { canonicalJson, sha256Hex } from "../canonicalJson.ts";
import type { ChatFoldersShape } from "../project/chatFolders.ts";
import type {
  ThreadForkCheckoutPlan,
  ThreadForkFailure,
  threadForkIdentity,
  ThreadForkLedgerRow,
} from "./forkLedger.ts";
import type { finalizeForkPublication, forkThreadTitle } from "./forkPlan.ts";
import type { plannedOutcome, ThreadForkRunError } from "./Layers/ThreadFork.ts";

/** How far ahead of this node's clock a carried time may be (another machine's clock). */
export const CARRIED_FORK_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** What a carried fork needs from `ThreadForkLive`, handed over so this chunk imports no boot value. */
export interface CarriedForkDeps {
  /** Joins or starts the attempt for a key, as `fork` does (`ThreadForkLive`). */
  readonly join: (
    forkKey: string,
    acceptance: (digest: string) => Effect.Effect<ThreadForkLedgerRow, ThreadForkRunError>,
    digest: string,
  ) => Effect.Effect<ThreadForkResult, ThreadForkError>;
  readonly attemptState: (forkKey: ThreadForkKey) => Effect.Effect<ThreadForkAttemptState>;
  readonly now: () => Date;
  readonly forkError: (
    reason: ThreadForkErrorReason,
    message: string,
    retryable?: boolean,
  ) => ThreadForkRunError;
  readonly conflictError: () => ThreadForkRunError;
  /** The layer's destination planner, as a fork of a local thread uses it. */
  readonly planCheckout: (input: {
    readonly destination: ThreadForkDestination;
    readonly identity: ReturnType<typeof threadForkIdentity>;
    readonly settings: ServerSettings;
    readonly project: OrchestrationProjectShell;
    readonly source: {
      readonly id: ThreadId;
      readonly title: string;
      readonly worktreeId: WorktreeId | null;
      readonly worktreePath: string | null;
      readonly branch: string | null;
    };
    readonly boundary: null;
  }) => Effect.Effect<ThreadForkCheckoutPlan, ThreadForkRunError | ProjectionRepositoryError>;
  readonly deletePinRefs: (
    checkout: ThreadForkCheckoutPlan,
    forkThreadId: ThreadId,
  ) => Effect.Effect<void>;
  readonly readRow: (
    forkKey: string,
  ) => Effect.Effect<ThreadForkLedgerRow | undefined, ThreadForkRepositoryError>;
  readonly ledger: Pick<ThreadForkRepositoryShape, "insertIfAbsent">;
  readonly snapshots: Pick<ProjectionSnapshotQueryShape, "getProjectShellById">;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings">;
  /** Absent when this node offers no chats without a project. */
  readonly chatFolders: Pick<ChatFoldersShape, "capability"> | undefined;
  /** `prefetchWorktreeBase` fetches `origin/<branch>` with this node's own remote and credentials. */
  readonly gitWorkflow: Pick<GitWorkflowServiceShape, "prefetchWorktreeBase">;
  readonly nowIso: () => string;
  readonly helpers: {
    readonly threadForkIdentity: typeof threadForkIdentity;
    readonly canonicalJson: typeof canonicalJson;
    readonly sha256Hex: typeof sha256Hex;
    readonly deriveProviderInstanceConfigMap: typeof deriveProviderInstanceConfigMap;
    readonly finalizeForkPublication: typeof finalizeForkPublication;
    readonly forkThreadTitle: typeof forkThreadTitle;
    readonly plannedOutcome: typeof plannedOutcome;
    readonly isChatProject: (project: OrchestrationProjectShell) => boolean;
  };
}

/**
 * `ThreadFork.forkCarried`: checks the request, answers a refusal with what the ledger holds for
 * its key, and otherwise joins or starts the attempt with the carried acceptance.
 */
export const forkCarried = (
  input: ThreadForkCarriedRequest,
  deps: CarriedForkDeps,
): Effect.Effect<ThreadForkResult, ThreadForkError> => {
  const checked = checkCarriedForkRequest(input, deps.now().getTime(), deps);
  if (checked.kind === "refused") {
    return Effect.flatMap(deps.attemptState(input.forkKey), (attempt) =>
      Effect.fail(new ThreadForkError({ ...checked.failure, attempt })),
    );
  }
  return deps.join(
    input.forkKey,
    (digest) => acceptCarriedFork(deps, checked.request, digest),
    checked.digest,
  );
};

/** A carried fork request that passed every check, its times clamped to this node's clock. */
export interface CarriedForkRequest {
  readonly forkKey: ThreadForkKey;
  readonly projectId: ProjectId | null;
  readonly destination: ThreadForkCarriedDestination;
  /** The branch on `origin` a `new-worktree` starts from; null for `new-chat`. */
  readonly remoteBranch: string | null;
  readonly history: CarriedThreadHistory;
}

type CarriedRefusal = Pick<ThreadForkFailure, "reason" | "message" | "retryable">;

export type CarriedForkCheck =
  | { readonly kind: "accepted"; readonly request: CarriedForkRequest; readonly digest: string }
  | { readonly kind: "refused"; readonly failure: CarriedRefusal };

const refuse = (reason: ThreadForkErrorReason, message: string): CarriedForkCheck => ({
  kind: "refused",
  failure: { reason, message, retryable: false },
});

const TOO_LARGE_MESSAGE =
  "This conversation is too long to continue on another machine. Fork from an earlier reply.";

/** UTF-8 bytes of `value` as JSON, or null when it cannot be written as JSON. */
function encodedJsonBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : Buffer.byteLength(json, "utf8");
  } catch {
    return null;
  }
}

/** The length of `value[key]` when it is an array; checked before the history is decoded. */
function arrayLength(value: unknown, key: string): number {
  if (typeof value !== "object" || value === null) return 0;
  const entry = (value as Record<string, unknown>)[key];
  return Array.isArray(entry) ? entry.length : 0;
}

const decodeDestination = Schema.decodeUnknownExit(ThreadForkCarriedDestination, {
  onExcessProperty: "error",
});

const decodeHistory = Schema.decodeUnknownExit(CarriedThreadHistory, {
  onExcessProperty: "error",
});

/** The first lines of a decode failure, for the error message. */
function decodeDetail(cause: unknown): string {
  const text = String(cause).split("\n").slice(0, 3).join(" ").trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/**
 * Checks a carried fork request before anything is read or written: the destination's shape,
 * the payload's size and counts, then the history's shape (unknown keys refused) and structure.
 * Times at most `CARRIED_FORK_CLOCK_SKEW_MS` ahead of `nowMs` are clamped to it; later ones are
 * refused. Pure apart from the digest helper.
 */
export function checkCarriedForkRequest(
  input: ThreadForkCarriedRequest,
  nowMs: number,
  deps: Pick<CarriedForkDeps, "helpers">,
): CarriedForkCheck {
  // The destination is the size of a few words: its shape is checked before anything else.
  const decodedDestination = decodeDestination(input.destination);
  if (Exit.isFailure(decodedDestination)) {
    return refuse("destination-unavailable", "The fork's destination is not valid.");
  }
  const destination = decodedDestination.value;
  let remoteBranch: string | null = null;
  if (destination.kind === "new-worktree") {
    if (input.projectId === null) {
      return refuse("destination-unavailable", "Pick a project on this machine for the fork.");
    }
    remoteBranch = carriedForkRemoteBranch(destination.start.baseRef);
    if (remoteBranch === null) {
      return refuse(
        "base-ref-invalid",
        "Only a branch pushed to origin can start the fork's worktree on another machine.",
      );
    }
  } else if (input.projectId !== null) {
    return refuse("destination-unavailable", "A chat without a project forks into a new chat.");
  }

  const bytes = encodedJsonBytes(input.history);
  if (bytes === null) return refuse("history-invalid", "The carried conversation is not valid.");
  if (bytes > CARRIED_THREAD_HISTORY_MAX_BYTES)
    return refuse("history-too-large", TOO_LARGE_MESSAGE);
  if (
    arrayLength(input.history, "messages") > CARRIED_THREAD_HISTORY_MAX_MESSAGES ||
    arrayLength(input.history, "proposedPlans") > CARRIED_THREAD_HISTORY_MAX_PLANS ||
    arrayLength(input.history, "turnOutcomes") > CARRIED_THREAD_HISTORY_MAX_TURN_OUTCOMES
  ) {
    return refuse("history-too-large", TOO_LARGE_MESSAGE);
  }
  const decoded = decodeHistory(input.history);
  if (Exit.isFailure(decoded)) {
    return refuse(
      "history-invalid",
      `The carried conversation is not valid: ${decodeDetail(decoded.cause)}`,
    );
  }
  const history = decoded.value;
  const structure = checkHistoryStructure(history, nowMs);
  if (structure.kind === "refused") return structure;
  return {
    kind: "accepted",
    request: {
      forkKey: input.forkKey,
      projectId: input.projectId,
      destination,
      remoteBranch,
      history: structure.history,
    },
    // The history as sent, before its times were clamped: a retry of the same request matches.
    // A key used for a local fork never matches it, nor the same key with another conversation.
    digest: deps.helpers.sha256Hex(
      deps.helpers.canonicalJson({
        kind: "carried",
        projectId: input.projectId,
        destination,
        history,
      }),
    ),
  };
}

/**
 * The carried conversation's structure: it ends at a reply of a turn that completed, every reply
 * names its turn, a turn's messages are contiguous, times never go backwards, and outcomes and
 * plans name carried turns. Returns the history with its times clamped to `nowMs`.
 */
function checkHistoryStructure(
  history: CarriedThreadHistory,
  nowMs: number,
):
  | { readonly kind: "accepted"; readonly history: CarriedThreadHistory }
  | Extract<CarriedForkCheck, { readonly kind: "refused" }> {
  const invalid = (detail: string) =>
    refuse("history-invalid", `The carried conversation is not valid: ${detail}`) as Extract<
      CarriedForkCheck,
      { readonly kind: "refused" }
    >;
  const latest = nowMs + CARRIED_FORK_CLOCK_SKEW_MS;
  let tooLate: string | null = null;
  const clamp = (time: string): string => {
    const ms = Date.parse(time);
    if (!Number.isFinite(ms)) {
      tooLate ??= `'${time}' is not a time`;
      return time;
    }
    if (ms > latest) tooLate ??= `'${time}' is in the future`;
    return new Date(Math.min(ms, nowMs)).toISOString();
  };

  const messages = history.messages.map((message) => ({
    ...message,
    createdAt: clamp(message.createdAt),
  }));
  const proposedPlans = history.proposedPlans.map((plan) => ({
    ...plan,
    createdAt: clamp(plan.createdAt),
    implementedAt: plan.implementedAt === null ? null : clamp(plan.implementedAt),
  }));
  if (tooLate !== null) return invalid(tooLate);

  const boundary = messages.at(-1);
  if (boundary === undefined || boundary.role !== "assistant" || boundary.turnId === null) {
    return invalid("it must end with a reply of the agent.");
  }
  const repliedTurns = new Set<string>();
  const leftTurns = new Set<string>();
  let currentTurn: string | null = null;
  let previousTime = "";
  for (const message of messages) {
    if (message.createdAt < previousTime) return invalid("its messages are out of order.");
    previousTime = message.createdAt;
    if (message.role === "assistant") {
      if (message.turnId === null) return invalid("a reply names no turn.");
      repliedTurns.add(message.turnId);
    }
    if (message.turnId === null) continue;
    if (message.turnId !== currentTurn) {
      if (leftTurns.has(message.turnId)) return invalid("a turn's messages are not together.");
      if (currentTurn !== null) leftTurns.add(currentTurn);
      currentTurn = message.turnId;
    }
  }
  const outcomeTurns = new Set<string>();
  for (const outcome of history.turnOutcomes) {
    if (!repliedTurns.has(outcome.turnId) || outcomeTurns.has(outcome.turnId)) {
      return invalid("a turn outcome names no carried turn, or one twice.");
    }
    if (outcome.turnId === boundary.turnId) {
      return invalid("the picked reply's turn did not complete.");
    }
    outcomeTurns.add(outcome.turnId);
  }
  const carriedTurns = new Set(
    messages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  for (const plan of proposedPlans) {
    if (
      plan.turnId !== null ? !carriedTurns.has(plan.turnId) : plan.createdAt > boundary.createdAt
    ) {
      return invalid("a proposed plan is not part of the carried turns.");
    }
  }
  return { kind: "accepted", history: { ...history, messages, proposedPlans } };
}

/** The four-digit position of a carried item: ids sort like the carried order. */
const position = (index: number) => String(index).padStart(4, "0");

/**
 * The fork's source on this node: a placeholder derived from the fork's own id, which names no
 * thread here (the decider refuses a carried publication whose source is a thread of this node).
 * The source's own id stays in `origin`, display-only.
 */
export function carriedForkSourceThreadId(forkThreadId: ThreadId): ThreadId {
  return ThreadId.make(`${forkThreadId}:origin`);
}

/** The `thread.fork.create` draft of a carried conversation, before its outcome is final. */
function carriedPublication(input: {
  readonly deps: CarriedForkDeps;
  readonly request: CarriedForkRequest;
  readonly forkThreadId: ThreadId;
  readonly commandId: ThreadForkCreateCommand["commandId"];
  readonly projectId: ProjectId;
  readonly createdAt: string;
  readonly modelSelection: ModelSelection;
  readonly checkout: ThreadForkCheckoutPlan;
  readonly origin: ThreadForkOrigin;
}) {
  const { history } = input.request;
  const { forkThreadId } = input;
  const sourceThreadId = carriedForkSourceThreadId(forkThreadId);
  const inheritedId = (sourceItemId: string) =>
    inheritedItemId({ forkThreadId, sourceThreadId, sourceItemId });
  const messages = history.messages.map((message, index): OrchestrationMessage => ({
    id: MessageId.make(inheritedId(`carried-${position(index)}`)),
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    streaming: false,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  }));
  const boundaryIndex = history.messages.length - 1;
  const boundary = history.messages[boundaryIndex]!;
  const sourceMessageId = MessageId.make(`carried-${position(boundaryIndex)}`);
  const sourceTurnId = boundary.turnId as TurnId;
  const proposedPlans = history.proposedPlans.map((plan, index): OrchestrationProposedPlan => ({
    id: inheritedId(`carried-plan-${position(index)}`),
    turnId: plan.turnId,
    planMarkdown: plan.planMarkdown,
    // A plan carried out after the picked reply counts as not carried out in the fork.
    implementedAt:
      plan.implementedAt !== null && plan.implementedAt <= boundary.createdAt
        ? plan.implementedAt
        : null,
    implementationThreadId: null,
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
  }));
  const sourceTitle = history.source.threadTitle;
  const outcome = input.deps.helpers.plannedOutcome(input.checkout, {
    kind: "handoff",
    reason: "no-native-session",
  });
  const draft: ThreadForkCreateCommand = {
    type: "thread.fork.create",
    commandId: input.commandId,
    threadId: forkThreadId,
    projectId: input.projectId,
    title: input.deps.helpers.forkThreadTitle(sourceTitle),
    modelSelection: input.modelSelection,
    runtimeMode: history.runtimeMode,
    interactionMode: history.interactionMode,
    ...(history.tokenMode !== undefined ? { tokenMode: history.tokenMode } : {}),
    branch: null,
    worktreePath: null,
    createdAt: input.createdAt,
    sourceThreadId,
    sourceMessageId,
    sourceTurnId,
    worktreeId: null,
    newWorktree: null,
    messages,
    proposedPlans,
    activities: [],
    forked: {
      schemaVersion: 1,
      sourceThreadId,
      sourceMessageId,
      sourceTurnId,
      sourceTitle,
      inheritedMessageCount: messages.length,
      ...(history.turnOutcomes.length > 0 ? { inheritedTurnOutcomes: history.turnOutcomes } : {}),
      providerContext: "handoff",
      checkout: outcome.checkout,
      notices: [],
      origin: input.origin,
    },
  };
  // A carried fork names no handoff reason: older clients could not decode a new one.
  const { handoffReason: _reason, ...withoutReason } = outcome;
  return {
    command: input.deps.helpers.finalizeForkPublication(draft, withoutReason, []),
    sourceThreadId,
    sourceMessageId,
    sourceTurnId,
    sourceTitle,
  };
}

/**
 * Accepts a checked carried fork: picks this node's provider instance for the source's driver,
 * plans the destination (fetching the branch first), and records the row with the carried
 * history in its plan, last, so a refused request leaves nothing behind but a fetched remote
 * branch. A key recorded meanwhile continues with its row when the digest matches.
 */
export const acceptCarriedFork = (
  deps: CarriedForkDeps,
  request: CarriedForkRequest,
  digest: string,
): Effect.Effect<ThreadForkLedgerRow, ThreadForkRunError> =>
  Effect.gen(function* () {
    const { helpers } = deps;
    const { history } = request;
    const identity = helpers.threadForkIdentity(request.forkKey);
    const createdAt = deps.nowIso();
    const settings = yield* deps.serverSettings.getSettings;
    const instances = Object.entries(helpers.deriveProviderInstanceConfigMap(settings)).map(
      ([instanceId, config]) => ({
        instanceId,
        driver: config.driver as string,
        enabled: config.enabled !== false,
      }),
    );
    const instance = pickCarriedForkInstance(instances, history.model.driver);
    if (instance === null) {
      return yield* deps.forkError(
        "destination-unavailable",
        `This machine has no enabled ${history.model.driver} provider. Turn one on, then try again.`,
      );
    }
    const modelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make(instance.instanceId),
      model: history.model.model,
    };

    let checkout: ThreadForkCheckoutPlan;
    let projectId: ProjectId;
    if (request.destination.kind === "new-chat" || request.projectId === null) {
      const chats = deps.chatFolders === undefined ? null : yield* deps.chatFolders.capability;
      if (chats?.available !== true) {
        return yield* deps.forkError(
          "destination-unavailable",
          "Chats without a project are not available on this machine.",
        );
      }
      projectId = identity.chatProjectId;
      checkout = {
        kind: "new-chat",
        projectId,
        titleSeed: helpers.forkThreadTitle(history.source.threadTitle),
      };
    } else {
      const project = Option.getOrUndefined(
        yield* deps.snapshots.getProjectShellById(request.projectId),
      );
      if (project === undefined || helpers.isChatProject(project)) {
        return yield* deps.forkError(
          "destination-unavailable",
          "This project is not on this machine anymore.",
        );
      }
      const branch = request.remoteBranch!;
      // This node's own remote and credentials; the client sent a branch name, never a path.
      yield* deps.gitWorkflow
        .prefetchWorktreeBase({ cwd: project.workspaceRoot, refName: `origin/${branch}` })
        .pipe(
          Effect.mapError((cause) =>
            deps.forkError(
              "base-ref-unavailable",
              `This machine could not fetch 'origin/${branch}'${
                cause instanceof Error && cause.message.trim().length > 0
                  ? ` (${cause.message.trim().slice(0, 300)})`
                  : ""
              }. Push the branch and check this machine can reach the remote, then try again.`,
              true,
            ),
          ),
        );
      const planned = yield* deps.planCheckout({
        // Fully qualified: a local branch with the same name never wins.
        destination: {
          kind: "new-worktree",
          start: { kind: "base-ref", baseRef: `refs/remotes/origin/${branch}` },
        },
        identity,
        settings,
        project,
        source: {
          id: carriedForkSourceThreadId(identity.forkThreadId),
          title: history.source.threadTitle,
          worktreeId: null,
          worktreePath: null,
          branch: null,
        },
        boundary: null,
      });
      checkout =
        planned.kind === "new-worktree" ? { ...planned, baseRef: `origin/${branch}` } : planned;
      projectId = project.id;
    }

    const origin: ThreadForkOrigin = {
      kind: "other-machine",
      machineLabel: history.source.machineLabel,
      sourceEnvironmentId: history.source.environmentId,
      sourceThreadId: history.source.threadId,
      sourceThreadTitle: history.source.threadTitle,
    };
    const destination: ThreadForkDestination =
      request.destination.kind === "new-worktree"
        ? {
            kind: "new-worktree",
            start: { kind: "base-ref", baseRef: `origin/${request.remoteBranch}` },
          }
        : { kind: "new-chat" };
    const row = yield* Effect.sync(() => {
      const publication = carriedPublication({
        deps,
        request,
        forkThreadId: identity.forkThreadId,
        commandId: identity.commandId("publish"),
        projectId,
        createdAt,
        modelSelection,
        checkout,
        origin,
      });
      return {
        forkKey: request.forkKey,
        requestDigest: digest,
        forkThreadId: identity.forkThreadId,
        sourceThreadId: publication.sourceThreadId,
        sourceMessageId: publication.sourceMessageId,
        destinationKind: destination.kind,
        phase: "accepted",
        plan: {
          schemaVersion: 1,
          forkThreadId: identity.forkThreadId,
          projectId,
          sourceProjectId: projectId,
          sourceThreadId: publication.sourceThreadId,
          sourceMessageId: publication.sourceMessageId,
          sourceTurnId: publication.sourceTurnId,
          sourceTitle: publication.sourceTitle,
          destination,
          checkout,
          // Nothing to copy natively here: the run hands off without a provider call.
          provider: { kind: "handoff", reason: "no-native-session" },
          attachments: [],
          command: publication.command,
          notices: [],
        },
        checkout: null,
        provider: null,
        attachments: null,
        result: null,
        error: null,
        origin,
        createdAt,
        updatedAt: createdAt,
      } satisfies ThreadForkLedgerRow;
    });
    const dropPins = () => deps.deletePinRefs(checkout, identity.forkThreadId);
    if (yield* deps.ledger.insertIfAbsent(row).pipe(Effect.onError(dropPins))) return row;
    // The key was recorded meanwhile: continue with its row when it asks for the same.
    const existing = yield* deps.readRow(request.forkKey);
    if (existing === undefined) {
      return yield* deps.forkError(
        "preparation-failed",
        "The fork could not finish. Retry to resume it where it stopped.",
        true,
      );
    }
    if (existing.requestDigest !== digest) return yield* deps.conflictError();
    return existing;
  }).pipe(
    Effect.catch((error) =>
      isRunError(error)
        ? Effect.fail(error)
        : Effect.logWarning("carried thread fork acceptance failed", { cause: error }).pipe(
            Effect.andThen(
              Effect.fail(
                deps.forkError(
                  "preparation-failed",
                  "This machine could not prepare the fork right now. Try again in a moment.",
                  true,
                ),
              ),
            ),
          ),
    ),
  );

const isRunError = (error: unknown): error is ThreadForkRunError =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "ForkRunError";
