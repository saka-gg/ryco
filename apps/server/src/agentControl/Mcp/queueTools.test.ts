import { assert, describe, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_QUEUE_MCP_TOOLS,
  MessageId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlCapability,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type QueuedFollowUp,
} from "@ryco/contracts";
import { Effect, Option } from "effect";

import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { findThreadInArray } from "../../orchestration/threadIndex.ts";
import { toMcpFollowUpQueue } from "./threadTranscript.ts";
import { extractThreadReferences } from "@ryco/shared/threadMentions";
import { withQueueTools } from "./queueTools.ts";
import type { AgentControlMcpTools } from "./tools.ts";

const now = "2026-10-30T08:00:00.000Z";
const threadId = ThreadId.make("thread-target");
const CODEX = ProviderInstanceId.make("codex");

const session = (
  callerThreadId = "thread-caller",
  capabilities: ReadonlyArray<AgentControlCapability> = [
    AGENT_CONTROL_CAPABILITIES.read,
    AGENT_CONTROL_CAPABILITIES.sendMessage,
  ],
): AgentControlSessionRecord => ({
  sessionId: `lease-${callerThreadId}`,
  issuedAt: now,
  threadId: ThreadId.make(callerThreadId),
  providerInstanceId: CODEX,
  runtimeSessionId: RuntimeSessionId.make("runtime-caller"),
  grantedCapabilities: capabilities,
  injectionMode: "codex-http",
});

const entry = (id: string, overrides: Partial<QueuedFollowUp> = {}): QueuedFollowUp => ({
  messageId: MessageId.make(id),
  text: `text of ${id}`,
  attachments: [
    { type: "image", id: `${id}-image`, name: "a.png", mimeType: "image/png", sizeBytes: 1 },
  ] as unknown as QueuedFollowUp["attachments"],
  modelSelection: { instanceId: CODEX, model: "gpt-5.6" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: now,
  updatedAt: now,
  revision: 2,
  status: "queued",
  author: "agent",
  queuedBy: ThreadId.make("thread-caller"),
  ...overrides,
});

const harness = (input: { readonly authority?: boolean } = {}) => {
  const entries: QueuedFollowUp[] = [
    entry("mine"),
    entry("other-agent", { queuedBy: ThreadId.make("thread-other") }),
    entry("person", { author: "user", queuedBy: undefined }),
    entry("old-agent", { queuedBy: undefined }),
    entry("steering-mine", { status: "steering" }),
  ];
  const dispatched: OrchestrationCommand[] = [];
  const base: AgentControlMcpTools = {
    descriptors: [],
    descriptorsFor: () => Effect.succeed([]),
    hasTool: () => false,
    isWriteTool: () => false,
    callTool: () => Effect.die("not used"),
  };
  const tools = withQueueTools(base, {
    helpers: { findThreadInArray, toMcpFollowUpQueue, extractThreadReferences },
    policy: {
      isEnabled: Effect.succeed(true),
      authorize: (request: {
        readonly grantedCapabilities: ReadonlyArray<AgentControlCapability>;
        readonly requiredCapability: AgentControlCapability;
      }) =>
        request.grantedCapabilities.includes(request.requiredCapability)
          ? Effect.void
          : Effect.fail(new Error("denied")),
    } as never,
    registry: {
      getTurnAuthority: (sessionId: string) =>
        Effect.succeed(
          input.authority === false
            ? Option.none()
            : Option.some({
                sessionId,
                threadId: ThreadId.make(sessionId.replace("lease-", "")),
                turnId: TurnId.make("turn-caller"),
                boundAt: now,
              }),
        ),
    },
    projections: {
      getThreadShellById: (id) =>
        Effect.succeed(
          id === threadId
            ? Option.some({ id } as unknown as OrchestrationThreadShell)
            : Option.none(),
        ),
    },
    engine: {
      getReadModel: () =>
        Effect.sync(
          () =>
            ({
              threads: [{ id: threadId, followUpQueue: { entries, hold: null } }],
            }) as never,
        ),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    },
  });
  const call = (name: string, args: unknown, caller = session()) =>
    tools.callTool(caller, name, args);
  return { tools, call, dispatched, entries };
};

describe("ryco_queue_* tools", () => {
  it.effect("lists the queue with each entry's revision and whether the caller queued it", () =>
    Effect.gen(function* () {
      const h = harness();
      const result = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueList, { threadId });
      assert.isUndefined(result.isError);
      const listed = (
        result.structuredContent as {
          readonly followUpQueue: {
            readonly entries: ReadonlyArray<{ messageId: string; mine: boolean; revision: number }>;
          };
        }
      ).followUpQueue.entries;
      assert.deepEqual(
        listed.map((item) => [item.messageId, item.mine, item.revision]),
        [
          ["mine", true, 2],
          ["other-agent", false, 2],
          ["person", false, 2],
          ["old-agent", false, 2],
          // Its own, though out of reach while it is being steered.
          ["steering-mine", true, 2],
        ],
      );
      const missing = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueList, {
        threadId: "thread-unknown",
      });
      assert.isTrue(missing.isError);
    }),
  );

  it.effect("edits only the caller's own entry, at the revision it read, keeping the rest", () =>
    Effect.gen(function* () {
      const h = harness();
      const edited = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueEdit, {
        threadId,
        messageId: "mine",
        expectedRevision: 2,
        text: "Rebase first, then run the tests.",
      });
      assert.deepEqual(edited.structuredContent, { messageId: "mine", revision: 3 });
      const command = h.dispatched[0] as unknown as Record<string, unknown>;
      assert.deepInclude(command, {
        type: "thread.queue.edit",
        threadId,
        messageId: "mine",
        expectedRevision: 2,
        text: "Rebase first, then run the tests.",
        attachments: [],
        keptAttachmentIds: ["mine-image"],
        runtimeMode: "approval-required",
        // The node checks again that it is still the caller's agent's.
        queuedBy: "thread-caller",
      });
      // A fresh command id per call: a refusal the node remembers never blocks a later edit.
      assert.notInclude(String(command.commandId), ":2");
      for (const messageId of ["other-agent", "person", "old-agent", "steering-mine"]) {
        const refused = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueEdit, {
          threadId,
          messageId,
          expectedRevision: 2,
          text: "Mine now",
        });
        assert.isTrue(refused.isError);
      }
      const stale = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueEdit, {
        threadId,
        messageId: "mine",
        expectedRevision: 1,
        text: "Old",
      });
      assert.include(stale.content[0]?.text ?? "", "changed since you read it");
      assert.lengthOf(h.dispatched, 1);
    }),
  );

  it.effect("answers a retry after a lost reply with the edit it already made", () =>
    Effect.gen(function* () {
      const h = harness();
      const text = "Rebase first, then run the tests.";
      // The node applied the first call; its reply was lost.
      h.entries[0] = { ...h.entries[0]!, text, revision: 3 };
      const retried = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueEdit, {
        threadId,
        messageId: "mine",
        expectedRevision: 2,
        text,
      });
      assert.deepEqual(retried.structuredContent, { messageId: "mine", revision: 3 });
      assert.lengthOf(h.dispatched, 0);
      // Another text at the old revision is a stale edit.
      const other = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueEdit, {
        threadId,
        messageId: "mine",
        expectedRevision: 2,
        text: "Something else",
      });
      assert.include(other.content[0]?.text ?? "", "changed since you read it");
    }),
  );

  it.effect("removes the caller's own entries, all or nothing", () =>
    Effect.gen(function* () {
      const h = harness();
      const mixed = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueRemove, {
        threadId,
        messageIds: ["mine", "person"],
      });
      assert.isTrue(mixed.isError);
      const steering = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueRemove, {
        threadId,
        messageIds: ["mine", "steering-mine"],
      });
      assert.isTrue(steering.isError);
      // An id that is no longer queued says so, and nothing is removed.
      const gone = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueRemove, {
        threadId,
        messageIds: ["mine", "sent-already"],
      });
      assert.include(gone.content[0]?.text ?? "", "No longer queued");
      assert.include(gone.content[0]?.text ?? "", "sent-already");
      assert.lengthOf(h.dispatched, 0);
      const removed = yield* h.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueRemove, {
        threadId,
        messageIds: ["mine"],
      });
      assert.deepEqual(removed.structuredContent, { removed: ["mine"] });
      assert.deepInclude(h.dispatched[0] as unknown as Record<string, unknown>, {
        type: "thread.queue.remove",
        messageIds: ["mine"],
        queuedBy: "thread-caller",
      });
    }),
  );

  it.effect("changes nothing without the caller's exact turn or the send-message grant", () =>
    Effect.gen(function* () {
      const noTurn = harness({ authority: false });
      const outsideTurn = yield* noTurn.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueRemove, {
        threadId,
        messageIds: ["mine"],
      });
      assert.include(outsideTurn.content[0]?.text ?? "", "active-turn");
      const readOnly = harness();
      const noGrant = yield* readOnly.call(
        AGENT_CONTROL_QUEUE_MCP_TOOLS.queueRemove,
        { threadId, messageIds: ["mine"] },
        session("thread-caller", [AGENT_CONTROL_CAPABILITIES.read]),
      );
      assert.strictEqual(noGrant.content[0]?.text, "Capability denied.");
      const invalid = yield* readOnly.call(AGENT_CONTROL_QUEUE_MCP_TOOLS.queueList, {
        threadId: 7,
      });
      assert.strictEqual(invalid.content[0]?.text, "Invalid tool arguments.");
      assert.lengthOf(noTurn.dispatched, 0);
      assert.lengthOf(readOnly.dispatched, 0);
      // A read-only session sees the list but not the changes.
      const listed = yield* readOnly.tools.descriptorsFor(
        session("thread-caller", [AGENT_CONTROL_CAPABILITIES.read]),
      );
      assert.deepEqual(
        listed.map((tool) => tool.name),
        [AGENT_CONTROL_QUEUE_MCP_TOOLS.queueList],
      );
    }),
  );
});
