/**
 * A heartbeat's runs: a schedule whose execution names an existing chat (`target`) queues each
 * run's prompt there as an `automation` follow-up instead of creating a chat. The chat's queue
 * holds and sends it like the person's own follow-ups, with the chat's current model and modes,
 * never above the run's runtime mode. The chat is not the run's: nothing undoes or archives it.
 *
 * Loaded by the executor on a heartbeat's first run or recovery; it imports no boot values (the
 * executor passes its own in), so the server's boot path carries none of it.
 *
 * @module agentControl/heartbeatRuns
 */
import type {
  CommandId,
  MessageId,
  OrchestrationThreadShell,
  QueuedFollowUp,
  ThreadId,
  ThreadQueueAddCommand,
} from "@ryco/contracts";
import { Effect, Option } from "effect";

/** Ends the message id of every run a heartbeat schedule queues, so its runs can coalesce. */
export const heartbeatMessageIdSuffix = (automationId: string) => `-of-${automationId}`;

export interface HeartbeatRunPlan {
  readonly automationId: string;
  readonly execution: {
    readonly projectId: string;
    readonly prompt: string;
    readonly runtimeMode: ThreadQueueAddCommand["entry"]["runtimeMode"];
    readonly target?: { readonly threadId: ThreadId } | undefined;
  };
}

export interface HeartbeatRunDeps<E> {
  /** The run's message and command ids (`messageIdFor` / `commandIdFor` of its operation). */
  readonly messageId: (step: string) => MessageId;
  readonly commandId: (step: string) => CommandId;
  readonly loadThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadShell, E>;
  /** The chat's queued follow-ups as the engine holds them now. */
  readonly queuedIn: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<QueuedFollowUp>, E>;
  /** Records that the run coalesced into the schedule's waiting entry. */
  readonly coalesced: Effect.Effect<void, E>;
  /** Dispatches the queue add and records it. */
  readonly queue: (command: ThreadQueueAddCommand) => Effect.Effect<void, E>;
}

const runMessageId = <E>(deps: Pick<HeartbeatRunDeps<E>, "messageId">, plan: HeartbeatRunPlan) =>
  deps.messageId(`automation-run${heartbeatMessageIdSuffix(plan.automationId)}`);

/**
 * Queues the run's prompt in its chat. Runs coalesce, like missed occurrences: while this
 * schedule's last entry still waits in the chat's queue (held, or behind other follow-ups), the
 * run adds no second one.
 */
export const runHeartbeat = <E>(deps: HeartbeatRunDeps<E>, plan: HeartbeatRunPlan) =>
  Effect.gen(function* () {
    const threadId = plan.execution.target?.threadId;
    if (threadId === undefined) return;
    const current = yield* deps.loadThread(threadId);
    if (current.archivedAt !== null || current.projectId !== plan.execution.projectId) {
      return yield* Effect.fail(new Error("The automation's chat is archived or moved."));
    }
    const suffix = heartbeatMessageIdSuffix(plan.automationId);
    const waiting = yield* deps.queuedIn(threadId);
    if (
      waiting.some((entry) => entry.author === "automation" && entry.messageId.endsWith(suffix))
    ) {
      return yield* deps.coalesced;
    }
    yield* deps.queue({
      type: "thread.queue.add",
      commandId: deps.commandId("automation-queue"),
      threadId,
      author: "automation",
      entry: {
        messageId: runMessageId(deps, plan),
        text: plan.execution.prompt,
        attachments: [],
        modelSelection: current.modelSelection,
        runtimeMode: plan.execution.runtimeMode,
        interactionMode: current.interactionMode,
        ...(current.tokenMode === undefined ? {} : { tokenMode: current.tokenMode }),
      },
      createdAt: new Date().toISOString(),
    });
  });

/**
 * After a restart lost the run's checkpoint: whether its queue add committed, so its message
 * reached the chat (still queued there, or already sent).
 */
export const heartbeatRunReachedChat = <E>(
  deps: Pick<HeartbeatRunDeps<E>, "messageId" | "queuedIn"> & {
    readonly sentMessage: (
      threadId: ThreadId,
      messageId: MessageId,
    ) => Effect.Effect<Option.Option<unknown>, E>;
  },
  plan: HeartbeatRunPlan,
) =>
  Effect.gen(function* () {
    const threadId = plan.execution.target?.threadId;
    if (threadId === undefined) return false;
    const messageId = runMessageId(deps, plan);
    if ((yield* deps.queuedIn(threadId)).some((entry) => entry.messageId === messageId)) {
      return true;
    }
    return Option.isSome(yield* deps.sentMessage(threadId, messageId));
  });
