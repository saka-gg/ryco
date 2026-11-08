import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@ryco/contracts";

const files = new Map<string, { base64: string; deleted: boolean }>();

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    async base64(): Promise<string> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return entry.base64;
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }
  },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  draftImageAttachmentFromPickerAsset,
  sniffImageMimeTypeFromBase64,
  convertPastedImagesToAttachments,
  isOwnedPastedImageUri,
  toUploadChatImageAttachments,
} from "./composerImages";

describe("toUploadChatImageAttachments", () => {
  it("strips client draft id and previewUri for the startTurn wire shape", () => {
    expect(
      toUploadChatImageAttachments([
        {
          id: "client-draft-id",
          type: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          sizeBytes: 12,
          dataUrl: "data:image/png;base64,AA==",
          previewUri: "file:///tmp/preview.png",
        },
      ]),
    ).toEqual([
      {
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AA==",
      },
    ]);
  });
});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
  });

  it("recognizes only files created in the native composer paste directory", () => {
    expect(
      isOwnedPastedImageUri(
        "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png",
      ),
    ).toBe(true);
    expect(isOwnedPastedImageUri("file:///private/var/mobile/photos/id.png")).toBe(false);
    expect(isOwnedPastedImageUri("https://example.com/t3-composer-paste/id.png")).toBe(false);
  });

  it("converts owned files to data-backed previews and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const attachments = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/png;base64,aGVsbG8=",
        previewUri: "data:image/png;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
  });

  it("deletes rejected and overflow owned files without deleting user-owned files", async () => {
    const rejected =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/bad.png";
    const overflow =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/overflow.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(rejected, { base64: "", deleted: false });
    files.set(overflow, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    await convertPastedImagesToAttachments({
      uris: [rejected, overflow, userOwned],
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(files.get(rejected)?.deleted).toBe(true);
    expect(files.get(overflow)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
  });
});

describe("draftImageAttachmentFromPickerAsset", () => {
  // The first bytes of a JPEG (FF D8 FF E0 …) and of a PNG signature.
  const JPEG_BASE64 = "/9j/4AAQSkZJRg==";
  const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";

  it("describes the payload, not the picked file", () => {
    // iOS's picker re-encodes a PNG as JPEG for base64 but reports the PNG's size and type.
    const { attachment, error } = draftImageAttachmentFromPickerAsset({
      uri: "file:///picked/screenshot.png",
      fileName: "screenshot.png",
      mimeType: "image/png",
      fileSize: 999_999,
      base64: JPEG_BASE64,
    });
    expect(error).toBeNull();
    expect(attachment).toMatchObject({
      name: "screenshot.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 10,
      dataUrl: `data:image/jpeg;base64,${JPEG_BASE64}`,
    });
  });

  it("keeps a matching type and drops whitespace from the payload", () => {
    const { attachment } = draftImageAttachmentFromPickerAsset({
      uri: "file:///a.png",
      fileName: "a.png",
      mimeType: "image/png",
      base64: `${PNG_BASE64.slice(0, 8)}\n${PNG_BASE64.slice(8)}`,
    });
    expect(attachment).toMatchObject({
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 16,
      dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    });
  });

  it("recognizes common image signatures", () => {
    expect(sniffImageMimeTypeFromBase64(JPEG_BASE64)).toBe("image/jpeg");
    expect(sniffImageMimeTypeFromBase64(PNG_BASE64)).toBe("image/png");
    expect(sniffImageMimeTypeFromBase64("AAAA")).toBeNull();
  });
});
