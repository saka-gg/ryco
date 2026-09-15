import "../../index.css";
import { useState } from "react";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import type { ChatMessage } from "@ryco/client-runtime/state/threads";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const { readChunk, readScope } = vi.hoisted(() => ({ readChunk: vi.fn(), readScope: vi.fn() }));
vi.mock("../../environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(),
  createEnvironmentApi: vi.fn(),
  readEnvironmentApiForConnection: vi.fn(),
  __setEnvironmentApiOverrideForTests: vi.fn(),
  __resetEnvironmentApiOverridesForTests: vi.fn(),
  readEnvironmentApi: () => ({ attachments: { readChunk } }),
}));
vi.mock("./useThreadImageReadScope", () => ({ useThreadImageReadScope: readScope }));
import { ThreadImageGallery, type ThreadImageGalleryProps } from "./ThreadImageGallery";

const scope = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const lifetime = {};
readScope.mockReturnValue({ available: true, lifetime, isCurrent: () => true });
afterEach(() => {
  vi.restoreAllMocks();
  readChunk.mockReset();
  readScope.mockReturnValue({ available: true, lifetime, isCurrent: () => true });
});

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#236c66"/><circle cx="300" cy="200" r="100" fill="#c5e8de"/></svg>';
const imageUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;
function messages(count: number, direct = true): ChatMessage[] {
  return [
    {
      id: MessageId.make("message"),
      role: "assistant",
      text: "",
      streaming: false,
      createdAt: "2026-09-15T00:00:00Z",
      attachments: Array.from({ length: count }, (_, i) => ({
        type: "image",
        id: `image-${i}`,
        name: `Image ${i}.svg`,
        mimeType: "image/svg+xml",
        sizeBytes: svg.length,
        width: 600,
        height: 400,
        ...(direct ? { previewUrl: imageUrl } : {}),
      })),
    },
  ];
}
function Harness(props: Partial<ThreadImageGalleryProps>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Thread images</button>
      <ThreadImageGallery
        scope={scope}
        messages={messages(25)}
        open={open}
        onOpenChange={setOpen}
        hasMoreBefore
        isLoadingOlder={false}
        onLoadOlder={() => undefined}
        {...props}
      />
    </>
  );
}

it("bounds thumbnails, loads older history only on request, and restores keyboard focus", async () => {
  const older = vi.fn();
  const screen = await render(<Harness onLoadOlder={older} />);
  expect(document.querySelectorAll("img")).toHaveLength(0);
  await page.getByRole("button", { name: "Thread images", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect
    .element(page.getByText("Images in loaded history · Newest messages first"))
    .toBeVisible();
  expect(document.querySelectorAll("li")).toHaveLength(24);
  expect(document.querySelectorAll('img[loading="lazy"][decoding="async"]')).toHaveLength(24);
  expect(older).not.toHaveBeenCalled();
  expect(readChunk).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  expect(document.querySelectorAll("li")).toHaveLength(1);
  await page.getByRole("button", { name: "Load older messages" }).click();
  expect(older).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "Preview Image 24.svg" }).click();
  await expect.element(page.getByRole("img", { name: "Image 24.svg" })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Download Image 24.svg" }))
    .toHaveAttribute("download", "Image 24.svg");
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("img", { name: "Image 0.svg" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Thread images", exact: true }))
    .toHaveFocus();
  await screen.unmount();
});

it("requires one explicit RPC image load, retries, and releases the owned blob on navigation", async () => {
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  let resolve!: (value: unknown) => void;
  readChunk.mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const screen = await render(<Harness messages={messages(2, false)} />);
  await page.getByRole("button", { name: "Thread images", exact: true }).click();
  await page.getByRole("button", { name: "Preview Image 0.svg" }).click();
  expect(readChunk).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Load image", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Retry image" })).toBeVisible();
  await page.getByRole("button", { name: "Retry image" }).click();
  await expect.element(page.getByRole("button", { name: "Next image" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Back to images" })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Load image", exact: true }))
    .toBeDisabled();
  expect(readChunk).toHaveBeenCalledTimes(2);
  resolve({ offset: 0, totalBytes: svg.length, dataBase64: btoa(svg) });
  await expect.element(page.getByRole("img", { name: "Image 0.svg" })).toBeVisible();
  const src = (page.getByRole("img", { name: "Image 0.svg" }).element() as HTMLImageElement).src;
  expect(src).toMatch(/^blob:/);
  expect(readChunk).toHaveBeenLastCalledWith({
    threadId: "thread",
    messageId: "message",
    attachmentId: "image-0",
    offset: 0,
  });
  await page.getByRole("button", { name: "Next image" }).click();
  expect(revoke).toHaveBeenCalledWith(src);
  expect(readChunk).toHaveBeenCalledTimes(2);
  await expect.element(page.getByRole("button", { name: "Load image", exact: true })).toBeVisible();
  await screen.unmount();
});

it("drops late RPC results after close and clears previews on lifecycle replacement", async () => {
  const create = vi.spyOn(URL, "createObjectURL");
  let resolve!: (value: unknown) => void;
  readChunk.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const screen = await render(<Harness messages={messages(1, false)} />);
  await page.getByRole("button", { name: "Thread images", exact: true }).click();
  await page.getByRole("button", { name: "Preview Image 0.svg" }).click();
  await page.getByRole("button", { name: "Load image", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  resolve({ offset: 0, totalBytes: svg.length, dataBase64: btoa(svg) });
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(create).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Thread images", exact: true }).click();
  await page.getByRole("button", { name: "Preview Image 0.svg" }).click();
  readChunk.mockResolvedValue({ offset: 0, totalBytes: svg.length, dataBase64: btoa(svg) });
  await page.getByRole("button", { name: "Load image", exact: true }).click();
  await expect.element(page.getByRole("img", { name: "Image 0.svg" })).toBeVisible();
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  readScope.mockReturnValue({ available: true, lifetime: {}, isCurrent: () => true });
  await screen.rerender(<Harness messages={messages(1, false)} />);
  await expect.element(page.getByRole("button", { name: "Preview Image 0.svg" })).toBeVisible();
  expect(revoke).toHaveBeenCalledOnce();
  await screen.unmount();
});

it("removes reverted selections and clears content when the environment becomes unavailable", async () => {
  const screen = await render(<Harness messages={messages(1)} />);
  await page.getByRole("button", { name: "Thread images", exact: true }).click();
  await page.getByRole("button", { name: "Preview Image 0.svg" }).click();
  await screen.rerender(<Harness messages={[]} loadOlderError="offline" />);
  await expect.element(page.getByText("No image attachments in loaded history.")).toBeVisible();
  expect(document.querySelectorAll("img")).toHaveLength(0);
  await expect.element(page.getByRole("alert")).toHaveTextContent("Could not load older messages");
  readScope.mockReturnValue({ available: false, lifetime: {}, isCurrent: () => false });
  await screen.rerender(<Harness messages={messages(1)} />);
  await expect.element(page.getByRole("status")).toHaveTextContent("Images are unavailable");
  expect(document.querySelectorAll("img")).toHaveLength(0);
  await screen.unmount();
});

it("keeps the grid inside a tablet dialog and the modal keyboard focus contained", async () => {
  await page.viewport(900, 800);
  const screen = await render(<Harness />);
  await page.getByRole("button", { name: "Thread images", exact: true }).click();
  const dialog = page.getByRole("dialog").element();
  const rect = dialog.getBoundingClientRect();
  expect(rect.width).toBeLessThanOrEqual(900);
  expect(rect.height).toBeLessThanOrEqual(800);
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  for (let i = 0; i < 32; i++) {
    await userEvent.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);
  }
  await page.screenshot({ path: "../../../../../output/task22-gallery-tablet.png" });
  await screen.unmount();
  await page.viewport(1280, 900);
});

it("keeps failed direct images downloadable and shows a readable thumbnail fallback", async () => {
  const broken = messages(1);
  broken[0]!.attachments![0]!.previewUrl = "data:image/png;base64,bm90YW5pbWFnZQ==";
  const screen = await render(<Harness messages={broken} />);
  await page.getByRole("button", { name: "Thread images", exact: true }).click();
  await expect.element(page.getByText("Preview unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Preview Image 0.svg" }).click();
  await expect
    .element(page.getByText("Could not display this image. Download it to open it."))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Download Image 0.svg" }))
    .toHaveAttribute("download", "Image 0.svg");
  expect(readChunk).not.toHaveBeenCalled();
  await screen.unmount();
});

it("discards a pending RPC image when switching thread scope, without publishing a blob", async () => {
  const create = vi.spyOn(URL, "createObjectURL");
  let resolve!: (value: unknown) => void;
  readChunk.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const screen = await render(<Harness messages={messages(1, false)} />);
  await page.getByRole("button", { name: "Thread images", exact: true }).click();
  await page.getByRole("button", { name: "Preview Image 0.svg" }).click();
  await page.getByRole("button", { name: "Load image", exact: true }).click();
  await screen.rerender(
    <Harness
      scope={{ ...scope, threadId: ThreadId.make("replacement") }}
      messages={messages(1, false)}
    />,
  );
  resolve({ offset: 0, totalBytes: svg.length, dataBase64: btoa(svg) });
  await expect.element(page.getByRole("button", { name: "Preview Image 0.svg" })).toBeVisible();
  expect(create).not.toHaveBeenCalled();
  expect(readChunk).toHaveBeenCalledOnce();
  await screen.unmount();
});

it("shows the shared expanded image presentation at desktop size", async () => {
  await page.viewport(1280, 900);
  const screen = await render(<Harness messages={messages(2)} />);
  await page.getByRole("button", { name: "Thread images", exact: true }).click();
  await page.getByRole("button", { name: "Preview Image 0.svg" }).click();
  const img = page.getByRole("img", { name: "Image 0.svg" }).element() as HTMLImageElement;
  await vi.waitFor(() => expect(img.naturalWidth).toBe(600));
  const bounds = img.getBoundingClientRect();
  expect(bounds.width / bounds.height).toBeCloseTo(1.5);
  expect(bounds.bottom).toBeLessThan(900);
  await page.screenshot({ path: "../../../../../output/task22-gallery-desktop.png" });
  await screen.unmount();
});
