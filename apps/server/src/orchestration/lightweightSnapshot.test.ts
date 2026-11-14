import type { OrchestrationReadModel } from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vite-plus/test";

import { getOfflineSnapshot } from "../cli/projectCommand.ts";
import { loadOrchestrationHttpSnapshot } from "./http.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";

const lightweightSnapshot = { snapshotSequence: 7 } as OrchestrationReadModel;

function makeProjectionQuery() {
  const getCommandReadModel = vi.fn(() => Effect.succeed(lightweightSnapshot));
  const getSnapshot = vi.fn(() => Effect.die("full snapshot must not be hydrated"));
  const service = {
    getCommandReadModel,
    getSnapshot,
  } as unknown as ProjectionSnapshotQueryShape;
  return { service, getCommandReadModel, getSnapshot };
}

describe("lightweight orchestration snapshot consumers", () => {
  it.effect("uses the command read model for the legacy HTTP payload", () => {
    const query = makeProjectionQuery();
    return Effect.gen(function* () {
      assert.strictEqual(yield* loadOrchestrationHttpSnapshot, lightweightSnapshot);
      assert.equal(query.getCommandReadModel.mock.calls.length, 1);
      assert.equal(query.getSnapshot.mock.calls.length, 0);
    }).pipe(Effect.provideService(ProjectionSnapshotQuery, query.service));
  });

  it.effect("uses the command read model for offline CLI project commands", () => {
    const query = makeProjectionQuery();
    return Effect.gen(function* () {
      assert.strictEqual(yield* getOfflineSnapshot(), lightweightSnapshot);
      assert.equal(query.getCommandReadModel.mock.calls.length, 1);
      assert.equal(query.getSnapshot.mock.calls.length, 0);
    }).pipe(Effect.provideService(ProjectionSnapshotQuery, query.service));
  });
});
