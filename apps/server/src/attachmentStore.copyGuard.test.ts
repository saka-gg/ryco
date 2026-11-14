import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

// The link crosses filesystems, so the store copies; the staging file's writes make no progress.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] !== "wx") return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "write")
            return async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const { linkOrCopyAttachmentFile } = await import("./attachmentStore.ts");

let attachmentsDir: string;
beforeEach(() => {
  attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-attachment-copy-guard-"));
});
afterEach(() => {
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
});

it("fails a copy whose writes make no progress instead of spinning", async () => {
  const source = path.join(attachmentsDir, "source.bin");
  fs.writeFileSync(source, Buffer.alloc(1024, 1));
  await expect(
    linkOrCopyAttachmentFile({
      source,
      destination: path.join(attachmentsDir, "destination.bin"),
      attachmentsDir,
      sizeBytes: 1024,
      name: "source.bin",
    }),
  ).rejects.toThrow("Attachment could not be stored.");
  expect(fs.existsSync(path.join(attachmentsDir, "destination.bin"))).toBe(false);
});
