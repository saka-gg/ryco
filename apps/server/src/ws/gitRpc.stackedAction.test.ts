import { expect, it } from "@effect/vitest";
import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  WorktreeId,
  WS_METHODS,
} from "@ryco/contracts";
import { Deferred, Duration, Effect, Fiber, Option, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { WsRpcContext } from "./context.ts";
import { toGitManagerError } from "./context/gitErrors.ts";
import { makeGitHandlers } from "./gitRpc.ts";

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
