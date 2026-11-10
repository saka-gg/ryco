import "../../index.css";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { injectHtmlRenderBootstrap } from "@ryco/shared/htmlRender";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
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

import { parkPointer, resetPointerEmulation } from "../../../test/browserPointer";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { __resetHtmlRenderMessagesForTests } from "./htmlRenderMessages";
import { __resetHtmlRenderZoomForTests } from "./htmlRenderZoomStore";
import { __resetHtmlRenderSourceCacheForTests } from "./useHtmlRenderSource";

// Zoom of an agent page shown full size (`HtmlRenderZoom`): buttons, Cmd/Ctrl
// + / − / 0 inside the page (its bootstrap reports them) and in the view,
// Ctrl+wheel (a pinch), Fit width, and the level kept per page for the session.
// The inline frame offers none of it, so its keys stay the browser's.

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread");
let messageId = MessageId.make("zoom-message-0");
let messageCount = 0;

/** A fixed-width page, 1400 px wide, as a dashboard mockup is. */
const WIDE_PAGE = `<div id="wide" style="width:1400px;height:240px">Wide dashboard</div>`;

function pageBytes(body: string) {
  return new TextEncoder().encode(
    injectHtmlRenderBootstrap(`<!doctype html><html><head></head><body>${body}</body></html>`),
  );
}

function serve(bytes: Uint8Array) {
  readChunk.mockImplementation(async ({ offset }: { offset: number }) => {
    let binary = "";
    const chunk = bytes.subarray(offset, offset + 256 * 1024);
    for (let at = 0; at < chunk.length; at += 8192) {
      binary += String.fromCharCode(...chunk.subarray(at, at + 8192));
    }
    return { offset, totalBytes: bytes.length, dataBase64: btoa(binary) };
  });
}

function renderFrame(bytes: Uint8Array) {
  const htmlRender = { title: "Dashboard", height: 300 };
  return render(
    <AppAtomRegistryProvider>
      <div style={{ width: 600 }}>
        <HtmlRenderFrame
          environmentId={environmentId}
          threadId={threadId}
          messageId={messageId}
          attachment={{
            type: "file",
            id: "thread-zoom-html",
            name: "Dashboard.html",
            mimeType: "text/html",
            sizeBytes: bytes.length,
            htmlRender,
          }}
          htmlRender={htmlRender}
        />
      </div>
    </AppAtomRegistryProvider>,
  );
}

const zoomBox = () => document.querySelector<HTMLElement>("[data-html-render-zoom]");
const zoomLevel = () => Number(zoomBox()?.getAttribute("data-html-render-zoom"));
const zoomedFrame = () => zoomBox()!.querySelector("iframe")!;
const inlineFrame = () =>
  document.querySelector<HTMLElement>("[data-html-render-frame]")!.querySelector("iframe")!;

async function openFullSize() {
  await page.getByRole("button", { name: "Open full size" }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await vi.waitFor(() => expect(zoomedFrame().className).toContain("opacity-100"));
  return dialog;
}

beforeEach(async () => {
  messageCount += 1;
  messageId = MessageId.make(`zoom-message-${messageCount}`);
  await page.viewport(1_280, 900);
  await resetPointerEmulation();
  await parkPointer(1_270, 890);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetHtmlRenderMessagesForTests();
  __resetHtmlRenderZoomForTests();
  readChunk.mockReset();
  __resetHtmlRenderSourceCacheForTests();
});

it("zooms the expanded page with its buttons, the way browser zoom does", async () => {
  const bytes = pageBytes(WIDE_PAGE);
  serve(bytes);
  const screen = await renderFrame(bytes);
  await vi.waitFor(() => expect(inlineFrame()).toBeTruthy());
  const dialog = await openFullSize();

  await expect
    .element(dialog.getByRole("button", { name: "Zoom 100%, reset to 100%" }))
    .toBeVisible();
  expect(zoomLevel()).toBe(1);
  expect(zoomedFrame().style.transform).toBe("");

  await dialog.getByRole("button", { name: "Zoom in" }).click();
  expect(zoomLevel()).toBe(1.1);
  // Laid out narrower, scaled back up to fill the box.
  expect(zoomedFrame().style.transform).toBe("scale(1.1)");
  expect(zoomedFrame().style.width).toBe("90.9091%");
  await dialog.getByRole("button", { name: "Zoom out" }).click();
  await dialog.getByRole("button", { name: "Zoom out" }).click();
  expect(zoomLevel()).toBe(0.9);
  await dialog.getByRole("button", { name: "Zoom 90%, reset to 100%" }).click();
  expect(zoomLevel()).toBe(1);
  await screen.unmount();
});

it("takes Cmd/Ctrl + / − / 0 from inside the page, and in the view around it", async () => {
  const bytes = pageBytes(WIDE_PAGE);
  serve(bytes);
  const screen = await renderFrame(bytes);
  await vi.waitFor(() => expect(inlineFrame()).toBeTruthy());
  const dialog = await openFullSize();

  // The page's keys never reach the app; its bootstrap reports the zoom keys
  // and keeps them from zooming the browser.
  await userEvent.click(zoomedFrame());
  expect(document.activeElement).toBe(zoomedFrame());
  await userEvent.keyboard("{Control>}={/Control}");
  await vi.waitFor(() => expect(zoomLevel()).toBe(1.1));
  await userEvent.keyboard("{Control>}={/Control}");
  await vi.waitFor(() => expect(zoomLevel()).toBe(1.25));
  await userEvent.keyboard("{Meta>}-{/Meta}");
  await vi.waitFor(() => expect(zoomLevel()).toBe(1.1));
  await userEvent.keyboard("{Control>}0{/Control}");
  await vi.waitFor(() => expect(zoomLevel()).toBe(1));

  // Focus on the view's own controls: the dialog takes the same keys.
  (dialog.getByRole("button", { name: "Zoom in" }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Control>}-{/Control}");
  expect(zoomLevel()).toBe(0.9);
  await userEvent.keyboard("{Control>}0{/Control}");
  expect(zoomLevel()).toBe(1);
  await screen.unmount();
});

it("zooms on a pinch or Ctrl+wheel over the page's box, and leaves a plain wheel alone", async () => {
  const bytes = pageBytes(WIDE_PAGE);
  serve(bytes);
  const screen = await renderFrame(bytes);
  await vi.waitFor(() => expect(inlineFrame()).toBeTruthy());
  await openFullSize();

  const pinch = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true });
  zoomBox()!.dispatchEvent(pinch);
  // Held back from the browser, which would zoom the whole app.
  expect(pinch.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(zoomLevel()).toBe(1.25));

  const scroll = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
  zoomBox()!.dispatchEvent(scroll);
  expect(scroll.defaultPrevented).toBe(false);
  expect(zoomLevel()).toBe(1.25);
  await screen.unmount();
});

it("fits a wide page's width, follows the box, and keeps the page's zoom for the session", async () => {
  const bytes = pageBytes(WIDE_PAGE);
  serve(bytes);
  const screen = await renderFrame(bytes);
  await vi.waitFor(() => expect(inlineFrame()).toBeTruthy());
  let dialog = await openFullSize();

  await dialog.getByRole("button", { name: "Fit width" }).click();
  const boxWidth = zoomBox()!.clientWidth;
  // The page reports it needs 1400 px; the frame is laid out that wide and scaled down.
  await vi.waitFor(() => expect(zoomLevel()).toBeCloseTo(boxWidth / 1400, 2));
  expect(zoomLevel()).toBeLessThan(1);
  await expect
    .element(dialog.getByRole("button", { name: "Fit width" }))
    .toHaveAttribute("aria-pressed", "true");

  // Closed and opened again: the same page comes back fitted.
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  dialog = await openFullSize();
  await expect
    .element(dialog.getByRole("button", { name: "Fit width" }))
    .toHaveAttribute("aria-pressed", "true");
  await vi.waitFor(() => expect(zoomLevel()).toBeCloseTo(zoomBox()!.clientWidth / 1400, 2));

  // Pressed again, Fit width lets go: back to 100%.
  await dialog.getByRole("button", { name: "Fit width" }).click();
  expect(zoomLevel()).toBe(1);
  await screen.unmount();
});

it("leaves the zoom keys to the browser in the inline frame, which offers no zoom", async () => {
  const bytes = pageBytes(`<button id="inside">Inside</button>`);
  serve(bytes);
  const screen = await renderFrame(bytes);
  await vi.waitFor(() => expect(inlineFrame().className).toContain("opacity-100"));
  const messages: unknown[] = [];
  const listener = (event: MessageEvent) => {
    if (event.source === inlineFrame().contentWindow) messages.push(event.data);
  };
  window.addEventListener("message", listener);
  try {
    expect(inlineFrame().name).not.toContain('"zoom":true');
    await userEvent.click(inlineFrame());
    await userEvent.keyboard("{Control>}={/Control}");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      messages.some(
        (message) => (message as { method?: string }).method === "ryco/notifications/zoom",
      ),
    ).toBe(false);
    expect(zoomBox()).toBeNull();
  } finally {
    window.removeEventListener("message", listener);
    await screen.unmount();
  }
});
