import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import Mime from "@effect/platform-node/Mime";
import {
  ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ryco/contracts";
import { Data, Schema } from "effect";

import {
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
  toSafeFileAttachmentExtensionSegment,
} from "./attachmentStore.ts";

export class AssistantAttachmentError extends Data.TaggedError("AssistantAttachmentError")<{}> {}

export const ASSISTANT_ATTACHMENT_INSTRUCTIONS = `Ryco can deliver generated files as persistent message attachments with image previews, audio/video playback and downloads. Only deliver files requested by the user or created as task outputs, never credentials or unrelated files. Save outputs inside the current thread workspace. If ryco_attach_file is available, call it with a workspace-relative path and optional name; a successful call already displays the file, so do not attach it again. Otherwise append one top-level fenced ryco-attachments block to your final reply containing JSON like {"files":[{"path":"output/narration.mp3","name":"narration.mp3"}]}. Use this exact fence language, not a regular code block. At most 8 files, 50 MiB total, 10 MiB per inline image. Paths must be workspace-relative, with no parent traversal or symlinks. Ryco copies the files when the reply completes; do not delete them before then. This delivery feature does not provide media-generation tools; use only generation tools actually available to you.`;

export const AssistantAttachmentFile = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
});
export type AssistantAttachmentFile = typeof AssistantAttachmentFile.Type;
const Manifest = Schema.Struct({
  files: Schema.Array(AssistantAttachmentFile).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
});

/** Only explicit, top-level delivery fences are actionable; examples inside other fences aren't. */
export function parseAssistantAttachments(text: string): {
  text: string;
  files: ReadonlyArray<AssistantAttachmentFile>;
  errors: string[];
} {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  const files: AssistantAttachmentFile[] = [];
  const errors: string[] = [];
  let fence: { char: string; length: number; delivery: boolean; body: string[] } | undefined;
  for (const line of lines) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        if (fence.delivery) {
          try {
            const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(fence.body.join("\n")));
            if (files.length + manifest.files.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
              throw new Error();
            files.push(...manifest.files);
          } catch {
            errors.push(
              "An attachment could not be delivered: invalid file list (maximum 8 files).",
            );
          }
        } else output.push(line);
        fence = undefined;
      } else if (fence.delivery) fence.body.push(line);
      else output.push(line);
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      fence = {
        char: open[1]![0]!,
        length: open[1]!.length,
        delivery: open[2]!.trim() === "ryco-attachments",
        body: [],
      };
      if (!fence.delivery) output.push(line);
    } else output.push(line);
  }
  if (fence?.delivery) errors.push("An attachment could not be delivered: incomplete file list.");
  return { text: output.join("\n").trim(), files, errors };
}

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/** Copy in bounded chunks; opaque deterministic ids make delivery retries idempotent. */
export async function persistAssistantAttachment(input: {
  attachmentsDir: string;
  cwd: string;
  threadId: string;
  deliveryId: string;
  file: AssistantAttachmentFile;
  remainingBytes?: number;
  signal?: AbortSignal;
}): Promise<ChatAttachment> {
  const relative = input.file.path;
  if (
    path.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative) ||
    /[\\\p{Cc}]/u.test(relative) ||
    relative.split("/").includes("..")
  ) {
    throw new Error("Use a relative path inside this thread's workspace.");
  }
  const root = await fs.realpath(input.cwd);
  const source = path.resolve(root, relative);
  if (!isInside(root, source)) throw new Error("File must be inside this thread's workspace.");
  let ancestor = root;
  for (const segment of path.relative(root, source).split(path.sep)) {
    ancestor = path.join(ancestor, segment);
    if ((await fs.lstat(ancestor)).isSymbolicLink())
      throw new Error("Symbolic links cannot be attached.");
  }
  if ((await fs.realpath(source)) !== source) throw new Error("File path changed during delivery.");
  const sourceInfo = await fs.lstat(source);
  const handle = await fs.open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let temporary: string | undefined;
  try {
    const info = await handle.stat();
    if (sourceInfo.isSymbolicLink() || sourceInfo.dev !== info.dev || sourceInfo.ino !== info.ino) {
      throw new Error("File path changed during delivery.");
    }
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("Only regular files without hard links can be attached.");
    const limit = Math.min(
      PROVIDER_SEND_TURN_MAX_FILE_BYTES,
      input.remainingBytes ?? PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
    );
    if (info.size <= 0 || info.size > limit)
      throw new Error("File is empty or exceeds the 50 MiB attachment budget.");
    const name = input.file.name ?? path.basename(source);
    // Generated raster images are identified by bytes. Other formats are downloads or native media.
    const header = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    const rasterMime = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
        ? "image/jpeg"
        : /^GIF8[79]a/.test(header.toString("ascii", 0, 6))
          ? "image/gif"
          : header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP"
            ? "image/webp"
            : undefined;
    const inlineImage = rasterMime !== undefined && info.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
    const mimeType = rasterMime ?? Mime.getType(source) ?? "application/octet-stream";
    const thread = toSafeThreadAttachmentSegment(input.threadId);
    if (!thread) throw new Error("Invalid attachment thread.");
    const contentHash = createHash("sha256").update(
      JSON.stringify([input.threadId, input.deliveryId, relative, name]),
    );
    await fs.mkdir(input.attachmentsDir, { recursive: true });
    temporary = path.join(input.attachmentsDir, `.${randomUUID()}.part`);
    const output = await fs.open(temporary, "wx", 0o600);
    try {
      const chunk = Buffer.alloc(Math.min(info.size, 64 * 1024));
      for (let offset = 0; offset < info.size;) {
        input.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, info.size - offset),
          offset,
        );
        if (bytesRead === 0) throw new Error("File changed during delivery.");
        contentHash.update(chunk.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(chunk, written, bytesRead - written, offset + written);
          if (result.bytesWritten === 0) throw new Error("Attachment could not be stored.");
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      const after = await handle.stat();
      const currentSource = await fs.lstat(source);
      if (
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        currentSource.dev !== info.dev ||
        currentSource.ino !== info.ino ||
        (await fs.realpath(source)) !== source
      )
        throw new Error("File changed during delivery.");
      await output.sync();
    } finally {
      await output.close();
    }
    input.signal?.throwIfAborted();
    const hash = contentHash.digest("hex");
    const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    const attachment = Schema.decodeUnknownSync(ChatAttachment)({
      type: inlineImage ? "image" : "file",
      id: `${thread}-${uuid}${inlineImage ? "" : `-${toSafeFileAttachmentExtensionSegment(path.basename(source))}`}`,
      name,
      mimeType,
      sizeBytes: info.size,
    });
    const destination = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
    if (!destination) throw new Error("Invalid attachment destination.");
    // Atomic publication. Never overwrite a previous delivery's snapshot.
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    return attachment;
  } finally {
    await handle.close();
    if (temporary) await fs.rm(temporary, { force: true });
  }
}
