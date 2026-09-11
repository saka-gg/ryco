import "../../index.css";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const { readChunk } = vi.hoisted(() => ({ readChunk: vi.fn() }));
vi.mock("../../environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(),
  createEnvironmentApi: vi.fn(),
  readEnvironmentApiForConnection: vi.fn(),
  __setEnvironmentApiOverrideForTests: vi.fn(),
  __resetEnvironmentApiOverridesForTests: vi.fn(),
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

function pdfFixture() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 6 0 R >>",
    "<< /Length 26 >>\nstream\n1 0 0 rg 20 20 80 80 re f\nendstream",
    "<< /Length 26 >>\nstream\n0 0 1 rg 20 20 80 80 re f\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

it("renders an RPC PDF inside the app, paginates, zooms, and reopens without rereading", async () => {
  const pdf = pdfFixture();
  readChunk.mockResolvedValue({ offset: 0, totalBytes: pdf.length, dataBase64: btoa(pdf) });
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
          id: "pdf",
          name: "report.pdf",
          mimeType: "application/octet-stream",
          sizeBytes: pdf.length,
        },
      ]}
    />,
  );
  expect(readChunk).not.toHaveBeenCalled();
  await page.getByRole("button", { name: /report.pdf/ }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByRole("img", { name: "report.pdf, page 1" })).toBeVisible();
  const canvas = page
    .getByRole("img", { name: "report.pdf, page 1" })
    .element() as HTMLCanvasElement;
  // Verify actual raster output, not just an empty canvas/viewer shell.
  const pixel = canvas
    .getContext("2d")!
    .getImageData(Math.floor(canvas.width * 0.2), Math.floor(canvas.height * 0.85), 1, 1).data;
  expect([...pixel]).toEqual([255, 0, 0, 255]);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.element(page.getByRole("img", { name: "report.pdf, page 2" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect
    .element(page.getByRole("button", { name: "Fit to width" }))
    .toHaveTextContent("125%");
  await expect.element(page.getByRole("img", { name: "report.pdf, page 2" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Preview report.pdf" }).click();
  await expect.element(page.getByRole("img", { name: "report.pdf, page 1" })).toBeVisible();
  expect(readChunk).toHaveBeenCalledOnce();
  await screen.unmount();
  expect(revoke).toHaveBeenCalled();
});

it("previews a local composer file as escaped source and releases its URL on close", async () => {
  const { AttachmentPreviewButton } = await import("./AttachmentDocumentPreview");
  const source = "<script>window.__attachmentExecuted = true</script><h1>Hello</h1>";
  const file = new File([source], "example.html", { type: "text/html" });
  const create = vi.spyOn(URL, "createObjectURL");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const screen = await render(
    <AttachmentPreviewButton
      attachment={{ name: file.name, mimeType: file.type, sizeBytes: file.size, file }}
    />,
  );
  expect(create).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Preview example.html" }).click();
  await expect.element(page.getByText(source, { exact: true })).toBeVisible();
  expect(document.querySelector("iframe")).toBeNull();
  expect(document.querySelector("pre script")).toBeNull();
  const url = create.mock.results[0]!.value;
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(url));
  expect(readChunk).not.toHaveBeenCalled();
  await screen.unmount();
});

it("leaves unsupported documents downloadable without offering a broken preview", async () => {
  const screen = await render(
    <MessageAttachments
      onImageExpand={() => undefined}
      attachments={[
        {
          type: "file",
          id: "zip",
          name: "archive.zip",
          mimeType: "application/zip",
          sizeBytes: 10,
          previewUrl: "blob:archive",
        },
      ]}
    />,
  );
  await expect.element(page.getByRole("link", { name: "Download archive.zip" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Preview archive.zip" }))
    .not.toBeInTheDocument();
  await screen.unmount();
});

it("loads PDF fonts, character maps, and image decoders from bundled assets", async () => {
  const { PdfAttachmentBinaryDataFactory } = await import("./pdfAttachmentAssets");
  const factory = new PdfAttachmentBinaryDataFactory();
  for (const [kind, filename] of [
    ["cMapUrl", "Adobe-Japan1-UCS2.bcmap"],
    ["standardFontDataUrl", "LiberationSans-Regular.ttf"],
    ["wasmUrl", "openjpeg.wasm"],
  ]) {
    const bytes = await factory.fetch({ kind: kind!, filename: filename! });
    expect(bytes.length).toBeGreaterThan(100);
  }
});

it("rejects corrupt PDFs with a download fallback", async () => {
  const { AttachmentPreviewButton } = await import("./AttachmentDocumentPreview");
  const file = new File(["not a pdf"], "broken.pdf", { type: "application/pdf" });
  const screen = await render(
    <AttachmentPreviewButton
      attachment={{ name: file.name, mimeType: file.type, sizeBytes: file.size, file }}
    />,
  );
  await page.getByRole("button", { name: "Preview broken.pdf" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Could not preview this PDF");
  await expect.element(page.getByRole("link", { name: "Download broken.pdf" })).toBeVisible();
  await screen.unmount();
});

it("bounds text previews before fetching and rejects mislabeled binary content", async () => {
  const { AttachmentPreviewButton } = await import("./AttachmentDocumentPreview");
  const file = new File([new Uint8Array([0, 1, 2])], "binary.txt", { type: "text/plain" });
  const screen = await render(
    <AttachmentPreviewButton
      attachment={{ name: file.name, mimeType: file.type, sizeBytes: file.size, file }}
    />,
  );
  await page.getByRole("button", { name: "Preview binary.txt" }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("cannot be previewed as UTF-8 text");
  await screen.unmount();
  const fetchSpy = vi.spyOn(window, "fetch");
  const large = await render(
    <AttachmentPreviewButton
      attachment={{
        name: "large.txt",
        mimeType: "text/plain",
        sizeBytes: 1024 * 1024,
        previewUrl: "blob:must-not-fetch",
      }}
    />,
  );
  await page.getByRole("button", { name: "Preview large.txt" }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Text previews are limited to 512 KB");
  expect(fetchSpy).not.toHaveBeenCalled();
  await large.unmount();
});
