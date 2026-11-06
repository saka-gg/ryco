/**
 * Private-session tools for setting projects up: on this node from a repository
 * (`importProject`, which this node executes once the user approves it) and on another node
 * (`copyProjectToNode`, which the Ryco app the user approves it in runs against that node), plus
 * the two reads they need: the node directory owner clients publish and this node's code
 * directory. Reads need `nodes.read` / `read`; proposals need `projects.import` /
 * `projects.copy` and exact active-turn authority. Never installed on the external endpoint.
 *
 * `ryco_suggest_project_destination` answers with paths of this node: a documented exception to
 * keeping workspace paths out of tool results, since the agent already runs here.
 * `ryco_list_nodes` adds what owner clients published about other nodes (their code directory,
 * where this chat's repository already is there): the user's own non-secret folder names, so an
 * agent can avoid copying to a node that has the project. A copy's destination is still resolved
 * by the approving app.
 *
 * @module agentControl/Mcp/projectCopyTools
 */
import { createHash } from "node:crypto";
import path from "node:path";

import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_PROJECT_COPY_MCP_TOOLS,
  AGENT_CONTROL_TITLE_MAX_CHARS,
  AgentControlCopyProjectDestination,
  AgentControlCopyProjectToNodePlan,
  AgentControlImportProjectPlan,
  AgentControlMcpListNodesInput,
  AgentControlMcpSuggestProjectDestinationInput,
  AgentControlMcpSuggestProjectDestinationResult,
  AgentControlPrompt,
  AgentControlRequestId,
  AgentControlTitle,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadEnvMode,
  rejectExcessProperties,
  type AgentControlCapability,
  type AgentControlNodeDirectoryListEntry,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import {
  GitBranchName,
  PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES,
  ProjectCopyRemoteUrl,
  ProjectSetupCommand,
  type ProjectCopyError,
} from "@ryco/contracts/project-copy";
import { isChatProject } from "@ryco/shared/projectKind";
import { setupProjectScript } from "@ryco/shared/projectScripts";
import { Effect, Option, Schema } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { GitNetworkShape } from "../../projectCopy/Services/GitNetwork.ts";
import type { NodePathsShape } from "../../projectCopy/Services/NodePaths.ts";
import {
  describeProjectDestinationProblem,
  projectCopyFolderNameFromRemote,
} from "../projectCopyControl.ts";
import { agentControlThreadEnvMode } from "../Services/AgentControlActionValidator.ts";
import type { AgentControlNodeDirectoryShape } from "../Services/AgentControlNodeDirectory.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import { modelSelectionSchema } from "./modelSelectionToolSchema.ts";
import { ToolFailure } from "./toolFailure.ts";
// Types only: a static import of the boot-loaded tool modules would split them into extra boot
// chunks, so the mutation helpers come in through `ProjectCopyToolDeps.mutations`.
import type {
  AgentControlMcpToolDeps,
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
  replayedAgentControlMutation,
  submitAgentControlMutation,
} from "./tools.ts";

const TOOLS = AGENT_CONTROL_PROJECT_COPY_MCP_TOOLS;

/** What to do when no other node is known (spec): the directory comes from the user's apps. */
export const EMPTY_NODE_DIRECTORY_HINT =
  "No other nodes are known here. Open Ryco on a device connected to that node so it can publish its node list.";

// ── Inputs (server-only: they never reach clients) ────────────────────

const FollowUpThreadInput = Schema.Struct({
  title: Schema.optional(AgentControlTitle),
  prompt: AgentControlPrompt,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  envMode: Schema.optional(ThreadEnvMode),
}).pipe(rejectExcessProperties);
type FollowUpThreadInput = typeof FollowUpThreadInput.Type;

const ProposeImportInput = Schema.Struct({
  requestId: AgentControlRequestId,
  remoteUrl: ProjectCopyRemoteUrl,
  title: Schema.optional(AgentControlTitle),
  branch: Schema.optional(Schema.NullOr(GitBranchName)),
  destination: Schema.optional(AgentControlCopyProjectDestination),
  setup: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        command: ProjectSetupCommand,
        saveAsScript: Schema.optional(Schema.Boolean),
      }).pipe(rejectExcessProperties),
    ),
  ),
  followUpThread: Schema.optional(Schema.NullOr(FollowUpThreadInput)),
}).pipe(rejectExcessProperties);

const ProposeCopyInput = Schema.Struct({
  requestId: AgentControlRequestId,
  source: Schema.optional(
    Schema.Union([
      Schema.Struct({ projectId: ProjectId }).pipe(rejectExcessProperties),
      Schema.Struct({
        remoteUrl: ProjectCopyRemoteUrl,
        title: Schema.optional(AgentControlTitle),
      }).pipe(rejectExcessProperties),
    ]),
  ),
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  destination: Schema.optional(AgentControlCopyProjectDestination),
  bringCommits: Schema.optional(Schema.Boolean),
  bringChanges: Schema.optional(Schema.Boolean),
  copySettings: Schema.optional(Schema.Boolean),
  branch: Schema.optional(Schema.NullOr(GitBranchName)),
  setup: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        command: Schema.optional(ProjectSetupCommand),
        saveAsScript: Schema.optional(Schema.Boolean),
      }).pipe(rejectExcessProperties),
    ),
  ),
  followUpThread: Schema.optional(Schema.NullOr(FollowUpThreadInput)),
}).pipe(rejectExcessProperties);

// ── Descriptors ───────────────────────────────────────────────────────

const requestIdProperty = { type: "string", minLength: 1, maxLength: 128 } as const;
const remoteUrlProperty = {
  type: "string",
  minLength: 1,
  maxLength: 2048,
  description:
    "The repository's https or ssh URL (https://host/owner/repo.git, git@host:owner/repo.git). Never put a password or token in it.",
} as const;
const titleProperty = { type: "string", minLength: 1, maxLength: AGENT_CONTROL_TITLE_MAX_CHARS };
const runtimeModeProperty = {
  type: "string",
  enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
  description: "At most this chat's own runtime mode. Defaults to it.",
} as const;
const destinationProperty = (where: string) =>
  ({
    description: `Where the folder goes on ${where}. Defaults to {kind:"default"}: the node's normal code directory, in a folder named after the project or repository.`,
    anyOf: [
      {
        type: "object",
        properties: { kind: { const: "default" } },
        required: ["kind"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "child-of-default" },
          name: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            description: "Folder name inside the normal code directory.",
          },
        },
        required: ["kind", "name"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "path" },
          path: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
            description: "Absolute folder path, or one starting with ~/.",
          },
        },
        required: ["kind", "path"],
        additionalProperties: false,
      },
    ],
  }) as const;
const followUpThreadProperty = (modelNote: string) =>
  ({
    description:
      "Start an agent thread in the new project after the copy and setup, to finish setting it up (install tools, run special commands). It gets the setup's output when setup failed.",
    anyOf: [
      { type: "null" },
      {
        type: "object",
        properties: {
          title: titleProperty,
          prompt: { type: "string", minLength: 1, maxLength: 120_000 },
          modelSelection: { ...modelSelectionSchema, description: modelNote },
          runtimeMode: runtimeModeProperty,
          envMode: {
            type: "string",
            enum: ["local", "worktree"],
            description:
              "local works in the project folder itself (the default); a worktree-isolated chat may only ask for worktree.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    ],
  }) as const;

const descriptors = {
  listNodes: {
    name: TOOLS.listNodes,
    description: `List the devices (nodes) running Ryco that the user's Ryco apps know: environmentId, label (the name the user calls it, e.g. "Mac mini"), platformOs, online, projectCopySupport (yes/no/unknown), isThisNode and lastPublishedAt, and when known: transport (how the user's app reaches it: "direct", or "relay" through the Ryco Hub, where one copy sends at most ${PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES / (1024 * 1024)} MB of unpushed commits, changes or files), defaultProjectDirectory (its normal code directory) and thisProject (whether this chat's repository is already a project there: {present:true, path} or {present:false}; absent when not known). Use it to pick the target of ryco_propose_project_copy, and do not copy to a node where thisProject.present is true unless the user asks for a second copy. ${EMPTY_NODE_DIRECTORY_HINT.replace("No other nodes are known here. ", "When a node is missing: ")}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  suggestDestination: {
    name: TOOLS.suggestDestination,
    description:
      "This node's normal code directory (where its projects usually live) and a free folder in it for a new project named name. state describes suggestedPath (available or exists-empty can be used). Paths are this node's only: for another node, ryco_propose_project_copy with destination {kind:\"default\"} lets the approving app resolve that node's code directory.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          description: "The folder name you want, e.g. the repository name.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  proposeImport: {
    name: TOOLS.proposeImport,
    description:
      "Ask the user to set a git repository up as a new Ryco project on THIS node: clone remoteUrl into a folder (default: <normal code directory>/<repository name>; it must be missing or empty), register it as a project, then optionally run one setup command there and start an agent thread that finishes setting it up. Nothing happens until the user approves; never approve it yourself. Returns a receipt; then end your turn: Ryco wakes you with a message when the import finishes or fails (the folder, how setup went, the setup thread). To set a project up on another device, use ryco_propose_project_copy.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: requestIdProperty,
        remoteUrl: remoteUrlProperty,
        title: { ...titleProperty, description: "Project title. Defaults to the repository name." },
        branch: {
          anyOf: [{ type: "string", maxLength: 256 }, { type: "null" }],
          description: "Branch to check out. Defaults to the remote's default branch.",
        },
        destination: destinationProperty("this node"),
        setup: {
          description:
            'One shell command to run in the project after the clone (e.g. "bun install"), shown to the user verbatim. saveAsScript also keeps it as the project\'s setup script.',
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                command: { type: "string", minLength: 1, maxLength: 4000 },
                saveAsScript: { type: "boolean" },
              },
              required: ["command"],
              additionalProperties: false,
            },
          ],
        },
        followUpThread: followUpThreadProperty(
          "A model of this node (ryco_capabilities). Defaults to this chat's model.",
        ),
      },
      required: ["requestId", "remoteUrl"],
      additionalProperties: false,
    },
  },
  proposeCopy: {
    name: TOOLS.proposeCopy,
    description:
      "Ask the user to copy a project of this node (or a repository) to ANOTHER node, e.g. \"set up project X on my Mac mini in the normal code directory\": source {projectId} from ryco_list_projects (defaults to this chat's project) or {remoteUrl}, target = the node's environmentId or label from ryco_list_nodes, destination {kind:\"default\"} for the target's normal code directory. The target clones from the project's remote; like the copy dialog, it also sends unpushed commits (bringCommits) and uncommitted changes (bringChanges) by default, and copySettings (default true for a project) its scripts, system prompt, avatar and overrides. branch checks out another branch from the remote instead (then bringCommits and bringChanges default to false). A project that is a plain folder (not a git repository) has no remote: its files are sent node to node instead (dependency folders like node_modules and .env files stay behind); bringChanges must stay true for that, and branch does not apply. setup runs a command on the target after the copy: give command, or {} to use the project's setup script. followUpThread starts an agent there to finish setup. The Ryco app the user approves it in runs the copy and reports back; nothing happens before that, and never approve it yourself. Returns a receipt; then end your turn: Ryco wakes you with a message when the copy finishes or fails (the folder on the target, how setup went, the setup thread).",
    inputSchema: {
      type: "object",
      properties: {
        requestId: requestIdProperty,
        source: {
          anyOf: [
            {
              type: "object",
              properties: { projectId: { type: "string", minLength: 1, maxLength: 256 } },
              required: ["projectId"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { remoteUrl: remoteUrlProperty, title: titleProperty },
              required: ["remoteUrl"],
              additionalProperties: false,
            },
          ],
        },
        target: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "The node's environmentId, or its label (a unique, case-insensitive match against ryco_list_nodes).",
        },
        destination: destinationProperty("the target node"),
        bringCommits: {
          type: "boolean",
          description:
            "Also send commits not on any remote. Default true for a project (false with branch or a repository source), as in the copy dialog; nothing is sent when there are none.",
        },
        bringChanges: {
          type: "boolean",
          description:
            "Also send uncommitted changes. Default true for a project (false with branch or a repository source), as in the copy dialog; nothing is sent when there are none.",
        },
        branch: {
          anyOf: [{ type: "string", maxLength: 256 }, { type: "null" }],
          description:
            "Branch to check out on the target, as the remote has it. Defaults to the source project's current branch, or the repository's default branch.",
        },
        copySettings: {
          type: "boolean",
          description:
            "Copy the project's scripts, system prompt, avatar and overrides. Default true for a project.",
        },
        setup: {
          description:
            "Run one shell command on the target after the copy, shown to the user verbatim. Omit command to use the project's setup script. saveAsScript keeps the command as the copy's setup script.",
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                command: { type: "string", minLength: 1, maxLength: 4000 },
                saveAsScript: { type: "boolean" },
              },
              additionalProperties: false,
            },
          ],
        },
        followUpThread: followUpThreadProperty(
          "A model of the TARGET node. Omit it to use the target's default model, which the user sees before approving.",
        ),
      },
      required: ["requestId", "target"],
      additionalProperties: false,
    },
  },
} satisfies Record<keyof typeof TOOLS, AgentControlMcpToolDescriptor>;

const ALL = Object.values(descriptors);
const WRITE_TOOLS = new Set<string>([TOOLS.proposeImport, TOOLS.proposeCopy]);

/** The grant each tool needs (A20): its own write capabilities, never the external ones. */
export const projectCopyCapabilityForTool = (name: string): AgentControlCapability | null => {
  switch (name) {
    case TOOLS.listNodes:
      return AGENT_CONTROL_CAPABILITIES.readNodes;
    case TOOLS.suggestDestination:
      return AGENT_CONTROL_CAPABILITIES.read;
    case TOOLS.proposeImport:
      return AGENT_CONTROL_CAPABILITIES.importProject;
    case TOOLS.proposeCopy:
      return AGENT_CONTROL_CAPABILITIES.copyProjectToNode;
    default:
      return null;
  }
};

const result = (value: unknown): AgentControlMcpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const errorResult = (text: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const copyFailure = (error: ProjectCopyError) => new ToolFailure(error.message.slice(0, 500));

/**
 * What a publisher said about the node beyond its identity: how it is reached, its code
 * directory, and whether the caller's repository (`repositoryKey`) is a project there. This node
 * is the agent's own, so only its transport is left out (the agent runs on it).
 */
export const listedNodeExtras = (
  node: AgentControlNodeDirectoryListEntry,
  repositoryKey: string | null,
) => {
  const match =
    repositoryKey === null || node.projects === undefined
      ? undefined
      : node.projects.find((project) => project.repositoryCanonicalKey === repositoryKey);
  return {
    ...(node.transport === undefined || node.isThisNode ? {} : { transport: node.transport }),
    ...(node.defaultProjectDirectory === undefined
      ? {}
      : { defaultProjectDirectory: node.defaultProjectDirectory }),
    ...(repositoryKey === null || node.projects === undefined || node.isThisNode
      ? {}
      : {
          thisProject:
            match === undefined ? { present: false } : { present: true, path: match.path },
        }),
  };
};

const describeNode = (node: AgentControlNodeDirectoryListEntry) =>
  `"${node.label}" (${node.environmentId}${node.isThisNode ? ", this node" : node.online ? ", online" : ", offline"})`;

export interface ProjectCopyToolDeps extends Pick<
  AgentControlMcpToolDeps,
  "validator" | "proposals"
> {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getProjectShellById"
  >;
  /** Without it, listing nodes and proposing copies fail clearly. */
  readonly nodeDirectory?: Pick<AgentControlNodeDirectoryShape, "list">;
  /** Without it, destination suggestions and imports fail clearly. */
  readonly nodePaths?: Pick<
    NodePathsShape,
    "resolveCodeRoots" | "previewDestination" | "judgeProjectDestination"
  >;
  /** Strips credentials from agent-given URLs before they enter a plan. */
  readonly gitNetwork?: Pick<GitNetworkShape, "sanitizeRemoteUrl">;
  /** The shared submit and replay of `./tools.ts`, passed in by the loader. */
  readonly mutations: {
    readonly submit: typeof submitAgentControlMutation;
    readonly replay: typeof replayedAgentControlMutation;
  };
}

/** Private, provider-session tools only. Same wrapper pattern as the local task tools. */
export function withProjectCopyTools(
  base: AgentControlMcpTools,
  deps: ProjectCopyToolDeps,
): AgentControlMcpTools {
  const owns = (name: string) => ALL.some((descriptor) => descriptor.name === name);
  const capabilityFor = (name: string) =>
    projectCopyCapabilityForTool(name) ?? AGENT_CONTROL_CAPABILITIES.read;

  const authorize = (
    session: AgentControlSessionRecord,
    name: string,
    turnId?: AgentControlTurnAuthority["turnId"],
  ) =>
    deps.policy
      .authorize({
        principal: {
          kind: "provider-session",
          threadId: session.threadId,
          providerInstanceId: session.providerInstanceId,
          runtimeSessionId: session.runtimeSessionId,
          ...(turnId === undefined ? {} : { turnId }),
        },
        grantedCapabilities: session.grantedCapabilities,
        requiredCapability: capabilityFor(name),
        operation: `mcp:${name}`,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "AgentControlDisabledError"
            ? new ToolFailure("Agent Control is disabled.")
            : new ToolFailure("Capability denied."),
        ),
      );
  /** The caller's exact active turn, or a failure: proposals need it. */
  const requireAuthority = (session: AgentControlSessionRecord, name: string) =>
    Effect.gen(function* () {
      const authority = Option.filter(
        yield* deps.registry.getTurnAuthority(session.sessionId),
        (value) => value.sessionId === session.sessionId && value.threadId === session.threadId,
      );
      if (Option.isNone(authority))
        return yield* Effect.fail(
          new ToolFailure("Exact active-turn write authority is unavailable."),
        );
      yield* authorize(session, name, authority.value.turnId);
      return authority.value;
    });
  const decode = <S extends Schema.Top>(schema: S, args: unknown) =>
    Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
      Effect.mapError(() => new ToolFailure("Invalid tool arguments.")),
    ) as Effect.Effect<S["Type"], ToolFailure>;
  /** A plan built from the tool's input, decoded so every bound and brand of the contract holds. */
  const buildPlan = <S extends Schema.Top>(schema: S, plan: unknown) =>
    Schema.decodeUnknownEffect(schema)(plan).pipe(
      Effect.mapError(
        () =>
          new ToolFailure(
            "The request does not fit a project request (a name, title or command is too long or invalid).",
          ),
      ),
    ) as Effect.Effect<S["Type"], ToolFailure>;

  const requireNodePaths = () =>
    deps.nodePaths === undefined
      ? Effect.fail(new ToolFailure("Project folders cannot be checked on this node."))
      : Effect.succeed(deps.nodePaths);

  const listDirectory = () =>
    deps.nodeDirectory === undefined
      ? Effect.fail(new ToolFailure("This node keeps no directory of other nodes."))
      : deps.nodeDirectory
          .list()
          .pipe(
            Effect.mapError(
              (error) =>
                new ToolFailure(
                  error.reason === "unavailable"
                    ? "This node keeps no directory of other nodes."
                    : "The node directory could not be read.",
                ),
            ),
          );

  const callerThread = (session: AgentControlSessionRecord) =>
    deps.projections.getThreadShellById(session.threadId).pipe(
      Effect.mapError(() => new ToolFailure("This thread is unavailable.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ToolFailure("This thread is unavailable.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** Agent-given URLs lose any username token before they are stored and shown (A13). */
  const sanitizeRemote = (remoteUrl: string) =>
    deps.gitNetwork === undefined
      ? Effect.fail(new ToolFailure("Repository URLs cannot be checked on this node."))
      : Effect.try({
          try: () => deps.gitNetwork!.sanitizeRemoteUrl(remoteUrl),
          catch: () => new ToolFailure("Repository URLs cannot be checked on this node."),
        });

  const folderNameFromRemote = (remoteUrl: string) => {
    const name = projectCopyFolderNameFromRemote(remoteUrl);
    return name === null
      ? Effect.fail(
          new ToolFailure(
            'No folder name follows from the URL; pass destination {kind:"child-of-default", name}.',
          ),
        )
      : Effect.succeed(name);
  };

  const followUpThreadFor = (
    input: FollowUpThreadInput,
    caller: OrchestrationThreadShell,
    projectTitle: string,
    modelSelection: ModelSelection | null,
  ) => ({
    title:
      input.title ??
      `Finish setting up ${projectTitle}`.slice(0, AGENT_CONTROL_TITLE_MAX_CHARS).trim(),
    prompt: input.prompt,
    runtimeMode: input.runtimeMode ?? caller.runtimeMode,
    envMode: input.envMode ?? agentControlThreadEnvMode(caller),
    modelSelection,
  });

  /** The repository identity of the calling chat's project; null for none (or a chat). */
  const callerRepositoryKey = (session: AgentControlSessionRecord) =>
    Effect.gen(function* () {
      const thread = yield* callerThread(session);
      const project = yield* deps.projections.getProjectShellById(thread.projectId);
      return Option.isNone(project) || isChatProject(project.value)
        ? null
        : (project.value.repositoryIdentity?.canonicalKey ?? null);
    }).pipe(Effect.orElseSucceed(() => null));

  const listNodes = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* decode(AgentControlMcpListNodesInput, args);
      const directory = yield* listDirectory();
      const repositoryKey = yield* callerRepositoryKey(session);
      const nodes = directory.nodes.map((node) => ({
        environmentId: node.environmentId,
        label: node.label,
        platformOs: node.platformOs,
        online: node.online,
        projectCopySupport: node.projectCopySupport,
        isThisNode: node.isThisNode,
        lastPublishedAt: node.lastPublishedAt,
        ...listedNodeExtras(node, repositoryKey),
      }));
      return nodes.some((node) => !node.isThisNode)
        ? { nodes }
        : { nodes, hint: EMPTY_NODE_DIRECTORY_HINT };
    });

  const suggestDestination = (args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decode(AgentControlMcpSuggestProjectDestinationInput, args);
      const nodePaths = yield* requireNodePaths();
      const roots = yield* nodePaths.resolveCodeRoots().pipe(Effect.mapError(copyFailure));
      const candidate = yield* nodePaths
        .previewDestination({ path: path.join(roots.defaultProjectDirectory, input.name) })
        .pipe(Effect.mapError(copyFailure));
      // `state` describes the folder suggested: the free alternative when the name is taken.
      const suggested =
        candidate.state === "available" ||
        candidate.state === "exists-empty" ||
        candidate.suggestedPath === null
          ? candidate
          : yield* nodePaths
              .previewDestination({ path: candidate.suggestedPath })
              .pipe(Effect.mapError(copyFailure));
      return Schema.encodeSync(AgentControlMcpSuggestProjectDestinationResult)({
        defaultProjectDirectory: roots.defaultProjectDirectory,
        suggestedPath: suggested.resolvedPath,
        state: suggested.state,
      });
    });

  /**
   * The canonical folder on this node a new clone would take, with why it may not (null: it
   * may). The problem is checked only after a replay is ruled out: once the request ran, its
   * folder holds the project.
   */
  const resolveLocalDestination = (
    destination: AgentControlCopyProjectDestination,
    remoteUrl: string,
  ) =>
    Effect.gen(function* () {
      const nodePaths = yield* requireNodePaths();
      const requested =
        destination.kind === "path"
          ? destination.path
          : path.join(
              (yield* nodePaths.resolveCodeRoots().pipe(Effect.mapError(copyFailure)))
                .defaultProjectDirectory,
              destination.kind === "child-of-default"
                ? destination.name
                : yield* folderNameFromRemote(remoteUrl),
            );
      const judgement = yield* nodePaths
        .judgeProjectDestination({ path: requested, intent: "create" })
        .pipe(Effect.mapError(copyFailure));
      const problem = judgement.usable
        ? null
        : new ToolFailure(describeProjectDestinationProblem(judgement.preview).slice(0, 500));
      if (judgement.canonicalPath === null)
        return yield* Effect.fail(problem ?? new ToolFailure("The folder cannot be resolved."));
      return { canonicalPath: judgement.canonicalPath, problem };
    });

  /**
   * Submits `plan`, unless it replays the caller's earlier request of the same id: then its
   * receipt answers (the same id with another plan is refused). `problem` (the request could not
   * start now) fails only a new request.
   */
  const submitOrReplay = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    requestId: AgentControlRequestId,
    plan: AgentControlImportProjectPlan | AgentControlCopyProjectToNodePlan,
    problem: ToolFailure | null = null,
  ) =>
    Effect.gen(function* () {
      const replayed = yield* deps.mutations.replay(deps.proposals, session, requestId, plan);
      if (Option.isSome(replayed)) return replayed.value;
      if (problem !== null) return yield* Effect.fail(problem);
      return yield* deps.mutations.submit(deps, { session, authority, requestId, plan });
    });

  /** One project per request: a retry of the same request builds the same plan. */
  const projectIdFor = (session: AgentControlSessionRecord, requestId: string) =>
    `project-agent-${createHash("sha256")
      .update(JSON.stringify([session.threadId, requestId]))
      .digest("hex")
      .slice(0, 32)}`;

  const proposeImport = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decode(ProposeImportInput, args);
      const caller = yield* callerThread(session);
      const remoteUrl = yield* sanitizeRemote(input.remoteUrl);
      const destination = yield* resolveLocalDestination(
        input.destination ?? { kind: "default" },
        remoteUrl,
      );
      const title = input.title ?? (yield* folderNameFromRemote(remoteUrl));
      const followUp = input.followUpThread ?? null;
      const plan = yield* buildPlan(AgentControlImportProjectPlan, {
        kind: "importProject",
        projectId: projectIdFor(session, input.requestId),
        title,
        destinationPath: destination.canonicalPath,
        remoteUrl,
        branch: input.branch ?? null,
        setup:
          input.setup == null
            ? null
            : { command: input.setup.command, saveAsScript: input.setup.saveAsScript ?? false },
        followUpThread:
          followUp === null
            ? null
            : followUpThreadFor(
                followUp,
                caller,
                title,
                followUp.modelSelection ?? caller.modelSelection,
              ),
      });
      return yield* submitOrReplay(session, authority, input.requestId, plan, destination.problem);
    });

  /** The directory entry `target` names: its environment id, else a unique label match. */
  const resolveTarget = (target: string) =>
    Effect.gen(function* () {
      const nodes = (yield* listDirectory()).nodes;
      const others = nodes.filter((node) => !node.isThisNode);
      if (others.length === 0 && !nodes.some((node) => node.environmentId === target))
        return yield* Effect.fail(new ToolFailure(EMPTY_NODE_DIRECTORY_HINT));
      const wanted = target.trim().toLowerCase();
      const byId = nodes.filter((node) => node.environmentId === target);
      const byLabel = nodes.filter((node) => node.label.trim().toLowerCase() === wanted);
      const byPartialLabel = nodes.filter((node) => node.label.toLowerCase().includes(wanted));
      const matches = byId.length > 0 ? byId : byLabel.length > 0 ? byLabel : byPartialLabel;
      if (matches.length === 0)
        return yield* Effect.fail(
          new ToolFailure(
            `No node matches "${target}". Known nodes: ${others.map(describeNode).join(", ")}.`.slice(
              0,
              1_000,
            ),
          ),
        );
      if (matches.length > 1)
        return yield* Effect.fail(
          new ToolFailure(
            `"${target}" matches ${matches.length} nodes: ${matches.map(describeNode).join(", ")}. Pass the environmentId of the one you mean.`.slice(
              0,
              1_000,
            ),
          ),
        );
      const node = matches[0]!;
      if (node.isThisNode)
        return yield* Effect.fail(
          new ToolFailure(
            `${node.label} is this node; set the repository up here with ${TOOLS.proposeImport}.`,
          ),
        );
      if (node.projectCopySupport === "no")
        return yield* Effect.fail(
          new ToolFailure(`Update Ryco on ${node.label} to copy projects there.`),
        );
      return { environmentId: node.environmentId, label: node.label };
    });

  const proposeCopy = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decode(ProposeCopyInput, args);
      const caller = yield* callerThread(session);
      const repository =
        input.source !== undefined && "remoteUrl" in input.source ? input.source : null;
      const project =
        repository !== null
          ? null
          : yield* deps.projections
              .getProjectShellById(
                input.source !== undefined && "projectId" in input.source
                  ? input.source.projectId
                  : caller.projectId,
              )
              .pipe(
                Effect.mapError(() => new ToolFailure("The project is unavailable.")),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new ToolFailure(
                          "The project is unavailable. Use ryco_list_projects for project ids.",
                        ),
                      ),
                    onSome: Effect.succeed,
                  }),
                ),
              );
      if (project !== null && isChatProject(project))
        return yield* Effect.fail(
          new ToolFailure("A chat cannot be copied to another node; turn it into a project first."),
        );
      const source =
        project !== null
          ? {
              kind: "project" as const,
              projectId: project.id,
              title: project.title.slice(0, AGENT_CONTROL_TITLE_MAX_CHARS).trim(),
              expectedUpdatedAt: project.updatedAt,
            }
          : {
              kind: "repository" as const,
              remoteUrl: yield* sanitizeRemote(repository!.remoteUrl),
              title: repository!.title ?? (yield* folderNameFromRemote(repository!.remoteUrl)),
            };
      const target = yield* resolveTarget(input.target);
      // The exact command is pinned in the plan (A18): the project's setup script as it is now.
      const setupCommand =
        input.setup == null
          ? null
          : (input.setup.command ??
            (project === null ? undefined : setupProjectScript(project.scripts)?.command));
      if (input.setup != null && setupCommand === undefined)
        return yield* Effect.fail(
          new ToolFailure(
            project === null
              ? "A repository has no setup script; give setup.command."
              : "The project has no setup script; give setup.command.",
          ),
        );
      const followUp = input.followUpThread ?? null;
      const plan = yield* buildPlan(AgentControlCopyProjectToNodePlan, {
        kind: "copyProjectToNode",
        source,
        target,
        destination: input.destination ?? { kind: "default" },
        // The copy dialog's defaults for a project; another branch leaves its own work behind,
        // and a repository has none.
        bringCommits: input.bringCommits ?? (project !== null && input.branch == null),
        bringChanges: input.bringChanges ?? (project !== null && input.branch == null),
        copySettings: input.copySettings ?? project !== null,
        // Only when given, so a plan without one keeps the digest it always had.
        ...(input.branch == null ? {} : { branch: input.branch }),
        setup:
          setupCommand === null || setupCommand === undefined
            ? null
            : { command: setupCommand, saveAsScript: input.setup?.saveAsScript ?? false },
        followUpThread:
          followUp === null
            ? null
            : followUpThreadFor(followUp, caller, source.title, followUp.modelSelection ?? null),
      });
      return yield* submitOrReplay(session, authority, input.requestId, plan);
    });

  const run = (
    session: AgentControlSessionRecord,
    name: string,
    args: unknown,
  ): Effect.Effect<unknown, ToolFailure> => {
    if (name === TOOLS.listNodes)
      return authorize(session, name).pipe(Effect.andThen(listNodes(session, args)));
    if (name === TOOLS.suggestDestination)
      return authorize(session, name).pipe(Effect.andThen(suggestDestination(args)));
    return requireAuthority(session, name).pipe(
      Effect.flatMap((authority): Effect.Effect<unknown, ToolFailure> => {
        switch (name) {
          case TOOLS.proposeImport:
            return proposeImport(session, authority, args);
          case TOOLS.proposeCopy:
            return proposeCopy(session, authority, args);
          default:
            return Effect.fail(new ToolFailure("Unknown tool."));
        }
      }),
    );
  };

  return {
    ...base,
    descriptors: [...base.descriptors, ...ALL],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled)) return tools;
        return [
          ...tools,
          ...ALL.filter((descriptor) =>
            session.grantedCapabilities.includes(capabilityFor(descriptor.name)),
          ),
        ];
      }),
    hasTool: (name) => owns(name) || base.hasTool(name),
    isWriteTool: (name) => WRITE_TOOLS.has(name) || base.isWriteTool(name),
    callTool: (session, name, args) =>
      owns(name)
        ? run(session, name, args).pipe(
            Effect.map(result),
            Effect.catch((failure) => Effect.succeed(errorResult(failure.reason))),
          )
        : base.callTool(session, name, args),
  };
}
