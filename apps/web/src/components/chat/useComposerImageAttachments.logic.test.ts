import type { ProviderDriverKind } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// Imported statically (vi.mock is hoisted above it) so the module graph loads
// while the file is collected, not inside the first test's timeout.
import { resolveComposerAttachmentRouting } from "./useComposerImageAttachments";

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
