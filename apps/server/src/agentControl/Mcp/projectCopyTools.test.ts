import { assert, describe, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_PROJECT_COPY_MCP_TOOLS,
  AgentControlProposal,
  EnvironmentId,
  OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  WorktreeId,
  type AgentControlActionPlan,
  type AgentControlCapability,
  type AgentControlCopyProjectToNodePlan,
  type AgentControlImportProjectPlan,
  type AgentControlNodeDirectoryListEntry,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import type { ProjectDestinationPreview } from "@ryco/contracts/project-copy";
import { Context, Effect, Layer, Option, PubSub, Redacted, Schema } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlPolicyLive } from "../Layers/AgentControlPolicy.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import { AgentControlSessionRegistryLive } from "../Layers/AgentControlSessionRegistry.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import {
  AgentControlSessionRegistry,
  type AgentControlIssuedLease,
  type AgentControlSessionRecord,
} from "../Services/AgentControlSessionRegistry.ts";
import { makeAgentControlMcpListener } from "./listener.ts";
import { EMPTY_NODE_DIRECTORY_HINT, withProjectCopyTools } from "./projectCopyTools.ts";
import {
  makeAgentControlMcpTools,
  type AgentControlMcpToolResult,
  type AgentControlMcpTools,
} from "./tools.ts";

const TOOLS = AGENT_CONTROL_PROJECT_COPY_MCP_TOOLS;
const now = "2026-10-22T09:00:00.000Z";
const projectId = ProjectId.make("project-1");
const chatId = ProjectId.make("chat-1");
const thisNode = EnvironmentId.make("env-this");
const miniNode = EnvironmentId.make("env-mini");

const ALL_GRANTS = [
  AGENT_CONTROL_CAPABILITIES.read,
  AGENT_CONTROL_CAPABILITIES.readNodes,
  AGENT_CONTROL_CAPABILITIES.importProject,
  AGENT_CONTROL_CAPABILITIES.copyProjectToNode,
];
const session = (
  grants: ReadonlyArray<AgentControlCapability> = ALL_GRANTS,
): AgentControlSessionRecord => ({
  sessionId: "lease-caller",
  issuedAt: now,
  threadId: ThreadId.make("caller"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("caller-runtime"),
  grantedCapabilities: grants,
  injectionMode: "codex-http",
});

const project = (id: ProjectId, overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(OrchestrationProjectShell)({
    id,
    title: "Ryco",
    workspaceRoot: "/code/ryco",
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

const callerThread = {
  id: ThreadId.make("caller"),
  projectId,
  title: "Caller",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  runtimeMode: "auto",
  worktreeId: WorktreeId.make("worktree-caller"),
} as unknown as OrchestrationThreadShell;

const entry = (
  value: Partial<AgentControlNodeDirectoryListEntry> & { readonly environmentId: EnvironmentId },
): AgentControlNodeDirectoryListEntry => ({
  label: "Node",
  platformOs: "darwin",
  online: true,
  projectCopySupport: "yes",
  isThisNode: false,
  lastPublishedAt: now,
  ...value,
});

const defaultNodes = [
  entry({ environmentId: thisNode, label: "MacBook", isThisNode: true }),
  entry({ environmentId: miniNode, label: "Mac mini" }),
  entry({
    environmentId: EnvironmentId.make("env-mini-2"),
    label: "Mac mini (studio)",
    online: false,
  }),
  entry({
    environmentId: EnvironmentId.make("env-old"),
    label: "Old box",
    projectCopySupport: "no",
  }),
];

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

/** `/code/taken` and the `occupied` folders exist; everything else under `/code` is free. */
const judge = (path: string, occupied: ReadonlySet<string> = new Set()) =>
  path.endsWith("taken") || occupied.has(path)
    ? preview(path, "exists-not-empty")
    : preview(path, "available");

const proposalFor = (plan: AgentControlActionPlan, requestId = "request") =>
  Schema.decodeUnknownSync(AgentControlProposal)({
    proposalId: "proposal-1",
    requestId,
    principal: { kind: "provider-session", threadId: "caller", providerInstanceId: "codex" },
    planVersion: 1,
    plan,
    planDigest: computeAgentControlPlanDigest(plan),
    riskTags: [],
    promptSummary: null,
    status: "pending-user-approval",
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
    decidedAt: null,
    result: null,
  });

const emptyBase: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.die("unused"),
};

const setup = (
  options: {
    readonly nodes?: ReadonlyArray<AgentControlNodeDirectoryListEntry>;
    readonly authority?: boolean;
  } = {},
) => {
  let enabled = true;
  const submitted: AgentControlActionPlan[] = [];
  /** The caller's requests by id, as the proposal store keeps them. */
  const byRequest = new Map<string, AgentControlProposal>();
  /** Folders a request created since. */
  const occupied = new Set<string>();
  const tools = withProjectCopyTools(emptyBase, {
    policy: {
      isEnabled: Effect.sync(() => enabled),
      authorize: (input) =>
        enabled && input.grantedCapabilities.includes(input.requiredCapability)
          ? Effect.void
          : (Effect.fail({ _tag: "AgentControlCapabilityDeniedError" }) as never),
    },
    registry: {
      getTurnAuthority: (sessionId) =>
        Effect.succeed(
          options.authority === false
            ? Option.none()
            : Option.some({
                sessionId,
                threadId: ThreadId.make("caller"),
                turnId: TurnId.make("caller-turn"),
                boundAt: now,
              }),
        ),
    },
    validator: {
      validateSubmission: (input: { readonly session: AgentControlSessionRecord }) =>
        Effect.succeed({
          kind: "provider-session",
          threadId: input.session.threadId,
          providerInstanceId: input.session.providerInstanceId,
        }),
    } as never,
    proposals: {
      getProposal: () => Effect.die("unused"),
      findByRequest: (_principal: unknown, requestId: string) =>
        Effect.succeed(Option.fromNullishOr(byRequest.get(requestId))),
      submit: (input: { readonly plan: AgentControlActionPlan; readonly requestId: string }) =>
        Effect.sync(() => {
          submitted.push(input.plan);
          const proposal = proposalFor(input.plan, input.requestId);
          byRequest.set(input.requestId, proposal);
          return { proposal, replayed: false };
        }),
    } as never,
    projections: {
      getThreadShellById: () => Effect.succeed(Option.some(callerThread)),
      getProjectShellById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some(project(projectId))
            : id === chatId
              ? Option.some(project(chatId, { kind: "chat" }))
              : Option.none(),
        ),
    },
    nodeDirectory: { list: () => Effect.succeed({ nodes: options.nodes ?? defaultNodes }) },
    nodePaths: {
      resolveCodeRoots: () =>
        Effect.succeed({
          defaultProjectDirectory: "/code",
          defaultProjectDirectorySource: "existing-projects",
          codeRoots: [],
        }),
      previewDestination: ({ path }) => Effect.succeed(judge(path, occupied)),
      judgeProjectDestination: ({ path }) => {
        const verdict = judge(path, occupied);
        const usable = verdict.state === "available";
        return Effect.succeed({
          preview: verdict,
          usable,
          canonicalPath: `/private${path}`,
          projectRoot: usable ? `/private${path}` : null,
          reservationKey: usable ? path : null,
        });
      },
    },
    gitNetwork: { sanitizeRemoteUrl: (url) => url.replace(/^(https?:\/\/)[^@/]+@/u, "$1") },
  });
  const call = (name: string, args: unknown, caller = session()) =>
    tools.callTool(caller, name, args);
  const value = <T = Record<string, unknown>>(result: AgentControlMcpToolResult) => {
    assert.isUndefined(result.isError, result.content[0]?.text);
    return result.structuredContent as T;
  };
  const failure = (result: AgentControlMcpToolResult) => {
    assert.isTrue(result.isError);
    return result.content[0]?.text ?? "";
  };
  return {
    tools,
    call,
    value,
    failure,
    submitted,
    occupied,
    disable: () => (enabled = false),
  };
};

describe("project copy tools", () => {
  it.effect("are offered by grant and never without Agent Control", () =>
    Effect.gen(function* () {
      const harness = setup();
      const names = (grants: ReadonlyArray<AgentControlCapability>) =>
        harness.tools
          .descriptorsFor(session(grants))
          .pipe(Effect.map((tools) => tools.map((tool) => tool.name).toSorted()));
      assert.deepEqual(yield* names([AGENT_CONTROL_CAPABILITIES.readNodes]), [TOOLS.listNodes]);
      assert.deepEqual(yield* names([AGENT_CONTROL_CAPABILITIES.read]), [TOOLS.suggestDestination]);
      assert.deepEqual(yield* names([AGENT_CONTROL_CAPABILITIES.importProject]), [
        TOOLS.proposeImport,
      ]);
      assert.deepEqual(yield* names([AGENT_CONTROL_CAPABILITIES.copyProjectToNode]), [
        TOOLS.proposeCopy,
      ]);
      assert.deepEqual(yield* names(ALL_GRANTS), Object.values(TOOLS).toSorted());
      assert.isTrue(harness.tools.isWriteTool(TOOLS.proposeCopy));
      assert.isTrue(harness.tools.isWriteTool(TOOLS.proposeImport));
      assert.isFalse(harness.tools.isWriteTool(TOOLS.listNodes));
      assert.include(
        harness.failure(yield* harness.call(TOOLS.listNodes, {}, session([]))),
        "Capability denied",
      );
      harness.disable();
      assert.deepEqual(yield* names(ALL_GRANTS), []);
    }),
  );

  it.effect("lists the published nodes, and says what to do when none are known", () =>
    Effect.gen(function* () {
      const harness = setup();
      const listed = harness.value<{
        readonly nodes: ReadonlyArray<Record<string, unknown>>;
        readonly hint?: string;
      }>(yield* harness.call(TOOLS.listNodes, {}));
      assert.lengthOf(listed.nodes, 4);
      assert.deepEqual(listed.nodes[1], {
        environmentId: miniNode,
        label: "Mac mini",
        platformOs: "darwin",
        online: true,
        projectCopySupport: "yes",
        isThisNode: false,
        lastPublishedAt: now,
      });
      assert.isUndefined(listed.hint);
      const lonely = setup({ nodes: [defaultNodes[0]!] });
      assert.strictEqual(
        lonely.value<{ readonly hint: string }>(yield* lonely.call(TOOLS.listNodes, {})).hint,
        EMPTY_NODE_DIRECTORY_HINT,
      );
    }),
  );

  it.effect("suggests a free folder in this node's code directory", () =>
    Effect.gen(function* () {
      const harness = setup();
      assert.deepEqual(
        harness.value(yield* harness.call(TOOLS.suggestDestination, { name: "app" })),
        {
          defaultProjectDirectory: "/code",
          suggestedPath: "/code/app",
          state: "available",
        },
      );
      assert.deepEqual(
        harness.value(yield* harness.call(TOOLS.suggestDestination, { name: "taken" })),
        { defaultProjectDirectory: "/code", suggestedPath: "/code/taken-2", state: "available" },
      );
      assert.include(
        harness.failure(yield* harness.call(TOOLS.suggestDestination, { name: "../etc" })),
        "Invalid tool arguments",
      );
    }),
  );

  it.effect(
    "proposes an import into a resolved folder with a sanitized URL and caller defaults",
    () =>
      Effect.gen(function* () {
        const harness = setup();
        const receipt = harness.value<{ readonly receipt: { readonly actionKind: string } }>(
          yield* harness.call(TOOLS.proposeImport, {
            requestId: "import-1",
            remoteUrl: "https://token123@github.com/me/new-app.git",
            setup: { command: "bun install" },
            followUpThread: { prompt: "Install the toolchain and run the tests." },
          }),
        );
        assert.strictEqual(receipt.receipt.actionKind, "importProject");
        const plan = harness.submitted[0] as AgentControlImportProjectPlan;
        assert.strictEqual(plan.destinationPath, "/private/code/new-app");
        assert.strictEqual(plan.remoteUrl, "https://github.com/me/new-app.git");
        assert.strictEqual(plan.title, "new-app");
        assert.match(plan.projectId, /^project-agent-[0-9a-f]{32}$/);
        assert.deepEqual(plan.setup, { command: "bun install", saveAsScript: false });
        assert.deepEqual(plan.followUpThread, {
          title: "Finish setting up new-app",
          prompt: "Install the toolchain and run the tests.",
          runtimeMode: "auto",
          envMode: "worktree",
          modelSelection: callerThread.modelSelection,
        });
        // A retry of the request, once the import made its folder, answers with its receipt.
        harness.occupied.add("/code/new-app");
        const retried = harness.value<{
          readonly receipt: { readonly actionKind: string };
          readonly replayed: boolean;
        }>(
          yield* harness.call(TOOLS.proposeImport, {
            requestId: "import-1",
            remoteUrl: "https://token123@github.com/me/new-app.git",
            setup: { command: "bun install" },
            followUpThread: { prompt: "Install the toolchain and run the tests." },
          }),
        );
        assert.isTrue(retried.replayed);
        assert.strictEqual(retried.receipt.actionKind, "importProject");
        assert.lengthOf(harness.submitted, 1);
        // The same id for another request is refused; a new id finds the folder taken.
        assert.include(
          harness.failure(
            yield* harness.call(TOOLS.proposeImport, {
              requestId: "import-1",
              remoteUrl: "https://github.com/me/new-app.git",
            }),
          ),
          "different plan",
        );
        assert.include(
          harness.failure(
            yield* harness.call(TOOLS.proposeImport, {
              requestId: "import-1b",
              remoteUrl: "https://github.com/me/new-app.git",
            }),
          ),
          "/code/new-app-2 is free",
        );

        assert.include(
          harness.failure(
            yield* harness.call(TOOLS.proposeImport, {
              requestId: "import-2",
              remoteUrl: "git@github.com:me/app.git",
              destination: { kind: "child-of-default", name: "taken" },
            }),
          ),
          "/code/taken-2 is free",
        );
        assert.include(
          harness.failure(
            yield* setup({ authority: false }).call(TOOLS.proposeImport, {
              requestId: "import-3",
              remoteUrl: "git@github.com:me/app.git",
            }),
          ),
          "active-turn",
        );
      }),
  );

  it.effect("proposes a copy to a node named by label, with the project's pinned setup", () =>
    Effect.gen(function* () {
      const harness = setup();
      const receipt = harness.value<{ readonly receipt: { readonly actionKind: string } }>(
        yield* harness.call(TOOLS.proposeCopy, {
          requestId: "copy-1",
          target: "mac MINI",
          setup: {},
          followUpThread: { prompt: "Finish setting it up." },
        }),
      );
      assert.strictEqual(receipt.receipt.actionKind, "copyProjectToNode");
      const plan = harness.submitted[0] as AgentControlCopyProjectToNodePlan;
      assert.deepEqual(plan.source, {
        kind: "project",
        projectId,
        title: "Ryco",
        expectedUpdatedAt: now,
      });
      assert.deepEqual(plan.target, { environmentId: miniNode, label: "Mac mini" });
      assert.deepEqual(plan.destination, { kind: "default" });
      assert.isFalse(plan.bringCommits);
      assert.isFalse(plan.bringChanges);
      assert.isTrue(plan.copySettings);
      assert.deepEqual(plan.setup, { command: "bun install", saveAsScript: false });
      assert.isNull(plan.followUpThread?.modelSelection);
      // A retry answers with the request's receipt instead of a second request.
      const retried = harness.value<{ readonly replayed: boolean }>(
        yield* harness.call(TOOLS.proposeCopy, {
          requestId: "copy-1",
          target: "mac MINI",
          setup: {},
          followUpThread: { prompt: "Finish setting it up." },
        }),
      );
      assert.isTrue(retried.replayed);
      assert.lengthOf(harness.submitted, 1);

      yield* harness.call(TOOLS.proposeCopy, {
        requestId: "copy-2",
        source: { remoteUrl: "git@github.com:me/tool.git" },
        target: miniNode,
        destination: { kind: "child-of-default", name: "tool" },
      });
      const repository = harness.submitted[1] as AgentControlCopyProjectToNodePlan;
      assert.deepEqual(repository.source, {
        kind: "repository",
        remoteUrl: "git@github.com:me/tool.git",
        title: "tool",
      });
      assert.isFalse(repository.copySettings);
    }),
  );

  it.effect(
    "refuses ambiguous, unknown, unsupported and same-node targets with the candidates",
    () =>
      Effect.gen(function* () {
        const harness = setup();
        const attempt = (target: string, extra: Record<string, unknown> = {}) =>
          harness.call(TOOLS.proposeCopy, { requestId: `copy-${target}`, target, ...extra });
        const ambiguous = harness.failure(yield* attempt("mini"));
        assert.include(ambiguous, '"mini" matches 2 nodes');
        assert.include(ambiguous, '"Mac mini (studio)" (env-mini-2, offline)');
        assert.include(ambiguous, "environmentId");
        const unknown = harness.failure(yield* attempt("Office server"));
        assert.include(unknown, "No node matches");
        assert.include(unknown, '"Old box"');
        assert.notInclude(unknown, "this node)");
        assert.include(harness.failure(yield* attempt("Old box")), "Update Ryco on Old box");
        assert.include(harness.failure(yield* attempt("MacBook")), "is this node");
        assert.include(
          harness.failure(
            yield* setup({ nodes: [] }).call(TOOLS.proposeCopy, {
              requestId: "x",
              target: "Mac mini",
            }),
          ),
          "Open Ryco on a device connected to that node so it can publish its node list",
        );
        assert.include(
          harness.failure(yield* attempt("Mac mini", { source: { projectId: chatId } })),
          "chat cannot be copied",
        );
        assert.include(
          harness.failure(
            yield* attempt("Mac mini", {
              source: { remoteUrl: "git@github.com:me/tool.git" },
              setup: {},
            }),
          ),
          "give setup.command",
        );
        assert.lengthOf(harness.submitted, 0);
      }),
  );
});

describe("project copy tools on the private MCP listener", () => {
  it.live("are listed by grant and answer tools/call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          AgentControlSessionRegistryLive.pipe(
            Layer.provideMerge(AgentControlPolicyLive),
            Layer.provideMerge(
              ServerSettingsService.layerTest({ agentControl: { enabled: true } }),
            ),
          ),
        );
        const registry = Context.get(context, AgentControlSessionRegistry);
        const policy = Context.get(context, AgentControlPolicy);
        const pubsub = yield* PubSub.unbounded<never>();
        const base = makeAgentControlMcpTools({
          policy,
          proposals: { getProposal: () => Effect.succeed(Option.none()) },
          proposalEvents: { subscribe: PubSub.subscribe(pubsub) as never },
          projections: {} as ProjectionSnapshotQueryShape,
          getProviders: Effect.succeed([]),
        });
        const tools = withProjectCopyTools(base, {
          policy,
          registry,
          proposals: { getProposal: () => Effect.succeed(Option.none()) },
          projections: {
            getThreadShellById: () => Effect.succeed(Option.none()),
            getProjectShellById: () => Effect.succeed(Option.none()),
          },
          nodeDirectory: { list: () => Effect.succeed({ nodes: defaultNodes }) },
        });
        const handle = yield* makeAgentControlMcpListener({ registry, tools });
        yield* registry.publishEndpoint({ url: handle.url });
        const lease = Option.getOrThrow(
          yield* registry.issueLease({
            threadId: ThreadId.make("caller"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeSessionId: RuntimeSessionId.make("caller-runtime"),
            capabilities: [AGENT_CONTROL_CAPABILITIES.readNodes],
            injectionMode: "codex-http",
          }),
        ) as AgentControlIssuedLease;
        const rpc = (method: string, params?: unknown) =>
          Effect.promise(async () => {
            const response = await fetch(handle.url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${Redacted.value(lease.credential)}`,
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                ...(params ? { params } : {}),
              }),
            });
            return (await response.json()) as { readonly result: Record<string, unknown> };
          });

        const listed = yield* rpc("tools/list");
        const names = (listed.result.tools as ReadonlyArray<{ readonly name: string }>).map(
          (tool) => tool.name,
        );
        assert.include(names, TOOLS.listNodes);
        assert.notInclude(names, TOOLS.proposeCopy);
        assert.notInclude(names, TOOLS.proposeImport);

        const called = yield* rpc("tools/call", { name: TOOLS.listNodes, arguments: {} });
        const content = called.result.structuredContent as {
          readonly nodes: ReadonlyArray<{ readonly label: string }>;
        };
        assert.isUndefined(called.result.isError);
        assert.deepEqual(
          content.nodes.map((node) => node.label),
          ["MacBook", "Mac mini", "Mac mini (studio)", "Old box"],
        );
      }),
    ),
  );
});
