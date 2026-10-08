import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  formatAssistantDeliveryText,
  parseAssistantAttachments,
  parseAssistantDelivery,
  persistAssistantAttachment,
  persistGeneratedAssistantAttachment,
} from "./assistantAttachments.ts";
import { attachmentRelativePath, resolveAttachmentPath } from "./attachmentStore.ts";

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
  it("only treats actionable manifests as a delivery and formats its visible text", () => {
    expect(parseAssistantDelivery("  plain reply  ")).toBeUndefined();
    expect(parseAssistantDelivery("```markdown\n```ryco-attachments\n```\n```")).toBeUndefined();
    const delivery = parseAssistantDelivery(
      'OK\n\n```ryco-attachments\n{"files":[{"path":"a.txt"}]}\n```',
    );
    expect(delivery?.files).toEqual([{ path: "a.txt" }]);
    expect(formatAssistantDeliveryText(delivery!.text, delivery!.errors)).toBe("OK");
    expect(formatAssistantDeliveryText("OK", ["Attachment 1 failed."])).toBe(
      "OK\n\nAttachment 1 failed.",
    );
    expect(formatAssistantDeliveryText("", [])).toBe(" ");
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

describe("generated assistant attachments", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-generated-"));
    roots.push(root);
    const html = "<!doctype html><p>Umsatz – 2026 ✓</p>";
    return {
      root,
      attachmentsDir: path.join(root, "attachments"),
      threadId: "thread-1",
      deliveryId: "html-render-1",
      name: "Revenue.html",
      mimeType: "text/html",
      extensionSegment: "html",
      bytes: Buffer.from(html, "utf8"),
      htmlRender: { title: "Revenue", height: 420, heights: [[320, 610] as const] },
    };
  }

  it("stores the exact bytes at the attachments root under the attachment id", async () => {
    const input = await setup();
    const { attachment, created } = await persistGeneratedAssistantAttachment(input);
    expect(created).toBe(true);
    expect(attachment).toMatchObject({
      type: "file",
      name: "Revenue.html",
      mimeType: "text/html",
      sizeBytes: input.bytes.byteLength,
      htmlRender: { title: "Revenue", height: 420, heights: [[320, 610]] },
    });
    expect(attachment.sizeBytes).toBeGreaterThan(input.bytes.toString("utf8").length);
    expect(attachment.id).toMatch(/^thread-1-[0-9a-f-]{36}-html$/);
    expect(attachmentRelativePath(attachment)).toBe(attachment.id);
    expect(await fs.readdir(input.attachmentsDir)).toEqual([attachment.id]);
    expect(
      await fs.readFile(
        resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment })!,
      ),
    ).toEqual(input.bytes);
  });

  it("resolves a retry to the stored snapshot without overwriting it", async () => {
    const input = await setup();
    const first = await persistGeneratedAssistantAttachment(input);
    const second = await persistGeneratedAssistantAttachment(input);
    expect(second).toEqual({ attachment: first.attachment, created: false });
    const other = await persistGeneratedAssistantAttachment({ ...input, deliveryId: "other" });
    expect(other.attachment.id).not.toBe(first.attachment.id);
    expect((await fs.readdir(input.attachmentsDir)).toSorted()).toEqual(
      [first.attachment.id, other.attachment.id].toSorted(),
    );
  });

  it("rejects empty, over-budget and cancelled writes without leaving staging files", async () => {
    const input = await setup();
    await expect(
      persistGeneratedAssistantAttachment({ ...input, bytes: new Uint8Array() }),
    ).rejects.toThrow();
    await expect(
      persistGeneratedAssistantAttachment({ ...input, remainingBytes: input.bytes.byteLength - 1 }),
    ).rejects.toThrow();
    await expect(
      persistGeneratedAssistantAttachment({ ...input, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    await expect(
      persistGeneratedAssistantAttachment({ ...input, name: "../escape.html" }),
    ).rejects.toThrow();
    expect(await fs.readdir(input.attachmentsDir).catch(() => [])).toEqual([]);
  });
});
