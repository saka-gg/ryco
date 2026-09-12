import { ServerSettingsService } from "../../serverSettings.ts";
import {
  AgentControlOperationId,
  AgentControlProposalId,
  AgentControlRequestId,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  WorktreeId,
  type AgentControlOperation,
  type AgentControlProposal,
  type AgentControlResultEnvelope,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Option, PubSub, Ref, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandApplication } from "../../orchestration/Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DeviceManager } from "../../device/DeviceManager.ts";
import { FakeDeviceBackend } from "../../device/FakeDeviceBackend.ts";
import { DeviceService } from "../../device/Services/DeviceService.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { AgentControlInvalidTransitionError, AgentControlPlanValidationError } from "../Errors.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import { AgentControlOperationStore } from "../Services/AgentControlOperationStore.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";
import {
  makeAgentControlExecution,
  preflightAgentControlWorktreeCheckout,
} from "./AgentControlExecution.ts";

const now = "2026-08-18T00:00:00.000Z";
const threadId = ThreadId.make("thread-target");
const projectId = ProjectId.make("project-1");

const target = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  id: threadId,
  projectId,
  title: "Before",
  modelSelection: { instanceId: "codex", model: "gpt-5.6" },
  runtimeMode: "auto",
  interactionMode: "default",
  branch: null,
  worktreePath: "/workspace/project",
  worktreeId: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const plan = {
  kind: "sendMessage" as const,
  threadId,
  text: "Continue",
  delivery: "queue" as const,
};

const approvedProposal: AgentControlProposal = {
  proposalId: AgentControlProposalId.make("proposal-exactly-once"),
  requestId: AgentControlRequestId.make("request-exactly-once"),
  principal: {
    kind: "provider-session",
    threadId: ThreadId.make("thread-origin"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeSessionId: RuntimeSessionId.make("runtime-origin"),
    originProjectId: projectId,
    originRuntimeMode: "auto",
    originEnvMode: "local",
    targetSnapshots: [
      {
        threadId,
        projectId,
        runtimeMode: "auto",
        envMode: "local",
        archived: false,
        activeTurnId: null,
      },
    ],
  },
  planVersion: 1,
  plan,
  planDigest: computeAgentControlPlanDigest(plan),
  riskTags: [],
  promptSummary: "Update thread",
  status: "approved",
  createdAt: now,
  updatedAt: now,
  expiresAt: "2099-01-01T00:00:00.000Z",
  decidedAt: now,
  result: null,
};

const invalidTransition = (from: string, to: string) =>
  new AgentControlInvalidTransitionError({
    entity: "proposal",
    from,
    to,
    actor: "executor",
    detail: "lost test CAS",
  });

const makeTestExecution = (input: {
  readonly proposalStore: unknown;
  readonly operationStore: unknown;
  readonly commandApplication: unknown;
  readonly projections: unknown;
  readonly engine?: unknown;
  readonly git?: unknown;
  readonly workspaceAccess?: unknown;
  readonly validator?: unknown;
  readonly deviceService?: unknown;
}) =>
  makeAgentControlExecution({ disableBackground: true }).pipe(
    Effect.provideService(AgentControlProposalStore, input.proposalStore as never),
    Effect.provideService(AgentControlOperationStore, input.operationStore as never),
    Effect.provideService(AgentControlProposalEvents, {} as never),
    Effect.provideService(
      AgentControlActionValidator,
      (input.validator ?? {
        validateSubmission: () => Effect.die("unused"),
        validateExternalSubmission: () => Effect.die("unused"),
        revalidateExecution: () => Effect.void,
      }) as never,
    ),
    Effect.provideService(OrchestrationCommandApplication, input.commandApplication as never),
    Effect.provideService(OrchestrationEngineService, (input.engine ?? {}) as never),
    Effect.provideService(ProjectionSnapshotQuery, input.projections as never),
    Effect.provideService(GitWorkflowService, (input.git ?? {}) as never),
    Effect.provideService(WorkspaceAccessPolicy, (input.workspaceAccess ?? {}) as never),
    Effect.provideService(
      DeviceService,
      (input.deviceService ?? { supported: false, manager: {} }) as never,
    ),
    Effect.provideService(ServerRuntimeStartup, {} as never),
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "agent-control-execution-test-",
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

const makeExecutionStores = (initialProposal: AgentControlProposal) =>
  Effect.gen(function* () {
    const proposalRef = yield* Ref.make(initialProposal);
    const operationRef = yield* Ref.make<Option.Option<AgentControlOperation>>(Option.none());
    const proposalStore = {
      getById: () => Ref.get(proposalRef).pipe(Effect.map(Option.some)),
      beginExecution: () =>
        Ref.modify(proposalRef, (current) =>
          current.status === "approved"
            ? [
                Option.some({ ...current, status: "executing" as const }),
                { ...current, status: "executing" as const },
              ]
            : [Option.none(), current],
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(invalidTransition("executing", "executing")),
              onSome: Effect.succeed,
            }),
          ),
        ),
      settleExecution: (input: { readonly result: AgentControlResultEnvelope }) =>
        Ref.modify(proposalRef, (current) => {
          const next: AgentControlProposal = {
            ...current,
            status: input.result.outcome === "completed" ? "completed" : "failed",
            result: input.result,
          };
          return [next, next];
        }),
      listActive: () => Effect.succeed([]),
    };
    const operationStore = {
      createForProposal: () =>
        Ref.modify(operationRef, (current) => {
          if (Option.isSome(current))
            return [{ operation: current.value, replayed: true }, current];
          const operation: AgentControlOperation = {
            operationId: AgentControlOperationId.make(`operation-${initialProposal.proposalId}`),
            proposalId: initialProposal.proposalId,
            actionKind: initialProposal.plan.kind,
            status: "pending",
            attempt: 0,
            state: {
              completedSteps: [],
              resources: {
                threadIds: [],
                ownedThreadIds: [],
                worktreeIds: [],
                ownedWorktrees: [],
              },
              commandReceipts: [],
            },
            result: null,
            createdAt: now,
            updatedAt: now,
          };
          return [{ operation, replayed: false }, Option.some(operation)];
        }),
      transition: (input: {
        readonly expectedStatus: AgentControlOperation["status"];
        readonly nextStatus: AgentControlOperation["status"];
        readonly attempt: number;
        readonly state: AgentControlOperation["state"];
        readonly result: AgentControlOperation["result"];
      }) =>
        Ref.modify(operationRef, (current) => {
          if (Option.isNone(current) || current.value.status !== input.expectedStatus) {
            return [Option.none<AgentControlOperation>(), current];
          }
          const next: AgentControlOperation = {
            ...current.value,
            status: input.nextStatus,
            attempt: input.attempt,
            state: input.state,
            result: input.result,
          };
          return [Option.some(next), Option.some(next)];
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(invalidTransition("running", "completed")),
              onSome: Effect.succeed,
            }),
          ),
        ),
      checkpoint: (input: {
        readonly expectedStatus: "running" | "compensating";
        readonly state: AgentControlOperation["state"];
      }) =>
        Ref.modify(operationRef, (current) => {
          if (Option.isNone(current) || current.value.status !== input.expectedStatus) {
            return [Option.none<AgentControlOperation>(), current];
          }
          const next = { ...current.value, state: input.state };
          return [Option.some(next), Option.some(next)];
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(invalidTransition("running", "running")),
              onSome: Effect.succeed,
            }),
          ),
        ),
      getByProposalId: () => Ref.get(operationRef),
      listRecoverable: () => Effect.succeed([]),
    };
    return { proposalRef, operationRef, proposalStore, operationStore };
  });

it.effect("preflights checkout ownership, collisions, and exact base refs before creation", () =>
  Effect.gen(function* () {
    const listRefs = vi.fn(() =>
      Effect.succeed({
        refs: [
          {
            name: "main",
            current: true,
            isDefault: true,
            worktreePath: "/workspace/project",
          },
        ],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 1,
      }),
    );
    const common = {
      cwd: "/workspace/project",
      checkoutPath: "/workspace/worktrees/new",
      workspaceAccess: {
        assertPath: ({ path }: { readonly path: string }) => Effect.succeed(path),
      },
      git: { listRefs },
    };

    yield* preflightAgentControlWorktreeCheckout({
      ...common,
      baseRef: "main",
      checkoutExists: () => false,
    });
    assert.strictEqual(listRefs.mock.calls.length, 1);

    const missingRef = yield* Effect.flip(
      preflightAgentControlWorktreeCheckout({
        ...common,
        baseRef: "missing",
        checkoutExists: () => false,
      }),
    );
    assert.include(missingRef.message, "base ref is unavailable");

    const callsBeforeCollision = listRefs.mock.calls.length;
    const collision = yield* Effect.flip(
      preflightAgentControlWorktreeCheckout({
        ...common,
        baseRef: "main",
        checkoutExists: () => true,
      }),
    );
    assert.include(collision.message, "already exists");
    assert.strictEqual(listRefs.mock.calls.length, callsBeforeCollision);
  }),
);

it.effect("only the accepted-proposal executor invokes a governed device action", () =>
  Effect.gen(function* () {
    const backend = new FakeDeviceBackend();
    const manager = new DeviceManager({ backend });
    const devicePlan = {
      kind: "deviceBoot" as const,
      threadId: ThreadId.make("thread-origin"),
      projectId,
      expectedProjectUpdatedAt: now,
      providerInstanceId: ProviderInstanceId.make("codex"),
      udid: "FAKE-0001" as never,
      expectedThreadDeviceVersion: 0,
      expectedAttachedDeviceUdid: null,
      expectedDeviceState: "shutdown" as const,
      expectedDeviceBootSource: "user" as const,
      expectedRecording: false,
      executionSummary: "Boot iOS Simulator FAKE-0001",
      riskClass: "device-lifecycle" as const,
    };
    const proposal: AgentControlProposal = {
      ...approvedProposal,
      proposalId: AgentControlProposalId.make("proposal-device-boot"),
      requestId: AgentControlRequestId.make("request-device-boot"),
      plan: devicePlan,
      planDigest: computeAgentControlPlanDigest(devicePlan),
    };
    const stores = yield* makeExecutionStores(proposal);
    const execution = yield* makeTestExecution({
      proposalStore: stores.proposalStore,
      operationStore: stores.operationStore,
      commandApplication: {},
      projections: {},
      deviceService: { supported: true, manager },
    });

    assert.deepStrictEqual(backend.calls, []);
    yield* execution.executeApproved(proposal.proposalId);
    yield* execution.executeApproved(proposal.proposalId);
    assert.deepStrictEqual(
      backend.calls.filter((entry) => entry.kind === "boot"),
      [{ kind: "boot", udid: "FAKE-0001" }],
    );

    const settled = yield* Ref.get(stores.proposalRef);
    assert.strictEqual(settled.status, "completed");
    assert.strictEqual(settled.result?.outcome, "completed");
    if (settled.result?.outcome === "completed") {
      assert.deepStrictEqual(settled.result.execution?.device, {
        actionKind: "deviceBoot",
        threadId: "thread-origin",
        projectId: "project-1",
        providerInstanceId: "codex",
        udid: "FAKE-0001",
      });
    }
    yield* Effect.promise(() => manager.dispose());
  }),
);

it.effect("executes one accepted proposal exactly once under concurrent retries", () =>
  Effect.gen(function* () {
    const proposalRef = yield* Ref.make(approvedProposal);
    const operationRef = yield* Ref.make<Option.Option<AgentControlOperation>>(Option.none());
    const dispatchCount = yield* Ref.make(0);

    const proposalStore = {
      getById: () => Ref.get(proposalRef).pipe(Effect.map(Option.some)),
      beginExecution: () =>
        Ref.modify(proposalRef, (current) =>
          current.status === "approved"
            ? [
                Option.some({ ...current, status: "executing" as const }),
                { ...current, status: "executing" as const },
              ]
            : [Option.none(), current],
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(invalidTransition("executing", "executing")),
              onSome: Effect.succeed,
            }),
          ),
        ),
      settleExecution: (input: { readonly result: AgentControlResultEnvelope }) =>
        Ref.modify(proposalRef, (current) => {
          const next: AgentControlProposal = {
            ...current,
            status: input.result.outcome === "completed" ? "completed" : "failed",
            result: input.result,
          };
          return [next, next];
        }),
      listActive: () => Effect.succeed([]),
    };

    const operationStore = {
      createForProposal: () =>
        Ref.modify(operationRef, (current) => {
          if (Option.isSome(current))
            return [{ operation: current.value, replayed: true }, current];
          const operation: AgentControlOperation = {
            operationId: AgentControlOperationId.make("operation-exactly-once"),
            proposalId: approvedProposal.proposalId,
            actionKind: "sendMessage",
            status: "pending",
            attempt: 0,
            state: {
              completedSteps: [],
              resources: {
                threadIds: [],
                ownedThreadIds: [],
                worktreeIds: [],
                ownedWorktrees: [],
              },
              commandReceipts: [],
            },
            result: null,
            createdAt: now,
            updatedAt: now,
          };
          return [{ operation, replayed: false }, Option.some(operation)];
        }),
      transition: (input: {
        readonly expectedStatus: AgentControlOperation["status"];
        readonly nextStatus: AgentControlOperation["status"];
        readonly attempt: number;
        readonly state: AgentControlOperation["state"];
        readonly result: AgentControlOperation["result"];
      }) =>
        Ref.modify(operationRef, (current) => {
          if (Option.isNone(current) || current.value.status !== input.expectedStatus) {
            return [Option.none<AgentControlOperation>(), current];
          }
          const next: AgentControlOperation = {
            ...current.value,
            status: input.nextStatus,
            attempt: input.attempt,
            state: input.state,
            result: input.result,
          };
          return [Option.some(next), Option.some(next)];
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(invalidTransition("running", "completed")),
              onSome: Effect.succeed,
            }),
          ),
        ),
      checkpoint: (input: {
        readonly expectedStatus: "running" | "compensating";
        readonly state: AgentControlOperation["state"];
      }) =>
        Ref.modify(operationRef, (current) => {
          if (Option.isNone(current) || current.value.status !== input.expectedStatus) {
            return [Option.none<AgentControlOperation>(), current];
          }
          const next = { ...current.value, state: input.state };
          return [Option.some(next), Option.some(next)];
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(invalidTransition("running", "running")),
              onSome: Effect.succeed,
            }),
          ),
        ),
      getByProposalId: () => Ref.get(operationRef),
      listRecoverable: () => Effect.succeed([]),
    };

    const execution = yield* makeTestExecution({
      proposalStore,
      operationStore,
      commandApplication: {
        apply: () =>
          Ref.updateAndGet(dispatchCount, (count) => count + 1).pipe(
            Effect.map((sequence) => ({ sequence })),
          ),
        applyWithDispatcher: () => Effect.die("unused"),
      },
      projections: {
        getThreadShellById: () => Effect.succeed(Option.some(target)),
      },
    });

    yield* Effect.all(
      Array.from({ length: 12 }, () => execution.executeApproved(approvedProposal.proposalId)),
      { concurrency: "unbounded", discard: true },
    );

    assert.strictEqual(yield* Ref.get(dispatchCount), 1);
    const settled = yield* Ref.get(proposalRef);
    assert.strictEqual(settled.status, "completed");
    assert.strictEqual(settled.result?.outcome, "completed");
    if (settled.result?.outcome !== "completed") return;
    assert.strictEqual(settled.result.execution?.commands.length, 1);
    assert.deepStrictEqual(settled.result.execution?.affectedThreadIds, [threadId]);
    assert.strictEqual(settled.result.execution?.delivery, "queued");
    assert.strictEqual(settled.result.execution?.commands[0]?.commandType, "thread.turn.start");
  }),
);

it.effect("unlinks a project exactly once without deleting its workspace contents", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "ryco-agent-control-unlink-",
      });
      const sentinelPath = `${workspaceRoot}/must-survive.txt`;
      yield* fs.writeFileString(sentinelPath, "working tree data");

      const removePlan = {
        kind: "removeProject" as const,
        projectId,
        expected: {
          title: "Project one",
          workspaceRoot,
          repositoryIdentityKey: null,
          updatedAt: now,
        },
        expectedThreadIds: [threadId],
        force: true,
      };
      const proposal: AgentControlProposal = {
        ...approvedProposal,
        proposalId: AgentControlProposalId.make("proposal-remove-project"),
        requestId: AgentControlRequestId.make("request-remove-project"),
        plan: removePlan,
        planDigest: computeAgentControlPlanDigest(removePlan),
      };
      const stores = yield* makeExecutionStores(proposal);
      const commands = yield* Ref.make<ReadonlyArray<ClientOrchestrationCommand>>([]);
      let revalidations = 0;
      const execution = yield* makeTestExecution({
        proposalStore: stores.proposalStore,
        operationStore: stores.operationStore,
        commandApplication: {
          apply: (command: ClientOrchestrationCommand) =>
            Ref.updateAndGet(commands, (current) => [...current, command]).pipe(
              Effect.map((current) => ({ sequence: current.length })),
            ),
          applyWithDispatcher: () => Effect.die("unused"),
        },
        projections: {},
        validator: {
          validateSubmission: () => Effect.die("unused"),
          validateExternalSubmission: () => Effect.die("unused"),
          revalidateExecution: () =>
            Effect.sync(() => {
              revalidations += 1;
            }),
        },
      });

      yield* execution.executeApproved(proposal.proposalId);
      yield* execution.executeApproved(proposal.proposalId);

      const dispatched = yield* Ref.get(commands);
      assert.strictEqual(dispatched.length, 1);
      assert.strictEqual(dispatched[0]?.type, "project.delete");
      if (dispatched[0]?.type !== "project.delete") return;
      assert.strictEqual(dispatched[0].expectedUpdatedAt, now);
      assert.deepStrictEqual(dispatched[0].expectedThreadIds, [threadId]);
      assert.strictEqual(yield* fs.exists(sentinelPath), true);
      assert.strictEqual(yield* fs.readFileString(sentinelPath), "working tree data");
      assert.strictEqual(revalidations, 2);

      const settled = yield* Ref.get(stores.proposalRef);
      assert.strictEqual(settled.status, "completed");
      assert.strictEqual(settled.result?.outcome, "completed");
      if (settled.result?.outcome !== "completed") return;
      assert.deepStrictEqual(settled.result.execution?.affectedProjectIds, [projectId]);
      assert.deepStrictEqual(settled.result.execution?.affectedThreadIds, [threadId]);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect(
  "refuses a stale approved project plan before dispatch and retains the failure detail",
  () =>
    Effect.gen(function* () {
      const updatePlan = {
        kind: "updateProject" as const,
        projectId,
        before: {
          title: "Before",
          workspaceRoot: "/workspace/project",
          repositoryIdentityKey: null,
          updatedAt: now,
        },
        after: {
          title: "After",
          workspaceRoot: "/workspace/project",
          repositoryIdentityKey: null,
        },
      };
      const proposal: AgentControlProposal = {
        ...approvedProposal,
        proposalId: AgentControlProposalId.make("proposal-stale-project"),
        requestId: AgentControlRequestId.make("request-stale-project"),
        plan: updatePlan,
        planDigest: computeAgentControlPlanDigest(updatePlan),
      };
      const stores = yield* makeExecutionStores(proposal);
      let dispatched = false;
      const execution = yield* makeTestExecution({
        proposalStore: stores.proposalStore,
        operationStore: stores.operationStore,
        commandApplication: {
          apply: () => {
            dispatched = true;
            return Effect.die("stale project command must not dispatch");
          },
          applyWithDispatcher: () => Effect.die("unused"),
        },
        projections: {},
        validator: {
          validateSubmission: () => Effect.die("unused"),
          validateExternalSubmission: () => Effect.die("unused"),
          revalidateExecution: () =>
            Effect.fail(
              new AgentControlPlanValidationError({
                reason: "project-stale",
                detail: "The approved project revision changed.",
              }),
            ),
        },
      });

      yield* execution.executeApproved(proposal.proposalId);

      assert.isFalse(dispatched);
      const settled = yield* Ref.get(stores.proposalRef);
      assert.strictEqual(settled.status, "failed");
      assert.strictEqual(settled.result?.outcome, "failed");
      if (settled.result?.outcome !== "failed") return;
      assert.include(settled.result.error.message, "approved project revision changed");
    }),
);

it.effect("falls back from rejected steering to queueing and records the delivery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const targetTurnId = TurnId.make("turn-target");
      const runningTarget = {
        ...target,
        session: {
          threadId,
          status: "running" as const,
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeSessionId: RuntimeSessionId.make("runtime-target"),
          runtimeMode: "auto" as const,
          activeTurnId: targetTurnId,
          lastError: null,
          updatedAt: now,
        },
      };
      const steerPlan = { ...plan, delivery: "steer" as const };
      const proposal: AgentControlProposal = {
        ...approvedProposal,
        proposalId: AgentControlProposalId.make("proposal-steer-fallback"),
        requestId: AgentControlRequestId.make("request-steer-fallback"),
        principal:
          approvedProposal.principal.kind === "provider-session"
            ? {
                ...approvedProposal.principal,
                targetSnapshots: [
                  {
                    threadId,
                    projectId,
                    runtimeMode: "auto",
                    envMode: "local",
                    archived: false,
                    activeTurnId: targetTurnId,
                  },
                ],
              }
            : approvedProposal.principal,
        plan: steerPlan,
        planDigest: computeAgentControlPlanDigest(steerPlan),
      };
      const stores = yield* makeExecutionStores(proposal);
      const events = yield* PubSub.unbounded<never>();
      const commands = yield* Ref.make<ReadonlyArray<ClientOrchestrationCommand>>([]);
      let reads = 0;

      const execution = yield* makeTestExecution({
        proposalStore: stores.proposalStore,
        operationStore: stores.operationStore,
        engine: { subscribeDomainEvents: PubSub.subscribe(events) },
        commandApplication: {
          apply: (command: ClientOrchestrationCommand) =>
            Effect.gen(function* () {
              yield* Ref.update(commands, (current) => [...current, command]);
              if (command.type === "thread.turn.steer") {
                yield* PubSub.publish(events, {
                  type: "thread.turn-steer-rejected",
                  payload: {
                    threadId,
                    messageId: command.message.messageId,
                  },
                } as never);
              }
              return { sequence: (yield* Ref.get(commands)).length };
            }),
          applyWithDispatcher: () => Effect.die("unused"),
        },
        projections: {
          getThreadShellById: () =>
            Effect.sync(() => {
              reads += 1;
              return Option.some(reads === 1 ? runningTarget : target);
            }),
        },
      });

      yield* execution.executeApproved(proposal.proposalId);

      assert.deepStrictEqual(
        (yield* Ref.get(commands)).map((command) => command.type),
        ["thread.turn.steer", "thread.turn.start"],
      );
      const settled = yield* Ref.get(stores.proposalRef);
      assert.strictEqual(settled.result?.outcome, "completed");
      if (settled.result?.outcome !== "completed") return;
      assert.strictEqual(settled.result.execution?.delivery, "queued-after-steer-fallback");
    }),
  ),
);

it.effect("records the requested turn and observed settled state for interrupts", () =>
  Effect.gen(function* () {
    const targetTurnId = TurnId.make("turn-target");
    const runningTarget = {
      ...target,
      session: {
        threadId,
        status: "running" as const,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeSessionId: RuntimeSessionId.make("runtime-target"),
        runtimeMode: "auto" as const,
        activeTurnId: targetTurnId,
        lastError: null,
        updatedAt: now,
      },
    };
    const interruptPlan = { kind: "interruptThread" as const, threadId, turnId: targetTurnId };
    const proposal: AgentControlProposal = {
      ...approvedProposal,
      proposalId: AgentControlProposalId.make("proposal-interrupt"),
      requestId: AgentControlRequestId.make("request-interrupt"),
      plan: interruptPlan,
      planDigest: computeAgentControlPlanDigest(interruptPlan),
    };
    const stores = yield* makeExecutionStores(proposal);
    const commands = yield* Ref.make<ReadonlyArray<ClientOrchestrationCommand>>([]);
    let reads = 0;
    const execution = yield* makeTestExecution({
      proposalStore: stores.proposalStore,
      operationStore: stores.operationStore,
      commandApplication: {
        apply: (command: ClientOrchestrationCommand) =>
          Ref.updateAndGet(commands, (current) => [...current, command]).pipe(
            Effect.map((current) => ({ sequence: current.length })),
          ),
        applyWithDispatcher: () => Effect.die("unused"),
      },
      projections: {
        getThreadShellById: () =>
          Effect.sync(() => {
            reads += 1;
            return Option.some(reads === 1 ? runningTarget : target);
          }),
      },
    });

    yield* execution.executeApproved(proposal.proposalId);

    assert.deepStrictEqual(
      (yield* Ref.get(commands)).map((command) => command.type),
      ["thread.turn.interrupt"],
    );
    const settled = yield* Ref.get(stores.proposalRef);
    assert.strictEqual(settled.result?.outcome, "completed");
    if (settled.result?.outcome !== "completed") return;
    assert.deepStrictEqual(settled.result.execution?.interrupt, {
      requestedTurnId: targetTurnId,
      settledStatus: "idle",
      settledActiveTurnId: null,
    });
  }),
);

it.effect(
  "restart recovery compensates only durably owned resources and settles terminal failure",
  () =>
    Effect.gen(function* () {
      const nonOwnedThreadId = ThreadId.make("thread-preexisting-target");
      const ownedWorktreeId = WorktreeId.make("worktree-owned");
      const ownedCheckoutPath = "/workspace/worktrees/owned";
      const executing: AgentControlProposal = {
        ...approvedProposal,
        proposalId: AgentControlProposalId.make("proposal-recovery"),
        requestId: AgentControlRequestId.make("request-recovery"),
        status: "executing",
      };
      const running: AgentControlOperation = {
        operationId: AgentControlOperationId.make("operation-recovery"),
        proposalId: executing.proposalId,
        actionKind: "createThreads",
        status: "running",
        attempt: 1,
        state: {
          completedSteps: ["planned-thread-ids"],
          resources: {
            threadIds: [threadId, nonOwnedThreadId],
            ownedThreadIds: [threadId],
            worktreeIds: [ownedWorktreeId],
            ownedWorktrees: [
              {
                worktreeId: ownedWorktreeId,
                projectId,
                branch: "ryco/agent-control-owned",
                checkoutPath: ownedCheckoutPath,
              },
            ],
          },
          commandReceipts: [],
        },
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      const proposalRef = yield* Ref.make(executing);
      const operationRef = yield* Ref.make(running);
      const deleted = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
      const deletedWorktrees = yield* Ref.make<ReadonlyArray<WorktreeId>>([]);
      const removedPaths = yield* Ref.make<ReadonlyArray<string>>([]);
      const deletedBranches = yield* Ref.make<ReadonlyArray<string>>([]);

      const proposalStore = {
        getById: () => Ref.get(proposalRef).pipe(Effect.map(Option.some)),
        listActive: () => Effect.succeed([]),
        settleExecution: (input: { readonly result: AgentControlResultEnvelope }) =>
          Ref.modify(proposalRef, (current) => {
            const next: AgentControlProposal = {
              ...current,
              status: "failed",
              result: input.result,
            };
            return [next, next];
          }),
      };
      const operationStore = {
        listRecoverable: () => Ref.get(operationRef).pipe(Effect.map((operation) => [operation])),
        getByProposalId: () => Ref.get(operationRef).pipe(Effect.map(Option.some)),
        transition: (input: {
          readonly expectedStatus: AgentControlOperation["status"];
          readonly nextStatus: AgentControlOperation["status"];
          readonly state: AgentControlOperation["state"];
          readonly result: AgentControlOperation["result"];
        }) =>
          Ref.updateAndGet(operationRef, (current) => ({
            ...current,
            status: input.nextStatus,
            state: input.state,
            result: input.result,
          })),
        checkpoint: (input: { readonly state: AgentControlOperation["state"] }) =>
          Ref.updateAndGet(operationRef, (current) => ({ ...current, state: input.state })),
      };

      const execution = yield* makeTestExecution({
        proposalStore,
        operationStore,
        commandApplication: {
          apply: (command: { readonly type: string; readonly threadId?: ThreadId }) =>
            command.type === "thread.delete" && command.threadId !== undefined
              ? Ref.update(deleted, (ids) => [...ids, command.threadId!]).pipe(
                  Effect.as({ sequence: 1 }),
                )
              : command.type === "worktree.delete" && "worktreeId" in command
                ? Ref.update(deletedWorktrees, (ids) => [
                    ...ids,
                    command.worktreeId as WorktreeId,
                  ]).pipe(Effect.as({ sequence: 2 }))
                : Effect.succeed({ sequence: 1 }),
          applyWithDispatcher: () => Effect.die("unused"),
        },
        projections: {
          getThreadShellById: (id: ThreadId) =>
            Effect.succeed(id === threadId ? Option.some(target) : Option.none()),
          getWorktreeShellById: () =>
            Effect.succeed(
              Option.some({
                worktreeId: ownedWorktreeId,
                projectId,
                branch: "ryco/agent-control-owned",
                worktreePath: ownedCheckoutPath,
              }),
            ),
          getProjectShellById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/workspace/project" })),
        },
        git: {
          listWorktreePaths: () => Effect.succeed([ownedCheckoutPath]),
          removeWorktree: (input: { readonly path: string }) =>
            Ref.update(removedPaths, (paths) => [...paths, input.path]),
          deleteBranch: (input: { readonly refName: string }) =>
            Ref.update(deletedBranches, (branches) => [...branches, input.refName]),
        },
        workspaceAccess: {
          assertExistingPath: ({ path }: { readonly path: string }) => Effect.succeed(path),
        },
      });

      yield* execution.recoverIncomplete;

      assert.deepStrictEqual(yield* Ref.get(deleted), [threadId]);
      assert.deepStrictEqual(yield* Ref.get(deletedWorktrees), [ownedWorktreeId]);
      assert.deepStrictEqual(yield* Ref.get(removedPaths), [ownedCheckoutPath]);
      assert.deepStrictEqual(yield* Ref.get(deletedBranches), ["ryco/agent-control-owned"]);
      const operation = yield* Ref.get(operationRef);
      assert.strictEqual(operation.status, "failed");
      assert.deepStrictEqual(operation.state.compensation, { attempted: true, completed: true });
      const proposal = yield* Ref.get(proposalRef);
      assert.strictEqual(proposal.status, "failed");
      assert.strictEqual(proposal.result?.outcome, "failed");
      if (proposal.result?.outcome !== "failed") return;
      assert.deepStrictEqual(proposal.result.execution?.affectedThreadIds, [
        threadId,
        nonOwnedThreadId,
      ]);
      assert.deepStrictEqual(proposal.result.execution?.compensation, {
        attempted: true,
        completed: true,
      });
    }),
);

it.effect("executes model and interaction preferences through orchestration exactly once", () =>
  Effect.gen(function* () {
    const nextPlan = {
      kind: "updateThread" as const,
      threadId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      interactionMode: "plan" as const,
      tokenMode: "aggressive" as const,
    };
    const proposal = {
      ...approvedProposal,
      plan: nextPlan,
      planDigest: computeAgentControlPlanDigest(nextPlan),
    };
    const stores = yield* makeExecutionStores(proposal);
    const commands: Array<{ type: string }> = [];
    const executor = yield* makeTestExecution({
      ...stores,
      projections: { getThreadShellById: () => Effect.succeed(Option.some(target)) },
      commandApplication: {
        apply: (command: { type: string }) => {
          commands.push(command);
          return Effect.succeed({ sequence: commands.length });
        },
      },
    });
    yield* executor.executeApproved(proposal.proposalId);
    yield* executor.executeApproved(proposal.proposalId);
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      ["thread.meta.update", "thread.interaction-mode.set", "thread.token-mode.set"],
    );
    assert.strictEqual((yield* Ref.get(stores.proposalRef)).status, "completed");
  }),
);

it.effect("executes only the captured non-secret setting and rejects stale before values", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    for (const [before, expected] of [
      [false, "completed"],
      [false, "failed"],
    ] as const) {
      const nextPlan = {
        kind: "changeSettings" as const,
        change: { kind: "legacyTokenStreaming" as const, before, after: true },
      };
      const proposal = {
        ...approvedProposal,
        plan: nextPlan,
        planDigest: computeAgentControlPlanDigest(nextPlan),
      };
      const stores = yield* makeExecutionStores(proposal);
      const execution = yield* makeTestExecution({
        ...stores,
        projections: {},
        commandApplication: {},
      });
      yield* execution.executeApproved(proposal.proposalId);
      assert.strictEqual((yield* Ref.get(stores.proposalRef)).status, expected);
    }
    assert.isTrue((yield* settings.getSettings).enableLegacyTokenStreaming);
  }).pipe(Effect.provide(ServerSettingsService.layerTest({ enableLegacyTokenStreaming: false }))),
);

it.effect(
  "preserves an explicit created thread title instead of treating it as a generated-title seed",
  () =>
    Effect.gen(function* () {
      const nextPlan = {
        kind: "createThreads" as const,
        entries: [
          {
            projectId,
            title: "Named worker",
            prompt: "Reply ready",
            envMode: "local" as const,
            runtimeMode: "auto" as const,
            modelSelection: target.modelSelection,
          },
        ],
      };
      const proposal = {
        ...approvedProposal,
        plan: nextPlan,
        planDigest: computeAgentControlPlanDigest(nextPlan),
      };
      const stores = yield* makeExecutionStores(proposal);
      const commands: ClientOrchestrationCommand[] = [];
      const executor = yield* makeTestExecution({
        ...stores,
        projections: {
          getShellSnapshot: () =>
            Effect.succeed({ projects: [{ id: projectId, workspaceRoot: "/workspace/project" }] }),
          getThreadShellById: () => Effect.succeed(Option.none()),
        },
        commandApplication: {
          apply: (command: ClientOrchestrationCommand) => {
            commands.push(command);
            return Effect.succeed({ sequence: commands.length });
          },
        },
      });
      yield* executor.executeApproved(proposal.proposalId);
      assert.strictEqual((yield* Ref.get(stores.proposalRef)).status, "completed");
      assert.deepInclude(
        commands.find((c) => c.type === "thread.create"),
        { title: "Named worker" },
      );
      assert.notProperty(
        commands.find((c) => c.type === "thread.turn.start"),
        "titleSeed",
      );
    }),
);
