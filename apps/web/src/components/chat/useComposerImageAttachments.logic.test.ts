import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ProviderDriverKind,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// Imported statically (vi.mock is hoisted above it) so the module graph loads
// while the file is collected, not inside the first test's timeout.
import {
  planDirectComposerAttachments,
  resolveComposerAttachmentRouting,
} from "./useComposerImageAttachments";

vi.mock("@ryco/shared/providerCapabilities", () => ({
  providerSupportsGeneralFileAttachments: vi.fn(
    (provider: { toString(): string }) =>
      provider.toString() === "copilot" || provider.toString() === "opencode",
  ),
}));

const CODEX = "codex" as ProviderDriverKind;

function makeFile(name: string, type: string): File {
  return new File(["data"], name, { type });
}

describe("resolveComposerAttachmentRouting", () => {
  it("attaches every file directly when the environment advertises fileAttachments", () => {
    const image = makeFile("shot.png", "image/png");
    const doc = makeFile("notes.pdf", "application/pdf");
    const routing = resolveComposerAttachmentRouting({
      fileUploadMaxBytes: 25 * 1024 * 1024,
      selectedProvider: CODEX,
      files: [image, doc],
    });
    expect(routing.direct).toEqual([image, doc]);
    expect(routing.references).toEqual([]);
  });

  it("falls back to file references for non-images when the capability is absent", () => {
    const image = makeFile("shot.png", "image/png");
    const doc = makeFile("notes.pdf", "application/pdf");
    const routing = resolveComposerAttachmentRouting({
      fileUploadMaxBytes: null,
      selectedProvider: CODEX,
      files: [image, doc],
    });
    expect(routing.direct).toEqual([image]);
    expect(routing.references).toEqual([doc]);
  });

  it("attaches files inline (dataUrl) when the legacy provider gate allows it", () => {
    const doc = makeFile("notes.pdf", "application/pdf");
    const routing = resolveComposerAttachmentRouting({
      fileUploadMaxBytes: null,
      selectedProvider: "copilot" as ProviderDriverKind,
      files: [doc],
    });
    expect(routing.direct).toEqual([doc]);
    expect(routing.references).toEqual([]);
  });
});

describe("planDirectComposerAttachments", () => {
  const text = (name: string, size: number) =>
    new File(["x".repeat(size)], name, { type: "text/plain" });
  const summary = (plan: ReturnType<typeof planDirectComposerAttachments>) =>
    plan.accepted.map(({ name, streamsUpload }) => ({ name, streamsUpload }));

  it("streams files where the environment takes uploads, unless told to keep them inline", () => {
    const files = [text("notes.txt", 10), makeFile("shot.png", "image/png")];
    const streamed = planDirectComposerAttachments({
      files,
      existing: [],
      fileUploadMaxBytes: 1024,
      streamFiles: true,
    });
    expect(summary(streamed)).toEqual([
      { name: "notes.txt", streamsUpload: true },
      { name: "shot.png", streamsUpload: false },
    ]);
    const inline = planDirectComposerAttachments({
      files,
      existing: [],
      fileUploadMaxBytes: 1024,
      streamFiles: false,
    });
    expect(summary(inline)).toEqual([
      { name: "notes.txt", streamsUpload: false },
      { name: "shot.png", streamsUpload: false },
    ]);
  });

  it("holds an inline file to the send limit, not the environment's upload limit", () => {
    const large = text("pasted-text.txt", 2048);
    expect(
      planDirectComposerAttachments({
        files: [large],
        existing: [],
        fileUploadMaxBytes: 1024,
        streamFiles: true,
      }).error,
    ).toContain("1KB attachment limit");
    expect(
      planDirectComposerAttachments({
        files: [large],
        existing: [],
        fileUploadMaxBytes: 1024,
        streamFiles: false,
      }).accepted,
    ).toHaveLength(1);
  });

  it("rejects files past the message's count and total size", () => {
    const full = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, () => ({
      sizeBytes: 1,
    }));
    const overCount = planDirectComposerAttachments({
      files: [text("a.txt", 1)],
      existing: full,
      fileUploadMaxBytes: null,
      streamFiles: false,
    });
    expect(overCount.accepted).toEqual([]);
    expect(overCount.error).toBe(
      `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    );
    const overTotal = planDirectComposerAttachments({
      files: [text("b.txt", 10)],
      existing: [{ sizeBytes: PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES - 5 }],
      fileUploadMaxBytes: null,
      streamFiles: false,
    });
    expect(overTotal.accepted).toEqual([]);
    expect(overTotal.error).toContain("Attachments can total at most");
  });
});
