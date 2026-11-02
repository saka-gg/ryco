import * as Schema from "effect/Schema";
import { PositiveInt, rejectExcessProperties } from "./baseSchemas.ts";
import { AgentControlPullRequestUrl } from "./agentControl.ts";

/**
 * `ryco_link_pull_request`: a private-session tool with which an agent links a pull request it
 * opened (or names) to its chat's workspace, so Ryco tracks it, shows it beside the chat and
 * settles the chat when it merges, without watching it. Like the queue tools, it is not part of
 * `AGENT_CONTROL_MCP_TOOLS` and never reaches the external endpoint.
 */
export const AGENT_CONTROL_LINK_PULL_REQUEST_TOOL = "ryco_link_pull_request";

export const AgentControlLinkPullRequestInput = Schema.Struct({
  number: Schema.optional(PositiveInt),
  url: Schema.optional(AgentControlPullRequestUrl),
}).pipe(rejectExcessProperties);
export type AgentControlLinkPullRequestInput = typeof AgentControlLinkPullRequestInput.Type;
