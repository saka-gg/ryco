import {
  AgentControlAutomationId,
  AgentControlAutomationRunId,
  AgentControlRequestId,
  ProjectId,
  ProviderInstanceId,
  type AgentControlAutomation,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AutomationCentreLive } from "./AutomationCentre.ts";
import { AutomationCentre } from "../Services/AutomationCentre.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import { AgentControlAutomationService } from "../Services/AgentControlAutomation.ts";
import { AgentControlAutomationRepository } from "../../persistence/Services/AgentControlAutomations.ts";
import { AgentControlAutomationRepositoryLive } from "../../persistence/Layers/AgentControlAutomations.ts";
import { AgentControlProposalRepositoryLive } from "../../persistence/Layers/AgentControlProposals.ts";
import { AgentControlOperationRepositoryLive } from "../../persistence/Layers/AgentControlOperations.ts";
import { AgentControlAuditRepositoryLive } from "../../persistence/Layers/AgentControlAudit.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlProposalServiceLive } from "./AgentControlProposalService.ts";
import { AgentControlProposalEventsLive } from "./AgentControlProposalEvents.ts";
import { AgentControlProposalStoreLive } from "./AgentControlProposalStore.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { makeAgentControlAutomationLive } from "./AgentControlAutomation.ts";

const projectId = ProjectId.make("centre-project");
const at = new Date(Date.now() + 3600000).toISOString();
const automation = (id: string): AgentControlAutomation => ({
  automationId: AgentControlAutomationId.make(id),
  projectId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  principal: {
    kind: "automation-owner",
    projectId,
    runtimeMode: "approval-required",
    envMode: "worktree",
  },
  definition: {
    enabled: true,
    schedule: { kind: "once", runAt: at },
    execution: {
      projectId,
      title: "Monitor",
      prompt: "Inspect changes",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "approval-required",
      envMode: "worktree",
    },
  },
  revision: 1,
  enabled: true,
  cancelled: false,
  cancelledAt: null,
  nextRunAt: at,
  createdAt: at,
  updatedAt: at,
});
const layer = it.layer(
  AutomationCentreLive.pipe(
    Layer.provideMerge(makeAgentControlAutomationLive({ disableBackground: true })),
    Layer.provideMerge(AgentControlProposalServiceLive),
    Layer.provideMerge(AgentControlProposalStoreLive),
    Layer.provideMerge(AgentControlProposalEventsLive),
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(AgentControlAutomationRepositoryLive),
    Layer.provideMerge(AgentControlProposalRepositoryLive),
    Layer.provideMerge(AgentControlOperationRepositoryLive),
    Layer.provideMerge(AgentControlAuditRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
    Layer.provideMerge(
      Layer.succeed(AgentControlActionValidator, {
        validateOwnerAutomation: () => Effect.void,
        validateSubmission: () => Effect.die("unused"),
        validateExternalSubmission: () => Effect.die("unused"),
        revalidateExecution: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.some({ id: projectId })),
      } as unknown as ProjectionSnapshotQueryShape),
    ),
  ),
);

layer("Automation centre", (it) => {
  it.effect(
    "owner authoring creates an inert immutable proposal, and request replay never duplicates it",
    () =>
      Effect.gen(function* () {
        const centre = yield* AutomationCentre;
        const repo = yield* AgentControlAutomationRepository;
        const item = automation("owner-authoring");
        const input = {
          kind: "save" as const,
          projectId,
          requestId: AgentControlRequestId.make("owner-save"),
          automationId: item.automationId,
          expectedRevision: null,
          definition: item.definition,
        };
        const first = yield* centre.command(input);
        const second = yield* centre.command(input);
        assert.strictEqual(first.proposals.at(-1)?.principal.kind, "automation-owner");
        assert.strictEqual(first.proposals.at(-1)?.status, "pending-user-approval");
        assert.deepStrictEqual(
          first.proposals.map((p) => p.proposalId),
          second.proposals.map((p) => p.proposalId),
        );
        assert.isTrue(Option.isNone(yield* repo.getAutomation(item.automationId)));
        const rejected = yield* Effect.flip(
          centre.command({ ...input, definition: { ...item.definition, enabled: false } }),
        );
        assert.strictEqual(rejected.code, "conflict");
      }),
  );

  it.effect(
    "isolates corrupt definitions, runs and active proposals while preserving their evidence",
    () =>
      Effect.gen(function* () {
        const repo = yield* AgentControlAutomationRepository;
        const service = yield* AgentControlAutomationService;
        const centre = yield* AutomationCentre;
        const sql = yield* SqlClient.SqlClient;
        for (const id of ["bad-definition", "bad-run", "bad-proposal", "healthy"])
          yield* repo.insertAutomation(automation(id));
        yield* sql`UPDATE agent_control_automations SET definition_json = 'broken-definition' WHERE automation_id = 'bad-definition'`;
        const claimed = yield* repo.claimDue({ now: at, limit: 25 });
        assert.isFalse(claimed.some((c) => c.automation.automationId === "bad-definition"));
        const badRun = claimed.find((c) => c.automation.automationId === "bad-run")!.run;
        yield* sql`UPDATE agent_control_automation_runs SET scheduled_for = 'broken-date' WHERE run_id = ${badRun.runId}`;
        yield* service.recover;
        const badProposalRun = (yield* repo.listRuns({
          automationId: AgentControlAutomationId.make("bad-proposal"),
          limit: 50,
        }))[0]!;
        yield* sql`UPDATE agent_control_proposals SET plan_json = 'broken-plan' WHERE proposal_id = ${badProposalRun.proposalId}`;
        yield* service.recover;
        yield* repo.insertAutomation(automation("healthy-after-corruption"));
        yield* repo.claimDue({ now: at, limit: 25 });
        yield* service.recover;
        const result = yield* centre.snapshot({ projectId });
        assert.isTrue(result.automations.some((a) => a.automationId === "healthy"));
        assert.isTrue(
          result.proposals.some(
            (p) =>
              p.plan.kind === "automationRun" && p.plan.automationId === "healthy-after-corruption",
          ),
        );
        assert.isTrue(result.runs.some((r) => r.run.automationId === "healthy"));
        assert.isTrue(
          result.proposals.some(
            (p) => p.plan.kind === "automationRun" && p.plan.automationId === "healthy",
          ),
        );
        assert.isAtLeast(result.unavailableRecords, 3);
        const rows = yield* sql<{
          value: string;
        }>`SELECT definition_json AS value FROM agent_control_automations WHERE automation_id = 'bad-definition'`;
        assert.strictEqual(rows[0]?.value, "broken-definition");
        const proposals = yield* sql<{
          value: string;
        }>`SELECT plan_json AS value FROM agent_control_proposals WHERE proposal_id = ${badProposalRun.proposalId}`;
        assert.strictEqual(proposals[0]?.value, "broken-plan");
      }),
  );

  it.effect("refuses a failed dispatch even when no affected thread IDs were recorded", () =>
    Effect.gen(function* () {
      const repo = yield* AgentControlAutomationRepository;
      const centre = yield* AutomationCentre;
      const sql = yield* SqlClient.SqlClient;
      yield* repo.insertAutomation(automation("uncertain-dispatch"));
      const claim = (yield* repo.claimDue({ now: at, limit: 25 })).find(
        (c) => c.automation.automationId === "uncertain-dispatch",
      )!;
      // Crash after delivery, before the receipt/link checkpoint: absence of IDs proves nothing.
      yield* sql`UPDATE agent_control_automation_runs SET status = 'failed', completed_at = ${at} WHERE run_id = ${claim.run.runId}`;
      const error = yield* Effect.flip(
        centre.command({
          kind: "retry",
          projectId,
          runId: claim.run.runId,
          requestId: AgentControlRequestId.make("uncertain-retry"),
        }),
      );
      assert.strictEqual(error.code, "conflict");
      assert.match(error.message, /uncertain/);
      assert.lengthOf(yield* repo.listRuns({ automationId: claim.run.automationId, limit: 50 }), 1);
    }),
  );

  it.effect(
    "simultaneous retries retain one active occurrence and immutable request identity",
    () =>
      Effect.gen(function* () {
        const repo = yield* AgentControlAutomationRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.insertAutomation(automation("retry-concurrent"));
        const source = (yield* repo.claimDue({ now: at, limit: 25 })).find(
          (c) => c.automation.automationId === "retry-concurrent",
        )!.run;
        yield* sql`UPDATE agent_control_automation_runs SET status = 'rejected', completed_at = ${at} WHERE run_id = ${source.runId}`;
        const terminal = (yield* repo.listRuns({
          automationId: source.automationId,
          limit: 50,
        }))[0]!;
        const results = yield* Effect.all(
          [1, 2].map((i) =>
            repo.retryRun({
              runId: AgentControlAutomationRunId.make(`retry-request-${i}`),
              source: terminal,
              now: new Date(Date.now() + i).toISOString(),
            }),
          ),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(results.filter(Boolean).length, 1);
        const winner = results[0] ? "retry-request-1" : "retry-request-2";
        assert.isTrue(
          yield* repo.retryRun({
            runId: AgentControlAutomationRunId.make(winner),
            source: terminal,
            now: at,
          }),
        );
        assert.isFalse(
          yield* repo.retryRun({
            runId: AgentControlAutomationRunId.make(winner),
            source: { ...terminal, runId: AgentControlAutomationRunId.make("different-source") },
            now: at,
          }),
        );
        assert.lengthOf(
          (yield* repo.listRuns({ automationId: source.automationId, limit: 50 })).filter(
            (r) => r.status === "materializing",
          ),
          1,
        );
      }),
  );

  it.effect("read state survives rereads and rejects stale run revisions", () =>
    Effect.gen(function* () {
      const repo = yield* AgentControlAutomationRepository;
      yield* repo.insertAutomation(automation("read-state"));
      const run = (yield* repo.claimDue({ now: at, limit: 25 })).find(
        (c) => c.automation.automationId === "read-state",
      )!.run;
      assert.isTrue(
        yield* repo.markRead({ runId: run.runId, expectedUpdatedAt: run.updatedAt, unread: false }),
      );
      assert.strictEqual(
        (yield* repo.centreMetadata(projectId)).runs.find((r) => r.runId === run.runId)
          ?.readUpdatedAt,
        run.updatedAt,
      );
      assert.isFalse(
        yield* repo.markRead({
          runId: run.runId,
          expectedUpdatedAt: "1999-01-01T00:00:00.000Z",
          unread: false,
        }),
      );
    }),
  );
});
