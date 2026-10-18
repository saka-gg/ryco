import { LOCAL_TASK_MAX_FILES, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@ryco/contracts";
import { RELAY_MAX_RPC_MESSAGE_BYTES } from "@ryco/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import {
  planTaskFileAdds,
  sanitizeTaskFileName,
  TASK_FILE_INLINE_MAX_BYTES,
} from "./taskFiles.logic";

/** A file that reports `size` bytes without holding them. */
function sized(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

const plan = (
  files: ReadonlyArray<File>,
  overrides: Partial<Parameters<typeof planTaskFileAdds>[0]> = {},
) =>
  planTaskFileAdds({
    files,
    heldCount: 0,
    heldBytes: 0,
    streamingMaxBytes: 50 * 1024 * 1024,
    inlineMaxBytes: null,
    ...overrides,
  });

describe("planTaskFileAdds", () => {
  it("takes files within a message's limits", () => {
    const result = plan([sized("shot.png", "image/png", 10), sized("spec.pdf", "", 20)]);
    expect(result.error).toBeNull();
    expect(result.accepted.map((file) => [file.name, file.type, file.mimeType])).toEqual([
      ["shot.png", "image", "image/png"],
      ["spec.pdf", "file", "application/octet-stream"],
    ]);
  });

  it("refuses an image over the image limit and files past the task's count", () => {
    const result = plan(
      [sized("huge.png", "image/png", PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1)],
      {},
    );
    expect(result.accepted).toEqual([]);
    expect(result.error).toContain("huge.png");
    expect(plan([sized("a.txt", "text/plain", 1)], { heldCount: LOCAL_TASK_MAX_FILES }).error).toBe(
      `A task holds up to ${LOCAL_TASK_MAX_FILES} files.`,
    );
  });

  it("refuses a file that would not fit one relay message when it goes inline", () => {
    // A 4 MB PDF is fine to stream, but its data URL is past the relay's message limit.
    const pdf = sized("manual.pdf", "application/pdf", 4_000_000);
    expect(plan([pdf]).accepted).toHaveLength(1);
    const inline = plan([pdf], {
      streamingMaxBytes: null,
      inlineMaxBytes: TASK_FILE_INLINE_MAX_BYTES,
    });
    expect(inline.accepted).toEqual([]);
    expect(inline.error).toBe(
      "'manual.pdf' is larger than 3MB, the most this connection can send.",
    );
    // What it does take fits: base64 of the largest inline file stays under the limit.
    expect(Math.ceil(TASK_FILE_INLINE_MAX_BYTES / 3) * 4).toBeLessThan(RELAY_MAX_RPC_MESSAGE_BYTES);
    expect(
      plan([sized("small.pdf", "application/pdf", 1_000_000)], {
        streamingMaxBytes: null,
        inlineMaxBytes: TASK_FILE_INLINE_MAX_BYTES,
      }).accepted,
    ).toHaveLength(1);
  });
});

describe("sanitizeTaskFileName", () => {
  it("keeps names the node stores as they are", () => {
    expect(sanitizeTaskFileName("a/b\\c.txt", "file")).toBe("a_b_c.txt");
    expect(sanitizeTaskFileName("  ", "image")).toBe("image");
  });
});
