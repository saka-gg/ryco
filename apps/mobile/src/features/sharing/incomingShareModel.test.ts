import { describe, expect, it } from "vite-plus/test";

import {
  buildIncomingShareDraft,
  fallbackShareName,
  incomingShareText,
  INCOMING_SHARE_NEW_TASK_PATH,
  isShareFileUriUnderOwnedRoots,
  mergeIncomingShareText,
  rewriteIncomingSharePath,
  type IncomingShareFileAccess,
  type IncomingSharePayload,
} from "./incomingShareModel";

function files(sizes: Record<string, number | null>): IncomingShareFileAccess & {
  readonly copied: string[];
} {
  const copied: string[] = [];
  let next = 0;
  return {
    copied,
    readBase64: async () => "QUJD",
    readSize: async (uri) => sizes[uri] ?? null,
    copyToOwned: async (uri, name) => {
      copied.push(uri);
      return `file:///cache/incoming-shares/${name}`;
    },
    newId: () => `id-${(next += 1)}`,
  };
}

describe("incomingShareText", () => {
  it("joins shared text and links once each", () => {
    const payloads: IncomingSharePayload[] = [
      { shareType: "text", value: " Look at this " },
      { shareType: "url", value: "https://ryco.dev" },
      { shareType: "text", value: "Look at this" },
      { shareType: "image", value: "file:///a.png" },
    ];
    expect(incomingShareText(payloads)).toBe("Look at this\n\nhttps://ryco.dev");
  });
});

describe("buildIncomingShareDraft", () => {
  it("inlines small images and copies other files into app storage", async () => {
    const access = files({ "file:///tmp/a.png": 3, "file:///tmp/report.pdf": 2048 });
    const draft = await buildIncomingShareDraft({
      payloads: [
        { shareType: "text", value: "Summarize" },
        { shareType: "image", value: "file:///tmp/a.png", mimeType: "image/png" },
        { shareType: "file", value: "file:///tmp/report.pdf", mimeType: "application/pdf" },
      ],
      resolvedPayloads: [],
      files: access,
    });
    expect(draft.text).toBe("Summarize");
    expect(draft.warnings).toEqual([]);
    expect(draft.attachments).toEqual([
      {
        type: "image",
        id: "id-1",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,QUJD",
        previewUri: "data:image/png;base64,QUJD",
      },
      {
        type: "file",
        id: "id-2",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        readUri: "file:///cache/incoming-shares/report.pdf",
      },
    ]);
    expect(access.copied).toEqual(["file:///tmp/report.pdf"]);
  });

  it("uses resolved names and sizes and sends HEIC photos as files", async () => {
    const draft = await buildIncomingShareDraft({
      payloads: [{ shareType: "image", value: "file:///tmp/IMG.HEIC" }],
      resolvedPayloads: [
        {
          shareType: "image",
          value: "file:///tmp/IMG.HEIC",
          contentUri: "file:///tmp/IMG.HEIC",
          contentMimeType: "image/heic",
          originalName: "Holiday.heic",
          contentSize: 4096,
        },
      ],
      files: files({}),
    });
    expect(draft.attachments).toMatchObject([
      { type: "file", name: "Holiday.heic", sizeBytes: 4096 },
    ]);
  });

  it("warns about unreadable, oversized and surplus items", async () => {
    const big = 60 * 1024 * 1024;
    const payloads: IncomingSharePayload[] = [
      { shareType: "file", value: "file:///tmp/empty.bin" },
      { shareType: "video", value: "file:///tmp/huge.mov", mimeType: "video/quicktime" },
      ...Array.from({ length: 9 }, (_, index) => ({
        shareType: "file" as const,
        value: `file:///tmp/f${index}.txt`,
        mimeType: "text/plain",
      })),
    ];
    const sizes: Record<string, number> = { "file:///tmp/huge.mov": big };
    for (let index = 0; index < 9; index += 1) sizes[`file:///tmp/f${index}.txt`] = 10;
    const draft = await buildIncomingShareDraft({
      payloads,
      resolvedPayloads: [],
      files: files(sizes),
    });
    expect(draft.attachments).toHaveLength(8);
    expect(draft.warnings).toEqual([
      "'empty.bin' is empty or could not be read.",
      "'huge.mov' is larger than the 50 MB file limit.",
      "Only the first 8 shared items were attached.",
    ]);
  });
});

describe("helpers", () => {
  it("names unnamed files by kind", () => {
    expect(fallbackShareName("content://x/", 0, "image/jpeg")).toBe("shared-image-1.jpeg");
    expect(fallbackShareName("file:///a/b%20c.txt", 2, "text/plain")).toBe("b c.txt");
  });

  it("deletes only inside the app's own directories", () => {
    const roots = ["file:///private/var/mobile/Containers/Data/App/Library/Caches/"];
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///var/mobile/Containers/Data/App/Library/Caches/x",
        roots,
      ),
    ).toBe(true);
    expect(isShareFileUriUnderOwnedRoots("file:///var/mobile/Documents/original.pdf", roots)).toBe(
      false,
    );
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///var/mobile/Containers/Data/App/Library/Caches/../../x",
        roots,
      ),
    ).toBe(false);
  });

  it("appends shared text after the user's own and maps the hand-off link", () => {
    expect(mergeIncomingShareText("", "hi")).toBe("hi");
    expect(mergeIncomingShareText("Mine ", "hi")).toBe("Mine\n\nhi");
    expect(rewriteIncomingSharePath("expo-sharing")).toBe(INCOMING_SHARE_NEW_TASK_PATH);
    expect(rewriteIncomingSharePath("/expo-sharing?x=1")).toBe(INCOMING_SHARE_NEW_TASK_PATH);
    expect(rewriteIncomingSharePath("tasks/new")).toBe("tasks/new");
  });
});
