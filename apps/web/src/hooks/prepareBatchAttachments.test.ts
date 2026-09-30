import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { ComposerImageAttachment } from "../composerDraftStore";
const { createFileUploadUrl, transferBytes } = vi.hoisted(() => ({
  createFileUploadUrl: vi.fn(),
  transferBytes: vi.fn(),
}));
vi.mock("../platform/attachmentUpload", () => ({
  webChatFileUploadTransport: { createFileUploadUrl, transferBytes },
}));
vi.mock("./executeChatSendTurn", () => ({
  buildOutgoingTurnAttachments: vi.fn(async () => [
    { type: "image", name: "fixture.png", dataUrl: "data:image/png;base64,AA==" },
  ]),
}));
import { prepareBatchAttachments } from "./prepareBatchAttachments";

const environmentId = EnvironmentId.make("fixture-node");
const file = {
  id: "attachment",
  type: "file",
  file: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
  name: "fixture.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
  uploadToken: "original-token",
  previewUrl: "",
} as unknown as ComposerImageAttachment;
describe("batch file copies", () => {
  it("uses separate tokens per destination and keeps the source draft untouched", async () => {
    createFileUploadUrl.mockImplementation(async ({ threadId }) => ({
      uploadToken: `token-${threadId}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxUploadBytes: 100,
    }));
    transferBytes.mockResolvedValue({});
    const results = await Promise.all(
      ["first", "second"].map((id) =>
        prepareBatchAttachments({
          environmentId,
          threadId: ThreadId.make(id),
          attachments: [file],
          signal: new AbortController().signal,
        }),
      ),
    );
    expect(results[0]![0]!.uploadToken).toBe("token-first");
    expect(results[1]![0]!.uploadToken).toBe("token-second");
    expect(file.uploadToken).toBe("original-token");
    expect(transferBytes).toHaveBeenCalledTimes(2);
    expect(transferBytes.mock.calls[0]![0].bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("requires original bytes instead of sharing a one-use source token", async () => {
    await expect(
      prepareBatchAttachments({
        environmentId,
        threadId: ThreadId.make("first"),
        attachments: [{ ...file, file: null }],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Reattach");
  });
  it("cancels outstanding uploads and never assembles a sendable token", async () => {
    transferBytes.mockImplementation(
      ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancelled"))),
        ),
    );
    const controller = new AbortController();
    const promise = prepareBatchAttachments({
      environmentId,
      threadId: ThreadId.make("cancel"),
      attachments: [file],
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(transferBytes.mock.calls.some(([input]) => input.uploadToken === "token-cancel")).toBe(
        true,
      ),
    );
    controller.abort();
    await expect(promise).rejects.toThrow("cancelled");
  });
});
