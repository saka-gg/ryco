import {
  COMMAND_WATCH_WAKES_PER_DAY,
  COMMAND_WATCHES_PER_NODE,
  COMMAND_WATCHES_PER_THREAD,
  ClientOrchestrationCommand,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadCommandWatch,
  type ThreadCommandWatchUpdateCommand,
} from "@ryco/contracts";
import { Cause, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { COMMAND_WATCH_CHANGED_DETAIL } from "./commandWatchUpdates.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-10-04T10:00:00.000Z";
const startedAt = "2026-10-04T10:05:00.000Z";
const updateAt = "2026-10-04T10:10:00.000Z";
const projectId = ProjectId.make("project-command-watch");
const threadId = ThreadId.make("thread-command-watch");
const userMessageId = MessageId.make("message-user-1");
const codex = ProviderInstanceId.make("codex");
const watchId = "command-watch:11111111-1111-4111-8111-111111111111";
const worktreePath = "/tmp/command-watch";

let seedSequence = 0;
function seedEvent(
  event: Omit<
    OrchestrationEvent,
    "sequence" | "eventId" | "causationEventId" | "correlationId" | "metadata"
  >,
): OrchestrationEvent {
  seedSequence += 1;
  return {
    ...event,
    sequence: seedSequence,
    eventId: EventId.make(`event-seed-${seedSequence}`),
    causationEventId: null,
    correlationId: event.commandId,
    metadata: {},
  } as OrchestrationEvent;
}

async function seed(): Promise<OrchestrationReadModel> {
  let model = createEmptyReadModel(createdAt);
  const events: Array<Parameters<typeof seedEvent>[0]> = [
    {
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: createdAt,
      commandId: CommandId.make("seed-project"),
      payload: {
        projectId,
        title: "Watch",
        workspaceRoot: "/tmp/command-watch-root",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: createdAt,
      commandId: CommandId.make("seed-thread"),
      payload: {
        threadId,
        projectId,
        title: "Watch",
        modelSelection: { instanceId: codex, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath,
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.message-sent",
      occurredAt: createdAt,
      commandId: CommandId.make("seed-message"),
      payload: {
        threadId,
        messageId: userMessageId,
        role: "user",
        text: "Wait for the maintainer's reply",
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.session-set",
      occurredAt: createdAt,
      commandId: CommandId.make("provider:seed-session"),
      payload: {
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: codex,
          runtimeSessionId: RuntimeSessionId.make("runtime-1"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
      },
    },
  ];
  for (const event of events) {
    model = await Effect.runPromise(projectEvent(model, seedEvent(event)));
  }
  return model;
}

function watch(overrides: Partial<ThreadCommandWatch> = {}): ThreadCommandWatch {
  return {
    watchId,
    command: "gh issue view 12 --json comments --jq '.comments[-1].body'",
    label: "Maintainer reply on #12",
    everyMinutes: 10,
    revision: 1,
    startedAt,
    runtimeMode: "full-access",
    worktreePath,
    cwd: worktreePath,
    lastOutputHash: null,
    wakes: 0,
    lastChangeAt: null,
    delivery: null,
    beforeWake: null,
    ...overrides,
  };
}

let commandSequence = 0;
function update(
  overrides: Partial<Omit<ThreadCommandWatchUpdateCommand, "type">> = {},
): ThreadCommandWatchUpdateCommand {
  commandSequence += 1;
  return {
    type: "thread.command-watch.update",
    commandId: CommandId.make(`server:command-watch:test:${commandSequence}`),
    threadId,
    watchId,
    expectedRevision: null,
    expectedStartedAt: null,
    next: watch(),
    createdAt: updateAt,
    ...overrides,
  };
}

/** A wake update from revision `revision`: the progress, the pending delivery and the turn. */
function withWake(
  revision: number,
  input: { readonly latestUserMessageId?: MessageId; readonly runtimeMode?: "full-access" } = {},
): ThreadCommandWatchUpdateCommand {
  const messageId = MessageId.make(`command-watch:${threadId}:wake-${revision}`);
  return update({
    expectedRevision: revision,
    expectedStartedAt: startedAt,
    next: watch({
      revision: revision + 1,
      lastOutputHash: "b".repeat(64),
      wakes: 1,
      lastChangeAt: updateAt,
      delivery: { messageId, sentAt: updateAt },
      beforeWake: { lastOutputHash: "a".repeat(64), wakes: 0 },
    }),
    wake: {
      messageId,
      text: "New output from the command Ryco is watching for you.",
      guard: {
        latestUserMessageId: input.latestUserMessageId ?? userMessageId,
        projectId,
        runtimeMode: input.runtimeMode ?? "full-access",
        worktreePath,
      },
    },
  });
}

async function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  return Effect.runPromise(Effect.exit(decideOrchestrationCommand({ command, readModel })));
}

async function rejection(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const exit = await decide(readModel, command);
  if (Exit.isSuccess(exit)) throw new Error(`expected ${command.type} to be rejected`);
  return Cause.pretty(exit.cause);
}

async function dispatch(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  const planned = Array.isArray(result) ? result : [result];
  let next = readModel;
  const events: OrchestrationEvent[] = [];
  for (const entry of planned) {
    const event = { ...entry, sequence: next.snapshotSequence + 1 } as OrchestrationEvent;
    events.push(event);
    next = await Effect.runPromise(projectEvent(next, event));
  }
  return { events, readModel: next };
}

const threadOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === threadId)!;

/** A chat with one watch whose baseline was recorded (revision 1). */
async function watched(): Promise<OrchestrationReadModel> {
  return (await dispatch(await seed(), update({ next: watch({ lastOutputHash: null }) })))
    .readModel;
}

const endedReasons = (events: ReadonlyArray<OrchestrationEvent>) =>
  events.flatMap((event) =>
    event.type === "thread.command-watch-updated"
      ? event.payload.changed.map((change) => change.ended)
      : [],
  );

describe("thread.command-watch.update", () => {
  it("starts a watch from the chat's own scope, with no runs yet", async () => {
    const { events, readModel } = await dispatch(await seed(), update());
    expect(events.map((event) => event.type)).toEqual(["thread.command-watch-updated"]);
    expect(threadOf(readModel).commandWatchState?.active).toEqual([watch()]);
    // Watch state is not thread activity.
    expect(threadOf(readModel).updatedAt).toBe(createdAt);

    expect(await rejection(readModel, update())).toContain(COMMAND_WATCH_CHANGED_DETAIL);
    expect(await rejection(await seed(), update({ next: watch({ revision: 2 }) }))).toContain(
      "one revision at a time",
    );
    // The captured scope is the chat's own, and a new watch has no progress to claim.
    for (const next of [
      watch({ worktreePath: "/somewhere/else" }),
      watch({ runtimeMode: "approval-required" }),
      watch({ lastOutputHash: "c".repeat(64) }),
      watch({ wakes: 3 }),
    ]) {
      expect(await rejection(await seed(), update({ next }))).toContain("chat's own scope");
    }
  });

  it("rejects a stale revision, a stale generation and a change of what runs", async () => {
    const readModel = await watched();
    expect(
      await rejection(
        readModel,
        update({ expectedRevision: 2, expectedStartedAt: startedAt, next: watch({ revision: 3 }) }),
      ),
    ).toContain(COMMAND_WATCH_CHANGED_DETAIL);
    expect(
      await rejection(
        readModel,
        update({
          expectedRevision: 1,
          expectedStartedAt: "2026-10-04T10:06:00.000Z",
          next: watch({ revision: 2 }),
        }),
      ),
    ).toContain(COMMAND_WATCH_CHANGED_DETAIL);
    for (const changed of [
      { command: "curl -s https://example.com/elsewhere" },
      { cwd: "/" },
      { everyMinutes: 1 },
      { startedAt: "2026-10-04T10:06:00.000Z" },
    ]) {
      expect(
        await rejection(
          readModel,
          update({
            expectedRevision: 1,
            expectedStartedAt: startedAt,
            next: watch({ revision: 2, ...changed }),
          }),
        ),
      ).toContain(COMMAND_WATCH_CHANGED_DETAIL);
    }
    // A baseline is a plain change.
    const baseline = await dispatch(
      readModel,
      update({
        expectedRevision: 1,
        expectedStartedAt: startedAt,
        next: watch({ revision: 2, lastOutputHash: "a".repeat(64) }),
      }),
    );
    expect(threadOf(baseline.readModel).commandWatchState?.active[0]?.lastOutputHash).toBe(
      "a".repeat(64),
    );
  });

  it("refuses chats outside Full access or default mode, and settled or archived chats", async () => {
    const approval = await dispatch(await seed(), {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("client-runtime"),
      threadId,
      runtimeMode: "approval-required",
      createdAt: updateAt,
    });
    expect(
      await rejection(
        approval.readModel,
        update({ next: watch({ runtimeMode: "approval-required" }) }),
      ),
    ).toContain("Full access and default mode");

    const planning = await dispatch(await seed(), {
      type: "thread.interaction-mode.set",
      commandId: CommandId.make("client-plan"),
      threadId,
      interactionMode: "plan",
      createdAt: updateAt,
    });
    expect(await rejection(planning.readModel, update())).toContain("Full access and default mode");

    const settled = await dispatch(await seed(), {
      type: "thread.settle",
      commandId: CommandId.make("client-settle"),
      threadId,
    });
    expect(await rejection(settled.readModel, update())).toContain("settled chat");

    const archived = await dispatch(await seed(), {
      type: "thread.archive",
      commandId: CommandId.make("client-archive"),
      threadId,
    });
    expect(await rejection(archived.readModel, update())).toContain("Archived");

    const trashed = await dispatch(await seed(), {
      type: "thread.trash",
      commandId: CommandId.make("client-trash"),
      threadId,
    });
    expect(await rejection(trashed.readModel, update())).toContain("Trash");
  });

  it(`refuses a duplicate command, a watch past ${COMMAND_WATCHES_PER_THREAD} per chat and past ${COMMAND_WATCHES_PER_NODE} per node`, async () => {
    const readModel = await watched();
    expect(
      await rejection(
        readModel,
        update({ watchId: "command-watch:other", next: watch({ watchId: "command-watch:other" }) }),
      ),
    ).toContain("already watches that command");

    let full = readModel;
    for (let index = 1; index < COMMAND_WATCHES_PER_THREAD; index += 1) {
      const id = `command-watch:${index}`;
      full = (
        await dispatch(
          full,
          update({ watchId: id, next: watch({ watchId: id, command: `echo ${index}` }) }),
        )
      ).readModel;
    }
    expect(threadOf(full).commandWatchState?.active).toHaveLength(COMMAND_WATCHES_PER_THREAD);
    expect(
      await rejection(
        full,
        update({
          watchId: "command-watch:six",
          next: watch({ watchId: "command-watch:six", command: "echo six" }),
        }),
      ),
    ).toContain(`at most ${COMMAND_WATCHES_PER_THREAD} command watches`);

    // The node's cap counts every chat's active watches.
    const crowded: OrchestrationReadModel = {
      ...readModel,
      threads: [
        ...readModel.threads,
        {
          ...threadOf(readModel),
          id: ThreadId.make("thread-elsewhere"),
          commandWatchState: {
            active: Array.from({ length: COMMAND_WATCHES_PER_NODE - 1 }, (_, index) =>
              watch({ watchId: `command-watch:elsewhere-${index}`, command: `echo ${index}` }),
            ),
            ended: [],
            recentWakes: [],
          },
        },
      ],
    };
    expect(
      await rejection(
        crowded,
        update({
          watchId: "command-watch:51",
          next: watch({ watchId: "command-watch:51", command: "echo 51" }),
        }),
      ),
    ).toContain(`at most ${COMMAND_WATCHES_PER_NODE} command watches`);
  });

  it("emits the watch event, then the wake's message and turn start under one command id", async () => {
    const command = withWake(1);
    const { events, readModel } = await dispatch(await watched(), command);
    expect(events.map((event) => event.type)).toEqual([
      "thread.command-watch-updated",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(new Set(events.map((event) => event.commandId))).toEqual(new Set([command.commandId]));
    const turnStart = events[2];
    if (turnStart?.type !== "thread.turn-start-requested") throw new Error("no turn start");
    expect(turnStart.payload.delegationReturnGuard?.source).toBe("command-watch");
    expect(turnStart.payload.messageId).toBe(command.wake?.messageId);
    expect(threadOf(readModel).commandWatchState?.active[0]?.delivery?.messageId).toBe(
      command.wake?.messageId,
    );
  });

  it("rejects the whole update, progress included, when the chat moved on or is busy", async () => {
    const readModel = await watched();
    // The user typed after the run read the chat.
    expect(
      await rejection(
        readModel,
        withWake(1, { latestUserMessageId: MessageId.make("message-before-the-users-latest") }),
      ),
    ).toContain("The chat changed while this command watch update was prepared.");

    const running = await dispatch(readModel, {
      type: "thread.session.set",
      commandId: CommandId.make("provider:running"),
      threadId,
      session: {
        ...threadOf(readModel).session!,
        status: "running",
        activeTurnId: TurnId.make("turn-running"),
      },
      createdAt: updateAt,
    });
    expect(await rejection(running.readModel, withWake(1))).toBeTruthy();
    expect(threadOf(running.readModel).commandWatchState?.active[0]?.revision).toBe(1);

    const command = withWake(1);
    expect(
      await rejection(readModel, { ...command, next: { ...command.next!, delivery: null } }),
    ).toContain("does not record this update as sent");
    expect(
      await rejection(readModel, {
        ...command,
        wake: { ...command.wake!, messageId: MessageId.make("not-a-watch-message") },
      }),
    ).toContain("command watch message id");
  });

  it("ends watches in the mode change that leaves Full access or default mode, so a round trip cannot keep them", async () => {
    for (const leave of [
      { type: "thread.runtime-mode.set", runtimeMode: "auto-accept-edits" },
      { type: "thread.runtime-mode.set", runtimeMode: "approval-required" },
      { type: "thread.interaction-mode.set", interactionMode: "plan" },
    ] as const) {
      const left = await dispatch(await watched(), {
        ...leave,
        commandId: CommandId.make("client-leave"),
        threadId,
        createdAt: updateAt,
      } as OrchestrationCommand);
      expect(left.events.map((event) => event.type)).toEqual([
        leave.type === "thread.runtime-mode.set"
          ? "thread.runtime-mode-set"
          : "thread.interaction-mode-set",
        "thread.command-watch-updated",
      ]);
      expect(endedReasons(left.events)).toEqual(["scope-changed"]);
      expect(new Set(left.events.map((event) => event.commandId)).size).toBe(1);
      // Coming straight back starts nothing again.
      const back = await dispatch(
        left.readModel,
        (leave.type === "thread.runtime-mode.set"
          ? {
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("client-back"),
              threadId,
              runtimeMode: "full-access",
              createdAt: updateAt,
            }
          : {
              type: "thread.interaction-mode.set",
              commandId: CommandId.make("client-back"),
              threadId,
              interactionMode: "default",
              createdAt: updateAt,
            }) as OrchestrationCommand,
      );
      expect(back.events).toHaveLength(1);
      expect(threadOf(back.readModel).commandWatchState?.active).toEqual([]);
      // The run that was in flight cannot wake the chat.
      expect(await rejection(back.readModel, withWake(1))).toContain(COMMAND_WATCH_CHANGED_DETAIL);
    }
    // Staying in scope ends nothing.
    const stay = await dispatch(await watched(), {
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("client-stay"),
      threadId,
      runtimeMode: "full-access",
      createdAt: updateAt,
    });
    expect(stay.events.map((event) => event.type)).toEqual(["thread.runtime-mode-set"]);
  });

  it("refuses a wake or a change once the chat moved to another checkout, and a start elsewhere", async () => {
    const moved = await dispatch(await watched(), {
      type: "thread.meta.update",
      commandId: CommandId.make("client-move"),
      threadId,
      worktreePath: "/tmp/command-watch-elsewhere",
    } as OrchestrationCommand);
    expect(threadOf(moved.readModel).worktreePath).toBe("/tmp/command-watch-elsewhere");
    expect(await rejection(moved.readModel, withWake(1))).toContain(
      "checkout or permissions changed",
    );
    expect(
      await rejection(
        moved.readModel,
        update({
          expectedRevision: 1,
          expectedStartedAt: startedAt,
          next: watch({ revision: 2, lastOutputHash: "a".repeat(64) }),
        }),
      ),
    ).toContain("checkout or permissions changed");
    // Ending still works.
    const ended = await dispatch(
      moved.readModel,
      update({
        expectedRevision: 1,
        expectedStartedAt: startedAt,
        next: null,
        endReason: "scope-changed",
      }),
    );
    expect(endedReasons(ended.events)).toEqual(["scope-changed"]);
    // A new watch's directory is the chat's, never another one.
    expect(await rejection(await seed(), update({ next: watch({ cwd: "/etc" }) }))).toContain(
      "chat's own scope",
    );
  });

  it(`spends a daily budget of ${COMMAND_WATCH_WAKES_PER_DAY} wakes across the chat's watches`, async () => {
    const readModel = await watched();
    const thread = threadOf(readModel);
    const now = Date.parse(updateAt);
    const spent = (count: number, agoMs: number): OrchestrationReadModel => ({
      ...readModel,
      threads: readModel.threads.map((entry) =>
        entry.id !== threadId
          ? entry
          : {
              ...thread,
              commandWatchState: {
                ...thread.commandWatchState!,
                recentWakes: Array.from({ length: count }, (_, index) =>
                  new Date(now - agoMs - index * 1_000).toISOString(),
                ),
              },
            },
      ),
    });
    expect(await rejection(spent(COMMAND_WATCH_WAKES_PER_DAY, 60_000), withWake(1))).toContain(
      `woke it ${COMMAND_WATCH_WAKES_PER_DAY} times in the last 24 hours`,
    );
    // Wakes older than a day no longer count, and an accepted wake is added.
    const old = await dispatch(spent(COMMAND_WATCH_WAKES_PER_DAY, 25 * 60 * 60_000), withWake(1));
    expect(threadOf(old.readModel).commandWatchState?.recentWakes).toEqual([updateAt]);
    // A closing message counts too, and lifecycle ends keep the window.
    const one = await dispatch(spent(COMMAND_WATCH_WAKES_PER_DAY - 1, 60_000), withWake(1));
    expect(threadOf(one.readModel).commandWatchState?.recentWakes).toHaveLength(
      COMMAND_WATCH_WAKES_PER_DAY,
    );
    const archived = await dispatch(one.readModel, {
      type: "thread.archive",
      commandId: CommandId.make("client-archive-budget"),
      threadId,
    });
    expect(threadOf(archived.readModel).commandWatchState?.recentWakes).toHaveLength(
      COMMAND_WATCH_WAKES_PER_DAY,
    );
  });

  it("ends a watch with a closing wake", async () => {
    const messageId = MessageId.make(`command-watch:${threadId}:closing`);
    const { events } = await dispatch(
      await watched(),
      update({
        expectedRevision: 1,
        expectedStartedAt: startedAt,
        next: null,
        endReason: "too-long",
        wake: {
          messageId,
          text: "Ryco stopped watching the command.",
          guard: {
            latestUserMessageId: userMessageId,
            projectId,
            runtimeMode: "full-access",
            worktreePath,
          },
        },
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "thread.command-watch-updated",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(endedReasons(events)).toEqual(["too-long"]);
  });
});

describe("command watch lifecycle", () => {
  it("a user Stop ends the thread's command watches in the same command; the node's does not", async () => {
    const readModel = await watched();
    const stopped = await dispatch(readModel, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("client-interrupt"),
      threadId,
      createdAt: updateAt,
    });
    expect(stopped.events.map((event) => event.type)).toEqual([
      "thread.turn-interrupt-requested",
      "thread.command-watch-updated",
    ]);
    expect(endedReasons(stopped.events)).toEqual(["stopped"]);
    expect(new Set(stopped.events.map((event) => event.commandId)).size).toBe(1);
    expect(threadOf(stopped.readModel).commandWatchState?.active).toEqual([]);

    const nodeInterrupt = await dispatch(readModel, {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("agent-control:operation:turn-interrupt"),
      threadId,
      createdAt: updateAt,
    });
    expect(nodeInterrupt.events.map((event) => event.type)).toEqual([
      "thread.turn-interrupt-requested",
    ]);

    const sessionStop = await dispatch(readModel, {
      type: "thread.session.stop",
      commandId: CommandId.make("client-stop"),
      threadId,
      userStop: true,
      createdAt: updateAt,
    });
    expect(endedReasons(sessionStop.events)).toEqual(["stopped"]);
  });

  it.each([
    ["thread.settle", "settled"],
    ["thread.archive", "archived"],
    ["thread.trash", "trashed"],
  ] as const)("%s ends command watches as %s in the same command", async (type, reason) => {
    const { events } = await dispatch(await watched(), {
      type,
      commandId: CommandId.make(`client-${type}`),
      threadId,
    } as OrchestrationCommand);
    expect(events[0]?.type).not.toBe("thread.command-watch-updated");
    expect(endedReasons(events)).toEqual([reason]);
    expect(new Set(events.map((event) => event.commandId)).size).toBe(1);
  });

  it("commands of chats without command watches keep exactly their own events", async () => {
    const { events } = await dispatch(await seed(), {
      type: "thread.archive",
      commandId: CommandId.make("client-archive"),
      threadId,
    });
    expect(events.map((event) => event.type)).toEqual(["thread.archived"]);
  });
});

describe("thread.command-watch.stop", () => {
  it("is the only command watch command a client can send", () => {
    const decode = Schema.decodeUnknownExit(ClientOrchestrationCommand);
    expect(
      Exit.isSuccess(
        decode({
          type: "thread.command-watch.stop",
          commandId: "client-stop",
          threadId,
          createdAt: updateAt,
        }),
      ),
    ).toBe(true);
    expect(Exit.isSuccess(decode(update()))).toBe(false);
  });

  it("stops one watch, every watch, and nothing without a watch", async () => {
    const readModel = await watched();
    const other = "command-watch:other";
    const two = (
      await dispatch(
        readModel,
        update({ watchId: other, next: watch({ watchId: other, command: "echo other" }) }),
      )
    ).readModel;

    const one = await dispatch(two, {
      type: "thread.command-watch.stop",
      commandId: CommandId.make("client-stop-one"),
      threadId,
      watchId: other,
      createdAt: updateAt,
    });
    expect(endedReasons(one.events)).toEqual(["unwatched"]);
    expect(threadOf(one.readModel).commandWatchState?.active.map((entry) => entry.watchId)).toEqual(
      [watchId],
    );

    const all = await dispatch(two, {
      type: "thread.command-watch.stop",
      commandId: CommandId.make("client-stop-all"),
      threadId,
      createdAt: updateAt,
    });
    expect(endedReasons(all.events)).toEqual(["unwatched", "unwatched"]);
    expect(threadOf(all.readModel).commandWatchState?.active).toEqual([]);

    const none = await dispatch(all.readModel, {
      type: "thread.command-watch.stop",
      commandId: CommandId.make("client-stop-none"),
      threadId,
      createdAt: updateAt,
    });
    expect(none.events).toEqual([]);
  });
});
