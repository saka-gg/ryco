import * as Schema from "effect/Schema";

import {
  AgentControlClientExecutorId,
  AgentControlNodeEnvironmentId,
  AgentControlNodeLabel,
  AgentControlProjectSetupOutcome,
  AgentControlProposalId,
  AgentControlProposalReceiptView,
  AgentControlResultMessage,
  AgentControlWorkspaceRoot,
} from "./agentControl.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  rejectExcessProperties,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatformOs } from "./environment.ts";
import {
  ProjectCopyDirectoryName,
  ProjectDestinationState,
  ProjectImportId,
} from "./projectCopyPrimitives.ts";

/**
 * Private-session tools for setting up projects on this node and copying them
 * to other nodes (`importProject` / `copyProjectToNode` proposals and their
 * reads). Like the local task tools, they are not part of
 * `AGENT_CONTROL_MCP_TOOLS` and never reach the external endpoint.
 */
export const AGENT_CONTROL_PROJECT_COPY_MCP_TOOLS = {
  /** The node directory owner clients publish (capability `nodes.read`). */
  listNodes: "ryco_list_nodes",
  /** This node's code directory and a free folder in it (capability `read`). */
  suggestDestination: "ryco_suggest_project_destination",
  /** Builds an `importProject` proposal (capability `projects.import`). */
  proposeImport: "ryco_propose_project_import",
  /** Builds a `copyProjectToNode` proposal (capability `projects.copy`). */
  proposeCopy: "ryco_propose_project_copy",
} as const;

export const AgentControlMcpListNodesInput = Schema.Struct({}).pipe(rejectExcessProperties);
export type AgentControlMcpListNodesInput = typeof AgentControlMcpListNodesInput.Type;

export const AgentControlMcpSuggestProjectDestinationInput = Schema.Struct({
  /** The folder to create under this node's code directory. */
  name: ProjectCopyDirectoryName,
}).pipe(rejectExcessProperties);
export type AgentControlMcpSuggestProjectDestinationInput =
  typeof AgentControlMcpSuggestProjectDestinationInput.Type;

/**
 * Paths of the agent's own node only: a documented exception to keeping
 * workspace paths out of tool results, since the agent already runs there.
 */
export const AgentControlMcpSuggestProjectDestinationResult = Schema.Struct({
  defaultProjectDirectory: Schema.String,
  suggestedPath: Schema.String,
  state: ProjectDestinationState,
});
export type AgentControlMcpSuggestProjectDestinationResult =
  typeof AgentControlMcpSuggestProjectDestinationResult.Type;

// The client-executed copy's reports and the node directory: what
// `agentControl.reportClientExecution` and `agentControl.publishNodeDirectory`
// carry. Both RPCs are in `WsProjectCopyRpcGroup`, so these schemas load with
// the copy RPC client rather than at boot.

// ── Client-executed proposals ─────────────────────────────────────────

export const AgentControlClientExecutionOutcome = Schema.Literals([
  /** The import started on the target; extends the report deadline. */
  "started",
  "completed",
  "failed",
]);
export type AgentControlClientExecutionOutcome = typeof AgentControlClientExecutionOutcome.Type;

export const AGENT_CONTROL_CLIENT_EXECUTION_WARNINGS_MAX = 20;

export const AgentControlClientExecutionResult = Schema.Struct({
  /** Must equal the plan's `target.environmentId`. */
  targetEnvironmentId: AgentControlNodeEnvironmentId,
  projectId: ProjectId,
  workspaceRoot: AgentControlWorkspaceRoot,
  warnings: Schema.Array(AgentControlResultMessage).check(
    Schema.isMaxLength(AGENT_CONTROL_CLIENT_EXECUTION_WARNINGS_MAX),
  ),
  /** How the target's setup command ended; null when none ran, absent when not known. */
  setup: Schema.optional(Schema.NullOr(AgentControlProjectSetupOutcome)),
  /** The setup thread the target's import started, when one started. */
  followUpThreadId: Schema.optional(Schema.NullOr(ThreadId)),
}).pipe(rejectExcessProperties);
export type AgentControlClientExecutionResult = typeof AgentControlClientExecutionResult.Type;

/**
 * Accepted only from the executor the proposal was accepted with, while it is
 * `executing`. Repeating an outcome returns the receipt.
 */
export const AgentControlReportClientExecutionInput = Schema.Struct({
  proposalId: AgentControlProposalId,
  executorId: AgentControlClientExecutorId,
  outcome: AgentControlClientExecutionOutcome,
  importId: Schema.optional(ProjectImportId),
  result: Schema.optional(Schema.NullOr(AgentControlClientExecutionResult)),
  /** Credential-redacted by the node before it is stored. */
  error: Schema.optional(Schema.NullOr(AgentControlResultMessage)),
}).pipe(rejectExcessProperties);
export type AgentControlReportClientExecutionInput =
  typeof AgentControlReportClientExecutionInput.Type;

export const AgentControlReportClientExecutionResult = AgentControlProposalReceiptView;
export type AgentControlReportClientExecutionResult = AgentControlProposalReceiptView;

// ── Node directory ────────────────────────────────────────────────────

export const AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES = 64;

/** Whether a node implements project copy; `unknown` until a client connected to it. */
export const AgentControlNodeProjectCopySupport = Schema.Literals(["yes", "no", "unknown"]);
export type AgentControlNodeProjectCopySupport = typeof AgentControlNodeProjectCopySupport.Type;

/** Projects one directory entry lists, at most. */
export const AGENT_CONTROL_NODE_DIRECTORY_MAX_PROJECTS = 64;
/** Projects one publication lists across all its entries, at most (keeps it one relay frame). */
export const AGENT_CONTROL_NODE_DIRECTORY_MAX_PUBLISHED_PROJECTS = 256;
const AgentControlNodeDirectoryPath = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));

/** How the publishing app reaches the node: directly, or through the Hub's relay. */
export const AgentControlNodeTransport = Schema.Literals(["direct", "relay"]);
export type AgentControlNodeTransport = typeof AgentControlNodeTransport.Type;

/** A repository project the publishing app saw on the node: its identity and folder. */
export const AgentControlNodeDirectoryProject = Schema.Struct({
  repositoryCanonicalKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  path: AgentControlNodeDirectoryPath,
}).pipe(rejectExcessProperties);
export type AgentControlNodeDirectoryProject = typeof AgentControlNodeDirectoryProject.Type;

/** Non-secret facts about one node an owner client knows; never addresses or credentials. */
export const AgentControlNodeDirectoryEntry = Schema.Struct({
  environmentId: AgentControlNodeEnvironmentId,
  label: AgentControlNodeLabel,
  platformOs: ExecutionEnvironmentPlatformOs,
  online: Schema.Boolean,
  projectCopySupport: AgentControlNodeProjectCopySupport,
  /** Absent while the publishing app is not connected to the node. */
  transport: Schema.optionalKey(AgentControlNodeTransport),
  /** The node's normal code directory, when the publishing app has read its path hints. */
  defaultProjectDirectory: Schema.optionalKey(AgentControlNodeDirectoryPath),
  /** The node's repository projects as the publishing app last saw them; absent when unknown. */
  projects: Schema.optionalKey(
    Schema.Array(AgentControlNodeDirectoryProject).check(
      Schema.isMaxLength(AGENT_CONTROL_NODE_DIRECTORY_MAX_PROJECTS),
    ),
  ),
}).pipe(rejectExcessProperties);
export type AgentControlNodeDirectoryEntry = typeof AgentControlNodeDirectoryEntry.Type;

/** Owner clients publish the nodes they hold owner on, on connect and when that list changes. */
export const AgentControlPublishNodeDirectoryInput = Schema.Struct({
  nodes: Schema.Array(AgentControlNodeDirectoryEntry).check(
    Schema.isMaxLength(AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES),
  ),
}).pipe(rejectExcessProperties);
export type AgentControlPublishNodeDirectoryInput =
  typeof AgentControlPublishNodeDirectoryInput.Type;

export const AgentControlPublishNodeDirectoryResult = Schema.Struct({
  accepted: NonNegativeInt,
});
export type AgentControlPublishNodeDirectoryResult =
  typeof AgentControlPublishNodeDirectoryResult.Type;

/** The merged directory as the node serves it; `isThisNode` and the time are the node's. */
export const AgentControlNodeDirectoryListEntry = Schema.Struct({
  ...AgentControlNodeDirectoryEntry.fields,
  isThisNode: Schema.Boolean,
  lastPublishedAt: IsoDateTime,
});
export type AgentControlNodeDirectoryListEntry = typeof AgentControlNodeDirectoryListEntry.Type;

export const AgentControlNodeDirectoryListResult = Schema.Struct({
  nodes: Schema.Array(AgentControlNodeDirectoryListEntry),
});
export type AgentControlNodeDirectoryListResult = typeof AgentControlNodeDirectoryListResult.Type;
