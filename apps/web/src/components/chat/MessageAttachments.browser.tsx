import "../../index.css";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const { readChunk } = vi.hoisted(() => ({ readChunk: vi.fn() }));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({ attachments: { readChunk } }),
}));
import { MessageAttachments } from "./MessageAttachments";

afterEach(() => {
  vi.restoreAllMocks();
  readChunk.mockReset();
});

function waveFixture() {
  const bytes = new Uint8Array(16044);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ] as const)
    bytes.set(new TextEncoder().encode(value), offset);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, 16000, true);
  return { size: bytes.length, dataBase64: btoa(String.fromCharCode(...bytes)) };
}

it("loads a hosted attachment on demand over RPC and releases the blob on unmount", async () => {
  const wave = waveFixture();
  readChunk.mockResolvedValue({ offset: 0, totalBytes: wave.size, dataBase64: wave.dataBase64 });
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const screen = await render(
    <MessageAttachments
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("thread")}
      messageId={MessageId.make("message")}
      onImageExpand={() => undefined}
      attachments={[
        {
          type: "file",
          id: "audio",
          name: "voice.wav",
          mimeType: "audio/wav",
          sizeBytes: wave.size,
        },
      ]}
    />,
  );
  expect(readChunk).not.toHaveBeenCalled();
  await page.getByRole("button", { name: /voice.wav/ }).click();
  await expect.element(page.getByRole("link", { name: "Download voice.wav" })).toBeInTheDocument();
  expect(readChunk).toHaveBeenCalledWith({
    threadId: "thread",
    messageId: "message",
    attachmentId: "audio",
    offset: 0,
  });
  const audio = document.querySelector("audio")!;
  expect(audio.controls).toBe(true);
  expect(audio.preload).toBe("none");
  expect(audio.autoplay).toBe(false);
  expect(audio.src).toMatch(/^blob:/);
  audio.muted = true;
  await audio.play();
  await vi.waitFor(() => expect(audio.currentTime).toBeGreaterThan(0));
  audio.pause();
  const source = audio.src;
  await screen.unmount();
  expect(revoke).toHaveBeenCalledWith(source);
});

it("offers retry when an attachment read fails", async () => {
  readChunk
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValue({ offset: 0, totalBytes: 3, dataBase64: btoa("pdf") });
  const screen = await render(
    <MessageAttachments
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("thread")}
      messageId={MessageId.make("message")}
      onImageExpand={() => undefined}
      attachments={[
        { type: "file", id: "pdf", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 3 },
      ]}
    />,
  );
  await page.getByRole("button", { name: /report.pdf/ }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Could not load file");
  await page.getByRole("button", { name: /report.pdf/ }).click();
  await expect
    .element(page.getByRole("link", { name: "Download report.pdf" }))
    .toHaveAttribute("download", "report.pdf");
  await screen.unmount();
});

it("keeps portrait and landscape user thumbnails proportional without stretching their frames", async () => {
  const dimensions = [
    [1600, 900],
    [900, 1600],
  ] as const;
  const attachments = dimensions.map(([width, height], index) => ({
    type: "image" as const,
    id: `shape-${index}`,
    name: `shape-${index}.svg`,
    mimeType: "image/svg+xml",
    sizeBytes: 100,
    width,
    height,
    previewUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`)}`,
  }));
  const expand = vi.fn();
  const screen = await render(
    <div style={{ width: 440 }}>
      <MessageAttachments variant="user" attachments={attachments} onImageExpand={expand} />
    </div>,
  );
  for (const [index, [width, height]] of dimensions.entries()) {
    const image = page
      .getByRole("img", { name: `shape-${index}.svg` })
      .element() as HTMLImageElement;
    await vi.waitFor(() => expect(image.naturalWidth).toBe(width));
    const rect = image.getBoundingClientRect();
    expect(rect.width / rect.height).toBeCloseTo(width / height, 2);
    expect(rect.height).toBeLessThanOrEqual(260);
    expect(rect.width).toBeLessThanOrEqual(360);
    expect(image.closest("button")!.getBoundingClientRect().height).toBeCloseTo(rect.height, 0);
  }
  await page.getByRole("button", { name: "Preview shape-1.svg" }).click();
  expect(expand).toHaveBeenCalledOnce();
  await screen.unmount();
});
