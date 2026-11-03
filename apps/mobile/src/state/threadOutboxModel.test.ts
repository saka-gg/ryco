import type { EnvironmentId, MessageId, ModelSelection, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  isQueuedThreadMessageHeld,
  isQueuedThreadMessageMovable,
  modelSelectionsEqual,
  normalizePersistedQueuedThreadMessageAttachments,
  queuedThreadMessageFollowUpFailure,
  resolveThreadOutboxFailureAction,
  summarizeQueuedThreadMessage,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./threadOutboxModel";

function queued(
  overrides: Partial<QueuedThreadMessage> &
    Pick<QueuedThreadMessage, "messageId" | "threadId" | "createdAt">,
): QueuedThreadMessage {
  return {
    environmentId: "env-a" as EnvironmentId,
    commandId: "cmd" as never,
    text: "hi",
    attachments: [],
    ...overrides,
  } as QueuedThreadMessage;
}

describe("threadOutboxModel", () => {
  it("backs off retries exponentially, capped", () => {
    expect(threadOutboxRetryDelayMs(1)).toBe(1000);
    expect(threadOutboxRetryDelayMs(2)).toBe(2000);
    expect(threadOutboxRetryDelayMs(3)).toBe(4000);
    expect(threadOutboxRetryDelayMs(99)).toBe(16000);
  });

  it("retries transient/settings-sync/interrupted failures and discards the rest", () => {
    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: new Error("x"),
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: new Error("x"),
        interrupted: true,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: { _tag: "ConnectionTransientError" },
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: new Error("bad request"),
        interrupted: false,
      }),
    ).toBe("discard");
  });

  it("groups + dedupes messages by thread, sorted by createdAt", () => {
    const messages = [
      queued({
        messageId: "m2" as MessageId,
        threadId: "t1" as ThreadId,
        createdAt: "2026-07-24T11:00:00.000Z",
      }),
      queued({
        messageId: "m1" as MessageId,
        threadId: "t1" as ThreadId,
        createdAt: "2026-07-24T10:00:00.000Z",
      }),
      // duplicate messageId is de-duplicated (last wins)
      queued({
        messageId: "m1" as MessageId,
        threadId: "t1" as ThreadId,
        createdAt: "2026-07-24T10:00:00.000Z",
      }),
      queued({
        messageId: "m3" as MessageId,
        threadId: "t2" as ThreadId,
        createdAt: "2026-07-24T09:00:00.000Z",
      }),
    ];
    const grouped = groupQueuedThreadMessages(messages);
    const keys = Object.keys(grouped);
    expect(keys).toHaveLength(2);
    const t1 = grouped[keys.find((k) => k.endsWith("t1"))!]!;
    expect(t1.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(flattenQueuedThreadMessages(grouped)).toHaveLength(3);
  });

  it("compares model selections structurally", () => {
    const a = { instanceId: "i1", model: "m", options: [] } as unknown as ModelSelection;
    const b = { instanceId: "i1", model: "m", options: [] } as unknown as ModelSelection;
    const c = { instanceId: "i1", model: "other", options: [] } as unknown as ModelSelection;
    expect(modelSelectionsEqual(a, b)).toBe(true);
    expect(modelSelectionsEqual(a, c)).toBe(false);
  });

  describe("normalizePersistedQueuedThreadMessageAttachments", () => {
    it("keeps image rows with their dataUrl and previews from it", () => {
      const rows = normalizePersistedQueuedThreadMessageAttachments([
        {
          type: "image",
          id: "img-1",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 10,
          dataUrl: "data:image/png;base64,AA",
        },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        type: "image",
        id: "img-1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 10,
        dataUrl: "data:image/png;base64,AA",
        previewUri: "data:image/png;base64,AA",
      });
    });

    it("keeps a token-backed file row with token metadata and no byte source", () => {
      const rows = normalizePersistedQueuedThreadMessageAttachments([
        {
          type: "file",
          id: "file-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          uploadToken: "tok-1",
          expiresAt: "2026-09-06T00:00:00.000Z",
          readUri: "file:///tmp/report.pdf",
        },
      ]);
      expect(rows).toEqual([
        {
          type: "file",
          id: "file-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          readUri: "",
          expiresAt: "2026-09-06T00:00:00.000Z",
          uploadToken: "tok-1",
        },
      ]);
    });

    it("restores a file without a token as a needsReattach row", () => {
      const rows = normalizePersistedQueuedThreadMessageAttachments([
        {
          type: "file",
          id: "file-2",
          name: "video.mp4",
          mimeType: "video/mp4",
          sizeBytes: 4096,
        },
      ]);
      expect(rows).toEqual([
        {
          type: "file",
          id: "file-2",
          name: "video.mp4",
          mimeType: "video/mp4",
          sizeBytes: 4096,
          readUri: "",
          uploadState: "needsReattach",
        },
      ]);
    });

    it("drops malformed entries and images without bytes", () => {
      expect(
        normalizePersistedQueuedThreadMessageAttachments([
          null,
          "junk",
          { id: "", name: "a", mimeType: "image/png", sizeBytes: 1, dataUrl: "data:" },
          { id: "img-2", name: "a", mimeType: "image/png", sizeBytes: 1 },
          { id: "file-3", name: "b", mimeType: "video/mp4", sizeBytes: -5 },
        ]),
      ).toEqual([]);
    });
  });

  describe("moving to the node's follow-up queue", () => {
    const base = { messageId: "m1" as MessageId, threadId: "t1" as ThreadId, createdAt: "x" };

    it("moves a held message as failed with the reason it waits for", () => {
      const steer = queued({ ...base, uncertainSteerError: "The steer was cut off." });
      expect(isQueuedThreadMessageHeld(steer)).toBe(true);
      expect(queuedThreadMessageFollowUpFailure(steer)).toEqual({
        reason: "steer-uncertain",
        detail: "The steer was cut off.",
      });
      const review = queued({ ...base, resumeReviewError: "Review the resume first." });
      expect(queuedThreadMessageFollowUpFailure(review)).toEqual({
        reason: "start-failed",
        detail: "Review the resume first.",
      });
      // A long provider error is cut to the contract's limit.
      expect(
        queuedThreadMessageFollowUpFailure(
          queued({ ...base, uncertainSteerError: "e".repeat(2_000) }),
        )?.detail,
      ).toHaveLength(1_000);
      const plain = queued(base);
      expect(isQueuedThreadMessageHeld(plain)).toBe(false);
      expect(queuedThreadMessageFollowUpFailure(plain)).toBeUndefined();
    });

    it("keeps a saved request with the retired project memory on the device", () => {
      const retired = { ...queued(base), projectMemory: { enabled: true } } as QueuedThreadMessage;
      expect(isQueuedThreadMessageMovable(retired)).toBe(false);
      expect(isQueuedThreadMessageHeld(retired)).toBe(true);
      expect(isQueuedThreadMessageMovable(queued(base))).toBe(true);
    });

    it("labels a queued message by its text, else its attachments", () => {
      expect(summarizeQueuedThreadMessage({ text: "  Run the tests  ", attachments: [] })).toBe(
        "Run the tests",
      );
      expect(summarizeQueuedThreadMessage({ text: "x".repeat(120), attachments: [] })).toBe(
        `${"x".repeat(89)}…`,
      );
      expect(summarizeQueuedThreadMessage({ text: "", attachments: [] })).toBe("Queued message");
    });
  });
});
