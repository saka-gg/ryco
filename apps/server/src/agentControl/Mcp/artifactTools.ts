/**
 * `ryco_list_artifacts`: the caller's own thread's artifacts (`@ryco/shared/threadArtifacts`),
 * newest first, with the ids `ryco_create_threads` entries hand over. A private,
 * provider-session read tool; never installed on the external endpoint.
 *
 * @module agentControl/Mcp/artifactTools
 */
import { AGENT_CONTROL_CAPABILITIES, type OrchestrationMessage } from "@ryco/contracts";
import { htmlRenderOfAttachment } from "@ryco/shared/htmlRender";
import { formatThreadArtifactId, isThreadArtifactAttachment } from "@ryco/shared/threadArtifacts";
import { Effect, Schema } from "effect";

import { isPersistableChatAttachment } from "../../attachmentStore.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
} from "./tools.ts";

export const LIST_ARTIFACTS_TOOL_NAME = "ryco_list_artifacts";
const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 50;

const descriptor: AgentControlMcpToolDescriptor = {
  name: LIST_ARTIFACTS_TOOL_NAME,
  description:
    "List this thread's artifacts, newest first: the pages you published with ryco_html_render, the files you attached with ryco_attach_file, and artifacts handed over to this thread by another one (from the thread that delegated it, or returned by a thread it delegated). Each has an artifactId; pass artifactIds in a ryco_create_threads entry's artifacts to hand those artifacts over to the new thread, which gets copies attached to its first message.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT_MAX },
    },
    additionalProperties: false,
  },
};

const ListArtifactsInput = Schema.Struct({
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))),
});

export interface ListedArtifact {
  readonly artifactId: string;
  readonly kind: "page" | "file";
  readonly name: string;
  /** Pages only: the page's title. */
  readonly title?: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly turnId: string | null;
  /** Handed over from another thread: the thread and message it was copied from. */
  readonly handedOverFrom?: { readonly threadId: string; readonly messageId: string };
}

/** The artifacts of messages listed newest first, in that order (each message's in publish order). */
export function listMessageArtifacts(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<ListedArtifact> {
  return messages.flatMap((message) =>
    (message.attachments ?? []).flatMap((attachment): ListedArtifact[] => {
      if (
        !isPersistableChatAttachment(attachment) ||
        !isThreadArtifactAttachment(message.role, attachment)
      )
        return [];
      const htmlRender = htmlRenderOfAttachment(attachment);
      return [
        {
          artifactId: formatThreadArtifactId({
            messageId: message.id,
            attachmentId: attachment.id,
          }),
          kind: htmlRender === undefined ? "file" : "page",
          name: attachment.name,
          ...(htmlRender === undefined ? {} : { title: htmlRender.title }),
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          createdAt: message.createdAt,
          turnId: message.turnId ?? null,
          ...(attachment.handoff === undefined
            ? {}
            : {
                handedOverFrom: {
                  threadId: attachment.handoff.threadId,
                  messageId: attachment.handoff.messageId,
                },
              }),
        },
      ];
    }),
  );
}

const errorResult = (text: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export function withArtifactTools(
  base: AgentControlMcpTools,
  deps: {
    readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
    readonly projections: Pick<ProjectionSnapshotQueryShape, "listThreadArtifactMessages">;
  },
): AgentControlMcpTools {
  const capability = AGENT_CONTROL_CAPABILITIES.read;
  const list = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* deps.policy.authorize({
        principal: {
          kind: "provider-session",
          threadId: session.threadId,
          providerInstanceId: session.providerInstanceId,
          runtimeSessionId: session.runtimeSessionId,
        },
        grantedCapabilities: session.grantedCapabilities,
        requiredCapability: capability,
        operation: `mcp:${LIST_ARTIFACTS_TOOL_NAME}`,
      });
      const input = yield* Schema.decodeUnknownEffect(ListArtifactsInput)(args ?? {});
      const limit = Math.min(input.limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
      const read = deps.projections.listThreadArtifactMessages;
      if (!read) return errorResult("Artifacts are unavailable on this server.");
      // One message carries up to 8 artifacts; `limit` messages always cover `limit` artifacts.
      const messages = yield* read({ threadId: session.threadId, limit });
      const artifacts = listMessageArtifacts(messages).slice(0, limit);
      const value = { threadId: session.threadId, artifacts };
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      } satisfies AgentControlMcpToolResult;
    }).pipe(Effect.catch(() => Effect.succeed(errorResult("Listing artifacts failed."))));

  return {
    ...base,
    descriptors: [...base.descriptors, descriptor],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled)) return tools;
        return session.grantedCapabilities.includes(capability) ? [...tools, descriptor] : tools;
      }),
    hasTool: (name) => name === descriptor.name || base.hasTool(name),
    isWriteTool: (name) => base.isWriteTool(name),
    callTool: (session, name, args) =>
      name === descriptor.name ? list(session, args) : base.callTool(session, name, args),
  };
}
