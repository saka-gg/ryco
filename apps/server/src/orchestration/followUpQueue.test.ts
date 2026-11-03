import {
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type QueuedFollowUp,
  type ThreadFollowUpQueue,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectFollowUpQueueEvent,
  reorderEntries,
  type FollowUpQueueEventDraft,
} from "./followUpQueue.ts";

const threadId = ThreadId.make("thread-1");
const at = "2026-10-24T10:00:00.000Z";
const entry = (id: string, overrides: Partial<QueuedFollowUp> = {}): QueuedFollowUp => ({
  messageId: MessageId.make(id),
  text: id,
  attachments: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: at,
  updatedAt: at,
  revision: 1,
  status: "queued",
  author: "user",
  ...overrides,
});

const EMPTY: ThreadFollowUpQueue = { entries: [], hold: null };
const fold = (events: ReadonlyArray<FollowUpQueueEventDraft>, replay = false) =>
  events.reduce<ThreadFollowUpQueue>((queue, event) => {
    const once = projectFollowUpQueueEvent(queue, event) ?? EMPTY;
    return replay ? (projectFollowUpQueueEvent(once, event) ?? EMPTY) : once;
  }, EMPTY);

const events: ReadonlyArray<FollowUpQueueEventDraft> = [
  {
    type: "thread.queue-entry-added",
    payload: { threadId, entry: entry("a"), beforeMessageId: null },
  },
  {
    type: "thread.queue-entry-added",
    payload: { threadId, entry: entry("b"), beforeMessageId: null },
  },
  {
    type: "thread.queue-entry-added",
    payload: { threadId, entry: entry("c"), beforeMessageId: MessageId.make("a") },
  },
  {
    type: "thread.queue-entry-edited",
    payload: { threadId, entry: entry("b", { text: "edited", revision: 2 }) },
  },
  {
    type: "thread.queue-reordered",
    payload: {
      threadId,
      order: [MessageId.make("b"), MessageId.make("c"), MessageId.make("a")],
      updatedAt: at,
    },
  },
  {
    type: "thread.queue-entry-failed",
    payload: {
      threadId,
      messageId: MessageId.make("c"),
      revision: 2,
      failure: { reason: "steer-uncertain", detail: null },
      updatedAt: at,
    },
  },
  {
    type: "thread.queue-held",
    payload: {
      threadId,
      hold: { reason: "paused", detail: null, causeKeys: ["paused:1"], heldAt: at },
      updatedAt: at,
    },
  },
  {
    type: "thread.queue-entries-removed",
    payload: { threadId, messageIds: [MessageId.make("a")], reason: "user", updatedAt: at },
  },
];

describe("follow-up queue projection", () => {
  it("applies each event as a plain replace, so replaying any of them changes nothing", () => {
    const queue = fold(events);
    expect(queue.entries.map((candidate) => [candidate.messageId, candidate.text])).toEqual([
      ["b", "edited"],
      ["c", "c"],
    ]);
    expect(queue.entries[1]).toMatchObject({ status: "failed", revision: 2 });
    expect(queue.hold?.reason).toBe("paused");
    expect(fold(events, true)).toEqual(queue);
  });

  it("is absent once empty and unheld", () => {
    const released = projectFollowUpQueueEvent(
      { entries: [], hold: { reason: "paused", detail: null, causeKeys: ["x"], heldAt: at } },
      {
        type: "thread.queue-released",
        payload: { threadId, acknowledgedCauseKeys: ["x"], updatedAt: at },
      },
    );
    expect(released).toBeUndefined();
  });

  it("orders by the named ids and keeps the rest after them", () => {
    expect(
      reorderEntries(
        [{ messageId: "a" }, { messageId: "b" }, { messageId: "c" }],
        ["c", "missing", "a"],
      ),
    ).toEqual([{ messageId: "c" }, { messageId: "a" }, { messageId: "b" }]);
  });
});
