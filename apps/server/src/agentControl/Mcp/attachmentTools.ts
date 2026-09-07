import { createHash } from "node:crypto";
import {
  AGENT_CONTROL_CAPABILITIES,
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
} from "@ryco/contracts";
import { Effect, Option, Schema, Semaphore } from "effect";
import {
  AssistantAttachmentError,
  AssistantAttachmentFile,
  persistAssistantAttachment,
} from "../../assistantAttachments.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { WorkspaceAccessPolicyShape } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type { AgentControlSessionRegistryShape } from "../Services/AgentControlSessionRegistry.ts";
import type {
  AgentControlMcpTools,
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
} from "./tools.ts";

const descriptor: AgentControlMcpToolDescriptor = {
  name: "ryco_attach_file",
  description:
    "Deliver a generated file to the user in this thread's timeline. Images are previewed, audio/video can be played, other files can be downloaded. Call only for user-requested files or task outputs. The path must be relative to this thread's workspace, with no symlinks or parent traversal. Ryco stores a snapshot, so later edits do not change the delivered file. Up to 8 files and 50 MiB per turn, 10 MiB per inline image. A successful call already displays the file; do not repeat it in a ryco-attachments block. This tool does not generate media.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4096 },
      name: { type: "string", minLength: 1, maxLength: 255 },
    },
  },
};

/** Private, exact-turn tool only. Never installed on the external Agent Control endpoint. */
export const withAssistantAttachmentTools = (
  base: AgentControlMcpTools,
  deps: {
    attachmentsDir: string;
    registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
    policy: Pick<AgentControlPolicyShape, "authorize">;
    projections: Pick<
      ProjectionSnapshotQueryShape,
      "listThreadMessagesByTurn" | "getThreadCheckpointContext"
    >;
    workspaceAccess: Pick<WorkspaceAccessPolicyShape, "assertExistingPath">;
    engine: Pick<OrchestrationEngineShape, "dispatch">;
  },
): Effect.Effect<AgentControlMcpTools> =>
  Effect.gen(function* () {
    // Serialize budget checks and publication across concurrent MCP requests.
    const deliveries = yield* Semaphore.make(1);
    const capability = AGENT_CONTROL_CAPABILITIES.attachFile;
    return {
      ...base,
      descriptors: [...base.descriptors, descriptor],
      descriptorsFor: (session) =>
        base
          .descriptorsFor(session)
          .pipe(
            Effect.map((tools) =>
              session.grantedCapabilities.includes(capability) ? [...tools, descriptor] : tools,
            ),
          ),
      hasTool: (name) => name === descriptor.name || base.hasTool(name),
      isWriteTool: (name) => name === descriptor.name || base.isWriteTool(name),
      callTool: (session, name, args) => {
        if (name !== descriptor.name) return base.callTool(session, name, args);
        return deliveries
          .withPermits(1)(
            Effect.gen(function* () {
              const authority = yield* deps.registry.getTurnAuthority(session.sessionId);
              if (
                Option.isNone(authority) ||
                authority.value.threadId !== session.threadId ||
                authority.value.sessionId !== session.sessionId
              )
                return yield* new AssistantAttachmentError();
              const turnId = authority.value.turnId;
              yield* deps.policy.authorize({
                principal: {
                  kind: "provider-session",
                  threadId: session.threadId,
                  runtimeSessionId: session.runtimeSessionId,
                  providerInstanceId: session.providerInstanceId,
                  turnId,
                },
                requiredCapability: capability,
                grantedCapabilities: session.grantedCapabilities,
                operation: "mcp:ryco_attach_file",
              });
              const file = yield* Schema.decodeUnknownEffect(AssistantAttachmentFile)(args);
              const digest = createHash("sha256")
                .update(JSON.stringify([session.sessionId, turnId, file.path, file.name]))
                .digest("hex");
              const messageId = MessageId.make(`attachment-${digest}`);
              // A bounded turn read supplies durable idempotency and a per-turn byte/count budget.
              if (!deps.projections.listThreadMessagesByTurn)
                return yield* new AssistantAttachmentError();
              const messages = yield* deps.projections.listThreadMessagesByTurn({
                threadId: session.threadId,
                turnId,
                limit: 1000,
              });
              if (messages.length >= 1000) return yield* new AssistantAttachmentError();
              const existing = messages.find((message) => message.id === messageId);
              if (existing?.attachments?.length)
                return {
                  content: [
                    { type: "text", text: "This file is already attached in the timeline." },
                  ],
                } satisfies AgentControlMcpToolResult;
              const attached = messages
                .filter((message) => message.role === "assistant")
                .flatMap((message) => message.attachments ?? []);
              if (attached.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
                return yield* new AssistantAttachmentError();
              const remainingBytes =
                PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES -
                attached.reduce((total, attachment) => total + (attachment.sizeBytes ?? 0), 0);
              const context = Option.getOrUndefined(
                yield* deps.projections.getThreadCheckpointContext(session.threadId),
              );
              const cwd = context?.worktreePath ?? context?.workspaceRoot;
              if (!cwd) return yield* new AssistantAttachmentError();
              const authorizedCwd = yield* deps.workspaceAccess.assertExistingPath({
                path: cwd,
                operation: "assistant file delivery",
              });
              const attachment = yield* Effect.tryPromise({
                try: (signal) =>
                  persistAssistantAttachment({
                    attachmentsDir: deps.attachmentsDir,
                    cwd: authorizedCwd,
                    threadId: session.threadId,
                    deliveryId: messageId,
                    file,
                    remainingBytes,
                    signal,
                  }),
                catch: () => new AssistantAttachmentError(),
              });
              const current = yield* deps.registry.getTurnAuthority(session.sessionId);
              if (
                Option.isNone(current) ||
                current.value.turnId !== turnId ||
                current.value.boundAt !== authority.value.boundAt
              )
                return yield* new AssistantAttachmentError();
              yield* deps.engine.dispatch({
                type: "thread.message.assistant.complete",
                commandId: CommandId.make(`attach-${digest}`),
                threadId: session.threadId,
                messageId,
                turnId,
                text: " ",
                attachments: [attachment],
                createdAt: new Date().toISOString(),
              });
              return {
                content: [
                  {
                    type: "text",
                    text: "File attached in the timeline. The user can preview or download it. Do not attach it again in your reply.",
                  },
                ],
                structuredContent: { messageId, attachment },
              } satisfies AgentControlMcpToolResult;
            }),
          )
          .pipe(
            Effect.catch(() =>
              Effect.succeed<AgentControlMcpToolResult>({
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "File was not delivered. An exact active turn and file-delivery permission are required. Use an existing regular file inside this thread's workspace (no links), at most 8 files and 50 MiB total per turn.",
                  },
                ],
              }),
            ),
          );
      },
    } satisfies AgentControlMcpTools;
  });
