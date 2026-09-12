import {
  AgentControlProposalId,
  AgentControlRequestId,
  AgentControlRiskTag,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlActionPlan,
  type AgentControlPrincipal,
  type AgentControlProposalStreamEvent,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Queue, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlAuditRepository } from "../../persistence/Services/AgentControlAudit.ts";
import { AgentControlAuditRepositoryLive } from "../../persistence/Layers/AgentControlAudit.ts";
import { AgentControlOperationRepositoryLive } from "../../persistence/Layers/AgentControlOperations.ts";
import { AgentControlProposalRepositoryLive } from "../../persistence/Layers/AgentControlProposals.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AgentControlProposalService } from "../Services/AgentControlProposalService.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { AgentControlProposalEventsLive } from "./AgentControlProposalEvents.ts";
import { makeAgentControlProposalServiceLive } from "./AgentControlProposalService.ts";
import { AgentControlProposalStoreLive } from "./AgentControlProposalStore.ts";

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

const submitInput = (requestIdValue: string, overrides?: { readonly expiresAt?: string }) => ({
  principal,
  requestId: AgentControlRequestId.make(requestIdValue),
  plan: createThreadsPlan(`Prompt for ${requestIdValue}`),
  riskTags: [AgentControlRiskTag.make("creates-threads")],
  promptSummary: "Create 1 thread in project-1",
  // Far future by default: queue reads sweep with the real clock, so only
  // tests that exercise expiry may create proposals that can lapse.
  expiresAt: overrides?.expiresAt ?? "2099-01-01T00:00:00.000Z",
  now: "2026-08-17T00:00:00.000Z",
});

const makeLayer = (enabled: boolean) =>
  makeAgentControlProposalServiceLive({ disablePeriodicExpirySweep: true }).pipe(
    Layer.provideMerge(AgentControlProposalStoreLive),
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

disabledLayer("AgentControlProposalService (feature disabled)", (it) => {
  it.effect("fails closed on queue reads and decisions", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;

      const queueError = yield* Effect.flip(service.getQueue({}));
      assert.strictEqual(queueError._tag, "AgentControlDisabledError");

      const getError = yield* Effect.flip(
        service.getProposal(AgentControlProposalId.make("proposal-any")),
      );
      assert.strictEqual(getError._tag, "AgentControlDisabledError");

      const acceptError = yield* Effect.flip(
        service.accept({
          proposalId: AgentControlProposalId.make("proposal-any"),
          decidedAt: "2026-08-17T00:00:01.000Z",
        }),
      );
      assert.strictEqual(acceptError._tag, "AgentControlDisabledError");

      const subscribeError = yield* Effect.flip(service.subscribeQueue({}).pipe(Stream.runHead));
      assert.strictEqual(subscribeError._tag, "AgentControlDisabledError");
    }),
  );

  it.effect("still expires overdue proposals so the queue converges while disabled", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      // No proposals can exist while disabled, but the sweep entry point
      // itself must not be feature-gated.
      const expired = yield* service.expireOverdue("2026-08-17T05:00:00.000Z");
      assert.deepStrictEqual(expired, []);
    }),
  );
});

enabledLayer("AgentControlProposalService", (it) => {
  it.effect(
    "accepts a non-secret settings proposal without mutating settings in the approval service",
    () =>
      Effect.gen(function* () {
        const service = yield* AgentControlProposalService;
        const store = yield* AgentControlProposalStore;
        const settings = yield* ServerSettingsService;
        const before = yield* settings.getSettings;
        const submitted = yield* service.submit({
          principal,
          requestId: AgentControlRequestId.make("request-settings-step-up"),
          plan: {
            kind: "changeSettings",
            change: { kind: "legacyTokenStreaming", before: false, after: true },
          },
          riskTags: [AgentControlRiskTag.make("changes-settings")],
          promptSummary: "Enable legacy token streaming",
          expiresAt: "2099-01-01T00:00:00.000Z",
          now: "2026-08-17T00:00:00.000Z",
        });

        const receipt = yield* service.accept({
          proposalId: submitted.proposal.proposalId,
          decidedAt: "2026-08-17T00:05:00.000Z",
        });
        assert.strictEqual(receipt.status, "approved");
        const unchanged = Option.getOrThrow(yield* store.getById(submitted.proposal.proposalId));
        assert.strictEqual(unchanged.status, "approved");
        assert.strictEqual(unchanged.result, null);
        assert.strictEqual(
          (yield* settings.getSettings).enableLegacyTokenStreaming,
          before.enableLegacyTokenStreaming,
        );
      }),
  );

  it.effect("accepts a pending proposal and returns a bounded receipt", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const store = yield* AgentControlProposalStore;
      const { proposal } = yield* service.submit(submitInput("request-accept"));

      const receipt = yield* service.accept({
        proposalId: proposal.proposalId,
        decidedAt: "2026-08-17T00:05:00.000Z",
      });
      assert.strictEqual(receipt.status, "approved");
      assert.strictEqual(receipt.decidedAt, "2026-08-17T00:05:00.000Z");
      assert.strictEqual(receipt.planDigest, proposal.planDigest);
      assert.strictEqual(receipt.actionKind, "createThreads");
      // Receipts never carry the plan payload or prompt text.
      assert.notInclude(JSON.stringify(receipt), "Prompt for request-accept");

      // The immutable plan and digest survive the decision untouched.
      const row = Option.getOrThrow(yield* store.getById(proposal.proposalId));
      assert.deepStrictEqual(row.plan, proposal.plan);
      assert.strictEqual(row.planDigest, proposal.planDigest);
    }),
  );

  it.effect("rejects a pending proposal with a terminal failure receipt", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const { proposal } = yield* service.submit(submitInput("request-reject"));

      const receipt = yield* service.reject({
        proposalId: proposal.proposalId,
        decidedAt: "2026-08-17T00:05:00.000Z",
      });
      assert.strictEqual(receipt.status, "rejected");
      assert.strictEqual(receipt.result?.outcome, "failed");
      if (receipt.result?.outcome === "failed") {
        assert.strictEqual(String(receipt.result.error.code), "rejected");
      }
    }),
  );

  it.effect("treats a repeated identical decision as idempotent", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const audit = yield* AgentControlAuditRepository;
      const { proposal } = yield* service.submit(submitInput("request-idempotent"));

      const first = yield* service.accept({
        proposalId: proposal.proposalId,
        decidedAt: "2026-08-17T00:05:00.000Z",
      });
      const second = yield* service.accept({
        proposalId: proposal.proposalId,
        decidedAt: "2026-08-17T00:06:00.000Z",
      });
      assert.strictEqual(first.status, "approved");
      assert.strictEqual(second.status, "approved");
      // The replay did not re-transition: one approval audit row only, and
      // the original decision timestamp stands.
      assert.strictEqual(second.decidedAt, "2026-08-17T00:05:00.000Z");
      const trail = yield* audit.listByProposalId({ proposalId: proposal.proposalId });
      assert.deepStrictEqual(
        trail.map((row) => String(row.eventKind)),
        ["proposal-created", "proposal-approved"],
      );
    }),
  );

  it.effect("lets exactly one of two conflicting concurrent decisions win", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const store = yield* AgentControlProposalStore;
      const { proposal } = yield* service.submit(submitInput("request-race"));

      const results = yield* Effect.all(
        [
          service
            .accept({
              proposalId: proposal.proposalId,
              decidedAt: "2026-08-17T00:05:00.000Z",
            })
            .pipe(Effect.result),
          service
            .reject({
              proposalId: proposal.proposalId,
              decidedAt: "2026-08-17T00:05:00.000Z",
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );

      const wins = results.filter((result) => result._tag === "Success");
      const losses = results.filter((result) => result._tag === "Failure");
      assert.strictEqual(wins.length, 1);
      assert.strictEqual(losses.length, 1);
      assert.strictEqual(losses[0]!.failure._tag, "AgentControlInvalidTransitionError");

      const row = Option.getOrThrow(yield* store.getById(proposal.proposalId));
      assert.strictEqual(row.status, wins[0]!.success.status);
    }),
  );

  it.effect("converges two concurrent identical decisions without a double transition", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const audit = yield* AgentControlAuditRepository;
      const { proposal } = yield* service.submit(submitInput("request-race-identical"));

      const results = yield* Effect.all(
        [
          service
            .accept({
              proposalId: proposal.proposalId,
              decidedAt: "2026-08-17T00:05:00.000Z",
            })
            .pipe(Effect.result),
          service
            .accept({
              proposalId: proposal.proposalId,
              decidedAt: "2026-08-17T00:05:01.000Z",
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.isTrue(results.every((result) => result._tag === "Success"));

      const trail = yield* audit.listByProposalId({ proposalId: proposal.proposalId });
      assert.deepStrictEqual(
        trail.map((row) => String(row.eventKind)),
        ["proposal-created", "proposal-approved"],
      );
    }),
  );

  it.effect("expires overdue proposals server-side and refuses late decisions", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const { proposal } = yield* service.submit(
        submitInput("request-overdue", { expiresAt: "2026-08-17T00:30:00.000Z" }),
      );

      const expired = yield* service.expireOverdue("2026-08-17T02:00:00.000Z");
      assert.deepStrictEqual(
        expired.map((entry) => entry.proposalId),
        [proposal.proposalId],
      );
      assert.strictEqual(expired[0]!.status, "expired");
      assert.strictEqual(expired[0]!.result?.outcome, "failed");

      // A second sweep finds nothing: expiry is terminal.
      assert.deepStrictEqual(yield* service.expireOverdue("2026-08-17T03:00:00.000Z"), []);

      const acceptError = yield* Effect.flip(
        service.accept({
          proposalId: proposal.proposalId,
          decidedAt: "2026-08-17T03:00:00.000Z",
        }),
      );
      assert.strictEqual(acceptError._tag, "AgentControlProposalExpiredError");
    }),
  );

  it.effect("sweeps overdue proposals out of the active queue on read", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const overdue = yield* service.submit(
        submitInput("request-queue-overdue", { expiresAt: "2026-08-16T00:00:00.000Z" }),
      );
      const pending = yield* service.submit(
        submitInput("request-queue-pending", { expiresAt: "2099-01-01T00:00:00.000Z" }),
      );

      const queue = yield* service.getQueue({});
      assert.include(
        queue.active.map((entry) => entry.proposalId),
        pending.proposal.proposalId,
      );
      assert.notInclude(
        queue.active.map((entry) => entry.proposalId),
        overdue.proposal.proposalId,
      );
      assert.include(
        queue.recent.map((entry) => entry.proposalId),
        overdue.proposal.proposalId,
      );
      assert.strictEqual(
        queue.recent.find((entry) => entry.proposalId === overdue.proposal.proposalId)?.status,
        "expired",
      );
    }),
  );

  it.effect("moves cancelled proposals into the recent history", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const store = yield* AgentControlProposalStore;
      const { proposal } = yield* service.submit(submitInput("request-cancelled"));
      yield* store.decide({
        proposalId: proposal.proposalId,
        decision: "cancelled",
        actor: "system",
        decidedAt: "2026-08-17T00:10:00.000Z",
      });

      const queue = yield* service.getQueue({});
      assert.notInclude(
        queue.active.map((entry) => entry.proposalId),
        proposal.proposalId,
      );
      assert.strictEqual(
        queue.recent.find((entry) => entry.proposalId === proposal.proposalId)?.status,
        "cancelled",
      );
    }),
  );

  it.effect("streams a snapshot first, then live transition events with rising revisions", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const before = yield* service.submit(submitInput("request-stream-before"));

      const received = yield* Queue.unbounded<AgentControlProposalStreamEvent>();
      const fiber = yield* service.subscribeQueue({}).pipe(
        Stream.runForEach((event) => Queue.offer(received, event)),
        Effect.forkChild,
      );

      const snapshot = yield* Queue.take(received);
      assert.strictEqual(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return;
      assert.include(
        snapshot.queue.active.map((entry) => entry.proposalId),
        before.proposal.proposalId,
      );

      const after = yield* service.submit(submitInput("request-stream-after"));
      const created = yield* Queue.take(received);
      assert.strictEqual(created.type, "proposal");
      if (created.type !== "proposal") return;
      assert.strictEqual(created.proposal.proposalId, after.proposal.proposalId);
      assert.strictEqual(created.proposal.status, "pending-user-approval");
      assert.isAbove(created.revision, snapshot.queue.revision);

      yield* service.accept({
        proposalId: after.proposal.proposalId,
        decidedAt: "2026-08-17T00:05:00.000Z",
      });
      const approved = yield* Queue.take(received);
      assert.strictEqual(approved.type, "proposal");
      if (approved.type !== "proposal") return;
      assert.strictEqual(approved.proposal.proposalId, after.proposal.proposalId);
      assert.strictEqual(approved.proposal.status, "approved");
      assert.isAbove(approved.revision, created.revision);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("does not publish a change event for an identical-request replay", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const first = yield* service.submit(submitInput("request-replay-silent"));

      const received = yield* Queue.unbounded<AgentControlProposalStreamEvent>();
      const fiber = yield* service.subscribeQueue({}).pipe(
        Stream.runForEach((event) => Queue.offer(received, event)),
        Effect.forkChild,
      );
      const snapshot = yield* Queue.take(received);
      assert.strictEqual(snapshot.type, "snapshot");

      const replay = yield* service.submit(submitInput("request-replay-silent"));
      assert.isTrue(replay.replayed);
      assert.strictEqual(replay.proposal.proposalId, first.proposal.proposalId);

      // The next observable event is the fresh submit below — the replay
      // published nothing.
      const distinct = yield* service.submit(submitInput("request-replay-distinct"));
      const next = yield* Queue.take(received);
      assert.strictEqual(next.type, "proposal");
      if (next.type !== "proposal") return;
      assert.strictEqual(next.proposal.proposalId, distinct.proposal.proposalId);

      yield* Fiber.interrupt(fiber);
    }),
  );
});
