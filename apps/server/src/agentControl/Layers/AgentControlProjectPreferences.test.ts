import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Ref } from "effect";
import {
  AgentControlOperationId,
  AgentControlProposalId,
  AgentControlRequestId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type AgentControlOperation,
  type AgentControlProposal,
  type AgentControlResultEnvelope,
  type ClientOrchestrationCommand,
  type ThreadDelegatedCreateCommand,
} from "@ryco/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandApplication } from "../../orchestration/Services/OrchestrationCommandApplication.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import { AgentControlOperationStore } from "../Services/AgentControlOperationStore.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";
import { makeAgentControlExecution } from "./AgentControlExecution.ts";

const projectId = ProjectId.make("project-preferences");
const now = "2026-08-18T00:00:00.000Z";

for (const { envMode, runSetupScript, setupFails, missingRunner } of [
  { envMode: "local", runSetupScript: true, setupFails: false, missingRunner: false },
  { envMode: "local", runSetupScript: false, setupFails: false, missingRunner: false },
  { envMode: "worktree", runSetupScript: true, setupFails: false, missingRunner: false },
  { envMode: "worktree", runSetupScript: false, setupFails: false, missingRunner: false },
  { envMode: "worktree", runSetupScript: true, setupFails: true, missingRunner: false },
  { envMode: "worktree", runSetupScript: true, setupFails: false, missingRunner: true },
] as const) {
  it.effect(
    `creates explicit ${envMode} batch threads with inherited setup=${runSetupScript}, failure=${setupFails}, missing runner=${missingRunner}`,
    () =>
      Effect.gen(function* () {
        const modelSelection = {
          instanceId: ProviderInstanceId.make("caller"),
          model: "caller-model",
          options: [{ id: "reasoningEffort", value: "low" }],
        };
        const plan = {
          kind: "createThreads" as const,
          entries: [
            {
              projectId,
              title: "Worker",
              prompt: "Ready",
              envMode,
              runtimeMode: "auto" as const,
              modelSelection,
            },
          ],
        };
        const proposal: AgentControlProposal = {
          proposalId: AgentControlProposalId.make("preferences-proposal"),
          requestId: AgentControlRequestId.make("preferences-request"),
          principal: {
            kind: "provider-session",
            threadId: ThreadId.make("origin"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeSessionId: RuntimeSessionId.make("runtime"),
            originProjectId: projectId,
            originRuntimeMode: "auto",
            originEnvMode: "local",
          },
          planVersion: 1,
          plan,
          planDigest: computeAgentControlPlanDigest(plan),
          riskTags: [],
          promptSummary: "Create worker",
          status: "approved",
          createdAt: now,
          updatedAt: now,
          expiresAt: "2099-01-01T00:00:00.000Z",
          decidedAt: now,
          result: null,
        };
        const settled = yield* Ref.make(proposal);
        const operation = yield* Ref.make<AgentControlOperation>({
          operationId: AgentControlOperationId.make("preferences-operation"),
          proposalId: proposal.proposalId,
          actionKind: plan.kind,
          status: "pending",
          attempt: 0,
          state: {
            completedSteps: [],
            resources: { threadIds: [], ownedThreadIds: [], worktreeIds: [], ownedWorktrees: [] },
            commandReceipts: [],
          },
          result: null,
          createdAt: now,
          updatedAt: now,
        });
        const events: string[] = [];
        const commands: Array<ClientOrchestrationCommand | ThreadDelegatedCreateCommand> = [];
        const executor = yield* makeAgentControlExecution({ disableBackground: true }).pipe(
          Effect.provideService(AgentControlProposalStore, {
            getById: () => Ref.get(settled).pipe(Effect.map(Option.some)),
            listActive: () => Effect.succeed([]),
            beginExecution: () =>
              Ref.updateAndGet(settled, (p): AgentControlProposal => ({
                ...p,
                status: "executing",
              })),
            settleExecution: ({ result }: { result: AgentControlResultEnvelope }) =>
              Ref.updateAndGet(settled, (p): AgentControlProposal => ({
                ...p,
                status: result.outcome === "completed" ? "completed" : "failed",
                result,
              })),
          } as never),
          Effect.provideService(AgentControlOperationStore, {
            createForProposal: () =>
              Ref.get(operation).pipe(Effect.map((operation) => ({ operation, replayed: false }))),
            transition: (input: {
              nextStatus: AgentControlOperation["status"];
              attempt: number;
              state: AgentControlOperation["state"];
              result: AgentControlOperation["result"];
            }) =>
              Ref.updateAndGet(operation, (o) => ({
                ...o,
                status: input.nextStatus,
                attempt: input.attempt,
                state: input.state,
                result: input.result,
              })),
            checkpoint: ({ state }: { state: AgentControlOperation["state"] }) =>
              Ref.updateAndGet(operation, (o) => ({ ...o, state })),
            getByProposalId: () => Ref.get(operation).pipe(Effect.map(Option.some)),
            listRecoverable: () => Effect.succeed([]),
          } as never),
          Effect.provideService(AgentControlProposalEvents, {} as never),
          Effect.provideService(AgentControlActionValidator, {
            revalidateExecution: () => Effect.void,
          } as never),
          Effect.provideService(OrchestrationCommandApplication, {
            apply: (command: ClientOrchestrationCommand) =>
              Effect.sync(() => {
                commands.push(command);
                events.push(command.type);
                return { sequence: commands.length };
              }),
            applyInternal: (command: ThreadDelegatedCreateCommand) =>
              Effect.sync(() => {
                commands.push(command);
                events.push(command.type);
                return { sequence: commands.length };
              }),
          } as never),
          Effect.provideService(OrchestrationEngineService, {
            dispatch: () => Effect.succeed({ sequence: 1 }),
          } as never),
          Effect.provideService(ProjectionSnapshotQuery, {
            getShellSnapshot: () =>
              Effect.succeed({
                projects: [
                  {
                    id: projectId,
                    workspaceRoot: "/fixture/project",
                    defaultModelSelection: null,
                    scripts: [
                      {
                        id: "fixture-setup",
                        name: "Setup",
                        command: "echo fixture",
                        icon: "terminal",
                        runOnWorktreeCreate: true,
                      },
                    ],
                  },
                ],
              }),
            getThreadShellById: () => Effect.succeed(Option.none()),
          } as never),
          Effect.provideService(GitWorkflowService, {
            createWorktree: (input: { path: string; newRefName: string }) =>
              Effect.sync(() => {
                events.push("checkout");
                assert.match(input.newRefName, /^project\/tasks\//);
                return { worktree: { path: input.path, refName: input.newRefName } };
              }),
          } as never),
          Effect.provideService(WorkspaceAccessPolicy, {
            assertPath: ({ path }: { path: string }) => Effect.succeed(path),
            assertExistingPath: ({ path }: { path: string }) => Effect.succeed(path),
          } as never),
          Effect.provide(
            missingRunner
              ? Layer.empty
              : Layer.succeed(ProjectSetupScriptRunner, {
                  runForThread: () =>
                    Effect.gen(function* () {
                      events.push("setup");
                      if (setupFails)
                        return yield* Effect.fail(new Error("Fixture setup launch failed"));
                      return { status: "no-script" as const };
                    }),
                }),
          ),
          Effect.provideService(ServerRuntimeStartup, {} as never),
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "project-preferences-batch-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        yield* executor.executeApproved(proposal.proposalId);
        assert.strictEqual(
          (yield* Ref.get(settled)).status,
          setupFails || missingRunner ? "failed" : "completed",
        );
        if (missingRunner) {
          assert.deepStrictEqual(commands, []);
          assert.deepStrictEqual(events, []);
          assert.lengthOf((yield* Ref.get(operation)).state.resources.ownedWorktrees, 0);
          return;
        }
        assert.deepInclude(
          commands.find((c) => c.type === "thread.delegated.create"),
          { modelSelection, runtimeMode: "auto" },
        );
        if (setupFails) {
          assert.isUndefined(commands.find((c) => c.type === "thread.turn.start"));
          const failed = yield* Ref.get(operation);
          assert.isTrue(failed.state.compensation?.attempted);
          assert.lengthOf(failed.state.resources.ownedWorktrees, 1);
        } else {
          assert.deepInclude(
            commands.find((c) => c.type === "thread.turn.start"),
            { modelSelection },
          );
        }
        assert.strictEqual(
          events.filter((event) => event === "setup").length,
          envMode === "worktree" && runSetupScript ? 1 : 0,
        );
        if (envMode === "worktree" && runSetupScript) {
          assert.isBelow(events.indexOf("checkout"), events.indexOf("setup"));
          assert.isBelow(events.indexOf("thread.attach-to-worktree"), events.indexOf("setup"));
          if (!setupFails)
            assert.isBelow(events.indexOf("setup"), events.indexOf("thread.turn.start"));
        }
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            initialModelSelection: {
              instanceId: ProviderInstanceId.make("node"),
              model: "node-model",
            },
            defaultThreadEnvMode: envMode === "worktree" ? "local" : "worktree",
            projectPreferences: {
              [projectId]: { worktreeBranchPrefix: "project/tasks", runSetupScript },
            },
          }),
        ),
      ),
  );
}
