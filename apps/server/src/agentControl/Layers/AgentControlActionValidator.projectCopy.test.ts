import {
  AgentControlIntegrationId,
  AgentControlProposalId,
  AgentControlRequestId,
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ServerProvider,
  ThreadId,
  TurnId,
  WorktreeId,
  type AgentControlCopyProjectToNodePlan,
  type AgentControlExternalIntegration,
  type AgentControlImportProjectPlan,
  type AgentControlNodeDirectoryListEntry,
  type AgentControlProposal,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import type { ProjectDestinationPreview } from "@ryco/contracts/project-copy";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { GitRemoteUrlKind } from "@ryco/shared/gitRemoteUrl";
import { AgentControlNodeDirectoryError } from "../Errors.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import type {
  AgentControlSessionRecord,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import { makeAgentControlActionValidatorFromDeps } from "./AgentControlActionValidator.ts";

const now = "2026-10-22T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const chatProjectId = ProjectId.make("chat-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const callerThreadId = ThreadId.make("thread-caller");
const runtimeSessionId = RuntimeSessionId.make("runtime-caller");
const turnId = TurnId.make("turn-caller");
const thisNode = EnvironmentId.make("env-this");
const miniNode = EnvironmentId.make("env-mini");

const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: projectId,
  title: "Ryco",
  workspaceRoot: "/code/ryco",
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});
const chatProject = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: chatProjectId,
  kind: "chat",
  title: "A chat",
  workspaceRoot: "/chats/1",
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});

const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: providerInstanceId,
  driver: "codex",
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [{ slug: "gpt-5.6", name: "GPT-5.6", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const callerThread = (envMode: "local" | "worktree", runtimeMode: "auto" | "approval-required") =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id: callerThreadId,
    projectId,
    title: "Caller",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6" },
    runtimeMode,
    interactionMode: "default",
    branch: envMode === "worktree" ? "feature" : null,
    worktreePath: envMode === "worktree" ? "/code/worktrees/caller" : "/code/ryco",
    worktreeId: envMode === "worktree" ? WorktreeId.make("worktree-caller") : null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: {
      threadId: callerThreadId,
      status: "running",
      providerName: "codex",
      providerInstanceId,
      runtimeSessionId,
      runtimeMode,
      activeTurnId: turnId,
      lastError: null,
      updatedAt: now,
    },
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

const session: AgentControlSessionRecord = {
  sessionId: "agent-control-session",
  threadId: callerThreadId,
  providerInstanceId,
  runtimeSessionId,
  grantedCapabilities: [],
  issuedAt: now,
  injectionMode: "codex-http",
};
const authority: AgentControlTurnAuthority = {
  sessionId: session.sessionId,
  threadId: callerThreadId,
  turnId,
  boundAt: now,
};

const directoryEntry = (
  entry: Partial<AgentControlNodeDirectoryListEntry> & { readonly environmentId: EnvironmentId },
): AgentControlNodeDirectoryListEntry => ({
  label: "Node",
  platformOs: "darwin",
  online: true,
  projectCopySupport: "yes",
  isThisNode: false,
  lastPublishedAt: now,
  ...entry,
});

const preview = (
  resolvedPath: string,
  state: ProjectDestinationPreview["state"],
): ProjectDestinationPreview => ({
  resolvedPath,
  state,
  existingProjectId: null,
  existingRepositoryCanonicalKey: null,
  suggestedPath: state === "available" ? null : `${resolvedPath}-2`,
  detail: null,
});

const classify = (url: string): GitRemoteUrlKind =>
  url.startsWith("https://")
    ? "https"
    : url.startsWith("http://")
      ? "http"
      : url.startsWith("git@")
        ? "scp"
        : url.startsWith("file://")
          ? "file"
          : "other";

const makeValidator = (
  options: {
    readonly envMode?: "local" | "worktree";
    readonly runtimeMode?: "auto" | "approval-required";
    readonly nodes?: ReadonlyArray<AgentControlNodeDirectoryListEntry> | "unavailable";
    readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  } = {},
) => {
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: options.projects ?? [project, chatProject],
    threads: [callerThread(options.envMode ?? "local", options.runtimeMode ?? "auto")],
    updatedAt: now,
  };
  const nodes = options.nodes ?? [
    directoryEntry({ environmentId: thisNode, label: "MacBook", isThisNode: true }),
    directoryEntry({ environmentId: miniNode, label: "Mac mini" }),
    directoryEntry({
      environmentId: EnvironmentId.make("env-old"),
      label: "Old box",
      projectCopySupport: "no",
    }),
  ];
  return makeAgentControlActionValidatorFromDeps({
    projections: {
      getShellSnapshot: () => Effect.succeed(snapshot),
    } as unknown as ProjectionSnapshotQueryShape,
    getProviders: Effect.succeed([provider]),
    listRefs: () => Effect.die("unused"),
    nodePaths: {
      judgeProjectDestination: ({ path }) =>
        Effect.succeed(
          path === "/code/new"
            ? {
                preview: preview(path, "available"),
                usable: true,
                canonicalPath: path,
                projectRoot: path,
                reservationKey: path,
              }
            : path === "/link/new"
              ? {
                  // A symlinked parent: the canonical folder differs from the approved one.
                  preview: preview("/private/link/new", "available"),
                  usable: true,
                  canonicalPath: "/private/link/new",
                  projectRoot: "/private/link/new",
                  reservationKey: "/private/link/new",
                }
              : {
                  preview: preview(path, "exists-not-empty"),
                  usable: false,
                  canonicalPath: null,
                  projectRoot: null,
                  reservationKey: null,
                },
        ),
    },
    gitNetwork: {
      classifyRemoteUrl: classify,
      sanitizeRemoteUrl: (url) => url.replace(/^(https?:\/\/)[^@/]+@/u, "$1"),
    },
    nodeDirectory: {
      list: () =>
        nodes === "unavailable"
          ? Effect.fail(
              new AgentControlNodeDirectoryError({ reason: "unavailable", detail: "not yet" }),
            )
          : Effect.succeed({ nodes }),
    },
    thisEnvironmentId: Effect.succeed(thisNode),
  });
};

const importPlan = (
  overrides: Partial<AgentControlImportProjectPlan> = {},
): AgentControlImportProjectPlan => ({
  kind: "importProject",
  projectId: ProjectId.make("project-new"),
  title: "New",
  destinationPath: "/code/new",
  remoteUrl: "git@github.com:me/new.git",
  branch: null,
  setup: { command: "bun install", saveAsScript: false },
  followUpThread: {
    title: "Finish setup",
    prompt: "Install the tools.",
    runtimeMode: "auto",
    envMode: "local",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6" },
  },
  ...overrides,
});

const copyPlan = (
  overrides: Partial<AgentControlCopyProjectToNodePlan> = {},
): AgentControlCopyProjectToNodePlan => ({
  kind: "copyProjectToNode",
  source: { kind: "project", projectId, title: "Ryco", expectedUpdatedAt: now },
  target: { environmentId: miniNode, label: "Mac mini" },
  destination: { kind: "default" },
  bringCommits: true,
  bringChanges: true,
  copySettings: true,
  setup: null,
  followUpThread: null,
  ...overrides,
});

const submit = (
  plan: AgentControlImportProjectPlan | AgentControlCopyProjectToNodePlan,
  options?: Parameters<typeof makeValidator>[0],
) => makeValidator(options).validateSubmission({ session, authority, plan });

const refusal = (
  plan: AgentControlImportProjectPlan | AgentControlCopyProjectToNodePlan,
  options?: Parameters<typeof makeValidator>[0],
) => Effect.flip(submit(plan, options));

const proposalOf = (
  plan: AgentControlImportProjectPlan | AgentControlCopyProjectToNodePlan,
  principal: AgentControlProposal["principal"],
): AgentControlProposal => ({
  proposalId: AgentControlProposalId.make("proposal-copy"),
  requestId: AgentControlRequestId.make("request-copy"),
  principal,
  planVersion: 1,
  plan,
  planDigest: computeAgentControlPlanDigest(plan),
  riskTags: [],
  promptSummary: null,
  status: "approved",
  createdAt: now,
  updatedAt: now,
  expiresAt: "2099-01-01T00:00:00.000Z",
  decidedAt: now,
  result: null,
});

describe("importProject validation", () => {
  it.effect(
    "accepts a free, canonical folder, a clone URL and a follow-up within the caller's rights",
    () =>
      Effect.gen(function* () {
        const principal = yield* submit(importPlan());
        assert.strictEqual(principal.kind, "provider-session");
        assert.strictEqual(principal.originRuntimeMode, "auto");
      }),
  );

  it.effect("refuses clones it must not run and folders it must not use", () =>
    Effect.gen(function* () {
      const reasons = [
        (yield* refusal(importPlan({ remoteUrl: "http://example.com/r.git" }))).detail,
        (yield* refusal(importPlan({ remoteUrl: "file:///tmp/r" }))).detail,
        (yield* refusal(importPlan({ remoteUrl: "https://token@github.com/me/r.git" }))).detail,
        (yield* refusal(importPlan({ destinationPath: "/code/taken" }))).detail,
        (yield* refusal(importPlan({ destinationPath: "/link/new" }))).detail,
        (yield* refusal(importPlan({ projectId }))).detail,
      ];
      assert.include(reasons[0], "Plain http");
      assert.include(reasons[1], "https, ssh or scp-style");
      assert.include(reasons[2], "credentials");
      assert.include(reasons[3], "/code/taken already exists and is not empty");
      assert.include(reasons[3], "/code/taken-2 is free");
      assert.include(reasons[4], "resolves elsewhere");
      assert.include(reasons[5], "already in use");
    }),
  );

  it.effect(
    "applies createThreads' rules to the follow-up thread and validates its model here",
    () =>
      Effect.gen(function* () {
        const followUp = importPlan().followUpThread!;
        const escalated = yield* refusal(
          importPlan({ followUpThread: { ...followUp, runtimeMode: "full-access" } }),
        );
        assert.strictEqual(escalated.reason, "privilege-escalation");
        const shared = yield* refusal(importPlan(), { envMode: "worktree" });
        assert.strictEqual(shared.reason, "worktree-escalation");
        yield* submit(importPlan({ followUpThread: { ...followUp, envMode: "worktree" } }), {
          envMode: "worktree",
        });
        const model = yield* refusal(
          importPlan({
            followUpThread: {
              ...followUp,
              modelSelection: { instanceId: providerInstanceId, model: "missing" },
            },
          }),
        );
        assert.strictEqual(model.reason, "model-unavailable");
      }),
  );
});

describe("copyProjectToNode validation", () => {
  it.effect("accepts a non-chat project of this node copied to a known other node", () =>
    Effect.gen(function* () {
      yield* submit(copyPlan());
      yield* submit(
        copyPlan({
          source: { kind: "repository", remoteUrl: "https://github.com/me/r.git", title: "r" },
          bringCommits: false,
          bringChanges: false,
          copySettings: false,
          destination: { kind: "child-of-default", name: "r" },
        }),
      );
    }),
  );

  it.effect("refuses stale, chat and repository sources it cannot copy", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* refusal(
          copyPlan({
            source: {
              kind: "project",
              projectId,
              title: "Ryco",
              expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
            },
          }),
        )).reason,
        "project-stale",
      );
      assert.include(
        (yield* refusal(
          copyPlan({
            source: {
              kind: "project",
              projectId: chatProjectId,
              title: "A chat",
              expectedUpdatedAt: now,
            },
          }),
        )).detail,
        "chat cannot be copied",
      );
      assert.strictEqual(
        (yield* refusal(
          copyPlan({
            source: {
              kind: "project",
              projectId: ProjectId.make("gone"),
              title: "Gone",
              expectedUpdatedAt: now,
            },
          }),
        )).reason,
        "project-unavailable",
      );
      assert.include(
        (yield* refusal(
          copyPlan({
            source: { kind: "repository", remoteUrl: "https://github.com/me/r.git", title: "r" },
          }),
        )).detail,
        "Only a project on this node",
      );
    }),
  );

  it.effect("refuses this node, unknown or outdated targets, and misleading labels", () =>
    Effect.gen(function* () {
      assert.include(
        (yield* refusal(copyPlan({ target: { environmentId: thisNode, label: "MacBook" } })))
          .detail,
        "is this node",
      );
      assert.include(
        (yield* refusal(
          copyPlan({ target: { environmentId: EnvironmentId.make("env-gone"), label: "Gone" } }),
        )).detail,
        "Open Ryco on a device connected to that node",
      );
      assert.include(
        (yield* refusal(
          copyPlan({ target: { environmentId: EnvironmentId.make("env-old"), label: "Old box" } }),
        )).detail,
        "Update Ryco on Old box",
      );
      assert.include(
        (yield* refusal(copyPlan({ target: { environmentId: miniNode, label: "Office server" } })))
          .detail,
        "does not match the node directory",
      );
      assert.include(
        (yield* refusal(copyPlan(), { nodes: "unavailable" })).detail,
        "no directory of other nodes",
      );
      assert.include(
        (yield* refusal(copyPlan({ destination: { kind: "path", path: "~/Code/../etc" } }))).detail,
        "must not contain '..'",
      );
      const shared = yield* refusal(
        copyPlan({
          followUpThread: {
            title: "Finish",
            prompt: "Go",
            runtimeMode: "approval-required",
            envMode: "local",
            modelSelection: null,
          },
        }),
        { envMode: "worktree" },
      );
      assert.strictEqual(shared.reason, "worktree-escalation");
    }),
  );

  it.effect("revalidates at execution without the submission-only label check", () =>
    Effect.gen(function* () {
      const principal = yield* submit(copyPlan());
      const renamed = makeValidator({
        nodes: [directoryEntry({ environmentId: miniNode, label: "Mac mini (office)" })],
      });
      yield* renamed.revalidateExecution(proposalOf(copyPlan(), principal));
      const gone = yield* Effect.flip(
        makeValidator({ nodes: [] }).revalidateExecution(proposalOf(copyPlan(), principal)),
      );
      assert.include(gone.detail, "not in this node's directory");
    }),
  );
});

describe("cross-node plans and other principals", () => {
  const integration = {
    integrationId: AgentControlIntegrationId.make("integration-1"),
    displayName: "CI",
    capabilities: [],
    projectScope: { kind: "all" },
  } as unknown as AgentControlExternalIntegration;

  it.effect("external integrations can neither propose nor execute either kind", () =>
    Effect.gen(function* () {
      const validator = makeValidator();
      for (const plan of [importPlan(), copyPlan()]) {
        const refused = yield* Effect.flip(
          validator.validateExternalSubmission({ integration, plan }),
        );
        assert.strictEqual(refused.reason, "privilege-escalation");
        const execution = yield* Effect.flip(
          validator.revalidateExecution(
            proposalOf(plan, {
              kind: "external-integration",
              integrationId: integration.integrationId,
              label: "CI",
              projectId,
              runtimeMode: "approval-required",
              envMode: "worktree",
            }),
          ),
        );
        assert.strictEqual(execution.reason, "privilege-escalation");
      }
    }),
  );
});
