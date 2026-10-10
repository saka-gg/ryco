import { createHash } from "node:crypto";
import { AGENT_CONTROL_CAPABILITIES, CommandId, MessageId } from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
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
import {
  makeTurnAttachmentDelivery,
  type TurnAttachmentDelivery,
} from "./turnAttachmentDelivery.ts";

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
    /** Shared with the other turn-attachment tools so they draw on one serialized budget. */
    delivery?: TurnAttachmentDelivery;
  },
): Effect.Effect<AgentControlMcpTools> =>
  Effect.gen(function* () {
    const delivery = deps.delivery ?? (yield* makeTurnAttachmentDelivery(deps));
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
        return delivery
          .serialized(
            Effect.gen(function* () {
              const authority = yield* delivery.authorize(session, {
                capability,
                operation: "mcp:ryco_attach_file",
              });
              const turnId = authority.turnId;
              const file = yield* Schema.decodeUnknownEffect(AssistantAttachmentFile)(args);
              const digest = createHash("sha256")
                .update(JSON.stringify([session.sessionId, turnId, file.path, file.name]))
                .digest("hex");
              const messageId = MessageId.make(`attachment-${digest}`);
              const budget = yield* delivery.budget(session, authority, messageId);
              if (budget.delivered)
                return {
                  content: [
                    { type: "text", text: "This file is already attached in the timeline." },
                  ],
                } satisfies AgentControlMcpToolResult;
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
                    remainingBytes: budget.remainingBytes,
                    signal,
                  }),
                catch: () => new AssistantAttachmentError(),
              });
              yield* delivery.publish(session, authority, {
                messageId,
                commandId: CommandId.make(`attach-${digest}`),
                attachment,
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
