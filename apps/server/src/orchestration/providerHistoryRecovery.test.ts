import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { inheritedItemId } from "./forkInheritance.ts";
import { historyMessagesToRestore, missingHistoryActivities } from "./providerHistoryRecovery.ts";
import type { ProviderThreadHistory } from "../provider/Services/ProviderAdapter.ts";

const at = "2026-09-05T10:00:00.000Z";
const turnId = TurnId.make("turn-1");
const message = {
  id: MessageId.make("assistant:item-1"),
  turnId,
  role: "assistant" as const,
  text: "hello world",
  createdAt: at,
};
const history: ProviderThreadHistory = {
  messages: [message],
  items: [],
  completedTurnIds: [turnId],
  failedTurnIds: [],
};
const thread = (messages: readonly OrchestrationMessage[] = []) => ({
  id: ThreadId.make("thread-1"),
  createdAt: at,
  messages,
});

describe("provider history message recovery", () => {
  it("matches a null-turn local prompt through the persisted turn association", () => {
    const user = {
      ...message,
      id: MessageId.make("local-user"),
      role: "user" as const,
      turnId: null,
      text: "question",
      streaming: false,
      updatedAt: at,
    };
    const recovered = {
      ...history,
      messages: [
        {
          ...message,
          id: MessageId.make("user:remote"),
          role: "user" as const,
          text: "injected context\nquestion",
        },
        message,
      ],
    };
    const restored = historyMessagesToRestore(
      thread([user]),
      recovered,
      at,
      new Map([[turnId, user.id]]),
    );
    expect(restored.map((entry) => entry.role)).toEqual(["assistant"]);
    expect(
      historyMessagesToRestore(
        thread([user, ...restored]),
        recovered,
        at,
        new Map([[turnId, user.id]]),
      ),
    ).toEqual([]);
    // An unrelated turn must still recover its prompt, even if its text repeats.
    expect(
      historyMessagesToRestore(
        thread([user]),
        recovered,
        at,
        new Map([[TurnId.make("other-turn"), user.id]]),
      ),
    ).toHaveLength(2);
  });

  it("orders recovered replies after their user prompt despite coarse provider timestamps", () => {
    const user = {
      ...message,
      id: MessageId.make("local-user"),
      role: "user" as const,
      text: "question",
      createdAt: "2026-09-05T10:00:00.900Z",
      streaming: false,
      updatedAt: at,
    };
    const orderedHistory = {
      ...history,
      messages: [
        { ...user, id: MessageId.make("user:remote"), createdAt: at },
        message,
        { ...message, id: MessageId.make("assistant:second") },
      ],
    };
    const restored = historyMessagesToRestore(thread([user]), orderedHistory, at);
    expect(restored.map((entry) => entry.createdAt)).toEqual([
      "2026-09-05T10:00:00.901Z",
      "2026-09-05T10:00:00.902Z",
    ]);
    expect(historyMessagesToRestore(thread([user, ...restored]), orderedHistory, at)).toEqual([]);
  });
  it("restores missing history idempotently with thread-scoped IDs", () => {
    const first = historyMessagesToRestore(thread(), history, at);
    expect(first[0]?.id).toBe("history:thread-1:assistant:item-1");
    expect(historyMessagesToRestore(thread(first), history, at)).toEqual([]);
    const fork = historyMessagesToRestore({ ...thread(), id: ThreadId.make("fork") }, history, at);
    expect(fork[0]?.id).not.toBe(first[0]?.id);
  });
  it("repairs a partial message using its existing identity", () => {
    const partial = { ...message, text: "hello", streaming: true, updatedAt: at };
    expect(historyMessagesToRestore(thread([partial]), history, at)).toEqual([
      { ...partial, text: "hello world", streaming: false },
    ]);
  });
  it("preserves pause-for-user segments without repeating their text", () => {
    const segments = [
      { ...message, text: "hello ", streaming: false, updatedAt: at },
      {
        ...message,
        id: MessageId.make("assistant:item-1:segment:1"),
        text: "w",
        streaming: true,
        updatedAt: at,
      },
    ];
    const repaired = historyMessagesToRestore(thread(segments), history, at);
    expect(repaired).toEqual([{ ...segments[1], text: "world", streaming: false }]);
    expect(historyMessagesToRestore(thread([segments[0]!, repaired[0]!]), history, at)).toEqual([]);
  });
  it("does not overwrite divergent earlier segments or duplicate an uncorrelated user prompt", () => {
    const segments = [
      { ...message, text: "different ", streaming: false, updatedAt: at },
      {
        ...message,
        id: MessageId.make("assistant:item-1:segment:1"),
        text: "text",
        streaming: false,
        updatedAt: at,
      },
    ];
    expect(historyMessagesToRestore(thread(segments), history, at)).toEqual([]);
    const user = {
      ...message,
      id: MessageId.make("local-user"),
      role: "user" as const,
      text: "question",
      streaming: false,
      updatedAt: at,
    };
    expect(
      historyMessagesToRestore(
        thread([user]),
        { ...history, messages: [{ ...user, id: MessageId.make("user:remote") }] },
        at,
      ),
    ).toEqual([]);
  });
});

describe("provider history recovery of attachment deliveries", () => {
  const fence = '```ryco-attachments\n{"files":[{"path":"hello.txt","name":"hello.txt"}]}\n```';
  const delivered = {
    ...message,
    text: "OK",
    attachments: [
      {
        type: "file" as const,
        id: "thread-1-8a720b02-d57d-e14a-be64-160a759fb6ec-txt",
        name: "hello.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      },
    ],
    streaming: false,
    updatedAt: at,
  } satisfies OrchestrationMessage;
  const withFence = (text: string): ProviderThreadHistory => ({
    ...history,
    messages: [{ ...message, text }],
  });

  it("leaves a delivered reply alone although the transcript still has its manifest", () => {
    expect(historyMessagesToRestore(thread([delivered]), withFence(`OK\n\n${fence}`), at)).toEqual(
      [],
    );
  });

  it("keeps delivery failure notices that live completion appended", () => {
    const failed = {
      ...delivered,
      text: "OK\n\nAttachment 1 could not be delivered. Check that the file exists.",
      attachments: [],
    };
    expect(historyMessagesToRestore(thread([failed]), withFence(`OK\n\n${fence}`), at)).toEqual([]);
    const onlyNotice = { ...failed, text: "Attachment 1 could not be delivered." };
    expect(historyMessagesToRestore(thread([onlyNotice]), withFence(fence), at)).toEqual([]);
  });

  it("strips the manifest from recovered text without replacing existing attachments", () => {
    // An earlier recovery wrote the raw manifest over a delivered reply.
    const leaked = { ...delivered, text: `OK\n\n${fence}` };
    const repaired = historyMessagesToRestore(thread([leaked]), withFence(`OK\n\n${fence}`), at);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ id: delivered.id, text: "OK", streaming: false });
    // Restores carry no attachment list, so the projection keeps the delivered files.
    expect(repaired[0]).not.toHaveProperty("attachments");
    expect(
      historyMessagesToRestore(
        thread([{ ...delivered, ...repaired[0]! }]),
        withFence(`OK\n\n${fence}`),
        at,
      ),
    ).toEqual([]);

    const streaming = { ...message, text: "OK\n\n```ryco-att", streaming: true, updatedAt: at };
    expect(historyMessagesToRestore(thread([streaming]), withFence(`OK\n\n${fence}`), at)).toEqual([
      { ...streaming, text: "OK", streaming: false },
    ]);
    expect(historyMessagesToRestore(thread(), withFence(`OK\n\n${fence}`), at)[0]?.text).toBe("OK");
  });

  it("reports an invalid manifest exactly like live completion", () => {
    const restored = historyMessagesToRestore(
      thread(),
      withFence("Done.\n\n```ryco-attachments\nnot json\n```"),
      at,
    );
    expect(restored.map((entry) => entry.text)).toEqual([
      "Done.\n\nAn attachment could not be delivered: invalid file list (maximum 8 files).",
    ]);
  });

  it("strips the manifest from the final segment of a paused reply", () => {
    const segments = [
      { ...message, text: "hello ", streaming: false, updatedAt: at },
      {
        ...message,
        id: MessageId.make("assistant:item-1:segment:1"),
        text: "wor",
        streaming: true,
        updatedAt: at,
      },
    ];
    const recovered = withFence(`hello world\n\n${fence}`);
    const repaired = historyMessagesToRestore(thread(segments), recovered, at);
    expect(repaired).toEqual([{ ...segments[1], text: "world", streaming: false }]);
    expect(historyMessagesToRestore(thread([segments[0]!, repaired[0]!]), recovered, at)).toEqual(
      [],
    );
  });

  it("does not treat a quoted manifest example as a delivery", () => {
    const example = `Use this format:\n\n\`\`\`\`markdown\n${fence}\n\`\`\`\``;
    expect(historyMessagesToRestore(thread(), withFence(example), at)[0]?.text).toBe(example);
  });
});

it("never restores question callbacks or settlements from provider history", () => {
  const recovered: OrchestrationThreadActivity[] = [
    "user-input.requested",
    "user-input.resolved",
    "user-input.response.submitted",
    "provider.user-input.respond.failed",
    "approval.requested",
    "approval.resolved",
    "tool.completed",
  ].map((kind) => ({
    id: EventId.make(kind),
    kind,
    summary: kind,
    tone: "info",
    turnId,
    createdAt: at,
    payload: { requestId: "reused-id" },
  }));
  expect(
    missingHistoryActivities({ ...thread(), activities: [] }, recovered).map(
      (activity) => activity.kind,
    ),
  ).toEqual(["tool.completed"]);
});

describe("provider history recovery of a native fork", () => {
  // A Codex fork's native thread repeats the source's turns (same turn and item ids) before
  // its own; the fork already shows those turns as inherited copies under its own ids.
  const forkId = ThreadId.make("fork-1");
  const inheritedTurn = TurnId.make("turn-inherited");
  const ownTurn = TurnId.make("turn-own");
  const inherited = (sourceItemId: string, role: "user" | "assistant", text: string) => ({
    id: MessageId.make(
      inheritedItemId({ forkThreadId: forkId, sourceThreadId: "source-1", sourceItemId }),
    ),
    role,
    text,
    turnId: inheritedTurn,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  });
  const fork = (messages: readonly OrchestrationMessage[]) => ({
    id: forkId,
    createdAt: at,
    messages,
    activities: [] as OrchestrationThreadActivity[],
  });
  const nativeHistory: ProviderThreadHistory = {
    messages: [
      {
        ...message,
        id: MessageId.make("user:inherited"),
        role: "user",
        text: "question",
        turnId: inheritedTurn,
      },
      // Even a reply the fork's copy does not match textually is never restored.
      {
        ...message,
        id: MessageId.make("assistant:inherited"),
        text: "answer v2",
        turnId: inheritedTurn,
      },
      { ...message, id: MessageId.make("assistant:own"), text: "own reply", turnId: ownTurn },
    ],
    items: [],
    completedTurnIds: [inheritedTurn, ownTurn],
    failedTurnIds: [],
  };

  it("restores nothing for inherited turns and still repairs the fork's own", () => {
    const copies = [
      inherited("user-source", "user", "question"),
      inherited("assistant:inherited", "assistant", "answer"),
    ];
    const restored = historyMessagesToRestore(fork(copies), nativeHistory, at);
    expect(restored.map((entry) => entry.id)).toEqual(["history:fork-1:assistant:own"]);
    expect(historyMessagesToRestore(fork([...copies, ...restored]), nativeHistory, at)).toEqual([]);
  });

  it("never rewrites an inherited copy of a native message", () => {
    // An inherited copy without a turn: only its id identifies the native message.
    const copy = { ...inherited("assistant:own", "assistant", "own"), turnId: null };
    expect(
      historyMessagesToRestore(
        fork([copy]),
        { ...nativeHistory, messages: nativeHistory.messages.slice(2) },
        at,
      ),
    ).toEqual([]);
  });

  it("never restores activities of inherited turns", () => {
    const recovered: OrchestrationThreadActivity[] = [inheritedTurn, ownTurn].map((turn) => ({
      id: EventId.make(`history:${turn}:reasoning`),
      kind: "task.started",
      summary: "Task started",
      tone: "info",
      turnId: turn,
      createdAt: at,
      payload: {},
    }));
    const thread = fork([inherited("assistant:inherited", "assistant", "answer")]);
    expect(missingHistoryActivities(thread, recovered).map((activity) => activity.turnId)).toEqual([
      ownTurn,
    ]);
  });
});
