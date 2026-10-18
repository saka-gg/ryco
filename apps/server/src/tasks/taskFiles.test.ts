import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type LocalTaskFile } from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";

import {
  attachmentRelativePath,
  parseThreadSegmentFromAttachmentId,
  readPersistedAttachment,
} from "../attachmentStore.ts";
import {
  classifyTaskFile,
  copyTaskFilesToThread,
  deleteTaskFiles,
  taskFileSegment,
  toLocalTaskFile,
  writeTaskFileFromDataUrl,
} from "./taskFiles.ts";

const makeDirs = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-task-files-"));
  const taskFilesDir = path.join(root, "task-files");
  const attachmentsDir = path.join(root, "attachments");
  fs.mkdirSync(taskFilesDir);
  fs.mkdirSync(attachmentsDir);
  return { taskFilesDir, attachmentsDir };
};

const storedTaskFile = (taskFilesDir: string, file: LocalTaskFile, bytes: string) => {
  fs.writeFileSync(path.join(taskFilesDir, file.fileId), bytes);
  return file;
};

describe("task files", () => {
  it("name their files after the task", () => {
    expect(taskFileSegment("abc_1")).toBe("task-abc_1");
  });

  it("send only provider-ready images as images", () => {
    const image = { mimeType: "image/PNG", name: "shot.png", sizeBytes: 4 };
    expect(classifyTaskFile(image)).toBe("image");
    expect(classifyTaskFile({ ...image, sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 })).toBe(
      "file",
    );
    expect(classifyTaskFile({ mimeType: "image/x-unknown", name: "raw.xyz", sizeBytes: 4 })).toBe(
      "file",
    );
    expect(classifyTaskFile({ mimeType: "application/pdf", name: "spec.pdf", sizeBytes: 4 })).toBe(
      "file",
    );
    expect(
      toLocalTaskFile({
        fileId: "task-a-png",
        ...image,
        width: 2,
        addedAt: "2026-10-02T00:00:00.000Z",
      }),
    ).toEqual({
      fileId: "task-a-png",
      type: "image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 4,
      width: 2,
      addedAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it.effect("store an inline file under a fresh task id and delete it best effort", () =>
    Effect.gen(function* () {
      const { taskFilesDir } = makeDirs();
      const input = {
        taskFilesDir,
        taskId: "task",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        dataUrl: "data:text/plain;base64,YWJj",
      };
      const written = yield* writeTaskFileFromDataUrl(input);
      expect(written.fileId.startsWith("task-task-")).toBe(true);
      expect(written.fileId.endsWith("-txt")).toBe(true);
      expect(fs.readFileSync(path.join(taskFilesDir, written.fileId), "utf8")).toBe("abc");
      const invalid = yield* Effect.flip(writeTaskFileFromDataUrl({ ...input, sizeBytes: 4 }));
      expect(invalid.reason).toBe("invalid");
      yield* deleteTaskFiles(taskFilesDir, [written.fileId, "task-task-missing-txt", "../escape"]);
      expect(fs.readdirSync(taskFilesDir)).toEqual([]);
    }),
  );

  it.effect("copy into a chat under the chat's own ids, repeatably", () =>
    Effect.gen(function* () {
      const { taskFilesDir, attachmentsDir } = makeDirs();
      const files = [
        storedTaskFile(
          taskFilesDir,
          {
            fileId: "task-task-11111111-2222-3333-4444-555555555555-png",
            type: "image",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 4,
            width: 2,
            height: 1,
            addedAt: "2026-10-02T00:00:00.000Z",
          },
          "png!",
        ),
        storedTaskFile(
          taskFilesDir,
          {
            fileId: "task-task-66666666-7777-8888-9999-000000000000-pdf",
            type: "file",
            name: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 3,
            addedAt: "2026-10-02T00:00:00.000Z",
          },
          "pdf",
        ),
      ];
      const input = { taskFilesDir, attachmentsDir, threadId: "chat-thread", files };
      const first = yield* copyTaskFilesToThread(input);
      const copies = first.attachments;
      expect(copies.map((copy) => parseThreadSegmentFromAttachmentId(copy.id!))).toEqual([
        "chat-thread",
        "chat-thread",
      ]);
      expect(first.createdIds).toEqual(copies.map((copy) => copy.id));
      const [image, file] = copies;
      expect(image).toMatchObject({ type: "image", width: 2, height: 1, mimeType: "image/png" });
      // Images are stored as id plus extension, so their id carries no extension segment.
      expect(attachmentRelativePath(image!)).toBe(`${image!.id}.png`);
      expect(file).toMatchObject({ type: "file", name: "spec.pdf" });
      expect(attachmentRelativePath(file!)).toBe(file!.id);
      for (const copy of copies) {
        const read = yield* Effect.promise(() =>
          readPersistedAttachment({ attachmentsDir, attachment: copy }),
        );
        expect(read.ok).toBe(true);
      }
      // A retry finds the same copies and creates none.
      expect(yield* copyTaskFilesToThread(input)).toEqual({ attachments: copies, createdIds: [] });
      // The chat's copy outlives the task's file.
      yield* deleteTaskFiles(
        taskFilesDir,
        files.map((entry) => entry.fileId),
      );
      expect(fs.readFileSync(path.join(attachmentsDir, file!.id!), "utf8")).toBe("pdf");
      const missing = yield* Effect.flip(
        copyTaskFilesToThread({ ...input, threadId: "other-thread" }),
      );
      expect(missing.reason).toBe("persistence");
    }),
  );

  it.effect("give each chat its own copy, so editing it never changes the task's file", () =>
    Effect.gen(function* () {
      const { taskFilesDir, attachmentsDir } = makeDirs();
      const file = storedTaskFile(
        taskFilesDir,
        {
          fileId: "task-task-11111111-2222-3333-4444-555555555555-csv",
          type: "file",
          name: "data.csv",
          mimeType: "text/csv",
          sizeBytes: 8,
          addedAt: "2026-10-02T00:00:00.000Z",
        },
        "a,b\n1,2\n",
      );
      const original = path.join(taskFilesDir, file.fileId);
      const input = { taskFilesDir, attachmentsDir, threadId: "thread-1", files: [file] };
      const [copy] = (yield* copyTaskFilesToThread(input)).attachments;
      const copyPath = path.join(attachmentsDir, copy!.id!);
      expect(fs.statSync(copyPath).ino).not.toBe(fs.statSync(original).ino);
      // An agent rewriting its attachment in place (same inode, new size).
      fs.writeFileSync(copyPath, "a,b\n1,2\n3,4\n");
      expect(fs.readFileSync(original, "utf8")).toBe("a,b\n1,2\n");
      const [next] = (yield* copyTaskFilesToThread({ ...input, threadId: "thread-2" })).attachments;
      expect(fs.readFileSync(path.join(attachmentsDir, next!.id!), "utf8")).toBe("a,b\n1,2\n");
      // No staging file is left behind.
      expect(fs.readdirSync(attachmentsDir).filter((name) => name.endsWith(".part"))).toEqual([]);
    }),
  );

  it.effect("delete the copies they made when a later file cannot be copied", () =>
    Effect.gen(function* () {
      const { taskFilesDir, attachmentsDir } = makeDirs();
      const stored = storedTaskFile(
        taskFilesDir,
        {
          fileId: "task-task-11111111-2222-3333-4444-555555555555-txt",
          type: "file",
          name: "kept.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
          addedAt: "2026-10-02T00:00:00.000Z",
        },
        "abc",
      );
      const missing: LocalTaskFile = {
        ...stored,
        fileId: "task-task-66666666-7777-8888-9999-000000000000-txt",
        name: "gone.txt",
      };
      const failure = yield* Effect.flip(
        copyTaskFilesToThread({
          taskFilesDir,
          attachmentsDir,
          threadId: "thread",
          files: [stored, missing],
        }),
      );
      expect(failure.message).toBe("Task file 'gone.txt' could not be added to the chat.");
      expect(fs.readdirSync(attachmentsDir)).toEqual([]);
    }),
  );
});
