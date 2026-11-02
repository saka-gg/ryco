import "../../index.css";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { wsConnectionOpenedCountAtom } from "@ryco/client-runtime/rpc";
import { injectHtmlRenderBootstrap, type HtmlRenderMetadata } from "@ryco/shared/htmlRender";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";

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
import { getPresentationTier, syncDocumentPresentationTier } from "../../lib/presentationTier";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { readHtmlRenderTheme } from "../../themes/htmlRenderTheme";
import { THEME_STYLE_ELEMENT_ID } from "../../themes/registry";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { useHtmlRenderMessages } from "./HtmlRenderMessageConfirmation";
import { __resetHtmlRenderMessagesForTests } from "./htmlRenderMessages";
import { __resetHtmlRenderSourceCacheForTests } from "./useHtmlRenderSource";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread");
// Each test renders its own message: a page's reported height is remembered
// per message for the session, as it is in the app.
let messageId = MessageId.make("render-message-0");
let messageCount = 0;
const attachmentId = "thread-abc-html";

function pageBytes(body: string) {
  return new TextEncoder().encode(
    injectHtmlRenderBootstrap(`<!doctype html><html><head></head><body>${body}</body></html>`),
  );
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return btoa(binary);
}

/** Serves the page in the transport's 256 KiB chunks, each after an optional delay. */
function serve(bytes: Uint8Array, options: { chunkDelayMs?: number } = {}) {
  readChunk.mockImplementation(async ({ offset }: { offset: number }) => {
    if (options.chunkDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs));
    }
    return {
      offset,
      totalBytes: bytes.length,
      dataBase64: base64(bytes.subarray(offset, offset + 256 * 1024)),
    };
  });
}

const readsFromStart = () =>
  readChunk.mock.calls.filter(([input]) => (input as { offset: number }).offset === 0).length;

/** A socket opening somewhere in the app, as `recordWsConnectionOpened` counts it. */
function openSocket() {
  appAtomRegistry.set(
    wsConnectionOpenedCountAtom,
    appAtomRegistry.get(wsConnectionOpenedCountAtom) + 1,
  );
}

const withAtoms = (node: ReactNode) => <AppAtomRegistryProvider>{node}</AppAtomRegistryProvider>;

function renderFrame(
  bytes: Uint8Array,
  htmlRender: HtmlRenderMetadata = { title: "Chart", height: 1000 },
  options: {
    sizeBytes?: number;
    wrap?: (node: ReactNode) => ReactNode;
    canSendMessages?: boolean;
  } = {},
) {
  const frame = (
    <div style={{ width: 600 }}>
      <HtmlRenderFrame
        environmentId={environmentId}
        threadId={threadId}
        messageId={messageId}
        attachment={{
          type: "file",
          id: attachmentId,
          name: "Chart.html",
          mimeType: "text/html",
          sizeBytes: options.sizeBytes ?? bytes.length,
          htmlRender,
        }}
        htmlRender={htmlRender}
        canSendMessages={options.canSendMessages === true}
      />
    </div>
  );
  return render(<>{options.wrap ? options.wrap(frame) : frame}</>);
}

const frameBox = () => document.querySelector<HTMLElement>("[data-html-render-frame]")!;
const frameElement = () => frameBox().querySelector("iframe")!;

/** Messages the inline page posted to the app. */
function collectPageMessages() {
  const messages: unknown[] = [];
  const listener = (event: MessageEvent) => {
    if (event.source !== null && event.source === frameElement()?.contentWindow) {
      messages.push(event.data);
    }
  };
  window.addEventListener("message", listener);
  return { messages, stop: () => window.removeEventListener("message", listener) };
}

beforeEach(async () => {
  messageCount += 1;
  messageId = MessageId.make(`render-message-${messageCount}`);
  // Desktop tier: the phone tier hides the expand affordance.
  await page.viewport(1_280, 900);
  // An earlier file may leave touch emulation on or the pointer resting where
  // a frame will render; either would reveal the hover-only expand button.
  await resetPointerEmulation();
  await parkPointer(1_270, 890);
  document.documentElement.classList.add("dark");
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetHtmlRenderMessagesForTests();
  readChunk.mockReset();
  __resetHtmlRenderSourceCacheForTests();
  document.documentElement.classList.remove("dark");
});

it("auto-loads the page into an exactly sandboxed srcdoc frame that paints with the app theme", async () => {
  const bytes = pageBytes(
    `<p>Chart</p><script>window.addEventListener("load",function(){parent.postMessage({probe:"theme",name:window.name,background:getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),scheme:getComputedStyle(document.documentElement).colorScheme},"*")})</script>`,
  );
  serve(bytes);
  const page$ = collectPageMessages();
  const screen = await renderFrame(bytes);
  await vi.waitFor(() => expect(frameElement()).toBeTruthy());
  const iframe = frameElement();
  expect(readChunk).toHaveBeenCalledWith({ threadId, messageId, attachmentId, offset: 0 });
  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  expect(iframe.hasAttribute("src")).toBe(false);
  expect(iframe.srcdoc).toBe(new TextDecoder().decode(bytes));
  expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(iframe.title).toBe("Chart");
  expect(iframe.name.startsWith("ryco-theme:")).toBe(true);

  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual(expect.objectContaining({ probe: "theme" })),
  );
  const probe = page$.messages.find(
    (message): message is { name: string; background: string; scheme: string } =>
      (message as { probe?: string }).probe === "theme",
  )!;
  // The page painted its first frame with the app's theme, read from the
  // frame name, and keeps the theme it wears there so a reload wears it too.
  expect(probe.name).toBe(iframe.getAttribute("name"));
  expect(probe.scheme).toBe("dark");
  expect(probe.background).toBe(readHtmlRenderTheme().variables["--background"]);
  // ...which is the background actually painted behind the frame.
  const surface = document.createElement("div");
  surface.className = "bg-background";
  document.body.append(surface);
  expect(probe.background).toBe(getComputedStyle(surface).backgroundColor);
  surface.remove();
  await vi.waitFor(() => expect(iframe.className).toContain("opacity-100"));
  page$.stop();
  await screen.unmount();
});

it("fits the box to the page's own height reports and ignores reports from other windows", async () => {
  const bytes = pageBytes(
    `<div id="box" style="height:300px"></div><script>window.addEventListener("message",function(e){if(e.data&&e.data.grow)document.getElementById("box").style.height=e.data.grow+"px"})</script>`,
  );
  serve(bytes);
  const screen = await renderFrame(bytes, { title: "Chart", height: 1000 });
  // The box holds the agent's height before anything loads.
  expect(frameBox().style.height).toBe("1000px");
  await vi.waitFor(() => expect(frameBox().style.height).toBe("300px"));
  // The first report snaps; nothing animates on mount.
  expect(frameBox().className).not.toContain("transition-[height]");

  window.postMessage(
    { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 900 } },
    "*",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(frameBox().style.height).toBe("300px");

  frameElement().contentWindow!.postMessage({ grow: 500 }, "*");
  await vi.waitFor(() => expect(frameBox().style.height).toBe("500px"));
  expect(frameBox().className).toContain("transition-[height]");
  await screen.unmount();
});

it("reveals the expand button while the page reports the pointer over it", async () => {
  // The sandboxed page runs out of process, so in the app the frame never
  // matches :hover; the page's own report is what shows the button. This page
  // reports without any real pointer, so CSS hover plays no part here.
  const bytes = pageBytes(
    `<div style="height:300px">Chart</div><script>window.addEventListener("message",function(e){if(e.data&&typeof e.data.point==="boolean")parent.postMessage({jsonrpc:"2.0",method:"ryco/notifications/pointer-changed",params:{inside:e.data.point}},"*")})</script>`,
  );
  serve(bytes);
  const screen = await renderFrame(bytes, { title: "Chart", height: 300 });
  await vi.waitFor(() =>
    expect(frameBox().querySelector('[aria-label="Open full size"]')).toBeTruthy(),
  );
  const reveal = () =>
    getComputedStyle(frameBox().querySelector('[aria-label="Open full size"]')!.parentElement!)
      .opacity;
  await vi.waitFor(() => expect(frameBox().style.height).toBe("300px"));
  expect(reveal()).toBe("0");

  // Another window claiming the pointer is ignored.
  window.postMessage(
    { jsonrpc: "2.0", method: "ryco/notifications/pointer-changed", params: { inside: true } },
    "*",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(reveal()).toBe("0");

  frameElement().contentWindow!.postMessage({ point: true }, "*");
  await vi.waitFor(() => expect(reveal()).toBe("1"));
  frameElement().contentWindow!.postMessage({ point: false }, "*");
  await vi.waitFor(() => expect(reveal()).toBe("0"));
  await screen.unmount();
});

it("has the bootstrap report the pointer entering and leaving the page", async () => {
  const bytes = pageBytes(`<div style="height:300px">Chart</div>`);
  serve(bytes);
  const page$ = collectPageMessages();
  const screen = await renderFrame(bytes, { title: "Chart", height: 300 });
  await vi.waitFor(() => expect(frameBox().style.height).toBe("300px"));
  const reports = () =>
    page$.messages.flatMap((message) =>
      (message as { method?: string }).method === "ryco/notifications/pointer-changed"
        ? [(message as { params: { inside: boolean } }).params.inside]
        : [],
    );
  await userEvent.hover(frameElement());
  await vi.waitFor(() => expect(reports()).toEqual([true]));
  await userEvent.unhover(frameElement());
  await vi.waitFor(() => expect(reports()).toEqual([true, false]));
  page$.stop();
  await screen.unmount();
});

it("remounts a row that scrolled back at the page's own height, without reading it again", async () => {
  const bytes = pageBytes(`<div style="height:300px"></div>`);
  serve(bytes);
  const first = await renderFrame(bytes, { title: "Chart", height: 1000 });
  await vi.waitFor(() => expect(frameBox().style.height).toBe("300px"));
  await first.unmount();

  const second = await renderFrame(bytes, { title: "Chart", height: 1000 });
  // Reserved at the reported height and painted from memory on the first commit.
  expect(frameBox().style.height).toBe("300px");
  expect(frameElement()).toBeTruthy();
  expect(readChunk).toHaveBeenCalledOnce();
  await second.unmount();
});

it("posts theme changes into the mounted page without reloading it", async () => {
  const bytes = pageBytes(
    `<script>parent.postMessage({loaded:true},"*");window.addEventListener("message",function(e){var d=e.data;if(d&&d.method==="ui/notifications/host-context-changed")parent.postMessage({echo:d.params.theme,background:getComputedStyle(document.documentElement).getPropertyValue("--background").trim()},"*")})</script>`,
  );
  serve(bytes);
  const page$ = collectPageMessages();
  const screen = await renderFrame(bytes);
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual(expect.objectContaining({ echo: "dark" })),
  );
  const iframe = frameElement();
  const name = iframe.name;

  document.documentElement.classList.remove("dark");
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual({ echo: "light", background: "rgb(255, 255, 255)" }),
  );
  expect(frameElement()).toBe(iframe);
  expect(iframe.name).toBe(name);
  expect(page$.messages.filter((message) => (message as { loaded?: boolean }).loaded)).toHaveLength(
    1,
  );
  page$.stop();
  await screen.unmount();
});

it("hands the live theme to a page that reloads itself", async () => {
  // A custom theme, so the page's own default palette cannot pass for it.
  const custom = document.createElement("style");
  custom.id = THEME_STYLE_ELEMENT_ID;
  custom.textContent = ":root.dark { --background: rgb(10, 40, 80); }";
  document.head.append(custom);
  try {
    const background = "rgb(10, 40, 80)";
    expect(readHtmlRenderTheme().variables["--background"]).toBe(background);
    const bytes = pageBytes(
      `<script>function r(p){parent.postMessage({probe:p,background:getComputedStyle(document.documentElement).getPropertyValue("--background").trim()},"*")}r("start");window.addEventListener("message",function(e){var d=e.data;if(d&&d.reload)location.reload();else if(d&&d.method==="ui/notifications/host-context-changed")r("theme")})</script>`,
    );
    serve(bytes);
    const page$ = collectPageMessages();
    const screen = await renderFrame(bytes);
    await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));
    expect(page$.messages).toContainEqual({ probe: "start", background });

    page$.messages.length = 0;
    const iframe = frameElement();
    iframe.contentWindow!.postMessage({ reload: true }, "*");
    // The reloaded document paints with the theme its bootstrap kept in the
    // frame's name; its load still hands it the live theme, which keeps it in
    // step when the theme changed while it reloaded.
    await vi.waitFor(() =>
      expect(page$.messages).toContainEqual(expect.objectContaining({ probe: "start" })),
    );
    await vi.waitFor(() => expect(page$.messages).toContainEqual({ probe: "theme", background }));
    expect(frameElement()).toBe(iframe);
    page$.stop();
    await screen.unmount();
  } finally {
    custom.remove();
  }
});

it("paints a page that reloads itself with the theme it last received, before its load", async () => {
  // A custom theme, so the page's own default palette cannot pass for it.
  const custom = document.createElement("style");
  custom.id = THEME_STYLE_ELEMENT_ID;
  custom.textContent = ":root.dark { --background: rgb(10, 40, 80); }";
  document.head.append(custom);
  try {
    // The page reports the background it lays out with as soon as its DOM is
    // parsed: before its load event, so before the app can post it anything.
    const bytes = pageBytes(
      `<script>function r(p){parent.postMessage({probe:p,background:getComputedStyle(document.documentElement).getPropertyValue("--background").trim()},"*")}document.addEventListener("DOMContentLoaded",function(){r("parsed")});window.addEventListener("message",function(e){var d=e.data;if(d&&d.reload)location.reload();else if(d&&d.method==="ui/notifications/host-context-changed")r("theme")})</script>`,
    );
    serve(bytes);
    const page$ = collectPageMessages();
    const screen = await renderFrame(bytes);
    await vi.waitFor(() =>
      expect(page$.messages).toContainEqual({ probe: "parsed", background: "rgb(10, 40, 80)" }),
    );
    await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));

    // The theme changes while the page runs.
    custom.textContent = ":root.dark { --background: rgb(70, 20, 30); }";
    await vi.waitFor(() =>
      expect(page$.messages).toContainEqual({ probe: "theme", background: "rgb(70, 20, 30)" }),
    );

    page$.messages.length = 0;
    const iframe = frameElement();
    iframe.contentWindow!.postMessage({ reload: true }, "*");
    await vi.waitFor(() =>
      expect(page$.messages).toContainEqual(expect.objectContaining({ probe: "parsed" })),
    );
    // Its first frame after the reload already wears the new theme.
    expect(
      page$.messages.find((message) => (message as { probe?: string }).probe === "parsed"),
    ).toEqual({ probe: "parsed", background: "rgb(70, 20, 30)" });
    expect(frameElement()).toBe(iframe);
    page$.stop();
    await screen.unmount();
  } finally {
    custom.remove();
  }
});

it("swaps an older build's bootstrap in a stored page for this build's", async () => {
  const current = new TextDecoder().decode(
    pageBytes(
      `<p>Chart</p><script>parent.postMessage({probe:"bootstrap",old:window.__olderBootstrap===true,current:typeof window.name==="string"&&window.name.indexOf("ryco-theme:")===0},"*")</script>`,
    ),
  );
  // The page as an older build stored it: the injected bootstrap's script differs.
  const stored = current.replace(
    /<script>[\s\S]*?<\/script>/,
    "<script>window.__olderBootstrap=true</script>",
  );
  expect(stored).not.toBe(current);
  const bytes = new TextEncoder().encode(stored);
  serve(bytes);
  const page$ = collectPageMessages();
  const screen = await renderFrame(bytes);
  await vi.waitFor(() => expect(frameElement()).toBeTruthy());
  expect(frameElement().srcdoc).toBe(current);
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual({ probe: "bootstrap", old: false, current: true }),
  );
  page$.stop();
  await screen.unmount();
});

it("opens links only for a focused frame the reader just used", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  // The page asks on load, and again whenever the app tells it to.
  const bytes = pageBytes(
    `<a href="https://example.com/report" style="display:block;height:400px">Report</a><script>function ask(id){parent.postMessage({jsonrpc:"2.0",id:id,method:"ui/open-link",params:{url:"https://example.com/"+id}},"*")}ask("forged");window.addEventListener("message",function(e){var d=e.data;if(d&&d.result)parent.postMessage({ack:d.id},"*");else if(d&&d.ask)ask(d.ask)})</script>`,
  );
  serve(bytes);
  const page$ = collectPageMessages();
  const screen = await renderFrame(
    bytes,
    { title: "Chart", height: 400 },
    {
      wrap: (node) => (
        <>
          {node}
          <button type="button">Elsewhere</button>
        </>
      ),
    },
  );
  await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));
  /** Has the page ask for a link and waits until the app has seen the request. */
  const pageAsks = async (id: string) => {
    frameElement().contentWindow!.postMessage({ ask: id }, "*");
    await vi.waitFor(() =>
      expect(page$.messages).toContainEqual(
        expect.objectContaining({ id, method: "ui/open-link" }),
      ),
    );
  };
  // Neither a page asking on load nor another window may open anything.
  window.postMessage(
    {
      jsonrpc: "2.0",
      id: "other",
      method: "ui/open-link",
      params: { url: "https://example.com/other" },
    },
    "*",
  );
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual(expect.objectContaining({ id: "forged" })),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(open).not.toHaveBeenCalled();

  // Focus alone is not enough: a script can focus the frame without the reader.
  await vi.waitFor(() => expect(navigator.userActivation.isActive).toBe(false), {
    timeout: 10_000,
  });
  frameElement().focus();
  expect(document.activeElement).toBe(frameElement());
  await pageAsks("focused");
  expect(open).not.toHaveBeenCalled();

  // Nor is a reader who just used the app somewhere other than this frame.
  await userEvent.click(page.getByRole("button", { name: "Elsewhere" }));
  expect(navigator.userActivation.isActive).toBe(true);
  expect(document.activeElement).not.toBe(frameElement());
  await pageAsks("elsewhere");
  expect(open).not.toHaveBeenCalled();

  await userEvent.click(frameElement());
  await vi.waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      "https://example.com/report",
      "_blank",
      "noopener,noreferrer",
    ),
  );
  expect(open).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(page$.messages).toContainEqual({ ack: "ryco-link-1" }));
  page$.stop();
  await screen.unmount();
});

it("expands to a full-size dialog with source and download, then closes", async () => {
  const bytes = pageBytes(`<h1 id="chart">Quarterly chart</h1>`);
  serve(bytes);
  const screen = await renderFrame(bytes);
  await vi.waitFor(() => expect(frameElement()).toBeTruthy());

  await page.getByRole("button", { name: "Open full size" }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByText("Chart", { exact: true })).toBeVisible();
  const fullSize = dialog.element().querySelector("iframe")!;
  expect(fullSize.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  expect(fullSize.srcdoc).toBe(new TextDecoder().decode(bytes));

  await dialog.getByRole("button", { name: "Source" }).click();
  const source = dialog.element().querySelector("pre")!;
  expect(source.textContent).toContain('<h1 id="chart">Quarterly chart</h1>');
  // The agent's own markup, without the bootstrap Ryco injected.
  expect(source.textContent).not.toContain("ryco-theme");
  expect(source.querySelector("h1, script")).toBeNull();

  const createObjectURL = vi.spyOn(URL, "createObjectURL");
  const downloads: Array<{ download: string; href: string }> = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ download: this.download, href: this.href });
  });
  await dialog.getByRole("button", { name: "Download" }).click();
  expect(downloads).toEqual([{ download: "Chart.html", href: expect.stringMatching(/^blob:/) }]);
  const blob = createObjectURL.mock.calls[0]![0] as Blob;
  expect(blob.type).toBe("application/octet-stream");
  expect(await blob.text()).toBe(new TextDecoder().decode(bytes));

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.unmount();
});

it("closes the full-size dialog on Escape pressed inside the page", async () => {
  const bytes = pageBytes(`<button id="inside">Inside</button>`);
  serve(bytes);
  const screen = await renderFrame(bytes);
  await vi.waitFor(() => expect(frameElement()).toBeTruthy());
  await page.getByRole("button", { name: "Open full size" }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  const fullSize = dialog.element().querySelector("iframe")!;
  await vi.waitFor(() => expect(fullSize.className).toContain("opacity-100"));
  // The page's keys never reach the app; its bootstrap reports Escape.
  await userEvent.click(fullSize);
  expect(document.activeElement).toBe(fullSize);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.unmount();
});

it("shows the page once it lays out, without waiting for its load event", async () => {
  // A slow or unreachable remote image keeps `load` from firing; drop the
  // frame's load listeners to stand in for it.
  const addEventListener = HTMLIFrameElement.prototype.addEventListener;
  vi.spyOn(HTMLIFrameElement.prototype, "addEventListener").mockImplementation(function (
    this: HTMLIFrameElement,
    type: string,
    ...rest: [EventListenerOrEventListenerObject, (boolean | AddEventListenerOptions)?]
  ) {
    if (type !== "load") addEventListener.call(this, type, ...rest);
  });
  const bytes = pageBytes(`<div style="height:240px">Chart</div>`);
  serve(bytes);
  const screen = await renderFrame(bytes, { title: "Chart", height: 600 });
  await vi.waitFor(() => expect(frameBox().style.height).toBe("240px"));
  expect(frameElement().className).toContain("opacity-100");
  await screen.unmount();
});

it("hides the expand affordance on the phone tier", async () => {
  await page.viewport(390, 844);
  const stop = syncDocumentPresentationTier();
  try {
    await vi.waitFor(() => expect(getPresentationTier()).toBe("phone"));
    const bytes = pageBytes(`<p>Chart</p>`);
    serve(bytes);
    const screen = await renderFrame(bytes);
    await vi.waitFor(() => expect(frameElement()).toBeTruthy());
    expect(document.querySelector('[aria-label="Open full size"]')).toBeNull();
    await screen.unmount();
  } finally {
    stop();
  }
});

it("holds the box on failure and loads the page on retry", async () => {
  const bytes = pageBytes(`<p>Chart</p>`);
  serve(bytes);
  readChunk.mockRejectedValueOnce(new Error("Disconnected"));
  const screen = await renderFrame(bytes, { title: "Chart", height: 360 });
  await expect.element(page.getByText("Unable to load Chart")).toBeVisible();
  expect(frameBox().style.height).toBe("360px");
  await page.getByRole("button", { name: "Retry" }).click();
  await vi.waitFor(() => expect(frameElement()).toBeTruthy());
  await screen.unmount();
});

it("retries a failed read when a connection opens", async () => {
  const bytes = pageBytes(`<p>Chart</p>`);
  serve(bytes);
  readChunk.mockRejectedValueOnce(new Error("Attachment connection unavailable."));
  const screen = await renderFrame(bytes, { title: "Chart", height: 360 }, { wrap: withAtoms });
  await expect.element(page.getByText("Unable to load Chart")).toBeVisible();
  openSocket();
  await vi.waitFor(() => expect(frameElement()).toBeTruthy());
  expect(readChunk).toHaveBeenCalledTimes(2);
  await screen.unmount();
});

it("lets a read in flight finish while sockets open elsewhere", async () => {
  // Three chunks, so the read is still going when the sockets open.
  const bytes = pageBytes(`<!-- ${"x".repeat(600 * 1024)} --><p>Chart</p>`);
  serve(bytes, { chunkDelayMs: 60 });
  const screen = await renderFrame(bytes, { title: "Chart", height: 360 }, { wrap: withAtoms });
  await vi.waitFor(() => expect(readChunk).toHaveBeenCalled());
  openSocket();
  await new Promise((resolve) => setTimeout(resolve, 70));
  openSocket();
  await vi.waitFor(() => expect(frameElement()).toBeTruthy());
  expect(readsFromStart()).toBe(1);
  expect(readChunk).toHaveBeenCalledTimes(3);
  await screen.unmount();
});

it("reads again at once when its own connection was replaced mid-read", async () => {
  const bytes = pageBytes(`<p>Chart</p>`);
  serve(bytes);
  readChunk.mockImplementationOnce(async () => {
    // The environment reconnected while this chunk was in flight.
    openSocket();
    throw new Error("Attachment connection changed.");
  });
  const screen = await renderFrame(bytes, { title: "Chart", height: 360 }, { wrap: withAtoms });
  await vi.waitFor(() => expect(frameElement()).toBeTruthy());
  expect(readsFromStart()).toBe(2);
  expect(document.body.textContent).not.toContain("Unable to load");
  await screen.unmount();
});

it("waits for the reader before loading a page above the auto-load cap", async () => {
  readChunk.mockRejectedValue(new Error("Disconnected"));
  const screen = await renderFrame(
    new Uint8Array(0),
    { title: "Atlas", height: 500 },
    {
      sizeBytes: 9 * 1024 * 1024,
    },
  );
  await expect.element(page.getByRole("button", { name: "Load page" })).toBeVisible();
  await expect.element(page.getByText("Atlas · 9 MB")).toBeVisible();
  expect(frameBox().style.height).toBe("500px");
  expect(readChunk).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Load page" }).click();
  await vi.waitFor(() => expect(readChunk).toHaveBeenCalled());
  await screen.unmount();
});

it("keeps loading a large page the reader asked for when its row remounts", async () => {
  // Too large to keep decoded, so a remount must read it again, unasked.
  const bytes = pageBytes(`<!-- ${"x".repeat(9 * 1024 * 1024)} --><p>Atlas</p>`);
  serve(bytes);
  const first = await renderFrame(bytes, { title: "Atlas", height: 500 });
  await page.getByRole("button", { name: "Load page" }).click();
  await vi.waitFor(() => expect(frameElement()).toBeTruthy(), { timeout: 10_000 });
  await first.unmount();

  const second = await renderFrame(bytes, { title: "Atlas", height: 500 });
  expect(document.body.textContent).not.toContain("Load page");
  await vi.waitFor(() => expect(frameElement()).toBeTruthy(), { timeout: 10_000 });
  expect(readsFromStart()).toBe(2);
  await second.unmount();
});

const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));

/** The thread's open view, as ChatView registers it: how it takes a page's message. */
function ThreadMessages(props: { readonly send: (text: string) => Promise<void> }) {
  return <>{useHtmlRenderMessages(threadKey, props.send)}</>;
}

/**
 * A page whose one large button sends `text` with `ryco.send` and reports how
 * it settled. Told `{ ask: id }`, it posts a bare `ui/message` of its own,
 * with no click behind it, and reports the app's answer. With `retryWith`, a
 * failed send is followed at once by a send of that text.
 */
function sendingPage(text: string, options: { readonly retryWith?: string } = {}) {
  const retry =
    options.retryWith === undefined
      ? ""
      : `if(t===${JSON.stringify(text)})send(${JSON.stringify(options.retryWith)});`;
  return pageBytes(
    `<button id="answer" style="display:block;width:100%;height:300px">Answer</button><script>function send(t){ryco.send(t).then(function(){parent.postMessage({sent:t},"*")},function(e){parent.postMessage({failed:t,reason:e.message},"*");${retry}})}document.getElementById("answer").addEventListener("click",function(){send(${JSON.stringify(text)})});window.addEventListener("message",function(e){var d=e.data;if(d&&d.ask)parent.postMessage({jsonrpc:"2.0",id:d.ask,method:"ui/message",params:{role:"user",content:[{type:"text",text:"Forged"}]}},"*");if(d&&d.error&&typeof d.id==="string"&&d.id.indexOf("raw-")===0)parent.postMessage({refused:d.id,reason:d.error.message},"*")})</script>`,
  );
}

const confirmation = () => page.getByRole("alertdialog");
const sendInConfirmation = () => confirmation().getByRole("button", { name: "Send", exact: true });

it("sends the reader's answer to the thread only once they confirm its exact text in the app", async () => {
  const send = vi.fn(async (_text: string) => undefined);
  const bytes = sendingPage("Option B\nwith notes");
  serve(bytes);
  const page$ = collectPageMessages();
  const screen = await renderFrame(
    bytes,
    { title: "Pick a plan", height: 300 },
    {
      canSendMessages: true,
      wrap: (node) => (
        <>
          <ThreadMessages send={send} />
          {node}
        </>
      ),
    },
  );
  await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));
  // The frame name tells the page it may ask.
  expect(JSON.parse(frameElement().name.slice("ryco-theme:".length)).send).toBe(true);

  await userEvent.click(frameElement());
  await expect.element(confirmation()).toBeVisible();
  await expect.element(confirmation().getByText("Send this message?")).toBeVisible();
  await expect.element(confirmation().getByText(/Pick a plan/)).toBeVisible();
  expect(
    confirmation().element().querySelector("[data-html-render-message-text]")?.textContent,
  ).toBe("Option B\nwith notes");
  // Send waits a moment, so a quick second click in the page cannot land on
  // it, and Cancel has the focus.
  const sendButton = sendInConfirmation().element() as HTMLButtonElement;
  expect(sendButton.disabled).toBe(true);
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
  expect(sendButton.disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(sendButton.disabled).toBe(false), { timeout: 3_000 });

  await sendInConfirmation().click();
  await vi.waitFor(() => expect(page$.messages).toContainEqual({ sent: "Option B\nwith notes" }));
  expect(send).toHaveBeenCalledExactlyOnceWith("Option B\nwith notes");
  await expect.element(confirmation()).not.toBeInTheDocument();
  page$.stop();
  await screen.unmount();
});

it("sends nothing when the reader cancels, and tells the page", async () => {
  const send = vi.fn(async (_text: string) => undefined);
  const bytes = sendingPage("Option C");
  serve(bytes);
  const page$ = collectPageMessages();
  // Two views of the thread (a pane leaving as another shows it): only the
  // one that takes its messages now asks.
  const screen = await renderFrame(
    bytes,
    { title: "Pick a plan", height: 300 },
    {
      canSendMessages: true,
      wrap: (node) => (
        <>
          <ThreadMessages send={send} />
          <ThreadMessages send={send} />
          {node}
        </>
      ),
    },
  );
  await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));
  await userEvent.click(frameElement());
  await expect.element(confirmation()).toBeVisible();
  expect(document.querySelectorAll("[data-html-render-message-confirmation]")).toHaveLength(1);
  await confirmation().getByRole("button", { name: "Cancel" }).click();
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual({
      failed: "Option C",
      reason: "You cancelled the message.",
    }),
  );
  await expect.element(confirmation()).not.toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  page$.stop();
  await screen.unmount();
});

it("asks the reader only for a focused page they just used, never for another window", async () => {
  const send = vi.fn(async (_text: string) => undefined);
  const bytes = sendingPage("Option D");
  serve(bytes);
  const page$ = collectPageMessages();
  const screen = await renderFrame(
    bytes,
    { title: "Pick a plan", height: 300 },
    {
      canSendMessages: true,
      wrap: (node) => (
        <>
          <ThreadMessages send={send} />
          {node}
          <button type="button">Elsewhere</button>
        </>
      ),
    },
  );
  await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));
  const gesture = "Messages send only from a click, key press or tap in the page.";
  /** Has the page post a bare request of its own and waits for the app's answer. */
  const pageAsks = async (id: string) => {
    frameElement().contentWindow!.postMessage({ ask: id }, "*");
    await vi.waitFor(() => expect(page$.messages).toContainEqual({ refused: id, reason: gesture }));
  };
  // Another window's request gets no answer and asks nobody.
  const answers: unknown[] = [];
  const listenForAnswers = (event: MessageEvent) => {
    if (event.source === window && (event.data as { error?: unknown })?.error) {
      answers.push(event.data);
    }
  };
  window.addEventListener("message", listenForAnswers);
  window.postMessage(
    {
      jsonrpc: "2.0",
      id: "raw-other",
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "Forged" }] },
    },
    "*",
  );

  await vi.waitFor(() => expect(navigator.userActivation.isActive).toBe(false), {
    timeout: 10_000,
  });
  await pageAsks("raw-unfocused");
  // Focus alone is not enough: a script can focus the frame without the reader.
  frameElement().focus();
  expect(document.activeElement).toBe(frameElement());
  await pageAsks("raw-focused");
  // Nor is a reader who just used the app somewhere other than this page.
  await userEvent.click(page.getByRole("button", { name: "Elsewhere" }));
  expect(navigator.userActivation.isActive).toBe(true);
  await pageAsks("raw-elsewhere");
  window.removeEventListener("message", listenForAnswers);
  expect(answers).toEqual([]);
  expect(document.querySelector("[data-html-render-message-confirmation]")).toBeNull();
  expect(send).not.toHaveBeenCalled();

  // The reader's own click in the page asks them.
  await userEvent.click(frameElement());
  await expect.element(confirmation()).toBeVisible();
  page$.stop();
  await screen.unmount();
});

it("refuses a second request within a second", async () => {
  // No thread view takes messages here, so the first request fails at once;
  // the page asks again right away, within the same click.
  const bytes = sendingPage("First", { retryWith: "Second" });
  serve(bytes);
  const page$ = collectPageMessages();
  const screen = await renderFrame(
    bytes,
    { title: "Pick a plan", height: 300 },
    { canSendMessages: true },
  );
  await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));
  await userEvent.click(frameElement());
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual({
      failed: "Second",
      reason: "Send at most one message per second.",
    }),
  );
  expect(page$.messages).toContainEqual({
    failed: "First",
    reason: "Open this page's thread to send its message.",
  });
  page$.stop();
  await screen.unmount();
});

it("never lets a page send where it may not, a page handed over or the phone tier", async () => {
  const send = vi.fn(async (_text: string) => undefined);
  const bytes = sendingPage("Option E");
  serve(bytes);
  const page$ = collectPageMessages();
  // Not a page this thread's agent published (canSendMessages is off).
  const screen = await renderFrame(
    bytes,
    { title: "Pick a plan", height: 300 },
    {
      wrap: (node) => (
        <>
          <ThreadMessages send={send} />
          {node}
        </>
      ),
    },
  );
  await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));
  expect(JSON.parse(frameElement().name.slice("ryco-theme:".length)).send).toBeUndefined();
  await userEvent.click(frameElement());
  const unavailable = "Sending messages is not available here.";
  // The page's ryco.send says so itself...
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual({ failed: "Option E", reason: unavailable }),
  );
  // ...and a bare request it posts right after the reader's click is refused.
  frameElement().contentWindow!.postMessage({ ask: "raw-handed-over" }, "*");
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual({ refused: "raw-handed-over", reason: unavailable }),
  );
  await screen.unmount();

  await page.viewport(390, 844);
  const stop = syncDocumentPresentationTier();
  try {
    await vi.waitFor(() => expect(getPresentationTier()).toBe("phone"));
    const phone = await renderFrame(
      bytes,
      { title: "Pick a plan", height: 300 },
      {
        canSendMessages: true,
        wrap: (node) => (
          <>
            <ThreadMessages send={send} />
            {node}
          </>
        ),
      },
    );
    await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));
    expect(JSON.parse(frameElement().name.slice("ryco-theme:".length)).send).toBeUndefined();
    await phone.unmount();
  } finally {
    stop();
  }
  expect(document.querySelector("[data-html-render-message-confirmation]")).toBeNull();
  expect(send).not.toHaveBeenCalled();
  page$.stop();
});

/** The frame of a page that may send, inside the thread's open view. */
async function renderSendingFrame(bytes: Uint8Array, send: (text: string) => Promise<void>) {
  serve(bytes);
  const screen = await renderFrame(
    bytes,
    { title: "Pick a plan", height: 300 },
    {
      canSendMessages: true,
      wrap: (node) => (
        <>
          <ThreadMessages send={send} />
          {node}
        </>
      ),
    },
  );
  await vi.waitFor(() => expect(frameElement()?.className).toContain("opacity-100"));
  return screen;
}

it("keeps Send off until the reader has scrolled to the end of the text, and states its size", async () => {
  const send = vi.fn(async (_text: string) => undefined);
  const text = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join("\n");
  const page$ = collectPageMessages();
  const screen = await renderSendingFrame(sendingPage(text), send);
  await userEvent.click(frameElement());
  await expect.element(confirmation()).toBeVisible();
  const box = confirmation()
    .element()
    .querySelector<HTMLElement>("[data-html-render-message-text]")!;
  expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  const size = () =>
    confirmation().element().querySelector("[data-html-render-message-size]")?.textContent;
  expect(size()).toBe(
    `20 lines, ${Array.from(text).length} characters · Scroll to the end to send it.`,
  );
  // Long past Send's delay, the hidden tail still keeps it off.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const sendButton = sendInConfirmation().element() as HTMLButtonElement;
  expect(sendButton.disabled).toBe(true);
  box.scrollTop = box.scrollHeight / 3;
  box.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(sendButton.disabled).toBe(true);
  box.scrollTop = box.scrollHeight;
  box.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
  expect(size()).toBe(`20 lines, ${Array.from(text).length} characters`);
  await sendInConfirmation().click();
  await vi.waitFor(() => expect(page$.messages).toContainEqual({ sent: text }));
  expect(send).toHaveBeenCalledExactlyOnceWith(text);
  page$.stop();
  await screen.unmount();
});

it("hands focus back to the page's container, so a page cannot ask again right after Cancel", async () => {
  const send = vi.fn(async (_text: string) => undefined);
  // The page asks again the moment a request fails, as a page looping its dialog would.
  const page$ = collectPageMessages();
  const screen = await renderSendingFrame(
    sendingPage("Option C", { retryWith: "Option C again" }),
    send,
  );
  await userEvent.click(frameElement());
  await expect.element(confirmation()).toBeVisible();
  // Past the one-a-second limit, so only the focus rule can stop the page.
  await vi.waitFor(
    () => expect((sendInConfirmation().element() as HTMLButtonElement).disabled).toBe(false),
    { timeout: 3_000 },
  );
  await confirmation().getByRole("button", { name: "Cancel" }).click();
  const gesture = "Messages send only from a click, key press or tap in the page.";
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual({ failed: "Option C again", reason: gesture }),
  );
  await expect.element(confirmation()).not.toBeInTheDocument();
  // Focus is back on the page's container, never inside the page.
  await vi.waitFor(() => expect(document.activeElement).toBe(frameBox()));
  expect(document.activeElement).not.toBe(frameElement());

  // The reader clicks into the page again: that counts as using it, and the
  // page still waits out the cancel.
  await userEvent.click(frameElement());
  const cooldown = "You cancelled the last message. Try again in a moment.";
  await vi.waitFor(() =>
    expect(page$.messages).toContainEqual({ failed: "Option C", reason: cooldown }),
  );
  expect(document.querySelector("[data-html-render-message-confirmation]")).toBeNull();
  expect(send).not.toHaveBeenCalled();
  page$.stop();
  await screen.unmount();
});

it("starts Send's delay over with every press, and ignores a click pressed before Send turned on", async () => {
  const send = vi.fn(async (_text: string) => undefined);
  const page$ = collectPageMessages();
  const screen = await renderSendingFrame(sendingPage("Option F"), send);
  await userEvent.click(frameElement());
  await expect.element(confirmation()).toBeVisible();
  const sendButton = sendInConfirmation().element() as HTMLButtonElement;
  // Presses every 200 ms for two seconds, as a page's "click fast" game would
  // have the reader do: Send stays off throughout.
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendButton.disabled).toBe(true);
    if (index % 2 === 0) {
      window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    } else {
      await userEvent.keyboard("{Shift}");
    }
  }
  expect(sendButton.disabled).toBe(true);
  await vi.waitFor(() => expect(sendButton.disabled).toBe(false), { timeout: 3_000 });
  // A pointer click whose press came while Send was off does nothing.
  sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(send).not.toHaveBeenCalled();
  await expect.element(confirmation()).toBeVisible();
  // The reader's own click, pressed and released on the enabled Send, sends.
  await sendInConfirmation().click();
  await vi.waitFor(() => expect(page$.messages).toContainEqual({ sent: "Option F" }));
  expect(send).toHaveBeenCalledExactlyOnceWith("Option F");
  page$.stop();
  await screen.unmount();
});
