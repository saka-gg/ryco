import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parseAssistantAttachments, persistAssistantAttachment } from "./assistantAttachments.ts";
import { resolveAttachmentPath } from "./attachmentStore.ts";

describe("assistant file delivery format", () => {
  it("extracts only explicit top-level manifests and preserves surrounding prose", () => {
    const parsed = parseAssistantAttachments(
      'Here is your file.\n\n```ryco-attachments\n{"files":[{"path":"output/a b.mp3","name":"Voice.mp3"}]}\n```',
    );
    expect(parsed).toEqual({
      text: "Here is your file.",
      files: [{ path: "output/a b.mp3", name: "Voice.mp3" }],
      errors: [],
    });
  });
  it("does not execute examples nested in longer fences or quoted blocks", () => {
    const example =
      '````markdown\n```ryco-attachments\n{"files":[{"path":"secret"}]}\n```\n````\n> ```ryco-attachments\n> {"files":[]}\n> ```';
    expect(parseAssistantAttachments(example)).toEqual({ text: example, files: [], errors: [] });
  });
  it("reports malformed, unfinished and over-limit manifests", () => {
    for (const text of [
      "```ryco-attachments\nnope\n```",
      '```ryco-attachments\n{"files":[]}',
      `~~~ryco-attachments\n${JSON.stringify({ files: Array.from({ length: 9 }, () => ({ path: "a" })) })}\n~~~`,
    ]) {
      expect(parseAssistantAttachments(text).errors).toHaveLength(1);
      expect(parseAssistantAttachments(text).files).toEqual([]);
    }
  });
});

describe("assistant attachment snapshots", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-delivery-"));
    roots.push(root);
    const cwd = path.join(root, "workspace");
    const attachmentsDir = path.join(root, "attachments");
    await fs.mkdir(cwd);
    return { root, cwd, attachmentsDir, threadId: "thread-1", deliveryId: "message-1" };
  }
  it("stores a named audio file independently of the original and retries without duplicates", async () => {
    const input = await setup();
    await fs.writeFile(path.join(input.cwd, "voice.mp3"), "ID3audio");
    const attachment = await persistAssistantAttachment({
      ...input,
      file: { path: "voice.mp3", name: "Narration.mp3" },
    });
    expect(attachment).toMatchObject({
      type: "file",
      name: "Narration.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 8,
    });
    expect(
      await persistAssistantAttachment({
        ...input,
        file: { path: "voice.mp3", name: "Narration.mp3" },
      }),
    ).toEqual(attachment);
    await fs.rm(path.join(input.cwd, "voice.mp3"));
    expect(
      await fs.readFile(
        resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment })!,
        "utf8",
      ),
    ).toBe("ID3audio");
    expect(await fs.readdir(input.attachmentsDir)).toHaveLength(1);
  });
  it("recognizes raster bytes independently of the supplied filename", async () => {
    const input = await setup();
    await fs.writeFile(
      path.join(input.cwd, "result.bin"),
      Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    );
    const attachment = await persistAssistantAttachment({
      ...input,
      file: { path: "result.bin", name: "Result.png" },
    });
    expect(attachment).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment })).toMatch(
      /\.png$/,
    );
  });
  it("keeps active document formats as downloadable file attachments", async () => {
    const input = await setup();
    await fs.writeFile(
      path.join(input.cwd, "image.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    expect(
      await persistAssistantAttachment({ ...input, file: { path: "image.svg" } }),
    ).toMatchObject({ type: "file", mimeType: "image/svg+xml" });
  });
  it("rejects traversal, absolute paths, links, directories and unsafe names", async () => {
    const input = await setup();
    await fs.writeFile(path.join(input.root, "outside.mp3"), "secret");
    await fs.writeFile(path.join(input.cwd, "ok.mp3"), "ID3audio");
    await fs.symlink(path.join(input.root, "outside.mp3"), path.join(input.cwd, "link.mp3"));
    await fs.symlink(input.root, path.join(input.cwd, "linked-dir"));
    await fs.link(path.join(input.root, "outside.mp3"), path.join(input.cwd, "hardlink.mp3"));
    for (const file of [
      { path: "../outside.mp3" },
      { path: path.join(input.root, "outside.mp3") },
      { path: "link.mp3" },
      { path: "linked-dir/outside.mp3" },
      { path: "hardlink.mp3" },
      { path: "." },
      { path: "missing.mp3" },
      { path: "ok.mp3", name: "../bad.mp3" },
      { path: "ok.mp3", name: "bad\nname.mp3" },
    ])
      await expect(persistAssistantAttachment({ ...input, file })).rejects.toThrow();
    expect(await fs.readdir(input.attachmentsDir).catch(() => [])).toEqual([]);
  });
  it("rejects empty, oversized and cancelled deliveries without leaving temporary files", async () => {
    const input = await setup();
    await fs.writeFile(path.join(input.cwd, "empty"), "");
    await expect(
      persistAssistantAttachment({ ...input, file: { path: "empty" } }),
    ).rejects.toThrow();
    await fs.writeFile(path.join(input.cwd, "large.mp4"), Buffer.alloc(128 * 1024));
    await expect(
      persistAssistantAttachment({ ...input, file: { path: "large.mp4" }, remainingBytes: 100 }),
    ).rejects.toThrow();
    await expect(
      persistAssistantAttachment({
        ...input,
        file: { path: "large.mp4" },
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(input.attachmentsDir)).toEqual([]);
  });
});
