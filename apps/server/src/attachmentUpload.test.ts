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

const makeRegistry = (input?: { readonly ttlMs?: number }) =>
  makeChatAttachmentUploads({
    attachmentsDir: fs.mkdtempSync(path.join(os.tmpdir(), "ryco-upload-")),
    ...(input?.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
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
});
