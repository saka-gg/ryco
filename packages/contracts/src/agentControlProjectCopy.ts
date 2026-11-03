import * as Schema from "effect/Schema";

import { rejectExcessProperties } from "./baseSchemas.ts";
import { ProjectCopyDirectoryName, ProjectDestinationState } from "./projectCopyPrimitives.ts";

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
