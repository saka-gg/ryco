import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type UserActionOutcome,
} from "@ryco/contracts";
import { Effect, Fiber, Layer, Option, Queue, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { threadWakeSource, waitUntil } from "../agentControl/eventDrivenWait.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import { findThreadInArray } from "../orchestration/threadIndex.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../project/Services/ProjectAvatarStore.ts";
import { registerUserActionSurfaceHook, type UserActionSurfaceEnded } from "./surfaceHooks.ts";
import {
  answerUserActionRequest,
  openUserActionRequest,
  readThreadUserActionRequests,
  reconcileUserActionRequestsAfterRestart,
  releaseUserActionRequestsOfThread,
  resolveUserActionRequest,
  userActionRequestIdFor,
  waitForUserActionRequest,
  watchUserActionRequest,
} from "./userActionRequests.ts";

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("unused"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-user-action-requests-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const setup = (key: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const threadId = ThreadId.make(`thread-${key}`);
    const projectId = ProjectId.make(`project-${key}`);
    const createdAt = new Date().toISOString();
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${key}`),
      projectId,
      title: "Hand-offs",
      workspaceRoot: process.cwd(),
      defaultModelSelection: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${key}`),
      threadId,
      projectId,
      title: "Hand-offs",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    const deps = { engine, findThreadInArray, waitUntil, threadWakeSource };
    return { engine, threadId, deps };
  });

const hasPendingUserInput = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    return Option.getOrThrow(yield* projections.getThreadShellById(threadId)).hasPendingUserInput;
  });

const open = (
  deps: Parameters<typeof openUserActionRequest>[0],
  threadId: ThreadId,
  callerRequestId: string,
  overrides: Partial<Parameters<typeof openUserActionRequest>[1]> = {},
) =>
  openUserActionRequest(deps, {
    threadId,
    turnId: TurnId.make("turn-1"),
    callerRequestId,
    surface: "browser",
    need: "sign-in",
    message: "Sign in to Jira with your company account.",
    target: "tab-1",
    maxPending: 3,
    ...overrides,
  });

layer("user action requests", (it) => {
  it.effect("opens once per caller id, holds the thread, and ends on the owner's Done", () =>
    Effect.gen(function* () {
      const { threadId, deps } = yield* setup("flow");
      const ended = yield* Ref.make<ReadonlyArray<UserActionSurfaceEnded>>([]);
      const unregister = registerUserActionSurfaceHook("browser", (event) =>
        Ref.update(ended, (all) => [...all, event]),
      );
      try {
        const first = yield* open(deps, threadId, "jira");
        assert.isTrue(first.created);
        assert.strictEqual(first.request.status, "pending");
        const again = yield* open(deps, threadId, "jira");
        assert.isFalse(again.created);
        assert.strictEqual(again.request.requestId, first.request.requestId);
        // The same id for another target is refused, not a second card.
        const other = yield* Effect.flip(open(deps, threadId, "jira", { target: "tab-2" }));
        assert.match(other.text, /already handed over something else/);
        assert.isTrue(yield* hasPendingUserInput(threadId));

        // A bounded wait returns pending, and a waiting call wakes on the owner's answer.
        const requestId = userActionRequestIdFor(threadId, "jira");
        const idle = yield* waitForUserActionRequest(deps, { threadId, requestId, waitMs: 0 });
        assert.strictEqual(idle?.status, "pending");
        const waiting = yield* Effect.forkChild(
          waitForUserActionRequest(deps, { threadId, requestId, waitMs: 20_000 }),
        );
        const answered = yield* answerUserActionRequest(deps, {
          threadId,
          requestId,
          answer: "done",
        });
        assert.deepEqual(answered, { outcome: "done" });
        assert.strictEqual((yield* Fiber.join(waiting))?.status, "done");
        assert.isFalse(yield* hasPendingUserInput(threadId));
        assert.deepEqual(yield* Ref.get(ended), [
          { threadId, requestId, target: "tab-1", outcome: "done" },
        ]);

        // Answered once: a second answer, and a surface outcome after it, change nothing.
        const twice = yield* Effect.flip(
          answerUserActionRequest(deps, { threadId, requestId, answer: "declined" }),
        );
        assert.strictEqual(twice.reason, "already-resolved");
        const late = yield* resolveUserActionRequest(deps, threadId, requestId, "closed");
        assert.strictEqual(late?.status, "done");
        assert.lengthOf(yield* Ref.get(ended), 1);
      } finally {
        unregister();
      }
    }),
  );

  it.effect("records a trimmed message and refuses one no reader could read back", () =>
    Effect.gen(function* () {
      const { threadId, deps } = yield* setup("message");
      // Leading and trailing spaces would make the payload unreadable: the base trims them.
      const { request } = yield* open(deps, threadId, "spaces", { message: "  Sign in.  " });
      assert.strictEqual(request.message, "Sign in.");
      const recorded = yield* readThreadUserActionRequests(deps, threadId);
      assert.deepEqual(
        recorded?.map((candidate) => [candidate.message, candidate.status]),
        [["Sign in.", "pending"]],
      );
      // Nothing to read back: refused, and nothing recorded.
      const blank = yield* Effect.flip(open(deps, threadId, "blank", { message: "   " }));
      assert.match(blank.text, /The message must be 1 to 300 characters/);
      const long = yield* Effect.flip(
        open(deps, threadId, "long", { target: "tab-9", message: "x".repeat(301) }),
      );
      assert.match(long.text, /The message must be/);
      assert.lengthOf((yield* readThreadUserActionRequests(deps, threadId)) ?? [], 1);
    }),
  );

  it.effect("gives the surface its target back when the thread is archived or deleted", () =>
    Effect.gen(function* () {
      const { engine, threadId, deps } = yield* setup("removed");
      // The removal is handled on a detached fiber: the hook reports into a queue the test takes.
      const ended = yield* Queue.unbounded<UserActionSurfaceEnded>();
      const unregister = registerUserActionSurfaceHook("browser", (event) =>
        Queue.offer(ended, event).pipe(Effect.asVoid),
      );
      try {
        const { request } = yield* open(deps, threadId, "archived");
        // The removal watch starts with the first wait.
        yield* waitForUserActionRequest(deps, {
          threadId,
          requestId: request.requestId,
          waitMs: 0,
        });
        // A thread can be archived once a message was sent.
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-removed"),
          threadId,
          message: {
            messageId: MessageId.make("message-removed"),
            role: "user",
            text: "Go",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        });
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-removed"),
          threadId,
        });
        assert.deepEqual(yield* Queue.take(ended), {
          threadId,
          requestId: request.requestId,
          target: "tab-1",
          outcome: "cancelled",
        });
        // Archived: the thread still records how the request ended.
        const recorded = yield* readThreadUserActionRequests(deps, threadId);
        assert.strictEqual(recorded?.[0]?.status, "cancelled");

        // Deleted: nothing can be recorded, the surface is released all the same, once.
        const other = yield* setup("deleted");
        const { request: second } = yield* open(other.deps, other.threadId, "deleted");
        yield* other.engine.dispatch({
          type: "thread.trash",
          commandId: CommandId.make("cmd-trash-deleted"),
          threadId: other.threadId,
        });
        assert.deepInclude((yield* Queue.take(ended)) as object, {
          requestId: second.requestId,
          outcome: "cancelled",
        });
        yield* releaseUserActionRequestsOfThread(other.deps, other.threadId);
        assert.strictEqual(yield* Queue.size(ended), 0);
      } finally {
        unregister();
      }
    }),
  );

  it.effect("caps pending requests per thread", () =>
    Effect.gen(function* () {
      const { threadId, deps } = yield* setup("cap");
      yield* open(deps, threadId, "a", { target: "tab-a" });
      yield* open(deps, threadId, "b", { target: "tab-b" });
      const refused = yield* Effect.flip(
        open(deps, threadId, "c", { target: "tab-c", maxPending: 2 }),
      );
      assert.match(refused.text, /as many hand-offs as it may/);
    }),
  );

  it.effect("ends on the surface's own watch with the outcome it names", () =>
    Effect.gen(function* () {
      const { threadId, deps } = yield* setup("watch");
      const { request } = yield* open(deps, threadId, "watched");
      const outcome = yield* Ref.make<UserActionOutcome | null>(null);
      yield* watchUserActionRequest(deps, {
        threadId,
        requestId: request.requestId,
        everyMs: 10,
        check: Ref.get(outcome),
      });
      yield* Ref.set(outcome, "condition-met");
      const ended = yield* waitForUserActionRequest(deps, {
        threadId,
        requestId: request.requestId,
        waitMs: 5_000,
      });
      assert.strictEqual(ended?.status, "condition-met");
    }),
  );

  it.effect("ends a terminal hand-off as closed after a restart: its shell is gone", () =>
    Effect.gen(function* () {
      const { engine, threadId, deps } = yield* setup("restart-terminal");
      yield* open(deps, threadId, "pw", { surface: "terminal", need: "input", target: "agent-1" });
      yield* open(deps, threadId, "tab", { ttlMs: 60_000 });
      if (engine.getReadModel === undefined) return assert.fail("The engine has no read model.");
      const model = yield* engine.getReadModel();
      yield* reconcileUserActionRequestsAfterRestart(deps, model.threads);
      const requests = yield* readThreadUserActionRequests(deps, threadId);
      assert.deepEqual(
        requests?.map((candidate) => [candidate.surface, candidate.status]),
        [
          ["terminal", "closed"],
          ["browser", "pending"],
        ],
      );
    }),
  );

  it.effect("expires as timeout, and a restart schedules the expiry again", () =>
    Effect.gen(function* () {
      const { engine, threadId, deps } = yield* setup("expiry");
      const { request } = yield* open(deps, threadId, "short", { ttlMs: 10_000 });
      assert.isTrue(Date.parse(request.expiresAt) - Date.parse(request.requestedAt) >= 10_000);
      // A TTL under the minimum is raised to it; over the maximum, cut to it.
      const { request: clamped } = yield* open(deps, threadId, "long", {
        target: "tab-9",
        ttlMs: 10 * 60 * 60 * 1_000,
      });
      assert.strictEqual(
        Date.parse(clamped.expiresAt) - Date.parse(clamped.requestedAt),
        60 * 60 * 1_000,
      );
      if (engine.getReadModel === undefined) return assert.fail("The engine has no read model.");
      const model = yield* engine.getReadModel();
      yield* reconcileUserActionRequestsAfterRestart(deps, model.threads);
      const requests = yield* readThreadUserActionRequests(deps, threadId);
      assert.deepEqual(
        requests?.map((candidate) => candidate.status),
        ["pending", "pending"],
      );
      const missing = yield* answerUserActionRequest(deps, {
        threadId,
        requestId: userActionRequestIdFor(threadId, "missing"),
        answer: "done",
      }).pipe(Effect.flip);
      assert.strictEqual(missing.reason, "not-found");

      // The expiry ends the short one as timeout, without anyone waiting on it.
      yield* TestClock.adjust("11 seconds");
      const after = yield* readThreadUserActionRequests(deps, threadId);
      assert.deepEqual(
        after?.map((candidate) => candidate.status),
        ["timeout", "pending"],
      );
      assert.isTrue(yield* hasPendingUserInput(threadId));
    }),
  );
});
