import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROVIDER_SEND_TURN_MAX_FILE_BYTES, ThreadId } from "@ryco/contracts";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";

import {
  ChatAttachmentUploadError,
  type ChatAttachmentUploadsShape,
  makeChatAttachmentUploads,
} from "./attachmentUpload.ts";

const makeRegistry = (input?: { readonly ttlMs?: number; readonly taskFilesDir?: string }) =>
  makeChatAttachmentUploads({
    attachmentsDir: fs.mkdtempSync(path.join(os.tmpdir(), "ryco-upload-")),
    ...(input?.taskFilesDir !== undefined ? { taskFilesDir: input.taskFilesDir } : {}),
    ...(input?.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  });

const taskUpload = {
  taskId: "task-1",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3,
};

/** A task upload whose bytes are in place, as the HTTP upload route leaves it. */
const uploadTaskFile = Effect.fn("uploadTaskFile")(function* (uploads: ChatAttachmentUploadsShape) {
  const created = yield* uploads.createForTask(taskUpload);
  const lease = yield* uploads.beginUpload(created.uploadToken);
  fs.writeFileSync(lease.finalPath, "pdf");
  yield* uploads.completeUpload(created.uploadToken);
  return { created, lease };
});

const createUpload = Effect.fn("createUpload")(function* (
  uploads: ChatAttachmentUploadsShape,
  input?: Partial<Parameters<ChatAttachmentUploadsShape["create"]>[0]>,
) {
  return yield* uploads.create({
    threadId: ThreadId.make("upload-thread"),
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    ...input,
  });
});

describe("chat attachment uploads", () => {
  it.effect("mints single-use tokens with expiry metadata", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry();
      const created = yield* createUpload(uploads);
      expect(created.uploadToken.length).toBeGreaterThan(0);
      expect(created.uploadToken.length).toBeLessThanOrEqual(256);
      expect(created.uploadToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Number.isNaN(Date.parse(created.expiresAt))).toBe(false);
      expect(created.maxUploadBytes).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);

      const lease = yield* uploads.beginUpload(created.uploadToken);
      expect(lease.finalPath.startsWith(lease.partPath.slice(0, -".part".length))).toBe(true);
      expect(lease.attachmentId.endsWith("-txt")).toBe(true);
      expect(path.basename(lease.partPath)).toBe(`${lease.attachmentId}.part`);

      const reuse = yield* Effect.flip(uploads.beginUpload(created.uploadToken));
      expect(reuse).toBeInstanceOf(ChatAttachmentUploadError);
      expect(reuse.reason).toBe("already-used");
    }),
  );

  it.effect("rejects invalid upload sizes at mint time", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry();
      const zero = yield* Effect.flip(
        uploads.create({
          threadId: ThreadId.make("upload-thread"),
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 0,
        }),
      );
      expect(zero.reason).toBe("invalid-request");
      const tooLarge = yield* Effect.flip(
        uploads.create({
          threadId: ThreadId.make("upload-thread"),
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
        }),
      );
      expect(tooLarge.reason).toBe("invalid-request");
    }),
  );

  it.live("expires tokens lazily", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry({ ttlMs: 20 });
      const created = yield* createUpload(uploads);
      yield* Effect.sleep("40 millis");
      const error = yield* Effect.flip(uploads.beginUpload(created.uploadToken));
      expect(error.reason).toBe("invalid-token");
    }),
  );

  it.effect("hands a completed upload to exactly one adopting turn", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry();
      const created = yield* createUpload(uploads);
      const lease = yield* uploads.beginUpload(created.uploadToken);
      yield* uploads.completeUpload(created.uploadToken);

      const adopted = yield* uploads.claimForAdoption({
        commandId: "adoption-command",
        uploadToken: created.uploadToken,
        threadId: ThreadId.make("upload-thread"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      });
      expect(adopted.attachmentId).toBe(lease.attachmentId);

      const reuse = yield* Effect.flip(
        uploads.claimForAdoption({
          commandId: "other-command",
          uploadToken: created.uploadToken,
          threadId: ThreadId.make("upload-thread"),
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        }),
      );
      expect(reuse.reason).toBe("already-used");
    }),
  );

  it.effect("releases overlapping claims only after every uncommitted attempt fails", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry();
      const created = yield* createUpload(uploads);
      yield* uploads.beginUpload(created.uploadToken);
      yield* uploads.completeUpload(created.uploadToken);
      const claim = {
        uploadToken: created.uploadToken,
        commandId: "overlap",
        threadId: ThreadId.make("upload-thread"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      };
      const first = Symbol("first");
      const second = Symbol("second");
      yield* uploads.claimForAdoption({ ...claim, attemptId: first });
      yield* uploads.claimForAdoption({ ...claim, attemptId: second });
      yield* uploads.releaseAdoption({ ...claim, attemptId: first });
      const blocked = yield* Effect.flip(
        uploads.claimForAdoption({ ...claim, commandId: "other" }),
      );
      expect(blocked.reason).toBe("already-used");
      yield* uploads.releaseAdoption({ ...claim, attemptId: second });
      const adopted = yield* uploads.claimForAdoption({ ...claim, commandId: "other" });
      expect(adopted.name).toBe("notes.txt");
    }),
  );

  it.effect("carries probed media dimensions into adoption", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry();
      const created = yield* createUpload(uploads);
      const withoutDimensions = yield* uploads.beginUpload(created.uploadToken);
      expect(withoutDimensions.attachmentId).toBeTruthy();
      yield* uploads.completeUpload(created.uploadToken);

      const adoptedWithoutDimensions = yield* uploads.claimForAdoption({
        commandId: "adoption-command",
        uploadToken: created.uploadToken,
        threadId: ThreadId.make("upload-thread"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      });
      expect(adoptedWithoutDimensions.width).toBeUndefined();
      expect(adoptedWithoutDimensions.height).toBeUndefined();

      const imageUpload = yield* createUpload(uploads, {
        name: "pic.png",
        mimeType: "image/png",
      });
      const imageLease = yield* uploads.beginUpload(imageUpload.uploadToken);
      expect(imageLease.attachmentId).toBeTruthy();
      yield* uploads.completeUpload(imageUpload.uploadToken, { width: 640, height: 360 });

      const adoptedImage = yield* uploads.claimForAdoption({
        commandId: "adoption-command",
        uploadToken: imageUpload.uploadToken,
        threadId: ThreadId.make("upload-thread"),
        name: "pic.png",
        mimeType: "image/png",
        sizeBytes: 3,
      });
      expect(adoptedImage.width).toBe(640);
      expect(adoptedImage.height).toBe(360);
    }),
  );

  it.effect("rejects adoption mismatches", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry();
      const created = yield* createUpload(uploads);
      yield* uploads.beginUpload(created.uploadToken);
      yield* uploads.completeUpload(created.uploadToken);

      const threadMismatch = yield* Effect.flip(
        uploads.claimForAdoption({
          commandId: "adoption-command",
          uploadToken: created.uploadToken,
          threadId: ThreadId.make("other-thread"),
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        }),
      );
      expect(threadMismatch.reason).toBe("invalid-request");

      const sizeMismatch = yield* Effect.flip(
        uploads.claimForAdoption({
          commandId: "adoption-command",
          uploadToken: created.uploadToken,
          threadId: ThreadId.make("upload-thread"),
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
        }),
      );
      expect(sizeMismatch.reason).toBe("invalid-request");

      const mimeMismatch = yield* Effect.flip(
        uploads.claimForAdoption({
          commandId: "adoption-command",
          uploadToken: created.uploadToken,
          threadId: ThreadId.make("upload-thread"),
          name: "notes.txt",
          mimeType: "application/json",
          sizeBytes: 3,
        }),
      );
      expect(mimeMismatch.reason).toBe("invalid-request");

      const adopted = yield* uploads.claimForAdoption({
        commandId: "adoption-command",
        uploadToken: created.uploadToken,
        threadId: ThreadId.make("upload-thread"),
        name: "notes.txt",
        mimeType: "TEXT/PLAIN",
        sizeBytes: 3,
      });
      expect(adopted.name).toBe("notes.txt");
    }),
  );

  it.effect("rejects adoption before the upload completed", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry();
      const created = yield* createUpload(uploads);
      const error = yield* Effect.flip(
        uploads.claimForAdoption({
          commandId: "adoption-command",
          uploadToken: created.uploadToken,
          threadId: ThreadId.make("upload-thread"),
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        }),
      );
      expect(error.reason).toBe("already-used");
    }),
  );

  it.effect("drops aborted uploads permanently", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry();
      const created = yield* createUpload(uploads);
      yield* uploads.beginUpload(created.uploadToken);
      yield* uploads.abortUpload(created.uploadToken);
      const error = yield* Effect.flip(uploads.beginUpload(created.uploadToken));
      expect(error.reason).toBe("invalid-token");
    }),
  );

  it.effect("stores a task upload in the task-file store and hands it to its task only", () =>
    Effect.gen(function* () {
      const taskFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-task-upload-"));
      const uploads = yield* makeRegistry({ taskFilesDir });
      const { created, lease } = yield* uploadTaskFile(uploads);
      expect(lease.scope).toEqual({ kind: "task", taskId: "task-1" });
      expect(path.dirname(lease.finalPath)).toBe(path.resolve(taskFilesDir));
      expect(lease.attachmentId.startsWith("task-task-1-")).toBe(true);
      expect(lease.attachmentId.endsWith("-pdf")).toBe(true);

      // Never adoptable into a chat command, whatever thread it names.
      const adopted = yield* Effect.flip(
        uploads.claimForAdoption({
          commandId: "chat-command",
          uploadToken: created.uploadToken,
          threadId: ThreadId.make("task-task-1"),
          ...taskUpload,
        }),
      );
      expect(adopted.reason).toBe("invalid-request");
      const otherTask = yield* Effect.flip(
        uploads.claimForTask({ ...taskUpload, uploadToken: created.uploadToken, taskId: "task-2" }),
      );
      expect(otherTask.reason).toBe("invalid-request");
      const mismatch = yield* Effect.flip(
        uploads.claimForTask({ ...taskUpload, uploadToken: created.uploadToken, sizeBytes: 4 }),
      );
      expect(mismatch.reason).toBe("invalid-request");

      const claimed = yield* uploads.claimForTask({
        ...taskUpload,
        uploadToken: created.uploadToken,
      });
      expect(claimed.attachmentId).toBe(lease.attachmentId);
      // A retried add claims the same file again.
      const again = yield* uploads.claimForTask({
        ...taskUpload,
        uploadToken: created.uploadToken,
      });
      expect(again.attachmentId).toBe(lease.attachmentId);
    }),
  );

  it.effect("refuses to hand a chat upload to a task, and task uploads without a store", () =>
    Effect.gen(function* () {
      const uploads = yield* makeRegistry();
      const unavailable = yield* Effect.flip(uploads.createForTask(taskUpload));
      expect(unavailable.reason).toBe("invalid-request");
      const created = yield* createUpload(uploads);
      yield* uploads.beginUpload(created.uploadToken);
      yield* uploads.completeUpload(created.uploadToken);
      const claimed = yield* Effect.flip(
        uploads.claimForTask({
          uploadToken: created.uploadToken,
          taskId: "task-1",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        }),
      );
      expect(claimed.reason).toBe("invalid-request");
    }),
  );

  it.live("deletes the file of a task upload nobody claimed before it expired", () =>
    Effect.gen(function* () {
      const taskFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-task-upload-"));
      const uploads = yield* makeRegistry({ ttlMs: 150, taskFilesDir });
      const unclaimed = yield* uploadTaskFile(uploads);
      const claimed = yield* uploadTaskFile(uploads);
      yield* uploads.claimForTask({ ...taskUpload, uploadToken: claimed.created.uploadToken });
      yield* Effect.sleep("300 millis");
      // Any later registry call prunes expired tokens.
      yield* createUpload(uploads);
      expect(fs.existsSync(unclaimed.lease.finalPath)).toBe(false);
      expect(fs.existsSync(claimed.lease.finalPath)).toBe(true);
      const expired = yield* Effect.flip(
        uploads.claimForTask({ ...taskUpload, uploadToken: unclaimed.created.uploadToken }),
      );
      expect(expired.reason).toBe("invalid-token");
    }),
  );

  it.live(
    "hands a claim whose add failed back, so it retries or expires like an unclaimed one",
    () =>
      Effect.gen(function* () {
        const taskFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-task-upload-"));
        const uploads = yield* makeRegistry({ ttlMs: 150, taskFilesDir });
        const retried = yield* uploadTaskFile(uploads);
        const token = { ...taskUpload, uploadToken: retried.created.uploadToken };
        yield* uploads.claimForTask(token);
        // Another task's release leaves the claim alone.
        yield* uploads.releaseTaskClaim({ uploadToken: token.uploadToken, taskId: "task-2" });
        yield* uploads.releaseTaskClaim({ uploadToken: token.uploadToken, taskId: "task-1" });
        expect((yield* uploads.claimForTask(token)).attachmentId).toBe(retried.lease.attachmentId);
        yield* uploads.releaseTaskClaim({ uploadToken: token.uploadToken, taskId: "task-1" });
        yield* Effect.sleep("300 millis");
        yield* createUpload(uploads);
        expect(fs.existsSync(retried.lease.finalPath)).toBe(false);
      }),
  );
});
