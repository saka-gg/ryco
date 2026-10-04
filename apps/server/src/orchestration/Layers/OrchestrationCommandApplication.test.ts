import {
  CommandId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
  type InternalOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { pipeArguments } from "effect/Pipeable";

import { ServerConfig } from "../../config.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { OrchestrationCommandApplication } from "../Services/OrchestrationCommandApplication.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationCommandApplicationLive,
  applyOrchestrationCommand,
  applyOrchestrationNormalizedCommand,
  makeOrchestrationCommandFlights,
} from "./OrchestrationCommandApplication.ts";

const threadId = ThreadId.make("thread-archive");

it.effect(
  "applies archive through the shared dispatcher and preserves session/terminal cleanup",
  () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationCommand[] = [];
      const close = vi.fn((_input: { readonly threadId: ThreadId }) => Effect.void);
      const command: OrchestrationCommand = {
        type: "thread.archive",
        commandId: CommandId.make("archive-command"),
        threadId,
      };

      const result = yield* applyOrchestrationNormalizedCommand({
        command,
        dispatch: (next) => {
          dispatched.push(next);
          return Effect.succeed({ sequence: dispatched.length });
        },
        projections: {
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                id: threadId,
                session: { status: "running" },
              } as OrchestrationThreadShell),
            ),
        } as unknown as ProjectionSnapshotQueryShape,
        terminals: { close } as unknown as TerminalManagerShape,
      });

      assert.strictEqual(result.sequence, 1);
      assert.deepStrictEqual(
        dispatched.map((entry) => entry.type),
        ["thread.archive", "thread.session.stop"],
      );
      assert.strictEqual(
        dispatched[1]?.commandId,
        CommandId.make("session-stop-for-archive:archive-command"),
      );
      assert.strictEqual(close.mock.calls.length, 1);
      assert.deepStrictEqual(close.mock.calls[0]?.[0], { threadId });
    }),
);

it.effect("does not add archive cleanup to unrelated commands", () =>
  Effect.gen(function* () {
    const dispatched: OrchestrationCommand[] = [];
    const close = vi.fn((_input: { readonly threadId: ThreadId }) => Effect.void);
    const command: OrchestrationCommand = {
      type: "thread.meta.update",
      commandId: CommandId.make("title-command"),
      threadId,
      title: "Renamed",
    };

    yield* applyOrchestrationNormalizedCommand({
      command,
      dispatch: (next) => {
        dispatched.push(next);
        return Effect.succeed({ sequence: 1 });
      },
      projections: {} as ProjectionSnapshotQueryShape,
      terminals: { close } as unknown as TerminalManagerShape,
    });

    assert.deepStrictEqual(dispatched, [command]);
    assert.strictEqual(close.mock.calls.length, 0);
  }),
);

const receiptsWith = (
  receipt: OrchestrationCommandReceipt | null,
): Pick<OrchestrationCommandReceiptRepositoryShape, "getByCommandId"> => ({
  getByCommandId: () => Effect.succeed(Option.fromNullishOr(receipt)),
});

const replayedCommand: ClientOrchestrationCommand = {
  type: "thread.meta.update",
  commandId: CommandId.make("replayed-command"),
  threadId,
  title: "Renamed",
};

const receipt = (
  status: OrchestrationCommandReceipt["status"],
  error: string | null = null,
): OrchestrationCommandReceipt => ({
  commandId: replayedCommand.commandId,
  aggregateKind: "thread",
  aggregateId: threadId,
  acceptedAt: "2026-01-01T00:00:00.000Z",
  resultSequence: 42,
  status,
  error,
});

/** A replay whose first attempt consumed what normalization needs (an adopted upload). */
const normalizeAfterFirstAttempt = () =>
  Effect.fail(new OrchestrationDispatchCommandError({ message: "unknown or already-used upload" }));

it.effect("answers a replayed command from its accepted receipt before normalizing it", () =>
  Effect.gen(function* () {
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const result = yield* applyOrchestrationCommand({
      command: replayedCommand,
      normalize: normalizeAfterFirstAttempt,
      dispatch,
      projections: {} as ProjectionSnapshotQueryShape,
      terminals: {} as TerminalManagerShape,
      receipts: receiptsWith(receipt("accepted")),
    });

    assert.strictEqual(result.sequence, 42);
    assert.strictEqual(dispatch.mock.calls.length, 0);
  }),
);

it.effect("answers a replayed command from its rejected receipt with the prior rejection", () =>
  Effect.gen(function* () {
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const error = yield* applyOrchestrationCommand({
      command: replayedCommand,
      normalize: normalizeAfterFirstAttempt,
      dispatch,
      projections: {} as ProjectionSnapshotQueryShape,
      terminals: {} as TerminalManagerShape,
      receipts: receiptsWith(receipt("rejected", "thread was busy")),
    }).pipe(Effect.flip);

    assert.strictEqual(error._tag, "OrchestrationDispatchCommandError");
    assert.include(error.message, "Command previously rejected (replayed-command)");
    assert.include(error.message, "thread was busy");
    assert.strictEqual(dispatch.mock.calls.length, 0);
  }),
);

it.effect("normalizes and dispatches a command the node has not seen", () =>
  Effect.gen(function* () {
    const normalize = vi.fn((command: ClientOrchestrationCommand) =>
      Effect.succeed(command as OrchestrationCommand),
    );
    const result = yield* applyOrchestrationCommand({
      command: replayedCommand,
      normalize,
      dispatch: () => Effect.succeed({ sequence: 7 }),
      projections: {} as ProjectionSnapshotQueryShape,
      terminals: {} as TerminalManagerShape,
      receipts: receiptsWith(null),
    });

    assert.strictEqual(result.sequence, 7);
    assert.strictEqual(normalize.mock.calls.length, 1);
  }),
);

it.effect("falls through to the engine's own receipt check when the receipt read fails", () =>
  Effect.gen(function* () {
    const result = yield* applyOrchestrationCommand({
      command: replayedCommand,
      normalize: (command) => Effect.succeed(command as OrchestrationCommand),
      dispatch: () => Effect.succeed({ sequence: 8 }),
      projections: {} as ProjectionSnapshotQueryShape,
      terminals: {} as TerminalManagerShape,
      receipts: {
        getByCommandId: () =>
          Effect.fail(
            new PersistenceSqlError({ operation: "receipt lookup", detail: "database busy" }),
          ),
      },
    });

    assert.strictEqual(result.sequence, 8);
  }),
);

it.effect("keeps an archive replay on the full path so its cleanup still runs", () =>
  Effect.gen(function* () {
    const close = vi.fn((_input: { readonly threadId: ThreadId }) => Effect.void);
    const dispatched: OrchestrationCommand[] = [];
    const archive: ClientOrchestrationCommand = {
      type: "thread.archive",
      commandId: CommandId.make("replayed-archive"),
      threadId,
    };
    const result = yield* applyOrchestrationCommand({
      command: archive,
      normalize: (command) => Effect.succeed(command as OrchestrationCommand),
      dispatch: (next) => {
        dispatched.push(next);
        // The engine answers the replay from its receipt.
        return Effect.succeed({ sequence: 42 });
      },
      projections: {
        getThreadShellById: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQueryShape,
      terminals: { close } as unknown as TerminalManagerShape,
      receipts: receiptsWith({ ...receipt("accepted"), commandId: archive.commandId }),
    });

    assert.strictEqual(result.sequence, 42);
    assert.deepStrictEqual(
      dispatched.map((entry) => entry.type),
      ["thread.archive"],
    );
    assert.strictEqual(close.mock.calls.length, 1);
  }),
);

it.effect("answers an overlapping replay from the attempt that is still running", () =>
  Effect.gen(function* () {
    const flights = makeOrchestrationCommandFlights();
    const release = yield* Deferred.make<void>();
    let runs = 0;
    const apply = () =>
      applyOrchestrationCommand({
        command: replayedCommand,
        normalize: (command) => Effect.succeed(command as OrchestrationCommand),
        dispatch: () =>
          Effect.suspend(() => {
            runs += 1;
            // A bootstrap turn start: its receipt exists only once it finishes.
            return Deferred.await(release).pipe(Effect.as({ sequence: 11 }));
          }),
        projections: {} as ProjectionSnapshotQueryShape,
        terminals: {} as TerminalManagerShape,
        receipts: receiptsWith(null),
        flights,
      });

    const first = yield* apply().pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const replay = yield* apply().pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);

    assert.deepStrictEqual(yield* Fiber.join(first), { sequence: 11 });
    assert.deepStrictEqual(yield* Fiber.join(replay), { sequence: 11 });
    assert.strictEqual(runs, 1);
  }),
);

it.effect("keeps running a command whose requester disconnected", () =>
  Effect.gen(function* () {
    const flights = makeOrchestrationCommandFlights();
    const release = yield* Deferred.make<void>();
    let runs = 0;
    let completed = 0;
    const apply = () =>
      applyOrchestrationCommand({
        command: replayedCommand,
        normalize: (command) => Effect.succeed(command as OrchestrationCommand),
        dispatch: () =>
          Effect.suspend(() => {
            runs += 1;
            return Deferred.await(release).pipe(
              Effect.tap(() => Effect.sync(() => (completed += 1))),
              Effect.as({ sequence: 12 }),
            );
          }),
        projections: {} as ProjectionSnapshotQueryShape,
        terminals: {} as TerminalManagerShape,
        receipts: receiptsWith(null),
        flights,
      });

    const first = yield* apply().pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    // The relay channel closes: the server interrupts the request's handler.
    yield* Fiber.interrupt(first);
    const replay = yield* apply().pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);

    assert.deepStrictEqual(yield* Fiber.join(replay), { sequence: 12 });
    // The first attempt ran to completion, once; the replay only waited for it.
    assert.strictEqual(runs, 1);
    assert.strictEqual(completed, 1);
  }),
);

it.effect(
  "never strands a replay behind a requester interrupted while registering its flight",
  () =>
    Effect.gen(function* () {
      const flights = makeOrchestrationCommandFlights();
      const commandId = CommandId.make("cmd-registering");
      const release = yield* Deferred.make<void>();
      let runs = 0;
      const attempt = Effect.suspend(() => {
        runs += 1;
        return Deferred.await(release).pipe(Effect.as({ sequence: 14 }));
      });
      // The client disconnects in the instant between the flight being
      // registered and its attempt being forked: `join` builds that attempt
      // right after registering it.
      const disconnectingAttempt = Object.assign(Object.create(attempt) as typeof attempt, {
        pipe() {
          Fiber.getCurrent()?.interruptUnsafe();
          return pipeArguments(attempt, arguments);
        },
      });

      const first = yield* flights.join(commandId, disconnectingAttempt).pipe(Effect.forkChild);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(first)));
      const replay = yield* flights.join(commandId, attempt).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;

      assert.deepStrictEqual(replay.pollUnsafe(), Exit.succeed({ sequence: 14 }));
      // The first attempt ran on its own; the replay waited for it.
      assert.strictEqual(runs, 1);
    }),
);

it.effect("runs a later attempt of the same id again once the first has settled", () =>
  Effect.gen(function* () {
    const flights = makeOrchestrationCommandFlights();
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 13 }));
    const apply = () =>
      applyOrchestrationCommand({
        command: replayedCommand,
        normalize: (command) => Effect.succeed(command as OrchestrationCommand),
        dispatch,
        projections: {} as ProjectionSnapshotQueryShape,
        terminals: {} as TerminalManagerShape,
        flights,
      });

    yield* apply();
    yield* apply();
    // Settled attempts leave the registry; the receipt answers from here on.
    assert.strictEqual(dispatch.mock.calls.length, 2);
  }),
);

const delegatedCreate: InternalOrchestrationCommand = {
  type: "thread.delegated.create",
  commandId: CommandId.make("delegated-create-command"),
  threadId: ThreadId.make("thread-delegated-child"),
  projectId: ProjectId.make("project-delegated"),
  title: "Delegated child",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  parentThreadId: ThreadId.make("thread-delegated-parent"),
};

const commandApplicationLayer = (dispatch: OrchestrationEngineShape["dispatch"]) =>
  OrchestrationCommandApplicationLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, { dispatch } as OrchestrationEngineShape),
        Layer.succeed(ProjectionSnapshotQuery, {} as ProjectionSnapshotQueryShape),
        Layer.succeed(TerminalManager, {} as TerminalManagerShape),
        Layer.succeed(WorkspaceAccessPolicy, {} as never),
        Layer.succeed(WorkspacePaths, {} as never),
        Layer.succeed(OrchestrationCommandReceiptRepository, {
          getByCommandId: () => Effect.succeed(Option.none()),
        } as unknown as OrchestrationCommandReceiptRepositoryShape),
        ServerConfig.layerTest(process.cwd(), { prefix: "ryco-command-application-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

it.effect("applyInternal dispatches an internal command unnormalized through the engine", () => {
  const dispatched: OrchestrationCommand[] = [];
  return Effect.gen(function* () {
    const application = yield* OrchestrationCommandApplication;
    const result = yield* application.applyInternal(delegatedCreate);
    assert.strictEqual(result.sequence, 7);
    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(dispatched[0], delegatedCreate);
  }).pipe(
    Effect.provide(
      commandApplicationLayer((command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: 7 });
      }),
    ),
  );
});

it.effect("applyInternal maps engine failures to OrchestrationDispatchCommandError", () =>
  Effect.gen(function* () {
    const application = yield* OrchestrationCommandApplication;
    const error = yield* Effect.flip(application.applyInternal(delegatedCreate));
    assert.isTrue(Schema.is(OrchestrationDispatchCommandError)(error));
    assert.instanceOf(error.cause, OrchestrationCommandInvariantError);
  }).pipe(
    Effect.provide(
      commandApplicationLayer(() =>
        Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: "thread.delegated.create",
            detail: "Parent thread 'thread-delegated-parent' was deleted.",
          }),
        ),
      ),
    ),
  ),
);
