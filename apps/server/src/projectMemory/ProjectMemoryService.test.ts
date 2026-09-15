import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  RuntimeSessionId,
  ProjectMemoryError,
} from "@ryco/contracts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ProjectMemoryService,
  ProjectMemoryServiceLive,
  type MemoryRuntimeIdentity,
} from "./ProjectMemoryService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";

const access = Layer.succeed(WorkspaceAccessPolicy, {
  accessRoot: undefined,
  isRestricted: false,
  assertPath: ({ path }) => Effect.succeed(path),
  assertExistingPath: ({ path }) => Effect.succeed(path),
});
const layer = ProjectMemoryServiceLive.pipe(
  Layer.provideMerge(access),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const seed = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make(name);
    const threadId = ThreadId.make(`thread-${name}`);
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${projectId},'Project','/test','[]','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`;
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES(${threadId},${projectId},'Thread','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`;
    const memory = yield* ProjectMemoryService;
    yield* memory.mutate(
      { projectId, expectedRevision: 0, mutation: { operation: "enable", enabled: true } },
      "user-a",
    );
    yield* memory.mutate(
      {
        projectId,
        expectedRevision: 1,
        mutation: {
          operation: "create",
          id: "entry",
          kind: "convention",
          text: "Use focused checks.",
        },
      },
      "user-a",
    );
    const runtime: MemoryRuntimeIdentity = {
      threadId,
      provider: "codex" as MemoryRuntimeIdentity["provider"],
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeSessionId: RuntimeSessionId.make(`runtime-${name}`),
    };
    return { memory, projectId, threadId, runtime, references: [{ id: "entry", revision: 2 }] };
  });
const reason = <A>(effect: Effect.Effect<A, ProjectMemoryError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));
it.layer(layer)("project memory", (it) => {
  it.effect("opt-in, revisions, export, forget and no stale resurrection", () =>
    Effect.gen(function* () {
      const { memory, projectId, references } = yield* seed("lifecycle");
      const page = yield* memory.list({ projectId, query: "", offset: 0 });
      assert.equal(page.total, 1);
      assert.equal(page.entries[0]?.provenance.actorId.length, 64);
      assert.deepEqual((yield* memory.export({ projectId })).entries, page.entries);
      yield* memory.mutate(
        {
          projectId,
          expectedRevision: 2,
          mutation: { operation: "forget", id: "entry", revision: 2 },
        },
        "user-a",
      );
      assert.equal(yield* reason(memory.preview({ projectId, references })), "conflict");
      assert.equal(
        yield* reason(
          memory.mutate(
            {
              projectId,
              expectedRevision: 1,
              mutation: { operation: "create", id: "entry", kind: "fact", text: "old text" },
            },
            "user-a",
          ),
        ),
        "conflict",
      );
      assert.equal((yield* memory.export({ projectId })).entries.length, 0);
      yield* memory.mutate(
        { projectId, expectedRevision: 3, mutation: { operation: "deleteAll" } },
        "user-a",
      );
      assert.equal(yield* reason(memory.preview({ projectId, references: [] })), "disabled");
      assert.equal((yield* memory.list({ projectId, query: "", offset: 0 })).revision, 4);
    }),
  );
  it.effect(
    "rejects recognized secrets without retaining rejected text and validates source scope",
    () =>
      Effect.gen(function* () {
        const { memory, projectId } = yield* seed("admission");
        for (const text of [
          "password=example-sensitive-value",
          "Bearer example-sensitive-value",
          "Private Hub deployment alpha",
          "https://private.example/path",
        ]) {
          assert.equal(
            yield* reason(
              memory.mutate(
                {
                  projectId,
                  expectedRevision: 2,
                  mutation: { operation: "create", id: "bad", kind: "fact", text },
                },
                "actor",
              ),
            ),
            "sensitive",
          );
        }
        assert.equal((yield* memory.export({ projectId })).entries.length, 1);
        assert.equal(
          yield* reason(
            memory.mutate(
              {
                projectId,
                expectedRevision: 2,
                mutation: {
                  operation: "create",
                  id: "bad",
                  kind: "fact",
                  text: "Safe text",
                  source: { threadId: ThreadId.make("elsewhere"), messageId: "missing" as never },
                },
              },
              "actor",
            ),
          ),
          "notFound",
        );
      }),
  );
  it.effect("accepts 500 astral characters, rejects 501, caps entries and pages at 50", () =>
    Effect.gen(function* () {
      const { memory, projectId } = yield* seed("capacity");
      yield* memory.mutate(
        {
          projectId,
          expectedRevision: 2,
          mutation: {
            operation: "edit",
            id: "entry",
            revision: 2,
            kind: "fact",
            text: "😀".repeat(500),
          },
        },
        "actor",
      );
      assert.equal(
        yield* reason(
          memory.mutate(
            {
              projectId,
              expectedRevision: 3,
              mutation: {
                operation: "edit",
                id: "entry",
                revision: 3,
                kind: "fact",
                text: "😀".repeat(501),
              },
            },
            "actor",
          ),
        ),
        "invalid",
      );
      for (let index = 1; index < 200; index++)
        yield* memory.mutate(
          {
            projectId,
            expectedRevision: index + 2,
            mutation: {
              operation: "create",
              id: `entry-${index}`,
              kind: "fact",
              text: `Fact ${index}`,
            },
          },
          "actor",
        );
      const page = yield* memory.list({ projectId, offset: 0, query: "" });
      assert.equal(page.total, 200);
      assert.equal(page.entries.length, 50);
      assert.equal(page.nextOffset, 50);
      assert.equal(
        yield* reason(
          memory.mutate(
            {
              projectId,
              expectedRevision: 202,
              mutation: { operation: "create", id: "overflow", kind: "fact", text: "One too many" },
            },
            "actor",
          ),
        ),
        "capacity",
      );
    }),
  );
  it.effect("expiry never reinforces on read; affirmation and pin restore recall", () =>
    Effect.gen(function* () {
      const { memory, projectId, references } = yield* seed("expiry");
      yield* TestClock.adjust("90 days");
      assert.equal(yield* reason(memory.preview({ projectId, references })), "expired");
      yield* memory.mutate(
        {
          projectId,
          expectedRevision: 2,
          mutation: { operation: "affirm", id: "entry", revision: 2 },
        },
        "actor",
      );
      assert.equal(
        (yield* memory.preview({ projectId, references: [{ id: "entry", revision: 3 }] })).entries
          .length,
        1,
      );
      yield* memory.mutate(
        {
          projectId,
          expectedRevision: 3,
          mutation: { operation: "pin", id: "entry", revision: 3, pinned: true },
        },
        "actor",
      );
      yield* TestClock.adjust("91 days");
      assert.equal(
        (yield* memory.preview({ projectId, references: [{ id: "entry", revision: 4 }] })).entries
          .length,
        1,
      );
    }),
  );
  it.effect(
    "a queued recall is checked after preview and fails after edit, disable or delete",
    () =>
      Effect.gen(function* () {
        for (const operation of ["edit", "enable", "deleteAll"] as const) {
          const fixture = yield* seed(`queued-${operation}`);
          yield* fixture.memory.preview(fixture);
          const mutation =
            operation === "edit"
              ? { operation, id: "entry", revision: 2, kind: "fact" as const, text: "Changed" }
              : operation === "enable"
                ? { operation, enabled: false }
                : { operation };
          yield* fixture.memory.mutate(
            { projectId: fixture.projectId, expectedRevision: 2, mutation },
            "actor",
          );
          let deliveries = 0;
          const result = yield* Effect.exit(
            fixture.memory.submitRecall(fixture, Effect.void, () =>
              Effect.sync(() => {
                deliveries++;
              }),
            ),
          );
          assert.isTrue(result._tag === "Failure");
          assert.equal(deliveries, 0);
        }
      }),
  );
  it.effect("submission excludes deletion until acceptance and never expires by wall clock", () =>
    Effect.gen(function* () {
      const fixture = yield* seed("race");
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const pending = yield* fixture.memory
        .submitRecall(fixture, Effect.void, () =>
          Effect.uninterruptible(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("31 seconds");
      assert.equal(
        yield* reason(
          fixture.memory.mutate(
            {
              projectId: fixture.projectId,
              expectedRevision: 2,
              mutation: { operation: "deleteAll" },
            },
            "actor",
          ),
        ),
        "conflict",
      );
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.await(pending);
      yield* fixture.memory.mutate(
        { projectId: fixture.projectId, expectedRevision: 2, mutation: { operation: "deleteAll" } },
        "actor",
      );
    }),
  );
  it.effect("failure and cancellation finalize and release the exact claim", () =>
    Effect.gen(function* () {
      const fixture = yield* seed("cancel");
      yield* Effect.exit(
        fixture.memory.submitRecall(fixture, Effect.void, () =>
          Effect.fail(new Error("provider rejected")),
        ),
      );
      const entered = yield* Deferred.make<void>();
      const fiber = yield* fixture.memory
        .submitRecall(fixture, Effect.void, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      yield* fixture.memory.mutate(
        {
          projectId: fixture.projectId,
          expectedRevision: 2,
          mutation: { operation: "forget", id: "entry", revision: 2 },
        },
        "actor",
      );
    }),
  );
  it.effect(
    "cleanup SQL failure retains finalized evidence and retries safely in the same process",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seed("cleanup");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_memory_cleanup BEFORE UPDATE OF dispatch_id ON project_memory_settings WHEN OLD.project_id = 'cleanup' AND OLD.dispatch_id IS NOT NULL AND NEW.dispatch_id IS NULL BEGIN SELECT RAISE(ABORT,'simulated cleanup failure'); END`;
        yield* fixture.memory.submitRecall(fixture, Effect.void, () => Effect.void);
        assert.equal(
          (yield* sql<{
            id: string;
          }>`SELECT dispatch_id AS id FROM project_memory_settings WHERE project_id = 'cleanup'`)
            .length,
          1,
        );
        yield* sql`DROP TRIGGER fail_memory_cleanup`;
        let stops = 0;
        yield* fixture.memory.recoverSubmissions(() =>
          Effect.sync(() => {
            stops++;
          }),
        );
        assert.equal(stops, 0);
        yield* fixture.memory.mutate(
          {
            projectId: fixture.projectId,
            expectedRevision: 2,
            mutation: { operation: "deleteAll" },
          },
          "actor",
        );
      }),
  );
  it.effect(
    "crash recovery uses recorded exact runtime, preserves live owners and rejects stop failure",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seed("recovery");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE project_memory_settings SET dispatch_id = 'old-claim', dispatch_thread_id = ${fixture.threadId}, dispatch_owner_pid = ${process.pid}, dispatch_owner = 'previous-process-incarnation', dispatch_runtime_json = ${JSON.stringify(fixture.runtime)} WHERE project_id = ${fixture.projectId}`;
        const failure = yield* Effect.exit(
          fixture.memory.recoverSubmissions(() =>
            Effect.fail(
              new ProjectMemoryError({ reason: "unavailable", message: "stop not proven" }),
            ),
          ),
        );
        assert.equal(failure._tag, "Failure");
        const stopped: MemoryRuntimeIdentity[] = [];
        yield* fixture.memory.recoverSubmissions((runtime) =>
          Effect.sync(() => {
            stopped.push(runtime);
          }),
        );
        assert.deepEqual(stopped, [fixture.runtime]);
        yield* fixture.memory.mutate(
          {
            projectId: fixture.projectId,
            expectedRevision: 2,
            mutation: { operation: "deleteAll" },
          },
          "actor",
        );
      }),
  );
});
