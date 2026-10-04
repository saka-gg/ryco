import {
  CommandId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type InternalOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
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
  applyOrchestrationNormalizedCommand,
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
