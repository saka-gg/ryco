/**
 * `ryco_link_pull_request`: a private-session tool with which an agent links a pull request it
 * opened, or names, to its chat's workspace. Ryco then shows it beside the chat, refreshes its
 * state and settles the chat when it merges, as for a pull request the user linked. It goes
 * through the pull request watch's runtime (the same workspace and repository checks as
 * `ryco_watch_pull_request`, without the watch). Needs exact active-turn authority and the
 * pull request grant; never installed on the external endpoint; loaded on first use
 * (`withLazyAgentControlTools`).
 *
 * Ported from T3 Code's `link_pull_request` (#10839), adapted to Ryco's workspace-level links.
 *
 * @module agentControl/Mcp/pullRequestLinkTools
 */
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_LINK_PULL_REQUEST_TOOL,
  AgentControlLinkPullRequestInput,
  type TurnId,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";

import type { PullRequestWatchServiceShape } from "../../sourceControl/PullRequestWatchService.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
} from "../Services/AgentControlSessionRegistry.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
} from "./tools.ts";

const linkDescriptor: AgentControlMcpToolDescriptor = {
  name: AGENT_CONTROL_LINK_PULL_REQUEST_TOOL,
  description:
    "Register every pull request you open for this chat, including each layer of a stack, right after creating it. Links a pull request to this chat's workspace so Ryco tracks it, shows its status beside the chat, and settles the chat when it merges. Pass the URL, or the number for this repository. Linking one already linked succeeds with alreadyLinked=true; one the user removed from the workspace stays removed.",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", minimum: 1 },
      url: { type: "string", maxLength: 2048, pattern: "^https?://" },
    },
    additionalProperties: false,
  },
};

const NO_AUTHORITY = "Exact active-turn write authority is unavailable.";

const textResult = (value: unknown): AgentControlMcpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const errorResult = (text: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

class ToolFailure {
  readonly _tag = "ToolFailure";
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export interface PullRequestLinkToolDeps {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly pullRequestWatch: Pick<PullRequestWatchServiceShape, "linkPullRequest">;
}

/** Private, provider-session tool only. Same wrapper pattern as the queue tools. */
export function withPullRequestLinkTools(
  base: AgentControlMcpTools,
  deps: PullRequestLinkToolDeps,
): AgentControlMcpTools {
  const capability = AGENT_CONTROL_CAPABILITIES.watchPullRequests;
  const authorize = (session: AgentControlSessionRecord, turnId: TurnId) =>
    deps.policy
      .authorize({
        principal: {
          kind: "provider-session",
          threadId: session.threadId,
          providerInstanceId: session.providerInstanceId,
          runtimeSessionId: session.runtimeSessionId,
          turnId,
        },
        grantedCapabilities: session.grantedCapabilities,
        requiredCapability: capability,
        operation: `mcp:${linkDescriptor.name}`,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "AgentControlDisabledError"
            ? new ToolFailure("Agent Control is disabled.")
            : new ToolFailure("Capability denied."),
        ),
      );

  const link = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const authority = yield* deps.registry
        .getTurnAuthority(session.sessionId)
        .pipe(
          Effect.map((value) =>
            Option.filter(
              value,
              (entry) =>
                entry.sessionId === session.sessionId && entry.threadId === session.threadId,
            ),
          ),
        );
      if (Option.isNone(authority)) return yield* Effect.fail(new ToolFailure(NO_AUTHORITY));
      yield* authorize(session, authority.value.turnId);
      const input = yield* Schema.decodeUnknownEffect(AgentControlLinkPullRequestInput)(
        args ?? {},
      ).pipe(Effect.mapError(() => new ToolFailure("Invalid tool arguments.")));
      // Only the calling chat: an agent links to its own workspace, never another chat's.
      const linked = yield* deps.pullRequestWatch
        .linkPullRequest({
          threadId: session.threadId,
          ...(input.number === undefined ? {} : { number: input.number }),
          ...(input.url === undefined ? {} : { url: input.url }),
        })
        .pipe(Effect.mapError((error) => new ToolFailure(error.detail)));
      return textResult(linked);
    });

  return {
    ...base,
    descriptors: [...base.descriptors, linkDescriptor],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled)) return tools;
        return session.grantedCapabilities.includes(capability)
          ? [...tools, linkDescriptor]
          : tools;
      }),
    hasTool: (name) => name === linkDescriptor.name || base.hasTool(name),
    isWriteTool: (name) => name === linkDescriptor.name || base.isWriteTool(name),
    callTool: (session, name, args) =>
      name === linkDescriptor.name
        ? link(session, args).pipe(
            Effect.catch((error) =>
              Effect.succeed(
                errorResult(
                  error instanceof ToolFailure ? error.text : "Linking the pull request failed.",
                ),
              ),
            ),
          )
        : base.callTool(session, name, args),
  };
}
