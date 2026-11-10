import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The phone's attachment files, with expo-file-system faked by an in-memory
// file tree. What it proves: an attachment is read over the transport of its
// own machine (never a URL), once for every caller asking at the same time,
// into a file named after it; a released read stops; a machine's purge drops
// its files and only its; and the previous run's files go before the first write.

const hoisted = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(),
}));

vi.mock("expo-file-system", () => {
  const { files, directories } = hoisted;
  const uriOf = (parts: ReadonlyArray<string | { uri: string }>) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  class Directory {
    readonly uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return (
        directories.has(this.uri) || [...files.keys()].some((uri) => uri.startsWith(`${this.uri}/`))
      );
    }
    create() {
      directories.add(this.uri);
    }
    delete() {
      for (const uri of directories) if (uri.startsWith(this.uri)) directories.delete(uri);
      for (const uri of files.keys()) if (uri.startsWith(`${this.uri}/`)) files.delete(uri);
    }
  }
  class File {
    readonly uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    write(content: Uint8Array) {
      files.set(this.uri, content);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  return { Directory, File, Paths: { cache: { uri: "file:///cache" } } };
});

import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";

import {
  acquireAttachmentFile,
  attachmentFileSegment,
  clearAttachmentFilesFromEarlierRuns,
  purgeAttachmentFiles,
  readStoredAttachmentFile,
  attachmentFileKey,
  resetAttachmentFilesForTests,
  type AttachmentFileReference,
} from "./attachmentFiles";

const reference = (environmentId: string, attachmentId = "att-1"): AttachmentFileReference => ({
  environmentId: environmentId as EnvironmentId,
  threadId: "thread-1" as ThreadId,
  messageId: "message-1" as MessageId,
  attachmentId,
  name: "shot.png",
  sizeBytes: 3,
});

/** A machine's attachment transport, answering one 3-byte chunk. */
function transport() {
  const readChunk = vi.fn(async (input: { offset: number }) => ({
    offset: input.offset,
    totalBytes: 3,
    dataBase64: btoa("abc"),
  }));
  return { readChunk };
}

beforeEach(() => {
  hoisted.files.clear();
  hoisted.directories.clear();
  resetAttachmentFilesForTests();
});

describe("attachment files", () => {
  it("reads over the machine's own transport once for every caller, into a named file", async () => {
    const machineA = transport();
    const machineB = transport();
    const first = acquireAttachmentFile({
      reference: reference("env-a"),
      currentTransport: () => machineA,
    });
    const second = acquireAttachmentFile({
      reference: reference("env-a"),
      currentTransport: () => machineB,
    });
    const uri = await first.promise;
    expect(await second.promise).toBe(uri);
    expect(machineA.readChunk).toHaveBeenCalledTimes(1);
    expect(machineB.readChunk).not.toHaveBeenCalled();
    expect(uri).toBe("file:///cache/attachment-files/env-a/att-1/shot.png");
    expect(new TextDecoder().decode(hoisted.files.get(uri))).toBe("abc");
    // Kept for this run: the next caller reads nothing.
    expect(readStoredAttachmentFile(attachmentFileKey(reference("env-a")))).toBe(uri);
  });

  it("fails without a connection and stops a read nobody wants anymore", async () => {
    const offline = acquireAttachmentFile({
      reference: reference("env-a"),
      currentTransport: () => undefined,
    });
    await expect(offline.promise).rejects.toThrow("Attachment connection unavailable.");

    let release!: () => void;
    const slow = {
      readChunk: vi.fn(
        () =>
          new Promise<{ offset: number; totalBytes: number; dataBase64: string }>((resolve) => {
            release = () => resolve({ offset: 0, totalBytes: 3, dataBase64: btoa("abc") });
          }),
      ),
    };
    const lease = acquireAttachmentFile({
      reference: reference("env-a", "att-2"),
      currentTransport: () => slow,
    });
    lease.release();
    release();
    await expect(lease.promise).rejects.toThrow();
    expect(readStoredAttachmentFile(attachmentFileKey(reference("env-a", "att-2")))).toBe(
      undefined,
    );
  });

  it("purges one machine's files with its device data", async () => {
    const machine = transport();
    const a = await acquireAttachmentFile({
      reference: reference("env-a"),
      currentTransport: () => machine,
    }).promise;
    const b = await acquireAttachmentFile({
      reference: reference("env-b"),
      currentTransport: () => machine,
    }).promise;
    // The device-data purge (Clear device cache, forget, sign-out) runs this.
    purgeAttachmentFiles("env-a" as EnvironmentId);
    expect(hoisted.files.has(a)).toBe(false);
    expect(hoisted.files.has(b)).toBe(true);
  });

  it("clears the previous run's files at launch, once", () => {
    hoisted.files.set("file:///cache/attachment-files/env-old/x/old.png", new Uint8Array([1]));
    clearAttachmentFilesFromEarlierRuns();
    expect(hoisted.files.size).toBe(0);
    hoisted.files.set("file:///cache/attachment-files/env-a/y/new.png", new Uint8Array([1]));
    clearAttachmentFilesFromEarlierRuns();
    expect(hoisted.files.size).toBe(1);
  });

  it("clears the previous run's files before the first write", async () => {
    hoisted.files.set("file:///cache/attachment-files/env-old/x/old.png", new Uint8Array([1]));
    const machine = transport();
    await acquireAttachmentFile({ reference: reference("env-a"), currentTransport: () => machine })
      .promise;
    expect(hoisted.files.has("file:///cache/attachment-files/env-old/x/old.png")).toBe(false);
  });

  it("keeps file names inside their folder", () => {
    expect(attachmentFileSegment("../../etc/passwd", "x")).toBe("__.._etc_passwd");
    expect(attachmentFileSegment("", "fallback")).toBe("fallback");
    expect(attachmentFileSegment("report 2026.pdf", "x")).toBe("report 2026.pdf");
  });

  it("keeps a thread's preview apart from the original the gallery opens", async () => {
    const original = transport();
    // A machine that makes previews: a 2-byte preview of the 3-byte original.
    const previews = {
      readChunk: vi.fn(async (input: { offset: number; preview?: number | undefined }) =>
        input.preview === undefined
          ? { offset: input.offset, totalBytes: 3, dataBase64: btoa("abc") }
          : { offset: input.offset, totalBytes: 2, dataBase64: btoa("pv"), preview: true },
      ),
    };
    const thumbnail = { ...reference("env-a"), preview: 512 as const };
    const previewUri = await acquireAttachmentFile({
      reference: thumbnail,
      currentTransport: () => previews,
    }).promise;
    expect(previewUri).toBe("file:///cache/attachment-files/env-a/att-1/preview-512/shot.png");
    expect(new TextDecoder().decode(hoisted.files.get(previewUri))).toBe("pv");
    expect(previews.readChunk).toHaveBeenCalledWith(expect.objectContaining({ preview: 512 }));
    expect(readStoredAttachmentFile(attachmentFileKey(reference("env-a")))).toBeUndefined();

    const originalUri = await acquireAttachmentFile({
      reference: reference("env-a"),
      currentTransport: () => original,
    }).promise;
    expect(originalUri).toBe("file:///cache/attachment-files/env-a/att-1/shot.png");
    expect(original.readChunk).toHaveBeenCalledWith(
      expect.not.objectContaining({ preview: expect.anything() }),
    );

    // A machine that makes no previews answers with the original; it shows as it is.
    const older = transport();
    const fallback = await acquireAttachmentFile({
      reference: { ...reference("env-b"), preview: 1024 },
      currentTransport: () => older,
    }).promise;
    expect(new TextDecoder().decode(hoisted.files.get(fallback))).toBe("abc");
  });
});
