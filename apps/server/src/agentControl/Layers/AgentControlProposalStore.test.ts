import {
  AgentControlOperationId,
  AgentControlProposalId,
  AgentControlRequestId,
  AgentControlRiskTag,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlActionPlan,
  type AgentControlPrincipal,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlAuditRepository } from "../../persistence/Services/AgentControlAudit.ts";
import { AgentControlProposalRepository } from "../../persistence/Services/AgentControlProposals.ts";
import { AgentControlAuditRepositoryLive } from "../../persistence/Layers/AgentControlAudit.ts";
import { AgentControlOperationRepositoryLive } from "../../persistence/Layers/AgentControlOperations.ts";
import { AgentControlProposalRepositoryLive } from "../../persistence/Layers/AgentControlProposals.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { AgentControlProposalEventsLive } from "./AgentControlProposalEvents.ts";
import { AgentControlProposalStoreLive } from "./AgentControlProposalStore.ts";

const SECRET_PROMPT = "SECRET-PROMPT-TOKEN: rotate the API keys in vault";

const principal: AgentControlPrincipal = {
  kind: "provider-session",
  threadId: ThreadId.make("thread-1"),
  providerInstanceId: ProviderInstanceId.make("codex"),
};

const createThreadsPlan = (prompt: string): AgentControlActionPlan => ({
  kind: "createThreads",
  entries: [
    {
      projectId: ProjectId.make("project-1"),
      title: "Fix the flaky test",
      prompt,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "full-access",
      envMode: "worktree",
    },
  ],
});

const submitInput = (requestIdValue: string, prompt: string = SECRET_PROMPT) => ({
  principal,
  requestId: AgentControlRequestId.make(requestIdValue),
  plan: createThreadsPlan(prompt),
  riskTags: [AgentControlRiskTag.make("creates-threads")],
  promptSummary: "Create 1 thread in project-1",
  expiresAt: "2026-08-17T01:00:00.000Z",
  now: "2026-08-17T00:00:00.000Z",
});

const makeLayer = (enabled: boolean) =>
  AgentControlProposalStoreLive.pipe(
    Layer.provideMerge(AgentControlProposalEventsLive),
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(AgentControlProposalRepositoryLive),
    Layer.provideMerge(AgentControlOperationRepositoryLive),
    Layer.provideMerge(AgentControlAuditRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerSettingsService.layerTest(enabled ? { agentControl: { enabled: true } } : {}),
    ),
  );

const disabledLayer = it.layer(makeLayer(false));
const enabledLayer = it.layer(makeLayer(true));

disabledLayer("AgentControlProposalStore (feature disabled)", (it) => {
  it.effect("fails closed on every entry point", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;

      const submitError = yield* Effect.flip(store.submit(submitInput("request-disabled")));
      assert.strictEqual(submitError._tag, "AgentControlDisabledError");

      const decideError = yield* Effect.flip(
        store.decide({
          proposalId: AgentControlProposalId.make("proposal-any"),
          decision: "approved",
          actor: "user",
          decidedAt: "2026-08-17T00:00:01.000Z",
        }),
      );
      assert.strictEqual(decideError._tag, "AgentControlDisabledError");

      const beginError = yield* Effect.flip(
        store.beginExecution({
          proposalId: AgentControlProposalId.make("proposal-any"),
          actor: "executor",
          now: "2026-08-17T00:00:01.000Z",
        }),
      );
      assert.strictEqual(beginError._tag, "AgentControlDisabledError");
    }),
  );
});

enabledLayer("AgentControlProposalStore", (it) => {
  it.effect("creates an immutable pending proposal with a computed digest and audit row", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const audit = yield* AgentControlAuditRepository;
      const input = submitInput("request-create");

      const { proposal, replayed } = yield* store.submit(input);
      assert.isFalse(replayed);
      assert.strictEqual(proposal.status, "pending-user-approval");
      assert.strictEqual(proposal.planDigest, computeAgentControlPlanDigest(input.plan));
      assert.strictEqual(proposal.decidedAt, null);
      assert.strictEqual(proposal.result, null);

      const trail = yield* audit.listByProposalId({ proposalId: proposal.proposalId });
      assert.deepStrictEqual(
        trail.map((row) => String(row.eventKind)),
        ["proposal-created"],
      );
      assert.deepStrictEqual((yield* store.listPending({ limit: 50 })).length >= 1, true);
    }),
  );

  it.effect("replays an identical request without creating a second proposal", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const audit = yield* AgentControlAuditRepository;
      const input = submitInput("request-replay");

      const first = yield* store.submit(input);
      const second = yield* store.submit(input);
      assert.isTrue(second.replayed);
      assert.strictEqual(second.proposal.proposalId, first.proposal.proposalId);
      assert.strictEqual(second.proposal.planDigest, first.proposal.planDigest);

      const trail = yield* audit.listByProposalId({ proposalId: first.proposal.proposalId });
      assert.deepStrictEqual(
        trail.map((row) => String(row.eventKind)),
        ["proposal-created"],
      );
    }),
  );

  it.effect("rejects reusing a request id with a different plan and audits the attempt", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const audit = yield* AgentControlAuditRepository;

      const first = yield* store.submit(submitInput("request-dup"));
      const error = yield* Effect.flip(
        store.submit({
          ...submitInput("request-dup", "A completely different prompt."),
          now: "2026-08-17T00:00:01.000Z",
        }),
      );
      assert.strictEqual(error._tag, "AgentControlDuplicateRequestError");
      if (error._tag !== "AgentControlDuplicateRequestError") return;
      assert.strictEqual(error.existingProposalId, first.proposal.proposalId);
      assert.notStrictEqual(error.requestedPlanDigest, error.existingPlanDigest);

      // The original proposal is untouched.
      const unchanged = Option.getOrThrow(yield* store.getById(first.proposal.proposalId));
      assert.strictEqual(unchanged.planDigest, first.proposal.planDigest);
      assert.strictEqual(unchanged.status, "pending-user-approval");

      const trail = yield* audit.listByProposalId({ proposalId: first.proposal.proposalId });
      assert.deepStrictEqual(
        trail.map((row) => String(row.eventKind)),
        ["proposal-created", "duplicate-request-rejected"],
      );
    }),
  );

  it.effect("runs the approved lifecycle and preserves the digest through every transition", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const repository = yield* AgentControlProposalRepository;
      const { proposal } = yield* store.submit(submitInput("request-lifecycle"));

      const approved = yield* store.decide({
        proposalId: proposal.proposalId,
        decision: "approved",
        actor: "user",
        decidedAt: "2026-08-17T00:05:00.000Z",
      });
      assert.strictEqual(approved.status, "approved");
      assert.strictEqual(approved.decidedAt, "2026-08-17T00:05:00.000Z");

      // Only the executor may move an accepted proposal into executing.
      const userBegin = yield* Effect.flip(
        store.beginExecution({
          proposalId: proposal.proposalId,
          actor: "user",
          now: "2026-08-17T00:06:00.000Z",
        }),
      );
      assert.strictEqual(userBegin._tag, "AgentControlInvalidTransitionError");

      const executing = yield* store.beginExecution({
        proposalId: proposal.proposalId,
        actor: "executor",
        now: "2026-08-17T00:06:00.000Z",
      });
      assert.strictEqual(executing.status, "executing");

      const completed = yield* store.settleExecution({
        proposalId: proposal.proposalId,
        result: {
          outcome: "completed",
          createdThreadIds: [ThreadId.make("thread-2")],
          completedAt: "2026-08-17T00:07:00.000Z",
        },
        now: "2026-08-17T00:07:00.000Z",
      });
      assert.strictEqual(completed.status, "completed");

      const row = Option.getOrThrow(yield* repository.getById({ proposalId: proposal.proposalId }));
      assert.strictEqual(row.planDigest, proposal.planDigest);
      assert.deepStrictEqual(row.plan, proposal.plan);
      assert.strictEqual(row.result?.outcome, "completed");
    }),
  );

  it.effect("preserves an exact project plan and its execution result with the audit trail", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const repository = yield* AgentControlProposalRepository;
      const audit = yield* AgentControlAuditRepository;
      const projectPlan: AgentControlActionPlan = {
        kind: "updateProject",
        projectId: ProjectId.make("project-1"),
        before: {
          title: "Before",
          workspaceRoot: "/workspace/before",
          repositoryIdentityKey: "git:example/project",
          updatedAt: "2026-08-17T00:00:00.000Z",
        },
        after: {
          title: "After",
          workspaceRoot: "/workspace/after",
          repositoryIdentityKey: "git:example/project",
        },
      };
      const { proposal } = yield* store.submit({
        principal,
        requestId: AgentControlRequestId.make("request-project-audit"),
        plan: projectPlan,
        riskTags: [AgentControlRiskTag.make("modifies-project-metadata")],
        promptSummary: "Update project project-1",
        expiresAt: "2026-08-17T01:00:00.000Z",
        now: "2026-08-17T00:00:00.000Z",
      });
      yield* store.decide({
        proposalId: proposal.proposalId,
        decision: "approved",
        actor: "user",
        decidedAt: "2026-08-17T00:01:00.000Z",
      });
      yield* store.beginExecution({
        proposalId: proposal.proposalId,
        actor: "executor",
        now: "2026-08-17T00:02:00.000Z",
      });
      const operationId = AgentControlOperationId.make("operation-project-audit");
      const result = {
        outcome: "completed" as const,
        execution: {
          operationId,
          commands: [],
          affectedThreadIds: [],
          affectedProjectIds: [ProjectId.make("project-1")],
          affectedAutomationIds: [],
          worktreeIds: [],
        },
        completedAt: "2026-08-17T00:03:00.000Z",
      };
      yield* store.settleExecution({
        proposalId: proposal.proposalId,
        result,
        now: result.completedAt,
      });

      const persisted = Option.getOrThrow(
        yield* repository.getById({ proposalId: proposal.proposalId }),
      );
      assert.deepStrictEqual(persisted.plan, projectPlan);
      assert.deepStrictEqual(persisted.result, result);

      const trail = yield* audit.listByProposalId({ proposalId: proposal.proposalId });
      assert.deepStrictEqual(
        trail.map((row) => String(row.eventKind)),
        ["proposal-created", "proposal-approved", "proposal-executing", "proposal-completed"],
      );
      assert.isTrue(trail.every((row) => row.metadata.planDigest === proposal.planDigest));
      assert.strictEqual(trail.at(-1)?.metadata.outcome, "completed");
      assert.strictEqual(trail.at(-1)?.metadata.operationId, operationId);
    }),
  );

  it.effect("rejects illegal transitions outright", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const { proposal } = yield* store.submit(submitInput("request-illegal"));

      // Pending proposals cannot execute — not even for the executor.
      const pendingBegin = yield* Effect.flip(
        store.beginExecution({
          proposalId: proposal.proposalId,
          actor: "executor",
          now: "2026-08-17T00:01:00.000Z",
        }),
      );
      assert.strictEqual(pendingBegin._tag, "AgentControlInvalidTransitionError");

      // Settling something that never began executing is illegal.
      const settleError = yield* Effect.flip(
        store.settleExecution({
          proposalId: proposal.proposalId,
          result: { outcome: "completed", completedAt: "2026-08-17T00:01:00.000Z" },
          now: "2026-08-17T00:01:00.000Z",
        }),
      );
      assert.strictEqual(settleError._tag, "AgentControlInvalidTransitionError");

      // Approval decisions belong to the user, not the executor.
      const executorApprove = yield* Effect.flip(
        store.decide({
          proposalId: proposal.proposalId,
          decision: "approved",
          actor: "executor",
          decidedAt: "2026-08-17T00:01:00.000Z",
        }),
      );
      assert.strictEqual(executorApprove._tag, "AgentControlInvalidTransitionError");
    }),
  );

  it.effect("never executes rejected or cancelled proposals", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;

      const rejected = yield* store.submit(submitInput("request-rejected"));
      yield* store.decide({
        proposalId: rejected.proposal.proposalId,
        decision: "rejected",
        actor: "user",
        decidedAt: "2026-08-17T00:05:00.000Z",
      });
      const rejectedBegin = yield* Effect.flip(
        store.beginExecution({
          proposalId: rejected.proposal.proposalId,
          actor: "executor",
          now: "2026-08-17T00:06:00.000Z",
        }),
      );
      assert.strictEqual(rejectedBegin._tag, "AgentControlInvalidTransitionError");
      const rejectedRow = Option.getOrThrow(yield* store.getById(rejected.proposal.proposalId));
      assert.strictEqual(rejectedRow.result?.outcome, "failed");

      const cancelled = yield* store.submit(submitInput("request-cancelled"));
      yield* store.decide({
        proposalId: cancelled.proposal.proposalId,
        decision: "cancelled",
        actor: "user",
        decidedAt: "2026-08-17T00:05:00.000Z",
      });
      const cancelledBegin = yield* Effect.flip(
        store.beginExecution({
          proposalId: cancelled.proposal.proposalId,
          actor: "executor",
          now: "2026-08-17T00:06:00.000Z",
        }),
      );
      assert.strictEqual(cancelledBegin._tag, "AgentControlInvalidTransitionError");
    }),
  );

  it.effect("expires an approved proposal at execution time instead of running it", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const { proposal } = yield* store.submit(submitInput("request-expiry"));
      yield* store.decide({
        proposalId: proposal.proposalId,
        decision: "approved",
        actor: "user",
        decidedAt: "2026-08-17T00:05:00.000Z",
      });

      const expiredError = yield* Effect.flip(
        store.beginExecution({
          proposalId: proposal.proposalId,
          actor: "executor",
          now: "2026-08-17T02:00:00.000Z",
        }),
      );
      assert.strictEqual(expiredError._tag, "AgentControlProposalExpiredError");

      const row = Option.getOrThrow(yield* store.getById(proposal.proposalId));
      assert.strictEqual(row.status, "expired");
      assert.strictEqual(row.result?.outcome, "failed");

      // Terminal: a later execution attempt stays refused.
      const retry = yield* Effect.flip(
        store.beginExecution({
          proposalId: proposal.proposalId,
          actor: "executor",
          now: "2026-08-17T02:01:00.000Z",
        }),
      );
      assert.strictEqual(retry._tag, "AgentControlProposalExpiredError");
    }),
  );

  it.effect("refuses to approve a proposal whose expiry already passed", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const { proposal } = yield* store.submit(submitInput("request-late-approve"));

      const error = yield* Effect.flip(
        store.decide({
          proposalId: proposal.proposalId,
          decision: "approved",
          actor: "user",
          decidedAt: "2026-08-17T03:00:00.000Z",
        }),
      );
      assert.strictEqual(error._tag, "AgentControlProposalExpiredError");
      const row = Option.getOrThrow(yield* store.getById(proposal.proposalId));
      assert.strictEqual(row.status, "expired");
    }),
  );

  it.effect("reports terminal proposals as invalid transitions, not as expired", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const { proposal } = yield* store.submit(submitInput("request-terminal-expiry"));
      yield* store.decide({
        proposalId: proposal.proposalId,
        decision: "rejected",
        actor: "user",
        decidedAt: "2026-08-17T00:05:00.000Z",
      });

      // Long past expiresAt: the refusal must name the real state
      // ("rejected"), not misreport the settled proposal as expired.
      const begin = yield* Effect.flip(
        store.beginExecution({
          proposalId: proposal.proposalId,
          actor: "executor",
          now: "2026-08-17T02:00:00.000Z",
        }),
      );
      assert.strictEqual(begin._tag, "AgentControlInvalidTransitionError");

      const decide = yield* Effect.flip(
        store.decide({
          proposalId: proposal.proposalId,
          decision: "cancelled",
          actor: "user",
          decidedAt: "2026-08-17T02:00:00.000Z",
        }),
      );
      assert.strictEqual(decide._tag, "AgentControlInvalidTransitionError");

      const row = Option.getOrThrow(yield* store.getById(proposal.proposalId));
      assert.strictEqual(row.status, "rejected");
    }),
  );

  it.effect("rolls the state change back when the audit append fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* AgentControlProposalStore;
      const { proposal } = yield* store.submit(submitInput("request-atomic"));

      yield* sql`
        CREATE TRIGGER agent_control_audit_fail
        BEFORE INSERT ON agent_control_audit
        BEGIN
          SELECT RAISE(ABORT, 'injected audit failure');
        END
      `;
      const error = yield* Effect.flip(
        store.decide({
          proposalId: proposal.proposalId,
          decision: "approved",
          actor: "user",
          decidedAt: "2026-08-17T00:05:00.000Z",
        }),
      );
      assert.strictEqual(error._tag, "PersistenceSqlError");
      yield* sql`DROP TRIGGER agent_control_audit_fail`;

      // The status change rolled back with the audit failure, so the user
      // can retry the decision and the audit trail stays gapless.
      const row = Option.getOrThrow(yield* store.getById(proposal.proposalId));
      assert.strictEqual(row.status, "pending-user-approval");
      const approved = yield* store.decide({
        proposalId: proposal.proposalId,
        decision: "approved",
        actor: "user",
        decidedAt: "2026-08-17T00:06:00.000Z",
      });
      assert.strictEqual(approved.status, "approved");
    }),
  );

  it.effect("keeps prompts and plan payloads out of audit rows", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const audit = yield* AgentControlAuditRepository;
      const { proposal } = yield* store.submit(submitInput("request-redaction"));
      yield* store.decide({
        proposalId: proposal.proposalId,
        decision: "rejected",
        actor: "user",
        decidedAt: "2026-08-17T00:05:00.000Z",
      });

      const trail = yield* audit.listByProposalId({ proposalId: proposal.proposalId });
      assert.isAtLeast(trail.length, 2);
      const serialized = JSON.stringify(trail);
      assert.notInclude(serialized, "SECRET-PROMPT-TOKEN");
      assert.notInclude(serialized, "rotate the API keys");
      assert.notInclude(serialized, "Fix the flaky test");
      // Identifiers and the audit-safe summary are retained.
      assert.include(serialized, proposal.planDigest);
      assert.include(serialized, "Create 1 thread in project-1");
    }),
  );

  it.effect("keeps device URLs and artifact paths out of audit metadata", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const audit = yield* AgentControlAuditRepository;
      const common = {
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        expectedProjectUpdatedAt: "2026-08-17T00:00:00.000Z",
        providerInstanceId: ProviderInstanceId.make("codex"),
        udid: "FAKE-0001" as never,
        expectedThreadDeviceVersion: 2,
        expectedAttachedDeviceUdid: "FAKE-0001" as never,
        expectedDeviceState: "booted" as const,
        expectedDeviceBootSource: "ryco" as const,
        expectedRecording: false,
      };
      const secretUrl = "ryco-secret://account/reset?token=never-audit-this";
      const artifactPath = "private/build/SecretProduct.app";
      const plans: readonly AgentControlActionPlan[] = [
        {
          kind: "deviceOpenUrl",
          ...common,
          executionSummary: "Open an approved URL or deep link",
          riskClass: "open-world",
          url: secretUrl,
        },
        {
          kind: "deviceInstall",
          ...common,
          executionSummary: "Install an approved workspace application",
          riskClass: "device-control",
          artifactPath: artifactPath as never,
        },
      ];
      for (const [index, plan] of plans.entries()) {
        const { proposal } = yield* store.submit({
          principal,
          requestId: AgentControlRequestId.make(`request-device-redaction-${index}`),
          plan,
          riskTags: [AgentControlRiskTag.make("device-mutation")],
          promptSummary: "Govern one exact Simulator action",
          expiresAt: "2026-08-17T01:00:00.000Z",
          now: "2026-08-17T00:00:00.000Z",
        });
        const serialized = JSON.stringify(
          yield* audit.listByProposalId({ proposalId: proposal.proposalId }),
        );
        assert.notInclude(serialized, secretUrl);
        assert.notInclude(serialized, artifactPath);
        assert.include(serialized, "FAKE-0001");
        assert.include(serialized, "sensitivePayloadsExcluded");
      }
    }),
  );
});

enabledLayer("private routine authorization", (it) => {
  it.effect("atomically approves routine requests and replays the same durable receipt", () =>
    Effect.gen(function* () {
      const store = yield* AgentControlProposalStore;
      const input = { ...submitInput("routine-create"), authorizeRoutine: true };
      const first = yield* store.submit(input);
      assert.strictEqual(first.proposal.status, "approved");
      assert.strictEqual(first.proposal.decidedAt, input.now);
      const replay = yield* store.submit(input);
      assert.isTrue(replay.replayed);
      assert.strictEqual(replay.proposal.proposalId, first.proposal.proposalId);
    }),
  );
  it.effect(
    "keeps archive and runtime security changes pending despite routine authorization",
    () =>
      Effect.gen(function* () {
        const store = yield* AgentControlProposalStore;
        for (const [index, plan] of [
          { kind: "updateThread", threadId: ThreadId.make("child"), archived: true },
          { kind: "updateThread", threadId: ThreadId.make("child"), runtimeMode: "full-access" },
        ].entries()) {
          const result = yield* store.submit({
            ...submitInput(`sensitive-${index}`),
            authorizeRoutine: true,
            plan: plan as AgentControlActionPlan,
          });
          assert.strictEqual(result.proposal.status, "pending-user-approval");
          assert.strictEqual(result.proposal.decidedAt, null);
        }
      }),
  );
});
