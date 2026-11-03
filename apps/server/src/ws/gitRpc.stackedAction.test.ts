import { expect, it } from "@effect/vitest";
import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  WorktreeId,
  WS_METHODS,
} from "@ryco/contracts";
import { Deferred, Duration, Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { GitActionRunnerShape } from "../git/GitActionRunner.ts";
import { makeGitActionRunner } from "../git/gitActionRunnerCore.ts";
import type { WsRpcContext } from "./context.ts";
import { toGitManagerError } from "./context/gitErrors.ts";
import { makeGitHandlers } from "./gitRpc.ts";

/**
 * Handlers whose stacked action reports a created pull request, then holds the work open until
 * it is interrupted: the gap between the report and the end of the action, widened.
 */
const reportThenHold = Effect.fnUntraced(function* (
  gitActionRunner: GitActionRunnerShape | undefined,
) {
  const reported = yield* Deferred.make<void>();
  const state = { linked: 0, refreshed: 0 };
  const handlers = makeGitHandlers({
    ownerStream: (_method: string, stream: unknown) => stream,
    attachLinkedIssuesToPrAction: (input: GitRunStackedActionInput) => Effect.succeed(input),
    gitWorkflow: {
      runStackedAction: (
        input: GitRunStackedActionInput,
        options: {
          readonly progressReporter: {
            readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void>;
          };
        },
      ) =>
        Effect.gen(function* () {
          yield* options.progressReporter.publish({
            actionId: input.actionId,
            cwd: input.cwd,
            action: input.action,
            kind: "action_finished",
            result: {
              action: input.action,
              branch: { status: "skipped_not_requested" },
              commit: { status: "skipped_not_requested" },
              push: { status: "skipped_not_requested" },
              pr: { status: "created", number: 7, title: "Demo" },
              toast: { title: "Created PR #7", cta: { kind: "none" } },
            },
          });
          yield* Deferred.succeed(reported, undefined);
          return yield* Effect.never;
        }),
    },
    projectionWorktrees: {
      getById: () => Effect.succeed(Option.some({ prTitle: null, issueState: null })),
    },
    dispatchWorktreeCommand: () =>
      Effect.sync(() => {
        state.linked += 1;
      }),
    serverCommandId: (tag: string) => tag,
    toGitManagerError,
    refreshGitStatus: () =>
      Effect.sync(() => {
        state.refreshed += 1;
      }),
    gitActionRunner,
    gitActionOwner: () => "direct:test",
  } as unknown as WsRpcContext);
  return { handlers, reported, state };
});

it.effect("does not let a stalled pull request link hold a finished action forever", () =>
  Effect.gen(function* () {
    const linking = yield* Deferred.make<void>();
    let refreshed = false;
    const handlers = makeGitHandlers({
      ownerStream: (_method: string, stream: unknown) => stream,
      attachLinkedIssuesToPrAction: (input: GitRunStackedActionInput) => Effect.succeed(input),
      gitWorkflow: {
        runStackedAction: (
          input: GitRunStackedActionInput,
          options: {
            readonly progressReporter: {
              readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void>;
            };
          },
        ) =>
          Effect.gen(function* () {
            const result = {
              action: input.action,
              branch: { status: "skipped_not_requested" as const },
              commit: { status: "skipped_not_requested" as const },
              push: { status: "skipped_not_requested" as const },
              pr: { status: "created" as const, number: 7, title: "Demo" },
              toast: { title: "Created PR #7", cta: { kind: "none" as const } },
            };
            yield* options.progressReporter.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "action_finished",
              result,
            });
            return result;
          }),
      },
      projectionWorktrees: {
        getById: () => Effect.succeed(Option.some({ prTitle: null, issueState: null })),
      },
      // Orchestration that never answers, as during a shutdown that already stopped it.
      dispatchWorktreeCommand: () =>
        Deferred.succeed(linking, undefined).pipe(Effect.andThen(Effect.never)),
      serverCommandId: (tag: string) => tag,
      toGitManagerError,
      refreshGitStatus: () =>
        Effect.sync(() => {
          refreshed = true;
        }),
      gitActionRunner: undefined,
      gitActionOwner: () => "direct:test",
    } as unknown as WsRpcContext);

    const fiber = yield* handlers[WS_METHODS.gitRunStackedAction]({
      actionId: "action-pr",
      cwd: "/repo",
      action: "create_pr",
      worktreeId: WorktreeId.make("worktree-pr"),
    }).pipe(Stream.runCollect, Effect.forkChild);
    yield* Deferred.await(linking);
    yield* TestClock.adjust(Duration.seconds(10));

    const events = yield* Fiber.join(fiber);
    expect([...events].map((event) => event.kind)).toEqual(["action_finished"]);
    expect(refreshed).toBe(true);
  }),
);

it.effect("links the pull request when the request closes right after the action reported it", () =>
  Effect.gen(function* () {
    const { handlers, reported, state } = yield* reportThenHold(undefined);
    const fiber = yield* handlers[WS_METHODS.gitRunStackedAction]({
      actionId: "action-closed",
      cwd: "/repo",
      action: "create_pr",
      worktreeId: WorktreeId.make("worktree-closed"),
    }).pipe(Stream.runDrain, Effect.forkChild);
    yield* Deferred.await(reported);

    yield* Fiber.interrupt(fiber);
    expect(state).toEqual({ linked: 1, refreshed: 1 });
  }),
);

it.effect("links the pull request when a shutdown lands right after the action reported it", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const runner = yield* makeGitActionRunner.pipe(Scope.provide(scope));
    const { handlers, reported, state } = yield* reportThenHold(runner);
    yield* handlers[WS_METHODS.gitRunStackedAction]({
      actionId: crypto.randomUUID(),
      recoverable: true,
      cwd: "/repo",
      action: "create_pr",
      worktreeId: WorktreeId.make("worktree-shutdown"),
    }).pipe(Stream.runDrain, Effect.forkChild);
    yield* Deferred.await(reported);

    yield* Scope.close(scope, Exit.void);
    expect(state).toEqual({ linked: 1, refreshed: 1 });
  }),
);
