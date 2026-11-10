import {
  AgentControlAutomationId,
  ProviderInstanceId,
  ProjectId,
  type AgentControlAutomation,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AgentControlAutomationRepository } from "../Services/AgentControlAutomations.ts";
import { AgentControlAutomationRepositoryLive } from "./AgentControlAutomations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  AgentControlAutomationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectId = ProjectId.make("project-automation-test");
const providerInstanceId = ProviderInstanceId.make("provider-automation-test");

const automationAt = (input: {
  readonly id: string;
  readonly start: string;
  readonly end: string;
}): AgentControlAutomation => ({
  automationId: AgentControlAutomationId.make(input.id),
  principal: {
    kind: "external-integration",
    integrationId: "integration-automation-test" as never,
    label: "Automation test",
    projectId,
    runtimeMode: "approval-required",
    envMode: "worktree",
  },
  projectId,
  providerInstanceId,
  definition: {
    execution: {
      projectId,
      title: "Bounded scheduled task",
      prompt: "Perform the exact bounded task.",
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      runtimeMode: "approval-required",
      envMode: "worktree",
    },
    schedule: {
      kind: "fixed-interval",
      startsAt: input.start,
      intervalMs: 15 * 60_000,
      endsAt: input.end,
    },
    enabled: true,
  },
  revision: 1,
  enabled: true,
  cancelled: false,
  cancelledAt: null,
  nextRunAt: input.start,
  createdAt: input.start,
  updatedAt: input.start,
});

layer("AgentControlAutomationRepository", (it) => {
  it.effect(
    "claims each due occurrence once across concurrent ticks and coalesces missed intervals",
    () =>
      Effect.gen(function* () {
        const repository = yield* AgentControlAutomationRepository;
        const start = "2026-08-18T00:00:00.000Z";
        const now = "2026-08-18T01:01:00.000Z";
        const automation = automationAt({
          id: "automation-concurrent",
          start,
          end: "2026-08-19T00:00:00.000Z",
        });
        assert.isTrue(yield* repository.insertAutomation(automation));

        const claims = yield* Effect.all(
          Array.from({ length: 8 }, () => repository.claimDue({ now, limit: 10 })),
          { concurrency: "unbounded" },
        );
        const claimed = claims.flat();
        assert.strictEqual(claimed.length, 1);
        assert.strictEqual(claimed[0]?.run.scheduledFor, start);
        assert.strictEqual(claimed[0]?.run.coalescedOccurrences, 4);

        const secondTick = yield* repository.claimDue({ now, limit: 10 });
        assert.deepStrictEqual(secondTick, []);
        // The claimed run is in flight: nothing is due until it ends.
        assert.strictEqual(yield* repository.nextDueAt!(), null);
      }),
  );

  it.effect("reports the earliest occurrence a claim could take", () =>
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      for (const [id, start] of [
        ["automation-next-late", "2026-09-02T12:00:00.000Z"],
        ["automation-next-early", "2026-09-01T08:00:00.000Z"],
      ] as const) {
        assert.isTrue(
          yield* repository.insertAutomation(
            automationAt({ id, start, end: "2026-09-10T00:00:00.000Z" }),
          ),
        );
      }
      assert.strictEqual(yield* repository.nextDueAt!(), "2026-09-01T08:00:00.000Z");
    }),
  );

  it.effect("cancellation wins before a future claim without deleting run history", () =>
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      const automation = automationAt({
        id: "automation-cancelled",
        start: "2026-08-18T02:00:00.000Z",
        end: "2026-08-19T00:00:00.000Z",
      });
      assert.isTrue(yield* repository.insertAutomation(automation));
      assert.isTrue(
        yield* repository.replaceAutomation({
          automation: {
            ...automation,
            revision: 2,
            enabled: false,
            cancelled: true,
            cancelledAt: "2026-08-18T01:30:00.000Z",
            nextRunAt: null,
            updatedAt: "2026-08-18T01:30:00.000Z",
          },
          expectedRevision: 1,
          expectedCancelled: false,
        }),
      );
      assert.deepStrictEqual(
        yield* repository.claimDue({ now: "2026-08-18T03:00:00.000Z", limit: 10 }),
        [],
      );
      assert.deepStrictEqual(
        yield* repository.listRuns({ automationId: automation.automationId, limit: 50 }),
        [],
      );
    }),
  );
});
