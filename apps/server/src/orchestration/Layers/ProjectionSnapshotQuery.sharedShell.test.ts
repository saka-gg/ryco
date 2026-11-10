/**
 * The shell the snapshot query serves once the engine feeds it is the shared, event-patched copy
 * (shellSnapshotCopy.ts): equal to a fresh database build after every command, current for a
 * caller that awaited its command, and patched rather than rebuilt per change.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  readSharedThreadShell,
  readStubbedShellSnapshot,
} from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const projectId = ProjectId.make("project-shared-shell");

/** On a file, so shells are built and patched on the read worker, as in production. */
const makeLayer = (databasePath: string) =>
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("unused"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(makeSqlitePersistenceLive(databasePath, { checkpointWorker: false })),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-shared-shell-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const runtimes: Array<ManagedRuntime.ManagedRuntime<unknown, unknown>> = [];
const directories: Array<string> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function system() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-shared-shell-"));
  directories.push(directory);
  const layer = makeLayer(path.join(directory, "state.sqlite"));
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, unknown>);
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeLayer>>>) =>
    runtime.runPromise(effect);
  const { engine, query } = await run(
    Effect.all({
      engine: Effect.service(OrchestrationEngineService),
      query: Effect.service(ProjectionSnapshotQuery),
    }),
  );
  let serial = 0;
  const dispatch = (command: Record<string, unknown>) =>
    run(
      engine.dispatch({
        ...command,
        commandId: CommandId.make(`shared-shell-${(serial += 1)}`),
      } as unknown as OrchestrationCommand),
    );
  /** A build from the database: a caller inside a transaction never reads the shared copy. */
  const fresh = <A, E>(read: Effect.Effect<A, E>) =>
    run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(read)));
  const latestSequence = () =>
    run(Effect.flatMap(OrchestrationEventStore, (store) => store.latestSequence));
  return { run, query, dispatch, fresh, latestSequence };
}

const createThread = (threadId: string, createdAt: string) => ({
  type: "thread.create",
  threadId: ThreadId.make(threadId),
  projectId,
  title: `Thread ${threadId}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt,
});

const withoutUpdatedAt = (snapshot: OrchestrationShellSnapshot) => ({
  ...snapshot,
  updatedAt: "",
});
const row = (snapshot: OrchestrationShellSnapshot, id: string) =>
  snapshot.threads.find((thread) => thread.id === id);

describe("the shared shell", () => {
  it("equals a fresh build after each command and patches only the rows events name", async () => {
    const s = await system();
    await s.dispatch({
      type: "project.create",
      projectId,
      title: "Shared shell",
      workspaceRoot: "/tmp/project-shared-shell",
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      createdAt: "2026-11-10T00:00:00.000Z",
    });
    for (const [index, id] of ["a", "b", "c"].entries()) {
      await s.dispatch(createThread(id, `2026-11-10T00:00:0${index + 1}.000Z`));
    }
    const first = await s.run(s.query.getShellSnapshot());
    expect(first.threads.map((thread) => thread.id)).toEqual(["a", "b", "c"]);

    await s.dispatch({
      type: "thread.meta.update",
      threadId: ThreadId.make("a"),
      title: "Renamed",
    });
    // Current for the caller that awaited the command, at the command's sequence.
    const second = await s.run(s.query.getShellSnapshot());
    expect(row(second, "a")?.title).toBe("Renamed");
    expect(second.snapshotSequence).toBe(await s.latestSequence());
    // Patched: an untouched row keeps its object.
    expect(row(second, "b")).toBe(row(first, "b"));
    expect(withoutUpdatedAt(second)).toEqual(
      withoutUpdatedAt(await s.fresh(s.query.getShellSnapshot())),
    );

    await s.dispatch({ type: "thread.delete", threadId: ThreadId.make("c") });
    await s.dispatch(createThread("d", "2026-11-10T00:00:00.500Z"));
    await s.dispatch({
      type: "thread.turn.start",
      threadId: ThreadId.make("b"),
      message: {
        messageId: MessageId.make("message-b"),
        role: "user",
        text: "Hello",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-11-10T00:00:05.000Z",
    });
    await s.dispatch({ type: "thread.archive", threadId: ThreadId.make("b") });
    const third = await s.run(s.query.getShellSnapshot());
    expect(third.threads.map((thread) => thread.id)).toEqual(["d", "a", "b"]);
    expect(withoutUpdatedAt(third)).toEqual(
      withoutUpdatedAt(await s.fresh(s.query.getShellSnapshot())),
    );
    const stubbed = await s.run(readStubbedShellSnapshot(s.query));
    const freshStubbed = await s.fresh(readStubbedShellSnapshot(s.query));
    expect({ ...stubbed, updatedAt: "" }).toEqual({ ...freshStubbed, updatedAt: "" });

    // Readers following events get the copy's row object.
    const shared = await s.run(readSharedThreadShell(s.query, ThreadId.make("a")));
    expect(Option.getOrThrow(shared)).toBe(row(third, "a"));
    expect(Option.isNone(await s.run(readSharedThreadShell(s.query, ThreadId.make("c"))))).toBe(
      true,
    );
  });
  it("answers a resume with the rows changed since, equal to a fresh build's", async () => {
    const s = await system();
    await s.dispatch({
      type: "project.create",
      projectId,
      title: "Shared shell",
      workspaceRoot: "/tmp/project-shared-shell",
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      createdAt: "2026-11-10T00:00:00.000Z",
    });
    for (const [index, id] of ["a", "b", "c"].entries()) {
      await s.dispatch(createThread(id, `2026-11-10T00:00:0${index + 1}.000Z`));
    }
    await s.run(s.query.getShellSnapshot());
    const position = await s.latestSequence();

    for (let index = 0; index < 5; index += 1) {
      await s.dispatch({
        type: "thread.meta.update",
        threadId: ThreadId.make("a"),
        title: `Renamed ${index}`,
      });
    }
    await s.dispatch({ type: "thread.delete", threadId: ThreadId.make("c") });

    const changes = Option.getOrThrow(await s.run(s.query.getShellChangesSince!(position)));
    expect(changes.snapshotSequence).toBe(await s.latestSequence());
    expect(changes.items.map((item) => item.kind)).toEqual(["thread-upserted", "thread-removed"]);
    const fresh = await s.fresh(s.query.getShellSnapshot());
    const upsert = changes.items[0];
    expect(upsert?.kind === "thread-upserted" ? upsert.thread : null).toEqual(row(fresh, "a"));
    // Unchanged threads are not sent.
    expect(changes.threadCount).toBe(2);
  });
});
