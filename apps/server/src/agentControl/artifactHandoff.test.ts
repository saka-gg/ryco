import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MessageId,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type OrchestrationMessage,
} from "@ryco/contracts";
import { formatThreadArtifactId } from "@ryco/shared/threadArtifacts";
import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  createFileAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { copyArtifactsToThread, resolveThreadArtifacts } from "./artifactHandoff.ts";

const PARENT = ThreadId.make("thread-parent");
const CHILD = ThreadId.make("thread-child");
let attachmentsDir: string;

beforeEach(() => {
  attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-artifact-handoff-"));
});
afterEach(() => {
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
});

function storedPage(bytes: string): ChatFileAttachment {
  const attachment: ChatFileAttachment = {
    type: "file",
    id: createFileAttachmentId(PARENT, "mockup.html")!,
    name: "mockup.html",
    mimeType: "text/html",
    sizeBytes: Buffer.byteLength(bytes),
    htmlRender: { title: "Mockup", height: 400 },
  };
  fs.writeFileSync(resolveAttachmentPath({ attachmentsDir, attachment })!, bytes);
  return attachment;
}

function message(
  id: string,
  role: OrchestrationMessage["role"],
  attachments: ReadonlyArray<ChatAttachment>,
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text: "",
    attachments,
    turnId: null,
    streaming: false,
    createdAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
  } as OrchestrationMessage;
}

const projectionsOf = (messages: ReadonlyArray<OrchestrationMessage>) => ({
  getThreadMessageById: (input: { readonly messageId: MessageId }) =>
    Effect.succeed(Option.fromNullishOr(messages.find((entry) => entry.id === input.messageId))),
});

const resolve = (messages: ReadonlyArray<OrchestrationMessage>, ids: ReadonlyArray<string>) =>
  Effect.runPromise(
    resolveThreadArtifacts(projectionsOf(messages), PARENT, ids).pipe(
      Effect.match({
        onFailure: (error) => ({ error: error.detail }),
        onSuccess: (artifacts) => ({ artifacts }),
      }),
    ),
  );

describe("resolveThreadArtifacts", () => {
  it("resolves the thread's own artifacts by id, once each, in order", async () => {
    const page = storedPage("<p>mockup</p>");
    const id = formatThreadArtifactId({ messageId: "m1", attachmentId: page.id });
    const result = await resolve([message("m1", "assistant", [page])], [id, id]);
    expect(result).toEqual({ artifacts: [{ messageId: "m1", attachment: page }] });
  });

  it("refuses ids that name no artifact of the thread", async () => {
    const page = storedPage("<p>mockup</p>");
    const upload = message("upload", "user", [page]);
    const own = (messageId: string) => formatThreadArtifactId({ messageId, attachmentId: page.id });
    for (const ids of [[own("upload")], [own("missing")], ["not-an-artifact-id"]]) {
      const result = await resolve([upload], ids);
      expect(result).toHaveProperty("error");
    }
    const tooMany = Array.from({ length: 9 }, (_, index) => own(`m${index}`));
    expect(await resolve([upload], tooMany)).toEqual({
      error: "At most 8 artifacts can be handed over at once.",
    });
  });

  it("accepts an artifact that was itself handed over to the thread", async () => {
    const page = {
      ...storedPage("<p>copy</p>"),
      handoff: { threadId: ThreadId.make("thread-root"), messageId: MessageId.make("root-m") },
    };
    const id = formatThreadArtifactId({ messageId: "delegated", attachmentId: page.id });
    const result = await resolve([message("delegated", "user", [page])], [id]);
    expect(result).toHaveProperty("artifacts");
  });
});

describe("copyArtifactsToThread", () => {
  it("copies each artifact under the receiving thread's ids, marked with where it came from", async () => {
    const page = storedPage("<p>mockup</p>");
    const copy = () =>
      Effect.runPromise(
        copyArtifactsToThread({
          attachmentsDir,
          sourceThreadId: PARENT,
          targetThreadId: CHILD,
          artifacts: [{ messageId: MessageId.make("m1"), attachment: page }],
        }),
      );
    const [copied] = await copy();
    expect(copied).toMatchObject({
      type: "file",
      name: "mockup.html",
      sizeBytes: page.sizeBytes,
      htmlRender: page.htmlRender,
      handoff: { threadId: PARENT, messageId: "m1" },
    });
    expect(parseThreadSegmentFromAttachmentId(copied!.id!)).toBe(
      toSafeThreadAttachmentSegment(CHILD),
    );
    expect(
      fs.readFileSync(resolveAttachmentPath({ attachmentsDir, attachment: copied! })!, "utf8"),
    ).toBe("<p>mockup</p>");
    // A retry links the same copy again.
    expect((await copy())[0]?.id).toBe(copied!.id);
  });

  it("fails when the source file is gone", async () => {
    const page = storedPage("<p>mockup</p>");
    fs.rmSync(resolveAttachmentPath({ attachmentsDir, attachment: page })!);
    await expect(
      Effect.runPromise(
        copyArtifactsToThread({
          attachmentsDir,
          sourceThreadId: PARENT,
          targetThreadId: CHILD,
          artifacts: [{ messageId: MessageId.make("m1"), attachment: page }],
        }),
      ),
    ).rejects.toThrow("could not be copied");
  });
});
