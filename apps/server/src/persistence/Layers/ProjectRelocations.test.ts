import { ProjectId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import {
  type ProjectRelocation,
  ProjectRelocationRepository,
} from "../Services/ProjectRelocations.ts";
import { ProjectRelocationRepositoryLive } from "./ProjectRelocations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectRelocationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const relocation = (overrides: Partial<ProjectRelocation> = {}): ProjectRelocation => ({
  relocationId: "relocation-1",
  projectId: ProjectId.make("project-chat"),
  sourcePath: "/chats/2026-10-08-plan-0a1b2c3d",
  destinationPath: "/code/plan",
  strategy: "rename",
  state: "pending",
  destinationCreated: false,
  title: "Offsite planner",
  error: null,
  createdAt: "2026-10-08T10:00:00.000Z",
  updatedAt: "2026-10-08T10:00:00.000Z",
  ...overrides,
});

layer("ProjectRelocationRepository", (it) => {
  it.effect("journals a move and reads it back", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectRelocationRepository;
      yield* repository.create(relocation({ relocationId: "relocation-roundtrip" }));
      const row = yield* repository.getById({ relocationId: "relocation-roundtrip" });
      assert.deepStrictEqual(
        Option.getOrThrow(row),
        relocation({ relocationId: "relocation-roundtrip" }),
      );
      // A move journaled without a title (none requested) reads back as null.
      yield* repository.create(relocation({ relocationId: "relocation-untitled", title: null }));
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getById({ relocationId: "relocation-untitled" })).title,
        null,
      );
    }),
  );

  it.effect("advances unresolved moves and never reopens a settled one", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectRelocationRepository;
      const row = relocation({ relocationId: "relocation-advance" });
      yield* repository.create(row);
      const moved = {
        ...row,
        strategy: "copy" as const,
        state: "moved" as const,
        destinationCreated: true,
        updatedAt: "2026-10-08T10:01:00.000Z",
      };
      assert.isTrue(yield* repository.update(moved));
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getById({ relocationId: row.relocationId })),
        moved,
      );
      // `moved` may step back to `pending` while a copy is being undone.
      assert.isTrue(yield* repository.update({ ...moved, state: "pending" }));
      assert.isTrue(
        yield* repository.update({ ...moved, state: "failed", error: "copy verification failed" }),
      );
      assert.isFalse(yield* repository.update({ ...moved, state: "done", error: null }));
      const settled = Option.getOrThrow(
        yield* repository.getById({ relocationId: row.relocationId }),
      );
      assert.equal(settled.state, "failed");
      assert.equal(settled.error, "copy verification failed");
    }),
  );

  it.effect("lists only unresolved moves, oldest first, also per project", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectRelocationRepository;
      const other = ProjectId.make("project-other");
      yield* repository.create(
        relocation({
          relocationId: "relocation-list-b",
          state: "moved",
          createdAt: "2026-10-08T11:00:00.000Z",
        }),
      );
      yield* repository.create(
        relocation({ relocationId: "relocation-list-a", createdAt: "2026-10-08T09:00:00.000Z" }),
      );
      yield* repository.create(relocation({ relocationId: "relocation-list-done", state: "done" }));
      yield* repository.create(
        relocation({ relocationId: "relocation-list-other", projectId: other }),
      );
      const unresolved = (yield* repository.listUnresolved()).map((row) => row.relocationId);
      assert.include(unresolved, "relocation-list-a");
      assert.include(unresolved, "relocation-list-b");
      assert.notInclude(unresolved, "relocation-list-done");
      assert.isBelow(
        unresolved.indexOf("relocation-list-a"),
        unresolved.indexOf("relocation-list-b"),
      );
      const forOther = yield* repository.listUnresolvedByProjectId({ projectId: other });
      assert.deepStrictEqual(
        forOther.map((row) => row.relocationId),
        ["relocation-list-other"],
      );
    }),
  );
});
