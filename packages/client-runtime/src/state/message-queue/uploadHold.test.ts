import { describe, expect, it } from "vite-plus/test";

import type { ChatFileUploadStatus } from "../composer/attachmentUpload.ts";
import {
  awaitsUploads,
  queueHasUploadHeldSend,
  type QueuedMessageUploadHold,
} from "./uploadHold.ts";
import {
  deriveHeldSendUploadView,
  resolveHeldSendRecovery,
  settleUploadHold,
  withoutHeldAttachment,
} from "./uploadHoldSettle.ts";

const HOLD: QueuedMessageUploadHold = { awaiting: ["a", "b"], sentAs: "send" };
const ATTACHMENTS = [
  { id: "a", name: "report.pdf" },
  { id: "b", name: "data.csv" },
  { id: "img", name: "shot.png" },
];

function statuses(map: Record<string, ChatFileUploadStatus>) {
  return (id: string) => map[id];
}

describe("upload hold", () => {
  it("waits while any upload it needs is still running", () => {
    expect(awaitsUploads({ uploadHold: HOLD })).toBe(true);
    expect(awaitsUploads({ uploadHold: { ...HOLD, awaiting: [] } })).toBe(false);
    expect(awaitsUploads({})).toBe(false);
  });

  it("keeps later sends behind a held entry until it went out, uploads finished or not", () => {
    expect(queueHasUploadHeldSend([{}, { uploadHold: { ...HOLD, awaiting: [] } }])).toBe(true);
    expect(queueHasUploadHeldSend([{}])).toBe(false);
    expect(queueHasUploadHeldSend(undefined)).toBe(false);
  });

  it("applies finished uploads one by one and goes out only after the last", () => {
    const attachments: Array<{ id: string; uploadToken?: string; expiresAt?: string }> =
      ATTACHMENTS.map((attachment) => ({ id: attachment.id }));
    const first = settleUploadHold({
      hold: HOLD,
      attachments,
      statusOf: statuses({
        a: { kind: "uploaded", uploadToken: "tok-a", expiresAt: "2026-11-13T12:00:00.000Z" },
        b: { kind: "uploading", progress: 0.4 },
      }),
    });
    expect(first?.hold.awaiting).toEqual(["b"]);
    expect(first?.attachments[0]).toEqual({
      id: "a",
      uploadToken: "tok-a",
      expiresAt: "2026-11-13T12:00:00.000Z",
    });
    expect(awaitsUploads({ uploadHold: first!.hold })).toBe(true);

    const last = settleUploadHold({
      hold: first!.hold,
      attachments: first!.attachments,
      statusOf: statuses({
        b: { kind: "uploaded", uploadToken: "tok-b", expiresAt: "2026-11-13T12:00:00.000Z" },
      }),
    });
    expect(last?.hold).toEqual({ awaiting: [], sentAs: "send" });
    expect(last?.attachments.map((attachment) => attachment.uploadToken)).toEqual([
      "tok-a",
      "tok-b",
      undefined,
    ]);
  });

  it("changes nothing while uploads run or after one failed", () => {
    expect(
      settleUploadHold({
        hold: HOLD,
        attachments: ATTACHMENTS,
        statusOf: statuses({
          a: { kind: "uploading", progress: 0.2 },
          b: { kind: "failed", retryable: true, message: "Network error" },
        }),
      }),
    ).toBeNull();
  });

  it("shows which file failed and whether it can be retried", () => {
    const view = deriveHeldSendUploadView({
      hold: HOLD,
      attachments: ATTACHMENTS,
      statusOf: statuses({
        a: { kind: "uploading", progress: 0.5 },
        b: { kind: "failed", retryable: true, message: "Network error", label: "Upload failed" },
      }),
    });
    expect(view.failed).toBe(true);
    expect(view.uploads).toEqual([
      { id: "a", name: "report.pdf", kind: "uploading", progress: 0.5 },
      { id: "b", name: "data.csv", kind: "failed", message: "Upload failed", retryable: true },
    ]);
  });

  it("treats an upload that is gone as a file to attach again, never as sent", () => {
    const view = deriveHeldSendUploadView({
      hold: { awaiting: ["a"], sentAs: "queue" },
      attachments: ATTACHMENTS,
      statusOf: () => undefined,
    });
    expect(view.failed).toBe(true);
    expect(view.uploads[0]).toMatchObject({ id: "a", kind: "failed", retryable: false });
  });

  it("sends without a removed file and stops waiting for it", () => {
    const next = withoutHeldAttachment({ hold: HOLD, attachments: ATTACHMENTS, attachmentId: "b" });
    expect(next.hold.awaiting).toEqual(["a"]);
    expect(next.attachments.map((attachment) => attachment.id)).toEqual(["a", "img"]);
  });
});

describe("held send recovery after a reload", () => {
  const view = (ids: string[], detailLoaded = true) => ({
    detailLoaded,
    projectedMessageIds: new Set(ids),
  });

  it("waits for a live shell before deciding", () => {
    expect(
      resolveHeldSendRecovery({
        messageId: "m",
        shellLive: false,
        view: null,
        serverQueueMessageIds: new Set(),
      }),
    ).toBe("wait");
  });

  it("restores a first message whose thread was never created", () => {
    expect(
      resolveHeldSendRecovery({
        messageId: "m",
        shellLive: true,
        view: null,
        serverQueueMessageIds: new Set(),
      }),
    ).toBe("restore");
  });

  it("reads the thread's messages before deciding", () => {
    expect(
      resolveHeldSendRecovery({
        messageId: "m",
        shellLive: true,
        view: view([], false),
        serverQueueMessageIds: new Set(),
      }),
    ).toBe("load-detail");
  });

  it("drops a message the thread already has, sent or queued on the node", () => {
    expect(
      resolveHeldSendRecovery({
        messageId: "m",
        shellLive: true,
        view: view(["m"]),
        serverQueueMessageIds: new Set(),
      }),
    ).toBe("sent");
    expect(
      resolveHeldSendRecovery({
        messageId: "m",
        shellLive: true,
        view: view([], false),
        serverQueueMessageIds: new Set(["m"]),
      }),
    ).toBe("sent");
  });

  it("restores a message the thread does not have", () => {
    expect(
      resolveHeldSendRecovery({
        messageId: "m",
        shellLive: true,
        view: view(["other"]),
        serverQueueMessageIds: new Set(),
      }),
    ).toBe("restore");
  });
});
