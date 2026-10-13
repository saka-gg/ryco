import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  readLifecycleMarker,
  retireThreadTrash,
  TRASH_RETIRED_AT_MARKER,
  trashRetirementCommandId,
} from "./ThreadTrashRetirement.ts";
import {
  createMarkerTable,
  iso,
  makeFakeEngine,
  removedProjectId,
  thread,
  trashedAt,
  writeMarker,
} from "./threadPurge.testSupport.ts";

it.layer(NodeSqliteClient.layerMemory())("retireThreadTrash", (it) => {
  it.effect("moves Trash to Archive once and records when", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(60_000);
      yield* createMarkerTable;
      const fake = yield* makeFakeEngine({
        threads: [
          thread("live"),
          thread("trashed", trashedAt(1_000)),
          thread("trashed-archived", { ...trashedAt(2_000), archivedAt: iso(500) }),
          thread("orphan", { ...trashedAt(3_000), projectId: removedProjectId }),
          thread("deleted", { deletedAt: iso(4_000) }),
        ],
      });
      const retire = retireThreadTrash({
        dispatch: fake.engine.dispatch,
        readModel: fake.engine.getReadModel!(),
      });

      assert.strictEqual(yield* retire, iso(60_000));
      assert.deepStrictEqual(
        fake.applied.map((command) => command.commandId as string),
        [
          trashRetirementCommandId("untrash", fake.thread("trashed")!.id),
          trashRetirementCommandId("archive", fake.thread("trashed")!.id),
          // Trash kept its archive state: only restored.
          trashRetirementCommandId("untrash", fake.thread("trashed-archived")!.id),
        ],
      );
      assert.deepInclude(fake.thread("trashed"), { deletedAt: null, trashedAt: null });
      assert.strictEqual(fake.thread("trashed")!.archivedAt, iso(60_000));
      assert.deepInclude(fake.thread("trashed-archived"), {
        deletedAt: null,
        archivedAt: iso(500),
      });
      // Its project is gone, so it cannot be restored: it stays, older than the marker.
      assert.strictEqual(fake.thread("orphan")!.trashedAt, iso(3_000));
      assert.deepStrictEqual(fake.rejected, []);
      assert.deepStrictEqual(
        yield* readLifecycleMarker(TRASH_RETIRED_AT_MARKER),
        Option.some(iso(60_000)),
      );

      // Recorded: a later start changes nothing, even with a conversation in Trash again.
      yield* TestClock.adjust(10_000);
      yield* fake.userCommand("thread.trash", "live");
      const before = fake.applied.length;
      assert.strictEqual(yield* retire, iso(60_000));
      assert.strictEqual(fake.applied.length, before);
      assert.isNotNull(fake.thread("live")!.trashedAt);
    }),
  );

  it.effect("keeps an existing marker", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(90_000);
      yield* createMarkerTable;
      yield* writeMarker(iso(10_000));
      const fake = yield* makeFakeEngine({ threads: [thread("trashed", trashedAt(20_000))] });
      const retiredAt = yield* retireThreadTrash({
        dispatch: fake.engine.dispatch,
        readModel: fake.engine.getReadModel!(),
      });
      assert.strictEqual(retiredAt, iso(10_000));
      assert.deepStrictEqual(fake.applied, []);
    }),
  );

  it.effect("reports no marker when it cannot be recorded, so nothing is purged", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      yield* createMarkerTable;
      const fake = yield* makeFakeEngine({});
      const retiredAt = yield* retireThreadTrash({
        dispatch: fake.engine.dispatch,
        readModel: Effect.fail("read model unavailable"),
      });
      assert.isNull(retiredAt);
      assert.deepStrictEqual(yield* readLifecycleMarker(TRASH_RETIRED_AT_MARKER), Option.none());
    }),
  );
});
