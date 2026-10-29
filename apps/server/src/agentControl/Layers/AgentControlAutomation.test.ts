import {
  AGENT_CONTROL_ERROR_CODES,
  AGENT_CONTROL_RISK_TAGS,
  AgentControlAutomationId,
  AgentControlProposalId,
  AgentControlRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlAutomation,
  type AgentControlProposal,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Duration, Effect, Layer, Logger, Option } from "effect";
import { TestClock } from "effect/testing";

import { AgentControlAuditRepositoryLive } from "../../persistence/Layers/AgentControlAudit.ts";
import { AgentControlAutomationRepositoryLive } from "../../persistence/Layers/AgentControlAutomations.ts";
import { AgentControlOperationRepositoryLive } from "../../persistence/Layers/AgentControlOperations.ts";
import { AgentControlProposalRepositoryLive } from "../../persistence/Layers/AgentControlProposals.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AgentControlAutomationRepository } from "../../persistence/Services/AgentControlAutomations.ts";
import { AgentControlAuditRepository } from "../../persistence/Services/AgentControlAudit.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlAutomationService } from "../Services/AgentControlAutomation.ts";
import {
  AgentControlProposalStore,
  agentControlFailureResult,
} from "../Services/AgentControlProposalStore.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { AgentControlProposalEventsLive } from "./AgentControlProposalEvents.ts";
import { AgentControlProposalStoreLive } from "./AgentControlProposalStore.ts";
import { makeAgentControlAutomationLive } from "./AgentControlAutomation.ts";

const projectId = ProjectId.make("project-automation-lifecycle");
const otherProjectId = ProjectId.make("project-automation-other");
const providerInstanceId = ProviderInstanceId.make("provider-automation-lifecycle");

const principal = {
  kind: "provider-session" as const,
  threadId: ThreadId.make("thread-automation-origin"),
  providerInstanceId,
  originProjectId: projectId,
  originRuntimeMode: "approval-required" as const,
  originEnvMode: "worktree" as const,
};

const ownerPrincipal = {
  kind: "automation-owner" as const,
  projectId,
  runtimeMode: "approval-required" as const,
  envMode: "worktree" as const,
};

const makeAutomation = (id: string, start: string): AgentControlAutomation => ({
  automationId: AgentControlAutomationId.make(id),
  principal,
  projectId,
  providerInstanceId,
  definition: {
    execution: {
      projectId,
      title: "Governed task",
      prompt: "Perform only the approved governed task.",
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      runtimeMode: "approval-required",
      envMode: "worktree",
    },
    schedule: { kind: "once", runAt: start },
    enabled: true,
  },
  revision: 1,
  enabled: true,
  cancelled: false,
  cancelledAt: null,
  nextRunAt: start,
  createdAt: start,
  updatedAt: start,
});

const makeAutomationLayer = (
  enabled: boolean,
  options: Parameters<typeof makeAgentControlAutomationLive>[0],
) =>
  makeAgentControlAutomationLive(options).pipe(
    Layer.provideMerge(AgentControlAutomationRepositoryLive),
    Layer.provideMerge(AgentControlProposalStoreLive),
    Layer.provideMerge(AgentControlProposalEventsLive),
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(AgentControlProposalRepositoryLive),
    Layer.provideMerge(AgentControlOperationRepositoryLive),
    Layer.provideMerge(AgentControlAuditRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest({ agentControl: { enabled } })),
  );

const layer = it.layer(makeAutomationLayer(true, { disableBackground: true }));

const cancellationProposal = (
  automation: AgentControlAutomation,
  request: string,
): AgentControlProposal => ({
  proposalId: AgentControlProposalId.make(`proposal-${request}`),
  requestId: AgentControlRequestId.make(request),
  principal,
  planVersion: 1,
  plan: {
    kind: "cancelAutomation",
    automationId: automation.automationId,
    expected: {
      revision: automation.revision,
      definition: automation.definition,
      cancelled: automation.cancelled,
      updatedAt: automation.updatedAt,
    },
  },
  planDigest: "a".repeat(64),
  riskTags: [AGENT_CONTROL_RISK_TAGS.cancelsAutomation],
  promptSummary: "Cancel future runs",
  status: "executing",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  expiresAt: "2099-01-01T00:00:00.000Z",
  decidedAt: new Date().toISOString(),
  result: null,
});

layer("AgentControlAutomationService", (it) => {
  it.effect("accepted schedule definitions only persist lifecycle state", () =>
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      const automations = yield* AgentControlAutomationService;
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const automationId = AgentControlAutomationId.make("automation-accepted-definition");
      const proposal: AgentControlProposal = {
        proposalId: AgentControlProposalId.make("proposal-accepted-definition"),
        requestId: AgentControlRequestId.make("request-accepted-definition"),
        principal,
        planVersion: 1,
        plan: {
          kind: "createAutomation",
          automationId,
          definition: makeAutomation("template-only", runAt).definition,
        },
        planDigest: "e".repeat(64),
        riskTags: [AGENT_CONTROL_RISK_TAGS.createsAutomation],
        promptSummary: "Create schedule definition",
        status: "executing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z",
        decidedAt: new Date().toISOString(),
        result: null,
      };

      const stored = yield* automations.applyLifecycle(proposal);
      assert.strictEqual(stored.automationId, automationId);
      assert.strictEqual(stored.nextRunAt, runAt);
      assert.deepStrictEqual(yield* repository.listRuns({ automationId, limit: 50 }), []);
      // Lifecycle application has no orchestration or provider runtime
      // dependency, so approval cannot create a thread or start a turn.
    }),
  );

  it.effect("materializes one fresh inert proposal and recovery does not duplicate it", () =>
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      const automations = yield* AgentControlAutomationService;
      const proposals = yield* AgentControlProposalStore;
      const audit = yield* AgentControlAuditRepository;
      const automation = makeAutomation(
        "automation-due-once",
        new Date(Date.now() - 60_000).toISOString(),
      );
      assert.isTrue(yield* repository.insertAutomation(automation));
      assert.strictEqual(yield* automations.materializeDue, 1);
      assert.strictEqual(yield* automations.materializeDue, 0);
      yield* automations.recover;
      yield* automations.recover;

      const active = (yield* proposals.listActive({ limit: 100 })).filter(
        (proposal) =>
          proposal.plan.kind === "automationRun" &&
          proposal.plan.automationId === automation.automationId,
      );
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0]?.status, "pending-user-approval");
      const auditTrail = yield* audit.listByProposalId({
        proposalId: active[0]!.proposalId,
      });
      assert.strictEqual(auditTrail[0]?.metadata.schedulerOutcome, "on-time");
      assert.strictEqual(
        auditTrail[0]?.metadata.recoverySafety,
        "idempotent-occurrence-and-request",
      );
      const runs = yield* repository.listRuns({ automationId: automation.automationId, limit: 50 });
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, "pending-approval");
      // No orchestration/provider service is a dependency of scheduling: a
      // due occurrence can only persist its fresh proposal here.
    }),
  );

  it.effect("rejection and expiry make a run terminal and permit no execution", () =>
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      const automations = yield* AgentControlAutomationService;
      const proposals = yield* AgentControlProposalStore;
      const automation = makeAutomation(
        "automation-rejected",
        new Date(Date.now() - 60_000).toISOString(),
      );
      assert.isTrue(yield* repository.insertAutomation(automation));
      yield* automations.materializeDue;
      const run = (yield* repository.listRuns({
        automationId: automation.automationId,
        limit: 1,
      }))[0]!;
      assert.isNotNull(run.proposalId);
      const rejected = yield* proposals.decide({
        proposalId: run.proposalId!,
        decision: "rejected",
        actor: "user",
        decidedAt: new Date().toISOString(),
      });
      yield* automations.reconcileProposal(rejected);
      const settled = yield* repository.getRun(run.runId);
      assert.strictEqual(Option.getOrThrow(settled).status, "rejected");
      const refusal = yield* Effect.flip(
        automations.validateRun({ ...rejected, status: "approved" }),
      );
      assert.strictEqual(refusal._tag, "AgentControlPlanValidationError");

      const expiring = makeAutomation(
        "automation-expired",
        new Date(Date.now() - 30_000).toISOString(),
      );
      assert.isTrue(yield* repository.insertAutomation(expiring));
      yield* automations.materializeDue;
      const expiringRun = (yield* repository.listRuns({
        automationId: expiring.automationId,
        limit: 1,
      }))[0]!;
      const expired = yield* proposals.expireOverdue({
        now: "2099-01-01T00:00:00.000Z",
        limit: 100,
      });
      const expiredProposal = expired.find(
        (proposal) => proposal.proposalId === expiringRun.proposalId,
      )!;
      yield* automations.reconcileProposal(expiredProposal);
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getRun(expiringRun.runId)).status,
        "expired",
      );
      const expiredRefusal = yield* Effect.flip(
        automations.validateRun({ ...expiredProposal, status: "approved" }),
      );
      assert.strictEqual(expiredRefusal._tag, "AgentControlPlanValidationError");
    }),
  );

  it.effect(
    "cancellation prevents future runs, wins pending races, and preserves accepted runs",
    () =>
      Effect.gen(function* () {
        const repository = yield* AgentControlAutomationRepository;
        const automations = yield* AgentControlAutomationService;
        const proposals = yield* AgentControlProposalStore;

        const pendingAutomation = makeAutomation(
          "automation-cancel-pending",
          new Date(Date.now() - 60_000).toISOString(),
        );
        assert.isTrue(yield* repository.insertAutomation(pendingAutomation));
        yield* automations.materializeDue;
        const pendingRun = (yield* repository.listRuns({
          automationId: pendingAutomation.automationId,
          limit: 1,
        }))[0]!;
        const cancelledAutomation = yield* automations.applyLifecycle(
          cancellationProposal(pendingAutomation, "cancel-pending"),
        );
        assert.isTrue(cancelledAutomation.cancelled);
        assert.isNull(cancelledAutomation.nextRunAt);
        const cancelledProposal = Option.getOrThrow(
          yield* proposals.getById(pendingRun.proposalId!),
        );
        assert.strictEqual(cancelledProposal.status, "cancelled");
        yield* automations.reconcileProposal(cancelledProposal);
        assert.strictEqual(
          Option.getOrThrow(yield* repository.getRun(pendingRun.runId)).status,
          "cancelled",
        );
        assert.strictEqual(yield* automations.materializeDue, 0);

        const acceptedAutomation = makeAutomation(
          "automation-cancel-accepted",
          new Date(Date.now() - 30_000).toISOString(),
        );
        assert.isTrue(yield* repository.insertAutomation(acceptedAutomation));
        yield* automations.materializeDue;
        const acceptedRun = (yield* repository.listRuns({
          automationId: acceptedAutomation.automationId,
          limit: 1,
        }))[0]!;
        const approved = yield* proposals.decide({
          proposalId: acceptedRun.proposalId!,
          decision: "approved",
          actor: "user",
          decidedAt: new Date().toISOString(),
        });
        yield* automations.reconcileProposal(approved);
        yield* automations.applyLifecycle(
          cancellationProposal(acceptedAutomation, "cancel-after-accept"),
        );
        assert.strictEqual(
          Option.getOrThrow(yield* repository.getRun(acceptedRun.runId)).status,
          "approved",
        );
        yield* automations.validateRun(approved);
      }),
  );

  it.effect("starts a run of an owner's run-without-asking schedule on its own", () =>
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      const automations = yield* AgentControlAutomationService;
      const proposals = yield* AgentControlProposalStore;
      const audit = yield* AgentControlAuditRepository;
      const due = new Date(Date.now() - 60_000).toISOString();
      const owned = makeAutomation("automation-unattended", due);
      const unattended: AgentControlAutomation = {
        ...owned,
        principal: ownerPrincipal,
        definition: { ...owned.definition, runPolicy: "run-without-asking" },
      };
      // An agent-authored definition that says the same still asks.
      const agentAuthored: AgentControlAutomation = {
        ...makeAutomation("automation-agent-unattended", due),
        definition: { ...owned.definition, runPolicy: "run-without-asking" },
      };
      assert.isTrue(yield* repository.insertAutomation(unattended));
      assert.isTrue(yield* repository.insertAutomation(agentAuthored));
      yield* automations.materializeDue;

      const runOf = (automation: AgentControlAutomation) =>
        repository
          .listRuns({ automationId: automation.automationId, limit: 1 })
          .pipe(Effect.map((runs) => runs[0]!));
      const unattendedRun = yield* runOf(unattended);
      assert.strictEqual(unattendedRun.status, "approved");
      const approved = Option.getOrThrow(yield* proposals.getById(unattendedRun.proposalId!));
      assert.strictEqual(approved.status, "approved");
      yield* automations.validateRun(approved);
      const trail = yield* audit.listByProposalId({ proposalId: approved.proposalId });
      assert.isTrue(trail.some((row) => row.metadata.approvedBy === "standing-approval"));

      assert.strictEqual((yield* runOf(agentAuthored)).status, "pending-approval");
    }),
  );

  it.effect("refuses an agent's plan that would let a schedule run without asking", () =>
    Effect.gen(function* () {
      const automations = yield* AgentControlAutomationService;
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const definition = {
        ...makeAutomation("template-unattended", runAt).definition,
        runPolicy: "run-without-asking" as const,
      };
      const proposalFor = (proposalPrincipal: AgentControlProposal["principal"], id: string) =>
        ({
          proposalId: AgentControlProposalId.make(`proposal-${id}`),
          requestId: AgentControlRequestId.make(`request-${id}`),
          principal: proposalPrincipal,
          planVersion: 1,
          plan: {
            kind: "createAutomation",
            automationId: AgentControlAutomationId.make(id),
            definition,
          },
          planDigest: "f".repeat(64),
          riskTags: [AGENT_CONTROL_RISK_TAGS.createsAutomation],
          promptSummary: "Create schedule definition",
          status: "executing",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt: "2099-01-01T00:00:00.000Z",
          decidedAt: new Date().toISOString(),
          result: null,
        }) satisfies AgentControlProposal;

      const refused = yield* Effect.flip(
        automations.applyLifecycle(proposalFor(principal, "automation-agent-refused")),
      );
      assert.strictEqual(refused._tag, "AgentControlPlanValidationError");
      const stored = yield* automations.applyLifecycle(
        proposalFor(ownerPrincipal, "automation-owner-accepted"),
      );
      assert.strictEqual(stored.definition.runPolicy, "run-without-asking");
    }),
  );

  it.effect("pauses an unattended schedule after three failed runs in a row", () =>
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      const automations = yield* AgentControlAutomationService;
      const proposals = yield* AgentControlProposalStore;
      const start = new Date(Date.now() - 10 * 60 * 60_000).toISOString();
      const base = makeAutomation("automation-failing", start);
      const automation: AgentControlAutomation = {
        ...base,
        principal: ownerPrincipal,
        definition: {
          ...base.definition,
          schedule: {
            kind: "fixed-interval",
            startsAt: start,
            intervalMs: 15 * 60_000,
            endsAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          },
          runPolicy: "run-without-asking",
        },
      };
      assert.isTrue(yield* repository.insertAutomation(automation));
      const failNextRun = Effect.gen(function* () {
        yield* automations.materializeDue;
        const run = (yield* repository.listRuns({
          automationId: automation.automationId,
          limit: 1,
        }))[0]!;
        const executing = yield* proposals.beginExecution({
          proposalId: run.proposalId!,
          actor: "executor",
          now: new Date().toISOString(),
        });
        const failed = yield* proposals.settleExecution({
          proposalId: executing.proposalId,
          result: agentControlFailureResult({
            error: {
              code: AGENT_CONTROL_ERROR_CODES.executionFailed,
              message: "Provider down",
              retryable: true,
            },
            failedAt: new Date().toISOString(),
          }),
          now: new Date().toISOString(),
        });
        yield* automations.reconcileProposal(failed);
        // Make the next occurrence due at once, unless the failure paused the schedule.
        const current = Option.getOrThrow(yield* repository.getAutomation(automation.automationId));
        if (!current.enabled) return;
        yield* repository.replaceAutomation({
          automation: { ...current, nextRunAt: new Date(Date.now() - 1_000).toISOString() },
          expectedRevision: current.revision,
          expectedCancelled: false,
        });
      });
      yield* failNextRun;
      yield* failNextRun;
      assert.isTrue(
        Option.getOrThrow(yield* repository.getAutomation(automation.automationId)).enabled,
      );
      yield* failNextRun;
      const paused = Option.getOrThrow(yield* repository.getAutomation(automation.automationId));
      assert.isFalse(paused.enabled);
      assert.isFalse(paused.definition.enabled);
      assert.isNull(paused.nextRunAt);
      assert.strictEqual(paused.revision, automation.revision + 1);
      const last = (yield* repository.listRuns({
        automationId: automation.automationId,
        limit: 1,
      }))[0]!;
      assert.include(last.safeFailureDetail ?? "", "Paused after 3 failed runs in a row");
    }),
  );

  it.effect("runs a calendar schedule at its local time and coalesces missed days", () =>
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      const automations = yield* AgentControlAutomationService;
      const base = makeAutomation("automation-calendar", new Date().toISOString());
      const definition = {
        ...base.definition,
        schedule: {
          kind: "calendar" as const,
          timeZone: "UTC",
          localTime: "00:00",
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          startsAt: new Date(Date.now() + 60_000).toISOString(),
          endsAt: new Date(Date.now() + 20 * 24 * 60 * 60_000).toISOString(),
        },
      };
      yield* automations.validateDefinition(definition, new Date().toISOString());
      const proposal = (id: string, value: typeof definition): AgentControlProposal => ({
        proposalId: AgentControlProposalId.make(`proposal-${id}`),
        requestId: AgentControlRequestId.make(`request-${id}`),
        principal,
        planVersion: 1,
        plan: {
          kind: "createAutomation",
          automationId: AgentControlAutomationId.make(id),
          definition: value,
        },
        planDigest: "c".repeat(64),
        riskTags: [AGENT_CONTROL_RISK_TAGS.createsAutomation],
        promptSummary: "Create schedule definition",
        status: "executing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z",
        decidedAt: new Date().toISOString(),
        result: null,
      });
      const stored = yield* automations.applyLifecycle(proposal("automation-calendar", definition));
      // The first run is the next UTC midnight after the start.
      const nextMidnight = new Date(Date.parse(definition.schedule.startsAt));
      nextMidnight.setUTCHours(24, 0, 0, 0);
      assert.strictEqual(stored.nextRunAt, nextMidnight.toISOString());

      // Three midnights later, the missed ones coalesce into one run.
      assert.isTrue(
        yield* repository.replaceAutomation({
          automation: {
            ...stored,
            nextRunAt: new Date(Date.now() - 3 * 24 * 60 * 60_000 - 1_000).toISOString(),
          },
          expectedRevision: stored.revision,
          expectedCancelled: false,
        }),
      );
      assert.strictEqual(yield* automations.materializeDue, 1);
      const [run] = yield* repository.listRuns({ automationId: stored.automationId, limit: 1 });
      assert.strictEqual(run?.coalescedOccurrences, 3);
      const after = Option.getOrThrow(yield* repository.getAutomation(stored.automationId));
      assert.isTrue(Date.parse(after.nextRunAt!) > Date.now());
      assert.strictEqual(new Date(after.nextRunAt!).getUTCHours(), 0);
    }),
  );

  it.effect("refuses a calendar schedule with an unknown zone or no run before its end", () =>
    Effect.gen(function* () {
      const automations = yield* AgentControlAutomationService;
      const now = new Date().toISOString();
      const base = makeAutomation("automation-calendar-invalid", now).definition;
      const schedule = {
        kind: "calendar" as const,
        timeZone: "UTC",
        localTime: "09:00",
        weekdays: [1],
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
      };
      const reasons = [];
      for (const bad of [
        { ...schedule, timeZone: "Mars/Olympus" },
        { ...schedule, weekdays: [1, 1] },
        // Runs only three days from now but ends in two minutes: no run fits.
        {
          ...schedule,
          weekdays: [(new Date().getUTCDay() + 3) % 7],
          endsAt: new Date(Date.now() + 2 * 60_000).toISOString(),
        },
      ]) {
        const failure = yield* Effect.flip(
          automations.validateDefinition({ ...base, schedule: bad }, now),
        );
        reasons.push(failure.detail);
      }
      assert.deepStrictEqual(reasons, [
        "The schedule's time zone is not known.",
        "The schedule's weekdays must be distinct, 0 to 6.",
        "No run falls between the schedule's start and end.",
      ]);
    }),
  );

  it.effect("hides automations outside the exact project/provider scope", () =>
    Effect.gen(function* () {
      const repository = yield* AgentControlAutomationRepository;
      const automations = yield* AgentControlAutomationService;
      const automation = makeAutomation(
        "automation-scope",
        new Date(Date.now() + 60_000).toISOString(),
      );
      assert.isTrue(yield* repository.insertAutomation(automation));
      const denied = yield* Effect.flip(
        automations.get(automation.automationId, {
          projectId: otherProjectId,
          providerInstanceId,
        }),
      );
      assert.strictEqual(denied._tag, "AgentControlPlanValidationError");
    }),
  );
});

it.effect("keeps the background scheduler idle while Agent Control is disabled", () => {
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => {
    messages.push(String(message));
  });

  return Effect.gen(function* () {
    yield* AgentControlAutomationService;
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(30));
    yield* Effect.yieldNow;
    assert.isFalse(
      messages.some(
        (message) =>
          message.includes("agent-control.automation-scheduler-failed") ||
          message.includes("agent-control.automation-recovery-failed"),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        makeAutomationLayer(false, { schedulerIntervalMs: 5 }),
        Logger.layer([logger], { mergeWithExisting: false }),
        TestClock.layer(),
      ),
    ),
  );
});
