import { assert, describe, it } from "@effect/vitest";
import {
  AgentControlProposalId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProviderInstanceId,
  ThreadId,
  type AgentControlOperation,
  type AgentControlOperationStatus,
  type AgentControlProposal,
  type AgentControlProposalStreamProposalEvent,
  type ClientOrchestrationCommand,
  type FollowUpQueueHold,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
  type QueuedFollowUp,
} from "@ryco/contracts";
import { Effect, Fiber, Option, PubSub, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  DELEGATION_SLOT_CAUSE_PREFIX,
  cancelledTaskEntryIds,
  delegationSlotCancelCommandId,
  delegationSlotHold,
  heldOnlyForDelegationSlot,
  noUserMessageSent,
} from "../orchestration/delegationSlotHold.ts";
import type { CompletionReturnRecord } from "../persistence/Layers/AgentControlCompletionReturns.ts";
import { DELEGATED_TASK_CANCEL_DETAIL, noLongerAwaited } from "./delegatedTaskControl.ts";
import { threadsQueuedAtBoot } from "../orchestration/Layers/ServerQueueDrain.ts";
import { anyLiveTaskWaitsForSlot } from "./Layers/AgentControlDelegationSlots.ts";
import {
  delegationSlotReleaseCommandId,
  isDelegationSlotWakeEvent,
  makeDelegationSlots,
  runDelegationSlots,
  tasksToRelease,
  waitingRequestIds,
  type DelegationSlotDeps,
} from "./delegationSlotRuntime.ts";

const proposalId = AgentControlProposalId.make("proposal-capped");
const slotKey = `delegation-slot:${proposalId}`;
const CODEX = ProviderInstanceId.make("codex");
const at = "2026-10-29T10:00:00.000Z";
const taskId = (index: number) => ThreadId.make(`thread-task-${index}`);

type Resume = Extract<ClientOrchestrationCommand, { type: "thread.queue.resume" }>;
type Remove = Extract<ClientOrchestrationCommand, { type: "thread.queue.remove" }>;

const firstMessage = (index: number): QueuedFollowUp => ({
  messageId: MessageId.make(`message-agent-control-op-create-${index}`),
  text: `task ${index}`,
  attachments: [],
  modelSelection: { instanceId: CODEX, model: "gpt-5.6" },
  runtimeMode: "auto",
  interactionMode: "default",
  createdAt: at,
  updatedAt: at,
  revision: 1,
  status: "queued",
  author: "agent",
});

interface Task {
  readonly id: ThreadId;
  deletedAt: string | null;
  archivedAt: string | null;
  /** The session runs, starts, asks, or its start has not bound yet. */
  busy: boolean;
  /** The delegating chat cancelled its return with `ryco_task_cancel`. */
  cancelled: boolean;
  /** Its return's status otherwise (the chat's Stop, archive or delete; its time limit). */
  returnStatus?: CompletionReturnRecord["status"];
  /** What its shell shows besides its id (a goal, its latest turn). */
  shell?: Partial<OrchestrationThreadShell>;
  /** Its first message was sent (it has a user message). */
  sent: boolean;
  queue: { entries: QueuedFollowUp[]; hold: FollowUpQueueHold | null } | undefined;
}

/**
 * A capped request on fakes: the first `cap` tasks started (busy), the rest wait with their first
 * message held for the slot. Resumes act like the engine and the decider: a seen command id
 * replays its receipt, only acknowledged causes are released, the last one ends the hold.
 */
const world = (input: { readonly cap: number | undefined; readonly count: number }) => {
  const tasks: Task[] = Array.from({ length: input.count }, (_, index) => {
    const waits = input.cap !== undefined && index >= input.cap;
    return {
      id: taskId(index),
      deletedAt: null,
      archivedAt: null,
      busy: !waits,
      cancelled: false,
      sent: !waits,
      queue: waits
        ? {
            entries: [firstMessage(index)],
            hold: { ...delegationSlotHold(proposalId, input.cap!), heldAt: at },
          }
        : undefined,
    };
  });
  const task = (index: number) => tasks[index]!;
  const dispatched: Resume[] = [];
  const removals: Remove[] = [];
  const receipts = new Map<string, "accepted" | "rejected">();
  /** Resumes of these tasks are refused (in Trash at that moment, say). */
  const refuse = new Set<ThreadId>();
  const operation = { status: "completed" as AgentControlOperationStatus };
  const reads = { proposals: 0, operations: 0 };
  let loseReply = false;
  let loseRemoval = false;
  const known = { proposal: true };

  const thread = (entry: Task) => ({
    id: entry.id,
    deletedAt: entry.deletedAt,
    archivedAt: entry.archivedAt,
    followUpQueue: entry.queue,
    messages: entry.sent ? [{ id: `first-of-${entry.id}`, role: "user" }] : [],
  });

  const deps: DelegationSlotDeps = {
    readModel: Effect.sync(
      () => ({ threads: tasks.map(thread) }) as unknown as OrchestrationReadModel,
    ),
    findThread: (threads, id) => threads.find((candidate) => candidate.id === id),
    subscribeDomainEvents: Effect.die("not used"),
    getThreadShellById: (id) =>
      Effect.sync(() =>
        tasks.some((entry) => entry.id === id)
          ? Option.some({
              id,
              ...tasks.find((entry) => entry.id === id)!.shell,
            } as unknown as OrchestrationThreadShell)
          : Option.none(),
      ),
    // The fence: busy while the session works, or while an unheld queue waits to send.
    holdReason: (shell) =>
      Effect.sync(() => {
        const entry = tasks.find((candidate) => candidate.id === shell.id)!;
        const waiting =
          entry.queue !== undefined && entry.queue.hold === null && entry.queue.entries.length > 0;
        return entry.busy || waiting ? "busy" : null;
      }),
    getProposal: (id) =>
      Effect.sync(() => {
        reads.proposals += 1;
        return known.proposal && id === proposalId
          ? Option.some({
              proposalId,
              plan: {
                kind: "createThreads",
                entries: [],
                ...(input.cap === undefined ? {} : { maxConcurrent: input.cap }),
              },
            } as unknown as AgentControlProposal)
          : Option.none();
      }),
    getOperation: (id) =>
      Effect.sync(() => {
        reads.operations += 1;
        return known.proposal && id === proposalId
          ? Option.some({
              status: operation.status,
              state: { resources: { ownedThreadIds: tasks.map((entry) => entry.id) } },
            } as unknown as AgentControlOperation)
          : Option.none();
      }),
    dispatch: (command) =>
      Effect.suspend(() => {
        const entry = tasks.find((candidate) => candidate.id === command.threadId)!;
        if (command.type === "thread.queue.remove") {
          removals.push(command);
          if (loseRemoval) {
            return Effect.fail(new OrchestrationDispatchCommandError({ message: "lost" }));
          }
          if (receipts.has(command.commandId)) return Effect.succeed({ sequence: 1 });
          receipts.set(command.commandId, "accepted");
          const left = (entry.queue?.entries ?? []).filter(
            (queued) => !command.messageIds.includes(queued.messageId),
          );
          // An emptied queue loses its hold too.
          entry.queue = left.length === 0 ? undefined : { ...entry.queue!, entries: left };
          return Effect.succeed({ sequence: 1 });
        }
        dispatched.push(command);
        const receipt = receipts.get(command.commandId);
        if (receipt !== undefined) {
          return receipt === "accepted"
            ? Effect.succeed({ sequence: 1 })
            : Effect.fail(new OrchestrationDispatchCommandError({ message: "refused" }));
        }
        if (refuse.has(entry.id)) {
          receipts.set(command.commandId, "rejected");
          return Effect.fail(new OrchestrationDispatchCommandError({ message: "refused" }));
        }
        receipts.set(command.commandId, "accepted");
        const hold = entry.queue?.hold;
        if (entry.queue !== undefined && hold != null) {
          const left = hold.causeKeys.filter((key) => !command.acknowledgeCauseKeys.includes(key));
          entry.queue.hold = left.length === 0 ? null : { ...hold, causeKeys: left };
        }
        return loseReply
          ? Effect.fail(new OrchestrationDispatchCommandError({ message: "reply lost" }))
          : Effect.succeed({ sequence: 1 });
      }),
    causePrefix: DELEGATION_SLOT_CAUSE_PREFIX,
    getCompletionReturn: (id) =>
      Effect.sync(() => {
        const index = tasks.findIndex((entry) => entry.id === id);
        return {
          status: task(index).returnStatus ?? (task(index).cancelled ? "cancelled" : "waiting"),
          detail: task(index).cancelled ? DELEGATED_TASK_CANCEL_DETAIL : "Waiting.",
          initialMessageId: firstMessage(index).messageId,
        } as CompletionReturnRecord;
      }),
    noLongerAwaited,
    cancelCommandId: delegationSlotCancelCommandId,
    noUserMessageSent,
    cancelledTaskEntryIds,
  };

  /** A released task's drain sent its message: the queue empties and the session works. */
  const started = (index: number) => {
    task(index).queue = undefined;
    task(index).busy = true;
    task(index).sent = true;
  };
  /** Accepted releases, in order. */
  const released = () =>
    dispatched
      .filter((command) => receipts.get(command.commandId) === "accepted")
      .filter(
        (command, index, all) =>
          all.findIndex((other) => other.commandId === command.commandId) === index,
      )
      .map((command) => command.threadId as string);
  return {
    tasks,
    task,
    deps,
    dispatched,
    released,
    started,
    reads,
    known,
    removals,
    refuse,
    operation,
    loseReply: (value: boolean) => (loseReply = value),
    loseRemoval: (value: boolean) => (loseRemoval = value),
  };
};

describe("delegation slots", () => {
  it.effect("a task that stops working releases exactly the next waiting one", () =>
    Effect.gen(function* () {
      const w = world({ cap: 2, count: 4 });
      const slots = yield* makeDelegationSlots(w.deps);
      yield* slots.pass;
      // Both slots are taken: nothing is released.
      assert.deepEqual(w.released(), []);
      w.task(0).busy = false;
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(2)]);
      assert.deepEqual(w.dispatched[0], {
        type: "thread.queue.resume",
        commandId: w.dispatched[0]!.commandId,
        threadId: taskId(2),
        // Only the slot's own cause.
        acknowledgeCauseKeys: [slotKey],
        createdAt: w.dispatched[0]!.createdAt,
      });
      assert.match(
        w.dispatched[0]!.commandId,
        /^delegation-slot-release:proposal-capped:thread-task-2:[0-9a-f]{8}:1$/u,
      );
      // Released and not sent yet, then sent: it holds the slot either way.
      yield* slots.pass;
      w.started(2);
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(2)]);
      w.task(1).busy = false;
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(2), taskId(3)]);
    }),
  );

  it.effect("never runs more than the cap: each free slot releases one task, in entry order", () =>
    Effect.gen(function* () {
      const w = world({ cap: 2, count: 6 });
      const slots = yield* makeDelegationSlots(w.deps);
      w.task(0).busy = false;
      w.task(1).busy = false;
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(2), taskId(3)]);
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(2), taskId(3)]);
      const working = w.tasks.filter(
        (entry) => entry.busy || (entry.queue !== undefined && entry.queue.hold === null),
      );
      assert.lengthOf(working, 2);
    }),
  );

  it.effect(
    "an archived, trashed or deleted task frees its slot; a gone waiting one never starts",
    () =>
      Effect.gen(function* () {
        const w = world({ cap: 2, count: 5 });
        const slots = yield* makeDelegationSlots(w.deps);
        // Archived while it still ran.
        w.task(0).archivedAt = at;
        // The next waiting task went to Trash (deleted, kept): it is skipped.
        w.task(2).deletedAt = at;
        yield* slots.pass;
        assert.deepEqual(w.released(), [taskId(3)]);
        w.started(3);
        w.task(1).deletedAt = at;
        yield* slots.pass;
        assert.deepEqual(w.released(), [taskId(3), taskId(4)]);
      }),
  );

  it.effect("a person's own Resume takes a slot", () =>
    Effect.gen(function* () {
      const w = world({ cap: 2, count: 4 });
      const slots = yield* makeDelegationSlots(w.deps);
      // The person resumed task 2 by hand (every cause it showed), and it runs.
      w.task(2).queue!.hold = null;
      w.started(2);
      w.task(0).busy = false;
      yield* slots.pass;
      // Tasks 1 and 2 work: task 3 keeps waiting.
      assert.deepEqual(w.released(), []);
      w.task(1).busy = false;
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(3)]);
    }),
  );

  it.effect(
    "only the slot's cause is released: another hold stays, and that task does not count",
    () =>
      Effect.gen(function* () {
        const w = world({ cap: 1, count: 3 });
        const slots = yield* makeDelegationSlots(w.deps);
        w.task(1).queue!.hold = {
          ...w.task(1).queue!.hold!,
          causeKeys: [slotKey, `paused:${at}`],
        };
        w.task(0).busy = false;
        yield* slots.pass;
        assert.deepEqual(w.released(), [taskId(1)]);
        assert.deepEqual(w.task(1).queue?.hold?.causeKeys, [`paused:${at}`]);
        // Paused by the person, it does not run: the next pass gives the slot to task 2.
        yield* slots.pass;
        assert.deepEqual(w.released(), [taskId(1), taskId(2)]);
      }),
  );

  it.effect("a restart rebuilds the request, its tasks and its cap from persisted state", () =>
    Effect.gen(function* () {
      const w = world({ cap: 2, count: 4 });
      const before = yield* makeDelegationSlots(w.deps);
      yield* before.pass;
      assert.strictEqual(w.reads.proposals, 1);
      // A new process: nothing in memory, the same queues, operation and plan.
      w.task(0).busy = false;
      const after = yield* makeDelegationSlots(w.deps);
      yield* after.pass;
      assert.strictEqual(w.reads.proposals, 2);
      assert.deepEqual(w.released(), [taskId(2)]);
      assert.deepEqual(
        waitingRequestIds((yield* w.deps.readModel).threads, DELEGATION_SLOT_CAUSE_PREFIX),
        [proposalId],
      );
    }),
  );

  it.effect("a replay never releases twice", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 3 });
      const slots = yield* makeDelegationSlots(w.deps);
      w.task(0).busy = false;
      // The release went through but its reply was lost.
      w.loseReply(true);
      yield* slots.pass;
      w.loseReply(false);
      assert.deepEqual(w.released(), [taskId(1)]);
      // The next pass, and a restarted process, see task 1 released: nothing is sent again.
      yield* slots.pass;
      yield* (yield* makeDelegationSlots(w.deps)).pass;
      assert.deepEqual(w.released(), [taskId(1)]);
      // Another attempt, under its own id, acknowledges a cause that is gone: nothing changes.
      w.task(1).queue!.hold = {
        reason: "paused",
        detail: null,
        causeKeys: ["paused:x"],
        heldAt: at,
      };
      yield* w.deps.dispatch({
        type: "thread.queue.resume",
        commandId: delegationSlotReleaseCommandId(proposalId, taskId(1), "later:1"),
        threadId: taskId(1),
        acknowledgeCauseKeys: [slotKey],
        createdAt: at,
      });
      assert.deepEqual(w.task(1).queue?.hold?.causeKeys, ["paused:x"]);
    }),
  );

  it.effect("a task cancelled while it waits never starts and frees nothing", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 3 });
      const slots = yield* makeDelegationSlots(w.deps);
      // ryco_task_cancel took task 1's first message out of its queue.
      w.task(1).cancelled = true;
      yield* w.deps.dispatch({
        type: "thread.queue.remove",
        commandId: delegationSlotCancelCommandId(proposalId, taskId(1)),
        threadId: taskId(1),
        messageIds: [firstMessage(1).messageId],
        createdAt: at,
      });
      assert.isUndefined(w.task(1).queue);
      // Task 0 still works: the cancelled task freed no slot.
      yield* slots.pass;
      assert.deepEqual(w.released(), []);
      w.task(0).busy = false;
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(2)]);
      w.started(2);
      w.task(2).busy = false;
      yield* slots.pass;
      yield* (yield* makeDelegationSlots(w.deps)).pass;
      assert.deepEqual(w.released(), [taskId(2)]);
      assert.isUndefined(w.task(1).queue);
    }),
  );

  it.effect(
    "a waiting task its chat stopped, archived or deleted, or that ran out of time, never starts",
    () =>
      Effect.gen(function* () {
        const w = world({ cap: 1, count: 4 });
        const slots = yield* makeDelegationSlots(w.deps);
        // The person stopped the delegating chat (or archived or deleted it): its return was
        // cancelled. Task 2's return expired after 7 days of waiting.
        w.task(1).returnStatus = "cancelled";
        w.task(2).returnStatus = "ready";
        w.task(0).busy = false;
        yield* slots.pass;
        // Both leave their queues; the slot goes to task 3.
        assert.deepEqual(w.released(), [taskId(3)]);
        assert.deepEqual(
          w.removals.map((command) => command.threadId),
          [taskId(1), taskId(2)],
        );
        assert.isUndefined(w.task(1).queue);
        assert.isUndefined(w.task(2).queue);
      }),
  );

  it.effect("a task whose goal continues keeps its slot through the goal's grace", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 2 });
      // A person's goal on a task an integration created (not a delegated child), whose provider
      // does not pursue goals: its turn just ended cleanly, and the goal starts the next one
      // after its grace.
      w.task(0).busy = false;
      w.task(0).shell = {
        goal: {
          status: "active",
          synchronization: { state: "unsupported" },
          updatedAt: "1970-01-01T00:00:00.000Z",
        },
        archivedAt: null,
        lineage: null,
        interactionMode: "default",
        hasActionableProposedPlan: false,
        latestTurn: {
          turnId: "turn-1",
          state: "completed",
          completedAt: "1970-01-01T00:00:01.000Z",
        },
      } as unknown as Partial<OrchestrationThreadShell>;
      const slots = yield* makeDelegationSlots(w.deps);
      yield* TestClock.adjust("10 seconds");
      yield* slots.pass;
      assert.deepEqual(w.released(), []);
      // No next turn came (its provider has no Agent Control tools, say): the slot frees.
      yield* TestClock.adjust("1 minute");
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(1)]);
    }),
  );

  it.effect("a cancel whose removal was lost is finished by a pass, also after a restart", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 3 });
      // The return was cancelled, but the removal never landed (a restart in between).
      w.task(1).cancelled = true;
      w.loseRemoval(true);
      w.task(0).busy = false;
      yield* (yield* makeDelegationSlots(w.deps)).pass;
      // Skipped: the slot goes to task 2, and the pass tried the cancel's own removal.
      assert.deepEqual(w.released(), [taskId(2)]);
      assert.deepEqual(
        w.removals.map((command) => command.commandId),
        [delegationSlotCancelCommandId(proposalId, taskId(1))],
      );
      assert.include(w.task(1).queue?.hold?.causeKeys ?? [], slotKey);
      // Restarted: still never started, and this time the removal lands.
      w.loseRemoval(false);
      w.started(2);
      w.task(2).busy = false;
      yield* (yield* makeDelegationSlots(w.deps)).pass;
      assert.deepEqual(w.released(), [taskId(2)]);
      assert.isUndefined(w.task(1).queue);
      assert.deepEqual(
        w.removals.map((command) => command.messageIds),
        [[firstMessage(1).messageId], [firstMessage(1).messageId]],
      );
    }),
  );

  it.effect(
    "releases nothing until the request's operation completed, and never after it failed",
    () =>
      Effect.gen(function* () {
        const w = world({ cap: 1, count: 3 });
        const slots = yield* makeDelegationSlots(w.deps);
        w.task(0).busy = false;
        // Still creating its tasks, or rolled back after a restart cut it off.
        for (const status of ["running", "compensating"] as const) {
          w.operation.status = status;
          yield* slots.pass;
        }
        assert.deepEqual(w.released(), []);
        w.operation.status = "failed";
        yield* slots.pass;
        const reads = w.reads.operations;
        yield* slots.pass;
        // A failed request is settled for good: no more reads, no release.
        assert.strictEqual(w.reads.operations, reads);
        assert.deepEqual(w.released(), []);
        // A completed one releases (a new process reads it afresh).
        w.operation.status = "completed";
        yield* (yield* makeDelegationSlots(w.deps)).pass;
        assert.deepEqual(w.released(), [taskId(1)]);
      }),
  );

  it.effect("a refused release does not block later attempts", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 3 });
      const slots = yield* makeDelegationSlots(w.deps);
      w.task(0).busy = false;
      // Refused once (the task was in Trash at that moment); the engine keeps the receipt.
      w.refuse.add(taskId(1));
      yield* slots.pass;
      assert.deepEqual(w.released(), []);
      w.refuse.delete(taskId(1));
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(1)]);
      assert.notStrictEqual(w.dispatched[0]!.commandId, w.dispatched[1]!.commandId);
    }),
  );

  it.effect("a cancelled task with other queued entries never starts; the agent's go too", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 3 });
      const agentFollowUp = { ...firstMessage(1), messageId: MessageId.make("agent-follow-up") };
      const personEntry = {
        ...firstMessage(1),
        messageId: MessageId.make("person-entry"),
        author: "user" as const,
      };
      w.task(1).queue!.entries.push(agentFollowUp, personEntry);
      w.task(1).cancelled = true;
      // The cancel took only the first message out (as before this fix).
      w.task(1).queue!.entries.shift();
      w.task(0).busy = false;
      const slots = yield* makeDelegationSlots(w.deps);
      yield* slots.pass;
      // Never released: the slot goes to task 2, and the agent's follow-up leaves too.
      assert.deepEqual(w.released(), [taskId(2)]);
      assert.deepEqual(
        w.removals.map((command) => command.messageIds.map(String)),
        [["agent-follow-up"]],
      );
      assert.deepEqual(
        w.task(1).queue?.entries.map((entry) => String(entry.messageId)),
        ["person-entry"],
      );
      assert.include(w.task(1).queue?.hold?.causeKeys ?? [], slotKey);
      w.started(2);
      w.task(2).busy = false;
      yield* slots.pass;
      yield* (yield* makeDelegationSlots(w.deps)).pass;
      assert.deepEqual(w.released(), [taskId(2)]);
    }),
  );

  it.effect("an archived waiting task does not keep its request polled", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 2 });
      w.task(1).archivedAt = at;
      const slots = yield* makeDelegationSlots(w.deps);
      yield* slots.pass;
      assert.strictEqual(w.reads.operations, 0);
      assert.deepEqual(
        waitingRequestIds((yield* w.deps.readModel).threads, DELEGATION_SLOT_CAUSE_PREFIX),
        [],
      );
      // Back from the archive, it waits again.
      w.task(1).archivedAt = null;
      w.task(0).busy = false;
      yield* slots.pass;
      assert.deepEqual(w.released(), [taskId(1)]);
    }),
  );

  it.effect("leaves holds alone when the request is unknown or not capped", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 2 });
      w.known.proposal = false;
      w.task(0).busy = false;
      yield* (yield* makeDelegationSlots(w.deps)).pass;
      assert.deepEqual(w.released(), []);
    }),
  );

  it.effect("passes when a capped request's creation completes", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 2 });
      w.operation.status = "running";
      w.task(0).busy = false;
      const domain = yield* PubSub.unbounded<OrchestrationEvent>();
      const proposals = yield* Queue.unbounded<AgentControlProposalStreamProposalEvent>();
      const fiber = yield* runDelegationSlots({
        ...w.deps,
        subscribeDomainEvents: Effect.map(PubSub.subscribe(domain), Stream.fromSubscription),
        proposalChanges: Stream.fromQueue(proposals),
      }).pipe(Effect.forkChild);
      const settle = Effect.repeat(Effect.yieldNow, { times: 50 });
      yield* settle;
      assert.deepEqual(w.released(), []);
      w.operation.status = "completed";
      yield* Queue.offer(proposals, {
        version: 1,
        type: "proposal",
        revision: 1,
        proposal: {
          status: "completed",
          plan: { kind: "createThreads", entries: [], maxConcurrent: 1 },
        },
      } as unknown as AgentControlProposalStreamProposalEvent);
      yield* settle;
      assert.deepEqual(w.released(), [taskId(1)]);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("passes once at start and again after a task's session event", () =>
    Effect.gen(function* () {
      const w = world({ cap: 1, count: 3 });
      const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
      const fiber = yield* runDelegationSlots({
        ...w.deps,
        subscribeDomainEvents: Effect.map(PubSub.subscribe(pubsub), Stream.fromSubscription),
      }).pipe(Effect.forkChild);
      const settle = Effect.repeat(Effect.yieldNow, { times: 50 });
      yield* settle;
      assert.deepEqual(w.released(), []);
      w.task(0).busy = false;
      yield* PubSub.publish(pubsub, {
        type: "thread.session-set",
        aggregateKind: "thread",
        aggregateId: taskId(0),
        payload: {},
      } as unknown as OrchestrationEvent);
      yield* settle;
      assert.deepEqual(w.released(), [taskId(1)]);
      yield* Fiber.interrupt(fiber);
    }),
  );
});

describe("delegation slot rules", () => {
  it("releases the first waiting tasks while fewer than the cap work", () => {
    const tasks = [
      { threadId: taskId(0), state: "working" as const },
      { threadId: taskId(1), state: "idle" as const },
      { threadId: taskId(2), state: "waiting" as const },
      { threadId: taskId(3), state: "gone" as const },
      { threadId: taskId(4), state: "waiting" as const },
      { threadId: taskId(5), state: "waiting" as const },
    ];
    assert.deepEqual(tasksToRelease(tasks, 3), [taskId(2), taskId(4)]);
    assert.deepEqual(tasksToRelease(tasks, 1), []);
  });

  it("wakes on what can end a task's work, not on its progress", () => {
    const event = (type: string, payload: unknown = {}) =>
      ({ type, aggregateKind: "thread", aggregateId: taskId(0), payload }) as OrchestrationEvent;
    assert.isTrue(isDelegationSlotWakeEvent(event("thread.session-set")));
    assert.isTrue(isDelegationSlotWakeEvent(event("thread.archived")));
    assert.isTrue(isDelegationSlotWakeEvent(event("thread.queue-released")));
    assert.isTrue(
      isDelegationSlotWakeEvent(
        event("thread.activity-appended", { activity: { kind: "provider.turn.start.failed" } }),
      ),
    );
    assert.isFalse(
      isDelegationSlotWakeEvent(event("thread.activity-appended", { activity: { kind: "tool" } })),
    );
    assert.isFalse(isDelegationSlotWakeEvent(event("thread.message-sent")));
  });

  it("a restart holds every left queue but one that only waits for a slot", () => {
    const thread = (id: string, causeKeys: ReadonlyArray<string> | null) => ({
      id: ThreadId.make(id),
      followUpQueue: {
        entries: [firstMessage(0)],
        hold: causeKeys === null ? null : { reason: "paused", detail: null, causeKeys, heldAt: at },
      },
    });
    const threads = [
      thread("unheld", null),
      thread("slot", [slotKey]),
      thread("slot-and-paused", [slotKey, "paused:x"]),
      thread("paused", ["paused:x"]),
    ] as unknown as OrchestrationReadModel["threads"];
    assert.deepEqual(threadsQueuedAtBoot(threads), ["unheld", "slot-and-paused", "paused"]);
    assert.isTrue(heldOnlyForDelegationSlot({ causeKeys: [slotKey] }));
    assert.isFalse(heldOnlyForDelegationSlot({ causeKeys: [] }));
    assert.isFalse(heldOnlyForDelegationSlot(null));
  });

  it("loads the runtime for a live waiting task only", () => {
    const thread = (archivedAt: string | null, deletedAt: string | null) => ({
      archivedAt,
      deletedAt,
      followUpQueue: {
        entries: [firstMessage(1)],
        hold: { reason: "paused", detail: null, causeKeys: [slotKey], heldAt: at },
      },
    });
    const threads = (...list: ReadonlyArray<ReturnType<typeof thread>>) =>
      list as unknown as OrchestrationReadModel["threads"];
    assert.isTrue(anyLiveTaskWaitsForSlot(threads(thread(null, null))));
    assert.isFalse(anyLiveTaskWaitsForSlot(threads(thread(at, null), thread(null, at))));
  });

  it("names the slot in the hold the person sees", () => {
    assert.deepEqual(delegationSlotHold(proposalId, 2), {
      reason: "paused",
      detail: "Waiting for a free slot: this request runs at most 2 tasks at once.",
      causeKeys: [slotKey],
    });
    assert.include(delegationSlotHold(proposalId, 1).detail, "at most 1 task at once");
  });
});
