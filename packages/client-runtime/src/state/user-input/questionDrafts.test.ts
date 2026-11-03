import { ApprovalRequestId, EnvironmentId, EventId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  addQuestionDraftAttachments,
  clearQuestionDraft,
  EMPTY_QUESTION_DRAFT,
  questionDraftKey,
  readQuestionDraft,
  removeQuestionDraftAttachment,
  setQuestionDraftAnswer,
  subscribeQuestionDrafts,
} from "./questionDrafts.ts";

const base = {
  environmentId: EnvironmentId.make("node-1"),
  threadId: ThreadId.make("thread-1"),
  requestId: ApprovalRequestId.make("optional:1"),
};

describe("question drafts", () => {
  it("keeps one draft per question generation, outside any card", () => {
    const key = questionDraftKey({
      ...base,
      userInputIdentity: { requestEventId: EventId.make("asked-1") },
    });
    // A later question reusing the provider's request id starts empty.
    const reused = questionDraftKey({
      ...base,
      userInputIdentity: { requestEventId: EventId.make("asked-2") },
    });
    const otherThread = questionDraftKey({ ...base, threadId: ThreadId.make("thread-2") });
    expect(new Set([key, reused, otherThread]).size).toBe(3);

    let notified = 0;
    const unsubscribe = subscribeQuestionDrafts(() => (notified += 1));
    setQuestionDraftAnswer(key, "0", { customAnswer: "Engineers" });
    addQuestionDraftAttachments(key, [
      { id: "file-1", name: "a.txt", mimeType: "text/plain", sizeBytes: 1 },
      { id: "file-2", name: "b.png", mimeType: "image/png", sizeBytes: 2 },
    ]);
    removeQuestionDraftAttachment(key, "file-1");
    unsubscribe();
    expect(notified).toBe(3);

    // Read again later (a remounted card, another thread shown in between): still there.
    expect(readQuestionDraft(key)).toEqual({
      answers: { "0": { customAnswer: "Engineers" } },
      attachments: [{ id: "file-2", name: "b.png", mimeType: "image/png", sizeBytes: 2 }],
    });
    expect(readQuestionDraft(reused)).toBe(EMPTY_QUESTION_DRAFT);

    // Sent: the draft goes, handing back its files so their uploads can be released.
    expect(clearQuestionDraft(key).attachments.map((attachment) => attachment.id)).toEqual([
      "file-2",
    ]);
    expect(readQuestionDraft(key)).toBe(EMPTY_QUESTION_DRAFT);
    expect(readQuestionDraft(key)).toBe(readQuestionDraft(key));
  });
});
