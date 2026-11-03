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
import type { extractThreadReferences } from "@ryco/shared/threadMentions";
import { Effect, Option, Schema } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { findThreadInArray } from "../../orchestration/threadIndex.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
} from "../Services/AgentControlSessionRegistry.ts";
import type { toMcpFollowUpQueue } from "./threadTranscript.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
} from "./tools.ts";

const listDescriptor: AgentControlMcpToolDescriptor = {
  name: AGENT_CONTROL_QUEUE_MCP_TOOLS.queueList,
  description:
    "List a thread's follow-up queue on the node, next first, and why it waits when held. Each entry has its revision and `mine`: whether this chat's agent queued it with ryco_send_message (delivery queue) and no person has edited it since. ryco_queue_edit and ryco_queue_remove change only those, and not while one is being steered into the running turn.",
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
      text: { type: "string", minLength: 1, maxLength: 120_000 },
    },
    required: ["threadId", "messageId", "expectedRevision", "text"],
    additionalProperties: false,
  },
};

const removeDescriptor: AgentControlMcpToolDescriptor = {
  name: AGENT_CONTROL_QUEUE_MCP_TOOLS.queueRemove,
  description:
    "Take follow-ups this chat's agent queued out of a thread's queue before the node sends them: all of them, or none when one is not yours or no longer queued.",
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
const GONE = "No longer queued (the node sent it, or it was removed); nothing was removed: ";

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
  /**
   * Helpers the boot path already holds, passed in: a lazily loaded module that imported them
   * would split them out of the boot chunk.
   */
  readonly helpers: {
    readonly findThreadInArray: typeof findThreadInArray;
    readonly toMcpFollowUpQueue: typeof toMcpFollowUpQueue;
    readonly extractThreadReferences: typeof extractThreadReferences;
  };
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
  const decode = <S extends Schema.Top>(schema: S, args: unknown) =>
    Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
      Effect.mapError(() => new ToolFailure("Invalid tool arguments.")),
    ) as Effect.Effect<S["Type"], ToolFailure>;
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
      const thread = deps.helpers.findThreadInArray(
        (yield* deps.engine.getReadModel()).threads,
        threadId,
      );
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
      const input = yield* decode(AgentControlQueueListInput, args);
      const queue = yield* queueOf(input.threadId);
      return textResult({
        threadId: input.threadId,
        followUpQueue: deps.helpers.toMcpFollowUpQueue(queue, { threadId: session.threadId }),
      });
    });

  const edit = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* writeAuthority(session, editDescriptor.name);
      const input = yield* decode(AgentControlQueueEditInput, args);
      const queue = yield* queueOf(input.threadId);
      const entry = queue.entries.find((candidate) => candidate.messageId === input.messageId);
      if (entry === undefined || !ownEntry(entry, session)) {
        return yield* Effect.fail(new ToolFailure(NOT_YOURS));
      }
      // A retry after a lost reply finds its own edit applied: the next revision, this text.
      if (entry.revision === input.expectedRevision + 1 && entry.text === input.text) {
        return textResult({ messageId: entry.messageId, revision: entry.revision });
      }
      if (entry.revision !== input.expectedRevision) {
        return yield* Effect.fail(new ToolFailure(CHANGED));
      }
      const threadReferences = deps.helpers.extractThreadReferences(input.text, input.threadId);
      yield* dispatch({
        type: "thread.queue.edit",
        // A fresh id per call: the node remembers a refusal under its command id.
        commandId: CommandId.make(
          `agent-control:queue-edit:${session.threadId}:${crypto.randomUUID()}`,
        ),
        // The node checks again that the entry is still this agent's.
        queuedBy: session.threadId,
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
      const input = yield* decode(AgentControlQueueRemoveInput, args);
      const queue = yield* queueOf(input.threadId);
      const wanted = [...new Set<string>(input.messageIds)];
      const entries = queue.entries.filter((entry) => wanted.includes(entry.messageId));
      // All or nothing: one entry that is gone or not this agent's refuses the whole call.
      const gone = wanted.filter((id) => !entries.some((entry) => entry.messageId === id));
      if (gone.length > 0) return yield* Effect.fail(new ToolFailure(GONE + gone.join(", ")));
      if (entries.some((entry) => !ownEntry(entry, session))) {
        return yield* Effect.fail(new ToolFailure(NOT_YOURS));
      }
      yield* dispatch({
        type: "thread.queue.remove",
        commandId: CommandId.make(
          `agent-control:queue-remove:${session.threadId}:${crypto.randomUUID()}`,
        ),
        // The node removes them only if all are still this agent's, unsent and not steered.
        queuedBy: session.threadId,
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
