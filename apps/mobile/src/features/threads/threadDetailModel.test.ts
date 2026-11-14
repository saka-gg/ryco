import {
  FOLLOW_UP_ON_ITS_WAY_REASON,
  type FollowUpQueueRow,
} from "@ryco/client-runtime/state/message-queue";
import type { ChatFileUploadRecord } from "@ryco/client-runtime/state/composer";
import { EnvironmentId, MessageId, ThreadId, TurnId } from "@ryco/contracts/base-schemas";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DraftComposerFileAttachment } from "../../lib/composerFiles";

import {
  claudeCacheSummary,
  composerAttachmentsTotalBytes,
  delegatedChildAttention,
  floatingThreadAttention,
  queuedRowEditUnavailableReason,
  SERVER_QUEUE_EDIT_IN_PROGRESS,
  serverQueueEditView,
  threadErrorBannerMessage,
  threadHasStarted,
  threadSessionPhase,
  threadWorkspaceTools,
  visibleFailedTurnNotice,
  withUploadedFileTokens,
} from "./threadDetailModel";

// The model reads composer attachments through `lib/composerFiles`, whose ids come from expo-crypto.
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));

const FAILED = { turnId: "turn-1", title: "The last turn failed", detail: "Rate limited" };

describe("threadSessionPhase", () => {
  it("keeps running, connecting and ready, and reads anything else as disconnected", () => {
    expect(threadSessionPhase("running")).toBe("running");
    expect(threadSessionPhase("connecting")).toBe("connecting");
    expect(threadSessionPhase("ready")).toBe("ready");
    expect(threadSessionPhase("error")).toBe("disconnected");
    expect(threadSessionPhase(undefined)).toBe("disconnected");
  });
});

describe("failed turn notice and error banner", () => {
  it("hides a notice dismissed for its turn only", () => {
    expect(visibleFailedTurnNotice(FAILED, null)).toBe(FAILED);
    expect(visibleFailedTurnNotice(FAILED, "turn-0")).toBe(FAILED);
    expect(visibleFailedTurnNotice(FAILED, "turn-1")).toBeNull();
    expect(visibleFailedTurnNotice(null, null)).toBeNull();
  });

  it("leaves out of the error banner what the notice already says", () => {
    expect(threadErrorBannerMessage("Rate limited", FAILED)).toBeNull();
    expect(threadErrorBannerMessage("Other", FAILED)).toBe("Other");
    expect(threadErrorBannerMessage("Rate limited", null)).toBe("Rate limited");
    expect(threadErrorBannerMessage(null, null)).toBeNull();
  });
});

describe("floatingThreadAttention", () => {
  const none = { approvals: 0, agentControlProposals: 0, userInputs: 0, secretRequests: 0 };

  it("puts approvals and proposals before questions and secret requests", () => {
    expect(floatingThreadAttention(none)).toBeNull();
    expect(floatingThreadAttention({ ...none, secretRequests: 1 })).toBe("question");
    expect(floatingThreadAttention({ ...none, userInputs: 1 })).toBe("question");
    expect(floatingThreadAttention({ ...none, userInputs: 1, agentControlProposals: 1 })).toBe(
      "approval",
    );
    expect(floatingThreadAttention({ ...none, approvals: 2 })).toBe("approval");
  });
});

describe("delegatedChildAttention", () => {
  it("picks the first waiting row that links a chat", () => {
    expect(
      delegatedChildAttention([
        { tone: "attention", childThreadId: null, label: "Unlinked" },
        { tone: "working", childThreadId: "child-1", label: "Working" },
        { tone: "attention", childThreadId: "child-2", label: "Waits" },
        { tone: "attention", childThreadId: "child-3", label: "Later" },
      ]),
    ).toEqual({ threadId: "child-2", title: "Waits" });
    expect(delegatedChildAttention([])).toBeNull();
  });
});

describe("composerAttachmentsTotalBytes", () => {
  it("counts every attachment but a file waiting to be re-attached", () => {
    expect(
      composerAttachmentsTotalBytes([
        {
          type: "file",
          id: "a",
          name: "a.txt",
          mimeType: "text/plain",
          sizeBytes: 10,
          readUri: "file:///a.txt",
        },
        {
          type: "file",
          id: "b",
          name: "b.txt",
          mimeType: "text/plain",
          sizeBytes: 100,
          readUri: "file:///b.txt",
          uploadState: "needsReattach",
        },
      ]),
    ).toBe(10);
  });
});

describe("queuedRowEditUnavailableReason", () => {
  const row = (overrides: Partial<FollowUpQueueRow>): FollowUpQueueRow => ({
    id: "message-1",
    source: "server",
    summary: "Next",
    status: "queued",
    failureDetail: null,
    author: "user",
    ...overrides,
  });

  it("refuses a second server entry while one is edited", () => {
    expect(
      queuedRowEditUnavailableReason(row({}), {
        serverQueueEditActive: true,
        composerAttachmentCount: 0,
      }),
    ).toBe(SERVER_QUEUE_EDIT_IN_PROGRESS);
  });

  it("refuses a row on its way to the node's queue", () => {
    expect(
      queuedRowEditUnavailableReason(row({ status: "moving" }), {
        serverQueueEditActive: false,
        composerAttachmentCount: 0,
      }),
    ).toBe(FOLLOW_UP_ON_ITS_WAY_REASON);
  });

  it("allows an idle row when the composer holds no attachments", () => {
    expect(
      queuedRowEditUnavailableReason(row({ source: "local" }), {
        serverQueueEditActive: true,
        composerAttachmentCount: 0,
      }),
    ).toBeNull();
  });
});

describe("threadWorkspaceTools", () => {
  it("offers each tool only where the node and the thread have it", () => {
    expect(
      threadWorkspaceTools({
        headerModel: { filesVisible: true, terminalVisible: false },
        capabilities: { projectContentSearch: true, worktreeNotes: true },
        nodeBrowserAvailable: false,
        hasProject: true,
        hasCheckout: false,
        deviceAvailability: { kind: "unsupported-platform" },
      }),
    ).toEqual({
      findInFiles: true,
      scripts: false,
      servers: false,
      notes: false,
      devices: false,
    });
    expect(
      threadWorkspaceTools({
        headerModel: null,
        capabilities: undefined,
        nodeBrowserAvailable: true,
        hasProject: true,
        hasCheckout: true,
        deviceAvailability: { kind: "available" },
      }),
    ).toEqual({
      findInFiles: false,
      scripts: false,
      servers: true,
      notes: false,
      devices: true,
    });
  });
});

describe("threadHasStarted", () => {
  it("is started by a turn, a message or a session", () => {
    const idle = { latestTurn: null, messages: [], session: null };
    expect(threadHasStarted(idle)).toBe(false);
    expect(
      threadHasStarted({
        ...idle,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: "2026-11-14T10:00:00.000Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    ).toBe(true);
  });
});

describe("claudeCacheSummary", () => {
  it("says nothing for other providers and Unknown before Claude reports", () => {
    expect(claudeCacheSummary("codex", undefined)).toBeNull();
    expect(claudeCacheSummary(null, undefined)).toBeNull();
    expect(claudeCacheSummary("claudeAgent", undefined)).toBe("Unknown");
  });
});

describe("withUploadedFileTokens", () => {
  const file: DraftComposerFileAttachment = {
    type: "file",
    id: "file-1",
    name: "a.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    readUri: "file:///a.txt",
  };
  const record = (status: ChatFileUploadRecord["status"]): ChatFileUploadRecord => ({
    attachmentId: "file-1",
    threadId: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("environment-1"),
    name: "a.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    readBytes: () => new Uint8Array(),
    status,
  });

  it("puts an uploaded file's token on its row", () => {
    const next = withUploadedFileTokens(
      [file],
      new Map([["file-1", record({ kind: "uploaded", uploadToken: "token", expiresAt: "later" })]]),
    );
    expect(next).toEqual([{ ...file, uploadToken: "token", expiresAt: "later" }]);
  });

  it("keeps the same array while nothing changed", () => {
    const current = [{ ...file, uploadToken: "token", expiresAt: "later" }];
    expect(
      withUploadedFileTokens(
        current,
        new Map([
          ["file-1", record({ kind: "uploaded", uploadToken: "token", expiresAt: "later" })],
        ]),
      ),
    ).toBe(current);
    expect(
      withUploadedFileTokens(current, new Map([["file-1", record({ kind: "pending" })]])),
    ).toBe(current);
  });
});

describe("serverQueueEditView", () => {
  const edit = {
    threadKey: "env\u0000thread-1",
    messageId: MessageId.make("message-1"),
    revision: 2,
    keptAttachmentIds: [],
  };

  it("drops another thread's edit", () => {
    expect(
      serverQueueEditView({
        edit,
        threadKey: "env\u0000thread-2",
        queue: null,
        detailLoaded: true,
        saving: null,
      }),
    ).toEqual({ ended: null, endedState: null, active: null });
  });

  it("keeps editing until the detail says otherwise, and ends once the entry is gone", () => {
    const base = { edit, threadKey: edit.threadKey, queue: null, saving: null };
    expect(serverQueueEditView({ ...base, detailLoaded: false })).toEqual({
      ended: null,
      endedState: null,
      active: edit,
    });
    expect(serverQueueEditView({ ...base, detailLoaded: true })).toEqual({
      ended: edit,
      endedState: "gone",
      active: null,
    });
  });
});
