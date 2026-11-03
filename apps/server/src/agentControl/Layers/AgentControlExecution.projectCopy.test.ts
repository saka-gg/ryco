import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AGENT_CONTROL_WS_METHODS,
  AgentControlClientExecutorId,
  AgentControlRequestId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlActionPlan,
  type AgentControlCopyProjectToNodePlan,
  type AgentControlImportProjectPlan,
  type AgentControlPrincipal,
  type AgentControlProposal,
  type AgentControlProposalId,
  type AgentControlProposalReceipt,
} from "@ryco/contracts";
import {
  ProjectCopyError,
  type ProjectImportId,
  type ProjectImportSnapshot,
  type ProjectImportStartInput,
} from "@ryco/contracts/project-copy";
import { Deferred, Duration, Effect, Fiber, Layer, Option, Stream } from "effect";

import { authorizeRpcPrincipal } from "../../auth/wsAuthorization.ts";
import { ServerConfig } from "../../config.ts";
import { DeviceService } from "../../device/Services/DeviceService.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandApplication } from "../../orchestration/Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentControlAuditRepositoryLive } from "../../persistence/Layers/AgentControlAudit.ts";
import { AgentControlOperationRepositoryLive } from "../../persistence/Layers/AgentControlOperations.ts";
import { AgentControlProposalRepositoryLive } from "../../persistence/Layers/AgentControlProposals.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AgentControlAuditRepository } from "../../persistence/Services/AgentControlAudit.ts";
import { PullRequestWatchService } from "../../sourceControl/PullRequestWatchService.ts";
import {
  ProjectImports,
  type ProjectImportsShape,
} from "../../projectCopy/Services/ProjectImports.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { makeAgentControlHandlers } from "../../ws/agentControlRpc.ts";
import type { WsRpcContext } from "../../ws/context.ts";
import { AgentControlPlanValidationError } from "../Errors.ts";
import {
  agentControlPromptSummaryForPlan,
  agentControlRiskTagsForPlan,
} from "../proposalPresentation.ts";
import { agentControlProjectImportId } from "../projectCopyControl.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import type { AgentControlExecutionShape } from "../Services/AgentControlExecution.ts";
import { AgentControlOperationStore } from "../Services/AgentControlOperationStore.ts";
import {
  AgentControlProposalService,
  type AgentControlProposalServiceShape,
} from "../Services/AgentControlProposalService.ts";
import { makeAgentControlExecution } from "./AgentControlExecution.ts";
import { AgentControlOperationStoreLive } from "./AgentControlOperationStore.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { AgentControlProposalEventsLive } from "./AgentControlProposalEvents.ts";
import { makeAgentControlProposalServiceLive } from "./AgentControlProposalService.ts";
import { AgentControlProposalStoreLive } from "./AgentControlProposalStore.ts";

const projectId = ProjectId.make("project-1");
const miniNode = EnvironmentId.make("env-mini");
const executorA = AgentControlClientExecutorId.make("1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b");
const executorB = AgentControlClientExecutorId.make("2a2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b");
const importIdOnTarget = "3c2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b" as ProjectImportId;

const principal: AgentControlPrincipal = {
  kind: "provider-session",
  threadId: ThreadId.make("thread-caller"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime-caller"),
  turnId: TurnId.make("turn-caller"),
  originProjectId: projectId,
  originRuntimeMode: "auto",
  originEnvMode: "local",
};

/** Every value here must stay out of audit rows (A20). */
const SECRETS = {
  title: "Quarterly Secret Project",
  label: "Mac mini in the office",
  path: "/Users/me/Code/hidden-folder",
  command: "bun install --registry-token=abc",
  prompt: "SECRET-PROMPT: set up the deploy keys",
  remoteUrl: "git@github.com:me/private-repo.git",
} as const;

const copyPlan: AgentControlCopyProjectToNodePlan = {
  kind: "copyProjectToNode",
  source: {
    kind: "project",
    projectId,
    title: SECRETS.title,
    expectedUpdatedAt: "2026-10-22T00:00:00.000Z",
  },
  target: { environmentId: miniNode, label: SECRETS.label },
  destination: { kind: "path", path: SECRETS.path },
  bringCommits: true,
  bringChanges: false,
  copySettings: true,
  setup: { command: SECRETS.command, saveAsScript: false },
  followUpThread: {
    title: "Finish",
    prompt: SECRETS.prompt,
    runtimeMode: "approval-required",
    envMode: "local",
    modelSelection: null,
  },
};

const importPlan: AgentControlImportProjectPlan = {
  kind: "importProject",
  projectId: ProjectId.make("project-imported"),
  title: SECRETS.title,
  destinationPath: SECRETS.path,
  remoteUrl: SECRETS.remoteUrl,
  branch: null,
  setup: { command: SECRETS.command, saveAsScript: true },
  followUpThread: {
    title: "Finish",
    prompt: SECRETS.prompt,
    runtimeMode: "approval-required",
    envMode: "local",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  },
};

const storesLayer = Layer.mergeAll(
  AgentControlOperationStoreLive,
  makeAgentControlProposalServiceLive({ disablePeriodicExpirySweep: true }),
).pipe(
  Layer.provideMerge(AgentControlProposalStoreLive),
  Layer.provideMerge(AgentControlProposalEventsLive),
  Layer.provideMerge(AgentControlPolicyLive),
  Layer.provideMerge(AgentControlProposalRepositoryLive),
  Layer.provideMerge(AgentControlOperationRepositoryLive),
  Layer.provideMerge(AgentControlAuditRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
);

const noImports: ProjectImportsShape = {
  start: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  subscribe: () => Stream.die("unused"),
  cancel: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
  discard: () => Effect.die("unused"),
  recoverOnStartup: () => Effect.void,
};

const makeExecution = (
  input: {
    readonly revalidate?: () => Effect.Effect<void, AgentControlPlanValidationError>;
    readonly imports?: ProjectImportsShape;
  } = {},
) =>
  makeAgentControlExecution({ disableBackground: true }).pipe(
    Effect.provideService(AgentControlActionValidator, {
      validateOwnerAutomation: () => Effect.die("unused"),
      validateSubmission: () => Effect.die("unused"),
      validateExternalSubmission: () => Effect.die("unused"),
      revalidateExecution: input.revalidate ?? (() => Effect.void),
    }),
    // Neither kind dispatches orchestration commands or touches git here.
    Effect.provideService(OrchestrationCommandApplication, {} as never),
    Effect.provideService(OrchestrationEngineService, {} as never),
    Effect.provideService(ProjectionSnapshotQuery, {} as never),
    Effect.provideService(GitWorkflowService, {} as never),
    Effect.provideService(WorkspaceAccessPolicy, {} as never),
    Effect.provideService(DeviceService, { supported: false, manager: {} } as never),
    Effect.provideService(ServerRuntimeStartup, {} as never),
    Effect.provideService(ProjectImports, input.imports ?? noImports),
    Effect.provideService(PullRequestWatchService, {} as never),
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "agent-control-project-copy-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const submit = (plan: AgentControlActionPlan, requestId: string) =>
  Effect.gen(function* () {
    const service = yield* AgentControlProposalService;
    const submitted = yield* service.submit({
      authorizeRoutine: true,
      principal,
      requestId: AgentControlRequestId.make(requestId),
      plan,
      riskTags: agentControlRiskTagsForPlan(plan),
      promptSummary: agentControlPromptSummaryForPlan(plan),
      now: new Date().toISOString(),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    return submitted.proposal;
  });

const readProposal = (proposalId: AgentControlProposalId) =>
  Effect.gen(function* () {
    const service = yield* AgentControlProposalService;
    return Option.getOrThrow(yield* service.getProposal(proposalId));
  });

interface TestRpcError {
  readonly _tag: string;
  readonly code?: string;
  readonly status?: string;
  readonly message?: string;
}
type TestHandler = (input: object) => Effect.Effect<AgentControlProposalReceipt, TestRpcError>;

/** An owner WS context over the real approval service and this execution. */
const ownerHandlers = (
  service: AgentControlProposalServiceShape,
  execution: AgentControlExecutionShape,
) => {
  const ownerEffect = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
    authorizeRpcPrincipal(
      { transport: "direct", role: "owner", scopeId: "session-owner", canManageLocalAccess: true },
      "owner",
      method,
    ).pipe(Effect.flatMap(() => effect));
  const handlers = makeAgentControlHandlers({
    ownerEffect,
    ownerStreamEffect: ownerEffect,
    agentControlProposals: Option.some(service),
    agentControlExecution: Option.some(execution),
    agentControlNodeDirectory: Option.none(),
    currentSessionId: "session-owner",
  } as unknown as WsRpcContext);
  const call = (method: keyof typeof handlers, input: object) =>
    (handlers[method] as unknown as TestHandler)(input);
  return {
    accept: (input: object) => call(AGENT_CONTROL_WS_METHODS.acceptProposal, input),
    report: (input: object) => call(AGENT_CONTROL_WS_METHODS.reportClientExecution, input),
  };
};

describe("copyProjectToNode: client-executed lifecycle", () => {
  it.effect(
    "is proposed for approval, bound to the executor that accepts it, and settled by its reports",
    () =>
      Effect.gen(function* () {
        const service = yield* AgentControlProposalService;
        const operations = yield* AgentControlOperationStore;
        const execution = yield* makeExecution();
        const rpc = ownerHandlers(service, execution);

        const proposal = yield* submit(copyPlan, "copy-1");
        assert.strictEqual(proposal.status, "pending-user-approval");
        assert.includeMembers(
          [...proposal.riskTags],
          ["cross-node", "copies-workspace-content", "runs-commands"],
        );

        // Never accepted without the approving client's executor.
        const unbound = yield* Effect.flip(rpc.accept({ proposalId: proposal.proposalId }));
        assert.strictEqual(unbound.code, "unsupported");
        assert.strictEqual(
          (yield* readProposal(proposal.proposalId)).status,
          "pending-user-approval",
        );

        const accepted = yield* rpc.accept({
          proposalId: proposal.proposalId,
          executeOnClient: { executorId: executorA },
        });
        assert.strictEqual(accepted.status, "executing");
        // The node's executor never runs it, approved or not.
        yield* execution.executeApproved(proposal.proposalId);
        const operation = Option.getOrThrow(yield* operations.getByProposalId(proposal.proposalId));
        assert.strictEqual(operation.status, "running");
        const binding = operation.state.clientExecution!;
        assert.strictEqual(binding.targetEnvironmentId, miniNode);
        assert.isNull(binding.importId);
        assert.notInclude(JSON.stringify(operation), executorA);
        const deadline = Date.parse(binding.deadlineAt) - Date.now();
        assert.isTrue(deadline > 110 * 60_000 && deadline <= 120 * 60_000);
        // The stream and the receipt never carry the executor or its hash.
        const visible = JSON.stringify([yield* readProposal(proposal.proposalId), accepted]);
        assert.notInclude(visible, executorA);
        assert.notInclude(visible, binding.executorIdHash);

        // The same executor gets its state back; another app is refused.
        const again = yield* rpc.accept({
          proposalId: proposal.proposalId,
          executeOnClient: { executorId: executorA },
        });
        assert.strictEqual(again.status, "executing");
        const other = yield* Effect.flip(
          rpc.accept({
            proposalId: proposal.proposalId,
            executeOnClient: { executorId: executorB },
          }),
        );
        assert.strictEqual(other.code, "conflict");
        const foreignReport = yield* Effect.flip(
          rpc.report({ proposalId: proposal.proposalId, executorId: executorB, outcome: "failed" }),
        );
        assert.strictEqual(foreignReport.code, "conflict");

        // `started` records the target's import and extends the deadline.
        yield* rpc.report({
          proposalId: proposal.proposalId,
          executorId: executorA,
          outcome: "started",
          importId: importIdOnTarget,
        });
        const started = Option.getOrThrow(yield* operations.getByProposalId(proposal.proposalId));
        assert.strictEqual(started.state.clientExecution?.importId, importIdOnTarget);
        assert.isTrue(
          Date.parse(started.state.clientExecution!.deadlineAt) - Date.now() > 5 * 60 * 60_000,
        );

        const result = {
          targetEnvironmentId: miniNode,
          projectId: ProjectId.make("project-on-mini"),
          workspaceRoot: SECRETS.path,
          warnings: ["Setup failed (exit 1); clone of https://me:hunter2@example.com/x.git"],
        };
        const wrongTarget = yield* Effect.flip(
          rpc.report({
            proposalId: proposal.proposalId,
            executorId: executorA,
            outcome: "completed",
            result: { ...result, targetEnvironmentId: EnvironmentId.make("env-other") },
          }),
        );
        assert.strictEqual(wrongTarget.code, "conflict");

        const completed = yield* rpc.report({
          proposalId: proposal.proposalId,
          executorId: executorA,
          outcome: "completed",
          result,
        });
        assert.strictEqual(completed.status, "completed");
        const settled = yield* readProposal(proposal.proposalId);
        assert.strictEqual(settled.result?.outcome, "completed");
        if (settled.result?.outcome === "completed") {
          assert.deepStrictEqual(settled.result.remoteProject, {
            environmentId: miniNode,
            projectId: "project-on-mini",
          });
          assert.isUndefined(settled.result.createdProjectIds);
          assert.include(settled.result.detail, `Copied to ${SECRETS.label}.`);
          assert.notInclude(settled.result.detail, "hunter2");
        }

        // Repeating the outcome answers with the receipt; a different one is a conflict.
        const repeated = yield* rpc.report({
          proposalId: proposal.proposalId,
          executorId: executorA,
          outcome: "completed",
          result,
        });
        assert.strictEqual(repeated.status, "completed");
        const late = yield* Effect.flip(
          rpc.report({ proposalId: proposal.proposalId, executorId: executorA, outcome: "failed" }),
        );
        assert.strictEqual(late.code, "conflict");
        assert.strictEqual(late.status, "completed");
      }).pipe(Effect.provide(storesLayer)),
  );

  it.effect("keeps audit rows to identifiers and switches, with no failure text", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const audit = yield* AgentControlAuditRepository;
      const execution = yield* makeExecution();
      const rpc = ownerHandlers(service, execution);
      const proposal = yield* submit(copyPlan, "copy-audit");
      yield* rpc.accept({
        proposalId: proposal.proposalId,
        executeOnClient: { executorId: executorA },
      });
      yield* rpc.report({
        proposalId: proposal.proposalId,
        executorId: executorA,
        outcome: "failed",
        error: `Clone of ${SECRETS.remoteUrl} into ${SECRETS.path} failed`,
      });
      const settled = yield* readProposal(proposal.proposalId);
      assert.strictEqual(settled.status, "failed");
      if (settled.result?.outcome === "failed")
        assert.include(settled.result.error.message, SECRETS.path);

      const rows = yield* audit.listByProposalId({ proposalId: proposal.proposalId });
      // Rows of one millisecond tie on time, so compare them as a set.
      assert.deepStrictEqual(rows.map((row) => row.eventKind).toSorted(), [
        "proposal-approved",
        "proposal-created",
        "proposal-executing",
        "proposal-failed",
      ]);
      for (const row of rows) {
        // Flat bounded strings: rows written here decode on any build.
        for (const value of Object.values(row.metadata)) assert.isString(value);
        assert.strictEqual(row.metadata.targetEnvironmentId, miniNode);
        assert.strictEqual(row.metadata.sourceProjectId, projectId);
        assert.strictEqual(row.metadata.bringCommits, "true");
        assert.strictEqual(row.metadata.setup, "true");
        assert.strictEqual(row.metadata.followUpThread, "true");
        const text = JSON.stringify(row);
        for (const secret of Object.values(SECRETS)) {
          if (secret === SECRETS.title) continue; // The prompt summary names the project.
          assert.notInclude(text, secret);
        }
        assert.notInclude(JSON.stringify(row.metadata), SECRETS.title);
        assert.notInclude(text, executorA);
        assert.isUndefined(row.metadata.failureDetail);
      }
      assert.strictEqual(
        rows.find((row) => row.eventKind === "proposal-failed")?.metadata.outcome,
        "failed",
      );
    }).pipe(Effect.provide(storesLayer)),
  );

  it.effect("fails a copy whose plan no longer validates when it is bound", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const execution = yield* makeExecution({
        revalidate: () =>
          Effect.fail(
            new AgentControlPlanValidationError({
              reason: "project-stale",
              detail: "The project changed after the copy was requested; request it again.",
            }),
          ),
      });
      const rpc = ownerHandlers(service, execution);
      const proposal = yield* submit(copyPlan, "copy-stale");
      const receipt = yield* rpc.accept({
        proposalId: proposal.proposalId,
        executeOnClient: { executorId: executorA },
      });
      assert.strictEqual(receipt.status, "failed");
      const settled = yield* readProposal(proposal.proposalId);
      if (settled.result?.outcome === "failed") {
        assert.strictEqual(settled.result.error.code, "revalidation-failed");
        assert.include(settled.result.error.message, "request it again");
      }
      const report = yield* Effect.flip(
        rpc.report({ proposalId: proposal.proposalId, executorId: executorA, outcome: "started" }),
      );
      assert.strictEqual(report.status, "failed");
    }).pipe(Effect.provide(storesLayer)),
  );

  it.effect("survives restarts until the report deadline, then fails with a clear message", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const operations = yield* AgentControlOperationStore;
      const execution = yield* makeExecution();
      const rpc = ownerHandlers(service, execution);
      const expire = (proposalId: AgentControlProposalId) =>
        Effect.gen(function* () {
          const operation = Option.getOrThrow(yield* operations.getByProposalId(proposalId));
          yield* operations.checkpoint({
            operationId: operation.operationId,
            expectedStatus: "running",
            attempt: operation.attempt,
            state: {
              ...operation.state,
              clientExecution: {
                ...operation.state.clientExecution!,
                deadlineAt: new Date(Date.now() - 1_000).toISOString(),
              },
            },
            updatedAt: new Date().toISOString(),
          });
        });

      const swept = yield* submit(copyPlan, "copy-sweep");
      const recovered = yield* submit(copyPlan, "copy-recover");
      for (const proposal of [swept, recovered])
        yield* rpc.accept({
          proposalId: proposal.proposalId,
          executeOnClient: { executorId: executorA },
        });

      // A restart (update everything) leaves running copies alone.
      yield* (yield* makeExecution()).recoverIncomplete;
      yield* execution.sweepClientExecutions;
      assert.strictEqual((yield* readProposal(swept.proposalId)).status, "executing");
      assert.strictEqual((yield* readProposal(recovered.proposalId)).status, "executing");

      yield* expire(swept.proposalId);
      yield* execution.sweepClientExecutions;
      const sweptResult = (yield* readProposal(swept.proposalId)).result;
      assert.strictEqual(sweptResult?.outcome, "failed");
      if (sweptResult?.outcome === "failed")
        assert.strictEqual(
          sweptResult.error.message,
          `The app that approved this request did not report back; check ${SECRETS.label}.`,
        );

      yield* expire(recovered.proposalId);
      yield* (yield* makeExecution()).recoverIncomplete;
      assert.strictEqual((yield* readProposal(recovered.proposalId)).status, "failed");
      // A report after the deadline settled it is refused.
      const late = yield* Effect.flip(
        rpc.report({
          proposalId: recovered.proposalId,
          executorId: executorA,
          outcome: "completed",
          result: {
            targetEnvironmentId: miniNode,
            projectId: ProjectId.make("p"),
            workspaceRoot: "/x",
            warnings: [],
          },
        }),
      );
      assert.strictEqual(late.code, "conflict");
    }).pipe(Effect.provide(storesLayer)),
  );
});

/** A scripted import job: running until the test finishes it. */
const scriptedImports = Effect.gen(function* () {
  const started: Array<ProjectImportStartInput> = [];
  const jobs = new Map<string, ProjectImportSnapshot>();
  const done = yield* Deferred.make<ProjectImportSnapshot>();
  const snapshotOf = (
    input: ProjectImportStartInput,
    status: ProjectImportSnapshot["status"],
  ): ProjectImportSnapshot => ({
    importId: input.importId,
    projectId: input.projectId,
    title: input.title,
    destinationPath: input.destinationPath,
    status,
    steps: [],
    outputTail: "",
    error:
      status === "failed"
        ? {
            step: "clone",
            code: "remote-unreachable",
            message: `fatal: could not read from ${input.source.kind === "clone" ? input.source.remoteUrl : ""}`,
          }
        : null,
    warnings: status === "completed" ? ["Setup failed (exit 1)."] : [],
    preflight: null,
    leftoverPath: null,
    followUpThreadId: status === "completed" ? ThreadId.make("thread-follow-up") : null,
    origin: input.origin,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  });
  const service: ProjectImportsShape = {
    ...noImports,
    start: (input) =>
      Effect.sync(() => {
        started.push(input);
        const job = snapshotOf(input, "running");
        jobs.set(input.importId, job);
        return job;
      }),
    get: (importId) => Effect.sync(() => Option.fromNullishOr(jobs.get(importId))),
    subscribe: ({ importId }) => {
      const current = jobs.get(importId);
      return current === undefined
        ? Stream.fail(new ProjectCopyError({ code: "not-found", message: "Unknown import." }))
        : Stream.concat(Stream.make(current), Stream.fromEffect(Deferred.await(done)));
    },
  };
  const finish = (status: "completed" | "failed") =>
    Effect.gen(function* () {
      const input = started.at(-1)!;
      const job = snapshotOf(input, status);
      jobs.set(input.importId, job);
      yield* Deferred.succeed(done, job);
    });
  return { service, started, finish };
});

const waitForStatus = (
  proposalId: AgentControlProposalId,
  status: AgentControlProposal["status"],
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const proposal = yield* readProposal(proposalId);
      if (proposal.status === status) return proposal;
      yield* Effect.sleep(Duration.millis(10));
    }
    return yield* readProposal(proposalId);
  });

describe("importProject: executed here through the import job", () => {
  it.live(
    "starts the job with an id derived from the operation and settles when it completes",
    () =>
      Effect.gen(function* () {
        const service = yield* AgentControlProposalService;
        const operations = yield* AgentControlOperationStore;
        const imports = yield* scriptedImports;
        const execution = yield* makeExecution({ imports: imports.service });
        const proposal = yield* submit(importPlan, "import-1");
        assert.strictEqual(proposal.status, "pending-user-approval");
        yield* service.accept({
          proposalId: proposal.proposalId,
          decidedAt: new Date().toISOString(),
        });
        yield* execution.executeApproved(proposal.proposalId);

        // It does not wait for the clone: the follower settles it.
        assert.strictEqual((yield* readProposal(proposal.proposalId)).status, "executing");
        const operation = Option.getOrThrow(yield* operations.getByProposalId(proposal.proposalId));
        assert.lengthOf(imports.started, 1);
        const input = imports.started[0]!;
        assert.strictEqual(input.importId, agentControlProjectImportId(operation.operationId));
        assert.deepStrictEqual(input.origin, {
          kind: "agent-control",
          sourceLabel: null,
          proposalId: proposal.proposalId,
        });
        assert.deepStrictEqual(input.setup, importPlan.setup);
        assert.deepStrictEqual(input.followUpThread, importPlan.followUpThread);
        assert.includeMembers([...operation.state.completedSteps], ["project-import-started"]);

        yield* imports.finish("completed");
        const settled = yield* waitForStatus(proposal.proposalId, "completed");
        assert.strictEqual(settled.status, "completed");
        if (settled.result?.outcome === "completed") {
          assert.deepStrictEqual(settled.result.createdProjectIds, [importPlan.projectId]);
          assert.deepStrictEqual(settled.result.createdThreadIds, [
            ThreadId.make("thread-follow-up"),
          ]);
          assert.include(settled.result.detail, "Setup failed (exit 1).");
        }
      }).pipe(Effect.provide(storesLayer)),
  );

  it.live("fails with the job's error and never compensates", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const audit = yield* AgentControlAuditRepository;
      const imports = yield* scriptedImports;
      const execution = yield* makeExecution({ imports: imports.service });
      const proposal = yield* submit(importPlan, "import-fail");
      yield* service.accept({
        proposalId: proposal.proposalId,
        decidedAt: new Date().toISOString(),
      });
      yield* execution.executeApproved(proposal.proposalId);
      yield* imports.finish("failed");
      const settled = yield* waitForStatus(proposal.proposalId, "failed");
      assert.strictEqual(settled.result?.outcome, "failed");
      if (settled.result?.outcome === "failed") {
        assert.include(settled.result.error.message, "could not read from");
        // The operation was never moved to compensating (no orchestration command ran).
        assert.isUndefined(settled.result.execution?.compensation);
      }
      const rows = yield* audit.listByProposalId({ proposalId: proposal.proposalId });
      for (const row of rows) {
        assert.notInclude(JSON.stringify(row), SECRETS.remoteUrl);
        assert.notInclude(JSON.stringify(row), SECRETS.path);
        assert.isUndefined(row.metadata.failureDetail);
      }
      assert.strictEqual(
        rows.find((row) => row.eventKind === "proposal-created")?.metadata.projectId,
        "project-imported",
      );
    }).pipe(Effect.provide(storesLayer)),
  );

  it.live("settles from the job after a restart, or fails when the job never started", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlProposalService;
      const imports = yield* scriptedImports;
      // A process that started the import and stopped before the job finished.
      const first = yield* makeExecution({
        imports: { ...imports.service, subscribe: () => Stream.never },
      });
      const running = yield* submit(importPlan, "import-restart");
      yield* service.accept({
        proposalId: running.proposalId,
        decidedAt: new Date().toISOString(),
      });
      yield* first.executeApproved(running.proposalId);
      yield* imports.finish("completed");

      // A process that stopped before the job existed.
      const lost = yield* submit(
        { ...importPlan, projectId: ProjectId.make("project-lost") },
        "import-lost",
      );
      yield* service.accept({ proposalId: lost.proposalId, decidedAt: new Date().toISOString() });
      const reachedStart = yield* Deferred.make<void>();
      const neverStarted = yield* makeExecution({
        imports: {
          ...noImports,
          start: () => Deferred.succeed(reachedStart, undefined).pipe(Effect.andThen(Effect.never)),
          get: () => Effect.succeed(Option.none()),
        },
      });
      const stopped = yield* Effect.forkChild(neverStarted.executeApproved(lost.proposalId));
      yield* Deferred.await(reachedStart);
      yield* Fiber.interrupt(stopped);

      yield* (yield* makeExecution({ imports: imports.service })).recoverIncomplete;
      assert.strictEqual(
        (yield* waitForStatus(running.proposalId, "completed")).status,
        "completed",
      );
      const lostResult = (yield* waitForStatus(lost.proposalId, "failed")).result;
      assert.strictEqual(lostResult?.outcome, "failed");
      if (lostResult?.outcome === "failed")
        assert.include(lostResult.error.message, "did not start");
    }).pipe(Effect.provide(storesLayer)),
  );
});
