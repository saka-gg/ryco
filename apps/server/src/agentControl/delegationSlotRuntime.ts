/**
 * Delegation slots: starts the next waiting task of a capped `ryco_create_threads` request
 * (`maxConcurrent`) when an earlier one stops working. Loaded by `AgentControlDelegationSlotsLive`
 * once the first queue holds a slot.
 *
 * A task past its request's cap waits with its first message in its own follow-up queue, held
 * with the cause `delegation-slot:<proposalId>` (`orchestration/delegationSlotHold.ts`). A pass
 * looks at every request that has such a task and, while fewer than its cap of its tasks work,
 * releases the next waiting ones in entry order: a `thread.queue.resume` that acknowledges only
 * that cause, so another hold on the queue (a person's Pause, Trash) stays. The queue drain then
 * sends the message like any other follow-up.
 *
 * Only a request whose operation completed releases anything: one still creating its tasks, or
 * rolled back after a failure or a restart, never starts a waiting task (its rollback deletes or
 * archives them).
 *
 * Nothing lives only in memory: a request's tasks are the operation's owned threads, its cap is
 * the plan's, and which tasks wait is the cause keys of their queues, so a restart rebuilds it all.
 * Each release attempt has its own command id (a refused one, say while the task was in Trash,
 * must not answer every later attempt from its receipt); releasing a cause that is gone changes
 * nothing, so no task is released twice. A person who resumes a waiting task by hand just takes a
 * slot.
 *
 * A task its delegating chat no longer waits for before its first message was sent never starts
 * and takes no slot: one cancelled with `ryco_task_cancel`, by the chat's Stop, archive or delete,
 * or past its return's time limit. Its slot's cause is never released. Only `ryco_task_cancel`
 * takes its first message and the agent's own follow-ups out of its queue (the cancel does it
 * itself; should that removal be lost, a restart in between, a pass removes them under the
 * cancel's own id); after a Stop, an archive or a delete, which a person can undo, they stay, and
 * the person can still resume the task by hand. A parent archived or deleted moments ago counts
 * before its return says so.
 *
 * A task whose goal will continue its last turn (a person's goal on a task an integration created;
 * a delegated task's own goal never continues) works through the goal's grace: the slot stays
 * taken until the next turn starts or the goal stops.
 *
 * It imports no value from a module the server's boot graph loads (only `effect`, which is split
 * already); everything else comes in through `DelegationSlotDeps`.
 *
 * @module delegationSlotRuntime
 */
import type {
  AgentControlProposalId,
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  OrchestrationDispatchCommandError,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  QueuedFollowUp,
  ThreadId,
} from "@ryco/contracts";
import { Cause, Clock, Duration, Effect, Option, Queue, Stream } from "effect";

import type { AgentControlOperationStoreShape } from "./Services/AgentControlOperationStore.ts";
import type { AgentControlProposalEventsShape } from "./Services/AgentControlProposalEvents.ts";
import type { AgentControlProposalStoreShape } from "./Services/AgentControlProposalStore.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type {
  CompletionReturnRecord,
  CompletionReturnRepository,
} from "../persistence/Layers/AgentControlCompletionReturns.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ServerWakeFenceShape } from "../orchestration/Services/ServerWakeFence.ts";
import { goalContinuationPending } from "../orchestration/goalContinuation.ts";

/** A pass over every waiting request at least this often (a start's grace, background work). */
export const DELEGATION_SLOT_SWEEP_INTERVAL = Duration.seconds(30);

type QueueCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.queue.resume" | "thread.queue.remove" }
>;

/**
 * What the runtime reads and calls, provided by `AgentControlDelegationSlotsLive` on the boot
 * side: services, and the boot modules' own functions and constants as values.
 */
export interface DelegationSlotDeps {
  /** The command read model as the engine holds it now (`currentCommandReadModel`). */
  readonly readModel: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;
  /** `findThreadInArray`. */
  readonly findThread: (
    threads: OrchestrationReadModel["threads"],
    threadId: string,
  ) => OrchestrationThread | undefined;
  readonly subscribeDomainEvents: OrchestrationEngineShape["subscribeDomainEvents"];
  readonly getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"];
  /** The shared wake fence's idle rule: `busy` while a thread works or is about to. */
  readonly holdReason: ServerWakeFenceShape["holdReason"];
  readonly getProposal: AgentControlProposalStoreShape["getById"];
  readonly getOperation: AgentControlOperationStoreShape["getByProposalId"];
  /** `OrchestrationCommandApplication.apply`. */
  readonly dispatch: (
    command: QueueCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  /** `DELEGATION_SLOT_CAUSE_PREFIX`. */
  readonly causePrefix: string;
  /** The task's completion return, when the node keeps them. */
  readonly getCompletionReturn?: (typeof CompletionReturnRepository.Service)["get"];
  /** `noLongerAwaited`. */
  readonly noLongerAwaited: (record: Pick<CompletionReturnRecord, "status">) => boolean;
  /** `cancelledByDelegatingChat`: only an explicit cancel takes the task's entries out. */
  readonly cancelledByDelegatingChat: (
    record: Pick<CompletionReturnRecord, "status" | "detail">,
  ) => boolean;
  /** `delegationSlotCancelCommandId`. */
  readonly cancelCommandId: (proposalId: string, threadId: string) => CommandId;
  /** `noUserMessageSent`. */
  readonly noUserMessageSent: (thread: Pick<OrchestrationThread, "messages">) => boolean;
  /** `cancelledTaskEntryIds`. */
  readonly cancelledTaskEntryIds: (
    entries: ReadonlyArray<Pick<QueuedFollowUp, "messageId" | "author">>,
    firstMessageId: string,
  ) => ReadonlyArray<MessageId>;
  /** Proposal changes: a capped request's completion wakes a pass. */
  readonly proposalChanges?: AgentControlProposalEventsShape["changes"];
}

/**
 * What one task of a capped request is doing. `cancelled`: the delegating chat stopped waiting for
 * it before it was sent; it never starts and takes no slot.
 */
export type DelegationSlotTaskState = "waiting" | "working" | "idle" | "gone" | "cancelled";

/** One release attempt's command id: never reused, so a refused attempt blocks no later one. */
export const delegationSlotReleaseCommandId = (
  proposalId: string,
  threadId: ThreadId,
  attemptId: string,
) => `delegation-slot-release:${proposalId}:${threadId}:${attemptId}` as CommandId;

/** The requests that have a task waiting for a slot, from the cause keys of held queues. */
export function waitingRequestIds(
  threads: OrchestrationReadModel["threads"],
  causePrefix: string,
): ReadonlyArray<AgentControlProposalId> {
  const ids = new Set<AgentControlProposalId>();
  for (const thread of threads) {
    // An archived or deleted task waits for nothing until it is back (both wake a pass).
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    for (const key of thread.followUpQueue?.hold?.causeKeys ?? []) {
      if (key.startsWith(causePrefix) && key.length > causePrefix.length) {
        ids.add(key.slice(causePrefix.length) as AgentControlProposalId);
      }
    }
  }
  return [...ids].toSorted();
}

/**
 * The tasks to release now: the first waiting ones, in entry order, while fewer than `max` of
 * the request's tasks work.
 */
export function tasksToRelease(
  tasks: ReadonlyArray<{ readonly threadId: ThreadId; readonly state: DelegationSlotTaskState }>,
  max: number,
): ReadonlyArray<ThreadId> {
  const free = max - tasks.filter((task) => task.state === "working").length;
  if (free <= 0) return [];
  return tasks
    .filter((task) => task.state === "waiting")
    .slice(0, free)
    .map((task) => task.threadId);
}

/** Thread events after which a task may have stopped working, or a request may wait. */
const SLOT_WAKE_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.session-set",
  "thread.turn-diff-completed",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.trashed",
  "thread.untrashed",
  "thread.queue-entry-added",
  "thread.queue-entries-removed",
  "thread.queue-held",
  "thread.queue-released",
]);

const START_ENDED_KINDS = new Set(["provider.turn.start.failed", "provider.turn.start.cancelled"]);

/** Whether `event` can change what a task of a capped request is doing. */
export function isDelegationSlotWakeEvent(event: OrchestrationEvent): boolean {
  if (event.aggregateKind !== "thread") return false;
  if (SLOT_WAKE_EVENT_TYPES.has(event.type)) return true;
  return (
    event.type === "thread.activity-appended" && START_ENDED_KINDS.has(event.payload.activity.kind)
  );
}

export const makeDelegationSlots = (deps: DelegationSlotDeps) =>
  Effect.gen(function* () {
    /** A goal continues only turns that ended while this process ran (`goalContinuationSourceTurn`). */
    const observedSinceMs = yield* Clock.currentTimeMillis;
    /**
     * Each request's cap (a plan never changes, so one read per request and process); null for a
     * request that releases nothing: not capped, or its operation failed or was cancelled.
     */
    const caps = new Map<AgentControlProposalId, number | null>();
    /** Unique to this runtime: with the serial, every release attempt gets an id of its own. */
    const runId = globalThis.crypto.randomUUID().slice(0, 8);
    let serial = 0;

    const capOf = (proposalId: AgentControlProposalId) =>
      Effect.gen(function* () {
        const known = caps.get(proposalId);
        if (known !== undefined) return known;
        const proposal = yield* deps.getProposal(proposalId);
        const plan = Option.isSome(proposal) ? proposal.value.plan : null;
        const cap = plan?.kind === "createThreads" ? (plan.maxConcurrent ?? null) : null;
        if (Option.isSome(proposal)) caps.set(proposalId, cap);
        return cap;
      });

    const taskState = (
      threads: OrchestrationReadModel["threads"],
      threadId: ThreadId,
      causeKey: string,
      nowMs: number,
    ) =>
      Effect.gen(function* () {
        const thread = deps.findThread(threads, threadId);
        // Deleted covers Trash too; an archived task neither works nor is started.
        if (thread === undefined || thread.deletedAt !== null || thread.archivedAt !== null) {
          return { state: "gone" as const };
        }
        const queue = thread.followUpQueue;
        const waiting = queue?.hold?.causeKeys.includes(causeKey) === true;
        // Released and not sent yet: the drain sends it (the shell may not show it yet).
        const unsent =
          queue !== undefined && queue.hold === null && queue.entries[0]?.status === "queued";
        // Given up before its first message was sent: whatever else waits in its queue, it never
        // starts, and what the cancel had to take out of the queue is taken out now.
        if (
          queue !== undefined &&
          (waiting || unsent) &&
          deps.getCompletionReturn !== undefined &&
          deps.noUserMessageSent(thread)
        ) {
          const record = yield* deps.getCompletionReturn(threadId);
          if (record !== undefined && deps.noLongerAwaited(record)) {
            return {
              state: "cancelled" as const,
              removals: deps.cancelledByDelegatingChat(record)
                ? deps.cancelledTaskEntryIds(queue.entries, record.initialMessageId)
                : [],
            };
          }
          // The delivery marks a gone parent's returns on its next scan: no slot opens meanwhile.
          if (record !== undefined && waiting) {
            const parent = yield* deps.getThreadShellById(record.parentThreadId);
            if (Option.isNone(parent) || parent.value.archivedAt !== null) {
              return { state: "cancelled" as const, removals: [] };
            }
          }
        }
        if (waiting) return { state: "waiting" as const };
        if (unsent) return { state: "working" as const };
        const shell = yield* deps.getThreadShellById(threadId);
        if (Option.isNone(shell)) return { state: "gone" as const };
        // Running, starting, a start not bound yet, a question or approval, background work, or
        // the goal's grace before its next turn.
        return {
          state:
            (yield* deps.holdReason(shell.value, nowMs)) === "busy" ||
            goalContinuationPending(shell.value, observedSinceMs, nowMs)
              ? ("working" as const)
              : ("idle" as const),
        };
      });

    const release = (proposalId: AgentControlProposalId, threadId: ThreadId, causeKey: string) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* deps.dispatch({
          type: "thread.queue.resume",
          commandId: delegationSlotReleaseCommandId(
            proposalId,
            threadId,
            `${runId}:${(serial += 1)}`,
          ),
          threadId,
          acknowledgeCauseKeys: [causeKey],
          createdAt: new Date(nowMs).toISOString(),
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("delegation slot was not released", {
            proposalId,
            threadId,
            error: error.message,
          }),
        ),
      );

    /** Finishes a cancel whose removal from the task's queue was lost. */
    const removeCancelled = (
      proposalId: AgentControlProposalId,
      threadId: ThreadId,
      messageIds: ReadonlyArray<MessageId>,
    ) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        yield* deps.dispatch({
          type: "thread.queue.remove",
          commandId: deps.cancelCommandId(proposalId, threadId),
          threadId,
          messageIds,
          createdAt: new Date(nowMs).toISOString(),
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("cancelled delegated task was not taken out of its queue", {
            proposalId,
            threadId,
            error: error.message,
          }),
        ),
      );

    /** One request: releases its next waiting tasks while it has free slots. */
    const passRequest = (
      threads: OrchestrationReadModel["threads"],
      proposalId: AgentControlProposalId,
      nowMs: number,
    ) =>
      Effect.gen(function* () {
        const cap = yield* capOf(proposalId);
        // Not a capped request of this node: its holds are left to the person.
        if (cap === null) return;
        const operation = yield* deps.getOperation(proposalId);
        if (Option.isNone(operation)) return;
        const status = operation.value.status;
        // Still creating its tasks (its completion wakes a pass), or rolled back: a failed or
        // cancelled request never starts its waiting tasks, which its rollback deletes or archives.
        if (status !== "completed") {
          if (status === "failed" || status === "cancelled") caps.set(proposalId, null);
          return;
        }
        const causeKey = `${deps.causePrefix}${proposalId}`;
        const tasks = yield* Effect.forEach(
          operation.value.state.resources.ownedThreadIds,
          (threadId) =>
            taskState(threads, threadId, causeKey, nowMs).pipe(
              Effect.map((task) => ({ threadId, ...task })),
            ),
        );
        for (const task of tasks) {
          if (
            task.state === "cancelled" &&
            task.removals !== undefined &&
            task.removals.length > 0
          ) {
            yield* removeCancelled(proposalId, task.threadId, task.removals);
          }
        }
        for (const threadId of tasksToRelease(tasks, cap)) {
          yield* release(proposalId, threadId, causeKey);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("delegation slots will be checked again", {
                proposalId,
                cause: Cause.pretty(cause),
              }),
        ),
      );

    /** One pass over every request with a waiting task. */
    const pass = Effect.gen(function* () {
      const { threads } = yield* deps.readModel;
      const nowMs = yield* Clock.currentTimeMillis;
      const waiting = waitingRequestIds(threads, deps.causePrefix);
      // A request with no task left waiting needs no cap any more.
      for (const proposalId of caps.keys())
        if (!waiting.includes(proposalId)) caps.delete(proposalId);
      for (const proposalId of waiting) {
        yield* passRequest(threads, proposalId, nowMs);
      }
    });

    return { pass, taskState, passRequest };
  });

/** Runs the slot releases until its scope closes. */
export const runDelegationSlots = (deps: DelegationSlotDeps) =>
  Effect.gen(function* () {
    const slots = yield* makeDelegationSlots(deps);
    // Wake-ups coalesce: one pending pass covers any number of events, and offering never blocks.
    const wake = yield* Queue.sliding<void>(1);
    // Subscribed before the first pass, so no event after it is missed.
    const events = yield* deps.subscribeDomainEvents;
    yield* Effect.forkScoped(
      Stream.runForEach(events, (event) =>
        isDelegationSlotWakeEvent(event) ? Queue.offer(wake, undefined) : Effect.void,
      ),
    );
    // A capped request that finished creating its tasks may have slots free already.
    if (deps.proposalChanges !== undefined) {
      yield* Effect.forkScoped(
        Stream.runForEach(deps.proposalChanges, ({ proposal }) =>
          proposal.status === "completed" &&
          proposal.plan.kind === "createThreads" &&
          proposal.plan.maxConcurrent !== undefined
            ? Queue.offer(wake, undefined)
            : Effect.void,
        ),
      );
    }
    // Passes run one at a time, so two never release on the same count.
    return yield* Effect.forever(
      slots.pass.pipe(
        Effect.catch(() => Effect.logWarning("delegation slots will be checked again")),
        Effect.andThen(Queue.take(wake).pipe(Effect.timeoutOption(DELEGATION_SLOT_SWEEP_INTERVAL))),
      ),
    );
  }).pipe(Effect.scoped);
