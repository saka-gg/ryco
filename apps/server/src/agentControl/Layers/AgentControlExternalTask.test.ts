import {
  AGENT_CONTROL_CAPABILITIES,
  AgentControlExternalTaskId,
  AgentControlIntegrationId,
  AgentControlProposalId,
  AgentControlRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlExternalCreateTaskInput,
  type AgentControlExternalIntegration,
  type AgentControlProposal,
  type AgentControlProposalStreamProposalEvent,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Clock, Context, Effect, Fiber, Layer, Option, PubSub, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { AgentControlExternalRepositoryLive } from "../../persistence/Layers/AgentControlExternal.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AgentControlExternalRepository,
  type AgentControlExternalRepositoryShape,
} from "../../persistence/Services/AgentControlExternal.ts";
import { AgentControlExternalIntegrationError } from "../Errors.ts";
import {
  AgentControlActionValidator,
  type AgentControlActionValidatorShape,
} from "../Services/AgentControlActionValidator.ts";
import {
  AgentControlExternalIntegrationService,
  type AgentControlExternalIntegrationServiceShape,
} from "../Services/AgentControlExternalIntegration.ts";
import {
  AgentControlExternalTaskService,
  type AgentControlExternalTaskServiceShape,
} from "../Services/AgentControlExternalTask.ts";
import {
  AgentControlProposalEvents,
  type AgentControlProposalEventsShape,
} from "../Services/AgentControlProposalEvents.ts";
import {
  AgentControlProposalService,
  type AgentControlProposalServiceShape,
} from "../Services/AgentControlProposalService.ts";
import { makeAgentControlExternalTask } from "./AgentControlExternalTask.ts";

const integrationId = AgentControlIntegrationId.make("integration-task-owner");
const projectId = ProjectId.make("project-task");
const providerInstanceId = ProviderInstanceId.make("codex-main");

const integration = (
  overrides: Partial<AgentControlExternalIntegration> = {},
): AgentControlExternalIntegration => ({
  integrationId,
  displayName: "Task owner",
  clientKind: "codex",
  projectScope: { kind: "selected", projectIds: [projectId] },
  capabilities: [
    AGENT_CONTROL_CAPABILITIES.externalCreateTask,
    AGENT_CONTROL_CAPABILITIES.externalReadTask,
  ],
  rateLimitPerMinute: 60,
  activeTaskLimit: 1,
  activeTaskCount: 0,
  expiresAt: null,
  revokedAt: null,
  pairingState: "paired",
  pairingCodeExpiresAt: null,
  pairedAt: "2026-08-18T00:00:00.000Z",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  lastUsedAt: null,
  ...overrides,
});

const request = (
  requestId: string,
  overrides: Partial<AgentControlExternalCreateTaskInput> = {},
): AgentControlExternalCreateTaskInput => ({
  requestId: AgentControlRequestId.make(requestId),
  projectId,
  providerInstanceId,
  model: "gpt-5.6",
  options: [],
  prompt: "Fix the focused test.",
  ...overrides,
});

const reasonOf = (error: unknown): string => {
  if (typeof error !== "object" || error === null || !("reason" in error)) {
    throw new Error("Expected an external integration error");
  }
  return String(error.reason);
};

const withHarness = <A, E>(
  run: (input: {
    readonly tasks: AgentControlExternalTaskServiceShape;
    readonly repository: AgentControlExternalRepositoryShape;
    readonly integrationRef: Ref.Ref<AgentControlExternalIntegration>;
    readonly proposals: Map<string, AgentControlProposal>;
    readonly submittedPlans: Array<AgentControlProposal["plan"]>;
    /** Publishes an integration change, as the integration service does on every grant change. */
    readonly publishChange: (id: AgentControlIntegrationId) => Effect.Effect<boolean>;
    /** Stores a proposal transition and publishes it, as the proposal store does. */
    readonly transitionProposal: (
      proposalId: string,
      status: AgentControlProposal["status"],
    ) => Effect.Effect<boolean>;
    /** Publishes a proposal event without storing it. */
    readonly publishProposal: (proposal: AgentControlProposal) => Effect.Effect<boolean>;
    readonly revalidations: () => number;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const integrationRef = yield* Ref.make(integration());
      const proposalEvents = yield* PubSub.unbounded<AgentControlProposalStreamProposalEvent>();
      const integrationChanges = yield* PubSub.unbounded<AgentControlIntegrationId>();
      let revalidations = 0;
      const proposals = new Map<string, AgentControlProposal>();
      const submittedPlans: Array<AgentControlProposal["plan"]> = [];
      let proposalSequence = 0;

      const integrationService = {
        authorizeTool: (
          input: Parameters<AgentControlExternalIntegrationServiceShape["authorizeTool"]>[0],
        ) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(integrationRef);
            if (current.revokedAt !== null) {
              return yield* new AgentControlExternalIntegrationError({ reason: "revoked" });
            }
            if (
              input.requiredCapability !== undefined &&
              !current.capabilities.includes(input.requiredCapability)
            ) {
              return yield* new AgentControlExternalIntegrationError({
                reason: "capability-denied",
              });
            }
            if (
              input.projectId !== undefined &&
              current.projectScope.kind === "selected" &&
              !current.projectScope.projectIds.includes(input.projectId)
            ) {
              return yield* new AgentControlExternalIntegrationError({ reason: "project-denied" });
            }
            return current;
          }),
        revalidate: () =>
          Ref.get(integrationRef).pipe(
            Effect.tap(() => Effect.sync(() => revalidations++)),
            Effect.flatMap((current) =>
              current.revokedAt !== null
                ? Effect.fail(new AgentControlExternalIntegrationError({ reason: "revoked" }))
                : current.expiresAt !== null
                  ? Effect.fail(new AgentControlExternalIntegrationError({ reason: "expired" }))
                  : Effect.succeed(current),
            ),
          ),
        appendAudit: () => Effect.void,
        subscribeChanges: PubSub.subscribe(integrationChanges),
      } as unknown as AgentControlExternalIntegrationServiceShape;
      const integrationLayer = Layer.succeed(
        AgentControlExternalIntegrationService,
        integrationService,
      );

      const validator: AgentControlActionValidatorShape = {
        validateOwnerAutomation: () => Effect.void,
        validateSubmission: () => Effect.die("not used"),
        validateExternalSubmission: ({ integration: current, plan }) => {
          if (plan.kind !== "createThreads" || plan.entries[0] === undefined) {
            return Effect.die("unexpected external task plan");
          }
          const entry = plan.entries[0];
          return Effect.succeed({
            kind: "external-integration" as const,
            integrationId: current.integrationId,
            label: current.displayName,
            projectId: entry.projectId,
            runtimeMode: entry.runtimeMode,
            envMode: entry.envMode,
          });
        },
        revalidateExecution: () => Effect.void,
      };
      const validatorLayer = Layer.succeed(AgentControlActionValidator, validator);

      const proposalService = {
        submit: (input: Parameters<AgentControlProposalServiceShape["submit"]>[0]) =>
          Effect.sync(() => {
            proposalSequence += 1;
            submittedPlans.push(input.plan);
            const proposal: AgentControlProposal = {
              proposalId: AgentControlProposalId.make(`proposal-${proposalSequence}`),
              requestId: input.requestId,
              principal: input.principal,
              planVersion: 1,
              plan: input.plan,
              planDigest: "d".repeat(64),
              riskTags: input.riskTags,
              promptSummary: input.promptSummary,
              status: "pending-user-approval",
              createdAt: input.now,
              updatedAt: input.now,
              expiresAt: input.expiresAt,
              decidedAt: null,
              result: null,
            };
            proposals.set(proposal.proposalId, proposal);
            return { proposal, replayed: false };
          }),
        getProposal: (proposalId: Parameters<AgentControlProposalServiceShape["getProposal"]>[0]) =>
          Effect.succeed(Option.fromNullishOr(proposals.get(proposalId))),
      } as unknown as AgentControlProposalServiceShape;
      const proposalLayer = Layer.succeed(AgentControlProposalService, proposalService);

      const eventsService = {
        publish: () => Effect.die("not used"),
        currentRevision: Effect.succeed(0),
        subscribe: PubSub.subscribe(proposalEvents),
        changes: Stream.empty,
      } satisfies AgentControlProposalEventsShape;
      const eventsLayer = Layer.succeed(AgentControlProposalEvents, eventsService);

      const context = yield* Layer.build(
        Layer.effect(
          AgentControlExternalTaskService,
          makeAgentControlExternalTask({ disableBackground: true }),
        ).pipe(
          Layer.provideMerge(AgentControlExternalRepositoryLive),
          Layer.provideMerge(integrationLayer),
          Layer.provideMerge(validatorLayer),
          Layer.provideMerge(proposalLayer),
          Layer.provideMerge(eventsLayer),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      );
      const repository = Context.get(context, AgentControlExternalRepository);
      const initialIntegration = yield* Ref.get(integrationRef);
      yield* repository.insertIntegration({
        ...initialIntegration,
        pairingCodeHash: null,
        credentialAudience: "external-mcp",
        credentialHash: "a".repeat(64),
      });
      let revision = 0;
      const publishProposal = (proposal: AgentControlProposal) =>
        Effect.suspend(() => {
          revision += 1;
          const event: AgentControlProposalStreamProposalEvent = {
            version: 1,
            type: "proposal",
            revision,
            proposal,
          };
          return PubSub.publish(proposalEvents, event);
        });
      return yield* run({
        tasks: Context.get(context, AgentControlExternalTaskService),
        repository,
        integrationRef,
        proposals,
        submittedPlans,
        publishChange: (id) => PubSub.publish(integrationChanges, id),
        transitionProposal: (proposalId, status) =>
          Effect.suspend(() => {
            const next = { ...proposals.get(proposalId)!, status };
            proposals.set(proposalId, next);
            return publishProposal(next);
          }),
        publishProposal,
        revalidations: () => revalidations,
      });
    }),
  );

it.effect("external tasks reuse proposals, default safely, and account idempotent capacity", () =>
  withHarness(({ tasks, repository, proposals, submittedPlans }) =>
    Effect.gen(function* () {
      const created = yield* tasks.create({
        integrationId,
        request: request("request-1", { tokenMode: "balanced" }),
      });
      assert.strictEqual(created.receipt.status, "pending-user-approval");
      assert.strictEqual(created.task.environment, "worktree");
      assert.strictEqual(created.task.runtimeMode, "approval-required");
      assert.strictEqual(submittedPlans.length, 1);
      assert.strictEqual(submittedPlans[0]?.kind, "createThreads");
      assert.strictEqual(
        submittedPlans[0]?.kind === "createThreads"
          ? submittedPlans[0].entries[0]?.tokenMode
          : undefined,
        "balanced",
      );

      const replay = yield* tasks.create({
        integrationId,
        request: request("request-1", { tokenMode: "balanced" }),
      });
      assert.isTrue(replay.replayed);
      assert.strictEqual(replay.task.taskId, created.task.taskId);
      assert.strictEqual(submittedPlans.length, 1);

      const conflict = yield* Effect.flip(
        tasks.create({
          integrationId,
          request: request("request-1", { tokenMode: "aggressive" }),
        }),
      );
      assert.strictEqual(reasonOf(conflict), "task-conflict");
      const capacity = yield* Effect.flip(
        tasks.create({ integrationId, request: request("request-2") }),
      );
      assert.strictEqual(reasonOf(capacity), "capacity-exhausted");

      const pending = proposals.get(created.task.proposalId)!;
      proposals.set(created.task.proposalId, {
        ...pending,
        status: "completed",
        decidedAt: "2026-08-18T00:01:00.000Z",
        updatedAt: "2026-08-18T00:02:00.000Z",
        result: {
          outcome: "completed",
          createdThreadIds: [ThreadId.make("thread-created")],
          completedAt: "2026-08-18T00:02:00.000Z",
        },
      });
      const terminal = yield* tasks.read({ integrationId, taskId: created.task.taskId });
      assert.strictEqual(terminal.receipt.status, "completed");
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getIntegration(integrationId)).activeTaskCount,
        0,
      );
      yield* tasks.create({ integrationId, request: request("request-2") });
      assert.strictEqual(submittedPlans.length, 2);
      assert.isUndefined(
        submittedPlans[1]?.kind === "createThreads"
          ? submittedPlans[1].entries[0]?.tokenMode
          : undefined,
      );
    }),
  ),
);

it.effect("external tasks enforce elevated grants and task ownership", () =>
  withHarness(({ tasks, integrationRef }) =>
    Effect.gen(function* () {
      const localDenied = yield* Effect.flip(
        tasks.create({
          integrationId,
          request: request("request-local", { environment: "local" }),
        }),
      );
      assert.strictEqual(reasonOf(localDenied), "capability-denied");
      const fullDenied = yield* Effect.flip(
        tasks.create({
          integrationId,
          request: request("request-full", { runtimeMode: "full-access" }),
        }),
      );
      assert.strictEqual(reasonOf(fullDenied), "capability-denied");

      yield* Ref.update(integrationRef, (current) => ({
        ...current,
        capabilities: [
          ...current.capabilities,
          AGENT_CONTROL_CAPABILITIES.externalSharedCheckout,
          AGENT_CONTROL_CAPABILITIES.externalFullAccess,
        ],
      }));
      const elevated = yield* tasks.create({
        integrationId,
        request: request("request-elevated", {
          environment: "local",
          runtimeMode: "full-access",
        }),
      });
      assert.strictEqual(elevated.task.environment, "local");
      assert.strictEqual(elevated.task.runtimeMode, "full-access");

      const otherIntegrationId = AgentControlIntegrationId.make("integration-other");
      const foreignRead = yield* Effect.flip(
        tasks.read({ integrationId: otherIntegrationId, taskId: elevated.task.taskId }),
      );
      assert.strictEqual(reasonOf(foreignRead), "task-not-found");
    }),
  ),
);

it.live("revocation interrupts a long external task wait", () =>
  withHarness(({ tasks, integrationRef, publishChange }) =>
    Effect.gen(function* () {
      const created = yield* tasks.create({ integrationId, request: request("request-wait") });
      const [revoked] = yield* Effect.all(
        [
          Effect.flip(
            tasks.wait({
              integrationId,
              request: { taskId: created.task.taskId, timeoutMs: 2_000 },
            }),
          ),
          Effect.sleep("100 millis").pipe(
            Effect.andThen(
              Ref.update(integrationRef, (current) => ({
                ...current,
                revokedAt: new Date().toISOString(),
              })),
            ),
            Effect.andThen(publishChange(integrationId)),
          ),
        ] as const,
        { concurrency: "unbounded" },
      );
      assert.strictEqual(reasonOf(revoked), "revoked");
    }),
  ),
);

/** Lets forked fibers run without advancing the test clock; true once `fiber` has ended. */
const awaitDone = (fiber: Fiber.Fiber<unknown, unknown>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 50 && fiber.pollUnsafe() === undefined; turn += 1) {
      yield* Effect.yieldNow;
    }
    return fiber.pollUnsafe() !== undefined;
  });

it.effect("an external task wait wakes on its proposal decision", () =>
  withHarness(({ tasks, transitionProposal, revalidations }) =>
    Effect.gen(function* () {
      const created = yield* tasks.create({ integrationId, request: request("request-decided") });
      const fiber = yield* Effect.forkChild(
        tasks.wait({
          integrationId,
          request: { taskId: created.task.taskId, waitFor: "decided", timeoutMs: 25_000 },
        }),
      );
      // Fails on the 250 ms poll: virtual time never advances here.
      assert.isFalse(yield* awaitDone(fiber));
      const before = revalidations();
      yield* transitionProposal(created.receipt.proposalId, "approved");
      assert.isTrue(yield* awaitDone(fiber));
      const result = yield* Fiber.join(fiber);
      assert.isFalse(result.timedOut);
      assert.strictEqual(result.receipt.status, "approved");
      assert.strictEqual(revalidations(), before + 1);
      assert.strictEqual(yield* Clock.currentTimeMillis, 0);
    }),
  ),
);

it.effect(
  "an external task wait re-checks a burst of decisions within 250 ms, as the poll did",
  () =>
    withHarness(({ tasks, transitionProposal, revalidations }) =>
      Effect.gen(function* () {
        const created = yield* tasks.create({ integrationId, request: request("request-burst") });
        const fiber = yield* Effect.forkChild(
          tasks.wait({
            integrationId,
            request: { taskId: created.task.taskId, waitFor: "terminal", timeoutMs: 25_000 },
          }),
        );
        assert.isFalse(yield* awaitDone(fiber));
        const before = revalidations();
        // Approval is not terminal: checked at once.
        yield* transitionProposal(created.receipt.proposalId, "approved");
        assert.isFalse(yield* awaitDone(fiber));
        assert.strictEqual(revalidations(), before + 1);
        // The completion right behind it waits for the trailing check, at most one old poll
        // interval later.
        yield* transitionProposal(created.receipt.proposalId, "completed");
        assert.isFalse(yield* awaitDone(fiber));
        yield* TestClock.adjust(249);
        assert.isFalse(yield* awaitDone(fiber));
        yield* TestClock.adjust(1);
        assert.isTrue(yield* awaitDone(fiber));
        const result = yield* Fiber.join(fiber);
        assert.isFalse(result.timedOut);
        assert.strictEqual(result.receipt.status, "completed");
        assert.strictEqual(revalidations(), before + 2);
      }),
    ),
);

it.effect("an external task wait ignores other proposals and integrations", () =>
  withHarness(({ tasks, proposals, publishProposal, publishChange, revalidations }) =>
    Effect.gen(function* () {
      const created = yield* tasks.create({ integrationId, request: request("request-mine") });
      const fiber = yield* Effect.forkChild(
        tasks.wait({ integrationId, request: { taskId: created.task.taskId, timeoutMs: 25_000 } }),
      );
      assert.isFalse(yield* awaitDone(fiber));
      const before = revalidations();
      yield* publishProposal({
        ...proposals.get(created.receipt.proposalId)!,
        proposalId: AgentControlProposalId.make("proposal-someone-else"),
        status: "rejected",
      });
      yield* publishChange(AgentControlIntegrationId.make("integration-someone-else"));
      assert.isFalse(yield* awaitDone(fiber));
      assert.strictEqual(revalidations(), before);
      yield* Fiber.interrupt(fiber);
    }),
  ),
);

it.effect("an integration change revalidates an external task wait at once", () =>
  withHarness(({ tasks, integrationRef, publishChange }) =>
    Effect.gen(function* () {
      const created = yield* tasks.create({ integrationId, request: request("request-revoke") });
      const fiber = yield* Effect.forkChild(
        Effect.flip(
          tasks.wait({
            integrationId,
            request: { taskId: created.task.taskId, timeoutMs: 25_000 },
          }),
        ),
      );
      assert.isFalse(yield* awaitDone(fiber));
      yield* Ref.update(integrationRef, (current) => ({ ...current, revokedAt: "2026-10-23" }));
      yield* publishChange(integrationId);
      assert.isTrue(yield* awaitDone(fiber));
      assert.strictEqual(reasonOf(yield* Fiber.join(fiber)), "revoked");
      assert.strictEqual(yield* Clock.currentTimeMillis, 0);
    }),
  ),
);

it.effect("an expired integration ends an external task wait at the next re-check", () =>
  withHarness(({ tasks, integrationRef }) =>
    Effect.gen(function* () {
      const created = yield* tasks.create({ integrationId, request: request("request-expire") });
      const fiber = yield* Effect.forkChild(
        Effect.flip(
          tasks.wait({
            integrationId,
            request: { taskId: created.task.taskId, timeoutMs: 25_000 },
          }),
        ),
      );
      assert.isFalse(yield* awaitDone(fiber));
      // Expiry publishes no change event.
      yield* Ref.update(integrationRef, (current) => ({ ...current, expiresAt: "2026-10-23" }));
      yield* TestClock.adjust(4_999);
      assert.isFalse(yield* awaitDone(fiber));
      yield* TestClock.adjust(1);
      assert.isTrue(yield* awaitDone(fiber));
      assert.strictEqual(reasonOf(yield* Fiber.join(fiber)), "expired");
    }),
  ),
);

it.effect("a quiet external task wait re-checks 6 times over 25 s instead of 101", () =>
  withHarness(({ tasks, revalidations }) =>
    Effect.gen(function* () {
      const created = yield* tasks.create({ integrationId, request: request("request-quiet") });
      const before = revalidations();
      const fiber = yield* Effect.forkChild(
        tasks.wait({ integrationId, request: { taskId: created.task.taskId, timeoutMs: 25_000 } }),
      );
      assert.isFalse(yield* awaitDone(fiber));
      yield* TestClock.adjust(25_000);
      assert.isTrue(yield* awaitDone(fiber));
      assert.isTrue((yield* Fiber.join(fiber)).timedOut);
      // Checks at 0, 5, 10, 15, 20 and 25 s.
      assert.strictEqual(revalidations() - before, 6);
    }),
  ),
);
