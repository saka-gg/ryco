/**
 * `ryco_queue_list`, `ryco_queue_edit`, `ryco_queue_remove`: private-session tools for a thread's
 * follow-up queue on the node. An agent lists a thread's queue, and edits or removes the entries
 * it queued itself with `ryco_send_message` (`delivery: "queue"`), named by the entry's
 * `queuedBy`. A person's entries, another chat's agent's and a schedule's stay out of reach.
 * Changes need exact active-turn authority and the send-message grant, run at once and are
 * revision-checked by the node, like the Tasks tools. Never installed on the external endpoint;
 * loaded on first use (`withLazyAgentControlTools`).
 *
 * @module agentControl/Mcp/queueTools
 */
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_QUEUE_MCP_TOOLS,
  AgentControlQueueEditInput,
  AgentControlQueueListInput,
  AgentControlQueueRemoveInput,
  CommandId,
  type AgentControlCapability,
  type OrchestrationCommand,
  type QueuedFollowUp,
  type ThreadFollowUpQueue,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";
import { extractThreadReferences } from "@ryco/shared/threadMentions";
import { Effect, Option, Schema } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { findThreadInArray } from "../../orchestration/threadIndex.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
} from "../Services/AgentControlSessionRegistry.ts";
import { toMcpFollowUpQueue } from "./threadTranscript.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
} from "./tools.ts";

const listDescriptor: AgentControlMcpToolDescriptor = {
  name: AGENT_CONTROL_QUEUE_MCP_TOOLS.queueList,
  description:
    "List a thread's follow-up queue on the node, next first, and why it waits when held. Each entry has its revision and `mine`: whether this chat's agent queued it with ryco_send_message (delivery queue), the only ones ryco_queue_edit and ryco_queue_remove change.",
  inputSchema: {
    type: "object",
    properties: { threadId: { type: "string", maxLength: 256 } },
    required: ["threadId"],
    additionalProperties: false,
  },
};

const editDescriptor: AgentControlMcpToolDescriptor = {
  name: AGENT_CONTROL_QUEUE_MCP_TOOLS.queueEdit,
  description:
    "Replace the text of a follow-up this chat's agent queued and the node has not sent yet, at the revision ryco_queue_list showed. Its place, attachments, model and modes stay.",
  inputSchema: {
    type: "object",
    properties: {
      threadId: { type: "string", maxLength: 256 },
      messageId: { type: "string", maxLength: 256 },
      expectedRevision: { type: "integer", minimum: 1 },
      text: { type: "string", maxLength: 120_000 },
    },
    required: ["threadId", "messageId", "expectedRevision", "text"],
    additionalProperties: false,
  },
};

const removeDescriptor: AgentControlMcpToolDescriptor = {
  name: AGENT_CONTROL_QUEUE_MCP_TOOLS.queueRemove,
  description:
    "Take follow-ups this chat's agent queued out of a thread's queue before the node sends them.",
  inputSchema: {
    type: "object",
    properties: {
      threadId: { type: "string", maxLength: 256 },
      messageIds: {
        type: "array",
        items: { type: "string", maxLength: 256 },
        minItems: 1,
        maxItems: 20,
      },
    },
    required: ["threadId", "messageIds"],
    additionalProperties: false,
  },
};

const NO_AUTHORITY = "Exact active-turn write authority is unavailable.";
const NOT_FOUND = "Thread not found.";
const NOT_YOURS =
  "Only follow-ups this chat's agent queued, and the node has not sent yet, can be changed.";
const CHANGED = "That follow-up changed since you read it: list the queue again.";

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

export interface QueueToolDeps {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly projections: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel">;
}

/** Whether `entry` is one this chat's agent queued and may still change. */
const ownEntry = (entry: QueuedFollowUp, session: AgentControlSessionRecord) =>
  entry.author === "agent" && entry.queuedBy === session.threadId && entry.status !== "steering";

/** Private, provider-session tools only. Same wrapper pattern as the delegation tools. */
export function withQueueTools(
  base: AgentControlMcpTools,
  deps: QueueToolDeps,
): AgentControlMcpTools {
  const owned = [listDescriptor, editDescriptor, removeDescriptor];
  const owns = (name: string) => owned.some((tool) => tool.name === name);
  const capabilityFor = (name: string): AgentControlCapability =>
    name === listDescriptor.name
      ? AGENT_CONTROL_CAPABILITIES.read
      : AGENT_CONTROL_CAPABILITIES.sendMessage;
  const authorize = (session: AgentControlSessionRecord, name: string, turnId?: TurnId) =>
    deps.policy.authorize({
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
    });
  const exactAuthority = (session: AgentControlSessionRecord) =>
    deps.registry
      .getTurnAuthority(session.sessionId)
      .pipe(
        Effect.map((authority) =>
          Option.filter(
            authority,
            (value) => value.sessionId === session.sessionId && value.threadId === session.threadId,
          ),
        ),
      );

  /** The thread's queue as the engine holds it now; a missing thread fails like a hidden one. */
  const queueOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* deps.projections.getThreadShellById(threadId);
      if (Option.isNone(shell)) return yield* Effect.fail(new ToolFailure(NOT_FOUND));
      if (deps.engine.getReadModel === undefined) {
        return yield* Effect.fail(new ToolFailure("The follow-up queue is unavailable."));
      }
      const thread = findThreadInArray((yield* deps.engine.getReadModel()).threads, threadId);
      if (thread === undefined) return yield* Effect.fail(new ToolFailure(NOT_FOUND));
      return thread.followUpQueue ?? ({ entries: [], hold: null } satisfies ThreadFollowUpQueue);
    });

  const writeAuthority = (session: AgentControlSessionRecord, name: string) =>
    Effect.gen(function* () {
      const authority = yield* exactAuthority(session);
      if (Option.isNone(authority)) return yield* Effect.fail(new ToolFailure(NO_AUTHORITY));
      yield* authorize(session, name, authority.value.turnId);
    });

  const dispatch = (command: OrchestrationCommand) =>
    deps.engine
      .dispatch(command)
      .pipe(
        Effect.mapError(
          (error) =>
            new ToolFailure(
              `The node refused it: ${(error as { readonly message?: string }).message ?? "unknown"}`,
            ),
        ),
      );

  const list = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* authorize(session, listDescriptor.name);
      const input = yield* Schema.decodeUnknownEffect(AgentControlQueueListInput)(args);
      const queue = yield* queueOf(input.threadId);
      return textResult({
        threadId: input.threadId,
        followUpQueue: toMcpFollowUpQueue(queue, { threadId: session.threadId }),
      });
    });

  const edit = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* writeAuthority(session, editDescriptor.name);
      const input = yield* Schema.decodeUnknownEffect(AgentControlQueueEditInput)(args);
      const queue = yield* queueOf(input.threadId);
      const entry = queue.entries.find((candidate) => candidate.messageId === input.messageId);
      if (entry === undefined || !ownEntry(entry, session)) {
        return yield* Effect.fail(new ToolFailure(NOT_YOURS));
      }
      if (entry.revision !== input.expectedRevision) {
        return yield* Effect.fail(new ToolFailure(CHANGED));
      }
      const threadReferences = extractThreadReferences(input.text, input.threadId);
      yield* dispatch({
        type: "thread.queue.edit",
        // One id per edit of one revision: a retry after a lost reply replays its receipt.
        commandId: CommandId.make(
          `agent-control:queue-edit:${session.threadId}:${entry.messageId}:${entry.revision}`,
        ),
        threadId: input.threadId,
        messageId: entry.messageId,
        expectedRevision: entry.revision,
        text: input.text,
        attachments: [],
        keptAttachmentIds: entry.attachments.flatMap((attachment) =>
          attachment.id === undefined ? [] : [attachment.id],
        ),
        modelSelection: entry.modelSelection,
        runtimeMode: entry.runtimeMode,
        interactionMode: entry.interactionMode,
        ...(entry.tokenMode === undefined ? {} : { tokenMode: entry.tokenMode }),
        ...(threadReferences.length > 0 ? { threadReferences } : {}),
        createdAt: new Date().toISOString(),
      });
      return textResult({ messageId: entry.messageId, revision: entry.revision + 1 });
    });

  const remove = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* writeAuthority(session, removeDescriptor.name);
      const input = yield* Schema.decodeUnknownEffect(AgentControlQueueRemoveInput)(args);
      const queue = yield* queueOf(input.threadId);
      const wanted = new Set<string>(input.messageIds);
      const entries = queue.entries.filter((entry) => wanted.has(entry.messageId));
      // All or nothing: one entry that is not this agent's refuses the whole call.
      if (entries.length !== wanted.size || entries.some((entry) => !ownEntry(entry, session))) {
        return yield* Effect.fail(new ToolFailure(NOT_YOURS));
      }
      yield* dispatch({
        type: "thread.queue.remove",
        commandId: CommandId.make(
          `agent-control:queue-remove:${session.threadId}:${crypto.randomUUID()}`,
        ),
        threadId: input.threadId,
        messageIds: entries.map((entry) => entry.messageId),
        createdAt: new Date().toISOString(),
      });
      return textResult({ removed: entries.map((entry) => entry.messageId) });
    });

  const run = <E>(
    effect: Effect.Effect<AgentControlMcpToolResult, E>,
    fallback: string,
  ): Effect.Effect<AgentControlMcpToolResult> =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.succeed(errorResult(error instanceof ToolFailure ? error.text : fallback)),
      ),
    );

  return {
    ...base,
    descriptors: [...base.descriptors, ...owned],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled)) return tools;
        return [
          ...tools,
          ...owned.filter((tool) => session.grantedCapabilities.includes(capabilityFor(tool.name))),
        ];
      }),
    hasTool: (name) => owns(name) || base.hasTool(name),
    isWriteTool: (name) =>
      name === editDescriptor.name || name === removeDescriptor.name || base.isWriteTool(name),
    callTool: (session, name, args) => {
      if (name === listDescriptor.name) return run(list(session, args), "Queue read failed.");
      if (name === editDescriptor.name) return run(edit(session, args), "Queue edit failed.");
      if (name === removeDescriptor.name)
        return run(remove(session, args), "Queue removal failed.");
      return base.callTool(session, name, args);
    },
  };
}
