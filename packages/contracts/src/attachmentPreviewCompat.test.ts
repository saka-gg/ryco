import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ChatAttachmentId,
  ChatAttachmentReadChunkInput,
  ChatAttachmentReadChunkResult,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProjectReadIconInput,
  ProjectReadIconResult,
  ThreadId,
} from "./index.ts";

// The schemas as released before previews and icon hashes: what an older peer decodes with.
const OldReadChunkInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  attachmentId: ChatAttachmentId,
  offset: NonNegativeInt,
});
const OldReadChunkResult = Schema.Struct({
  dataBase64: Schema.String,
  offset: NonNegativeInt,
  totalBytes: NonNegativeInt,
});
const OldReadIconInput = Schema.Struct({ projectId: ProjectId });
const OldReadIconResult = Schema.NullOr(
  Schema.Struct({ dataBase64: Schema.String, mimeType: Schema.String }),
);

const reference = { threadId: "thread", messageId: "message", attachmentId: "file-id", offset: 0 };

it("an older server reads a preview request as a plain read", () => {
  expect(Schema.decodeUnknownSync(OldReadChunkInput)({ ...reference, preview: 512 })).toEqual(
    reference,
  );
});

it("a newer client reads an older server's answer as the original", () => {
  const answer = { dataBase64: "", offset: 0, totalBytes: 3 };
  expect(Schema.decodeUnknownSync(ChatAttachmentReadChunkResult)(answer)).toEqual(answer);
  expect(Schema.decodeUnknownSync(OldReadChunkResult)({ ...answer, preview: true })).toEqual(
    answer,
  );
});

it("accepts only the preview sizes a server makes", () => {
  expect(() =>
    Schema.decodeUnknownSync(ChatAttachmentReadChunkInput)({ ...reference, preview: 2048 }),
  ).toThrow();
  expect(
    Schema.decodeUnknownSync(ChatAttachmentReadChunkInput)({ ...reference, preview: 1024 }),
  ).toEqual({ ...reference, preview: 1024 });
});

it("icon reads with a known hash stay compatible both ways", () => {
  expect(
    Schema.decodeUnknownSync(OldReadIconInput)({ projectId: "project", knownHash: "h" }),
  ).toEqual({ projectId: "project" });
  const artwork = { dataBase64: "aWNvbg==", mimeType: "image/png" };
  expect(Schema.decodeUnknownSync(ProjectReadIconResult)(artwork)).toEqual(artwork);
  expect(Schema.decodeUnknownSync(OldReadIconResult)({ ...artwork, hash: "h" })).toEqual(artwork);
  expect(Schema.decodeUnknownSync(ProjectReadIconResult)({ unchanged: true })).toEqual({
    unchanged: true,
  });
  expect(Schema.decodeUnknownSync(ProjectReadIconInput)({ projectId: "project" })).toEqual({
    projectId: "project",
  });
});
