/**
 * AgentControlNodeDirectory - which other nodes exist, as the owner clients connected to this
 * node know them. Nodes never talk to each other, so a client publishes the nodes it holds owner
 * on (`agentControl.publishNodeDirectory`) on connect and whenever that list changes; agents read
 * the merge (`ryco_list_nodes`) to name a copy's target.
 *
 * Non-secret fields only, never addresses or credentials. Entries are kept per publisher and
 * merged by environment id with the newest publication winning (a local Hub alias of the same
 * machine collapses into one entry); they expire 30 days after they were last published. The
 * merge lives in memory and in `<stateDir>/agent-control-node-directory.json`.
 *
 * @module AgentControlNodeDirectory
 */
import type {
  AgentControlNodeDirectoryEntry,
  AgentControlNodeDirectoryListResult,
  AgentControlPublishNodeDirectoryResult,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { AgentControlNodeDirectoryError } from "../Errors.ts";

export interface PublishAgentControlNodeDirectoryInput {
  /** The publishing client session; its previous publication is replaced. */
  readonly publisherKey: string;
  /** At most `AGENT_CONTROL_NODE_DIRECTORY_MAX_ENTRIES`, validated by the RPC schema. */
  readonly nodes: ReadonlyArray<AgentControlNodeDirectoryEntry>;
}

export interface AgentControlNodeDirectoryShape {
  /** Replaces the publisher's entries; answers how many it kept. */
  readonly publish: (
    input: PublishAgentControlNodeDirectoryInput,
  ) => Effect.Effect<AgentControlPublishNodeDirectoryResult, AgentControlNodeDirectoryError>;
  /** The merged directory; `isThisNode` and `lastPublishedAt` are this node's own. */
  readonly list: () => Effect.Effect<
    AgentControlNodeDirectoryListResult,
    AgentControlNodeDirectoryError
  >;
}

export class AgentControlNodeDirectory extends Context.Service<
  AgentControlNodeDirectory,
  AgentControlNodeDirectoryShape
>()("ryco/agentControl/Services/AgentControlNodeDirectory") {}
