import "../index.css";
import type { NodeBrowserFrameSourceHandlers } from "@ryco/client-runtime/connection/nodeBrowserFrameSource";
import type {
  NodeBrowserCommand,
  NodeBrowserEvent,
  NodeBrowserInputEvent,
  NodeBrowserTab,
} from "@ryco/contracts/node-browser";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { NodeBrowserPanel } from "./NodeBrowserPanel";
import { createNodeBrowserPainter } from "./nodeBrowserPainter";
import { NodeBrowserSurface } from "./NodeBrowserSurface";
import type { NodeBrowserViewerClient } from "./useBrowserMode";

const tab: NodeBrowserTab = {
  id: "tab-1",
  scope: "/work/app",
  url: "http://localhost:3000/",
  title: "App",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  state: "live",
  viewport: { width: 1000, height: 500 },
  dialog: null,
  error: null,
};

/** A JPEG of the given size, as the node sends one. */
const jpegOf = async (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "teal";
  context.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((value) => resolve(value!), "image/jpeg", 0.8),
  );
  return new Uint8Array(await blob.arrayBuffer());
};

const fakeClient = (options: { readonly input?: () => Promise<void> } = {}) => {
  const sent: Array<NodeBrowserInputEvent> = [];
  let handlers: NodeBrowserFrameSourceHandlers | null = null;
  let listener: ((event: NodeBrowserEvent) => void) | null = null;
  const client = {
    read: vi.fn(),
    command: vi.fn(async (_command: NodeBrowserCommand) => ({ tab: null })),
    input: vi.fn(async (request: { readonly events: ReadonlyArray<NodeBrowserInputEvent> }) => {
      sent.push(...request.events);
      await options.input?.();
    }),
    subscribe: vi.fn((next: (event: NodeBrowserEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    openFrameSource: vi.fn((_request: unknown, next: NodeBrowserFrameSourceHandlers) => {
      handlers = next;
      return { close: vi.fn() };
    }),
  };
  return {
    client: client as unknown as NodeBrowserViewerClient,
    mock: client,
    sent,
    frame: async (width: number, height: number, cssWidth: number, cssHeight: number) =>
      handlers!.onFrame({ seq: 0, cssWidth, cssHeight, jpeg: await jpegOf(width, height) }, 1),
    publish: (event: NodeBrowserEvent) => listener!(event),
    opened: () => handlers !== null,
  };
};

const mountSurface = async (fake: ReturnType<typeof fakeClient>) => {
  unmount = (
    await render(
      <div style={{ width: 400, height: 400, display: "flex", flexDirection: "column" }}>
        <NodeBrowserSurface client={fake.client} tab={tab} />
      </div>,
    )
  ).unmount;
  await expect.poll(fake.opened).toBe(true);
  // A 200 x 100 frame of a 1000 x 500 page, shown 400 x 200 in the middle of the 400 x 400 box.
  await fake.frame(200, 100, 1000, 500);
  const canvas = document.querySelector<HTMLCanvasElement>("[data-node-browser-surface] canvas")!;
  await expect.poll(() => canvas.width).toBe(200);
  const box = canvas.getBoundingClientRect();
  return { canvas, center: { clientX: box.left + 200, clientY: box.top + 200 } };
};

const pointer = (
  canvas: HTMLCanvasElement,
  type: "pointerdown" | "pointerup",
  at: { readonly clientX: number; readonly clientY: number },
) =>
  canvas.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      ...at,
      button: 0,
      buttons: type === "pointerdown" ? 1 : 0,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
    }),
  );

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("node browser surface", () => {
  it("maps a click on the letterboxed frame to the page's own pixels", async () => {
    const fake = fakeClient();
    const { canvas, center } = await mountSurface(fake);
    pointer(canvas, "pointerdown", center);
    pointer(canvas, "pointerup", center);
    await expect
      .poll(() => fake.sent.filter((event) => event.type === "mouse"))
      .toEqual([
        {
          type: "mouse",
          action: "down",
          x: 500,
          y: 250,
          button: "left",
          buttons: 1,
          clickCount: 1,
          modifiers: 0,
        },
        {
          type: "mouse",
          action: "up",
          x: 500,
          y: 250,
          button: "left",
          buttons: 0,
          clickCount: 1,
          modifiers: 0,
        },
      ]);
    // The bars around the frame are not the page.
    const before = fake.sent.length;
    pointer(canvas, "pointerdown", { clientX: center.clientX, clientY: center.clientY - 150 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.sent).toHaveLength(before);
  });

  it("scrolls a line of a line-based wheel as 16 px", async () => {
    const fake = fakeClient();
    const { canvas, center } = await mountSurface(fake);
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ...center,
      deltaY: 3,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    await expect
      .poll(() => fake.sent.filter((event) => event.type === "wheel"))
      .toEqual([{ type: "wheel", x: 500, y: 250, deltaX: 0, deltaY: 48, modifiers: 0 }]);
  });

  it("stops sending input once the node refuses it, and says so", async () => {
    const fake = fakeClient({
      input: () =>
        Promise.reject({ _tag: "AuthRpcError", status: 403, message: "Operators only." }),
    });
    const { canvas, center } = await mountSurface(fake);
    pointer(canvas, "pointerdown", center);
    await expect.poll(() => fake.mock.input.mock.calls.length).toBe(1);
    await expect.element(page.getByText(/no longer takes your input/u)).toBeVisible();
    const calls = fake.mock.input.mock.calls.length;
    pointer(canvas, "pointerup", center);
    pointer(canvas, "pointerdown", center);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.mock.input.mock.calls.length).toBe(calls);
  });

  it("asks the node to fit the page to the panel", async () => {
    const fake = fakeClient();
    await mountSurface(fake);
    await expect
      .poll(() => fake.mock.command.mock.calls.map(([command]) => command))
      .toContainEqual({ type: "resize", tabId: "tab-1", width: 400, height: 400 });
  });
});

describe("node browser painter", () => {
  it("decodes one frame at a time and drops the ones a newer frame replaced", async () => {
    const canvas = document.createElement("canvas");
    const decode = vi.spyOn(window, "createImageBitmap");
    const painter = createNodeBrowserPainter(canvas);
    const [first, second, third] = await Promise.all([
      jpegOf(10, 10),
      jpegOf(20, 20),
      jpegOf(30, 30),
    ]);
    painter.paint(first);
    painter.paint(second);
    painter.paint(third);
    await expect.poll(() => canvas.width).toBe(30);
    expect(decode).toHaveBeenCalledTimes(2);
    painter.stop();
    decode.mockRestore();
  });
});

describe("node browser panel", () => {
  it("shows only the project's tabs and opens new ones for it", async () => {
    const fake = fakeClient();
    fake.mock.command.mockImplementation(async () => ({ tab: null }));
    unmount = (
      await render(
        <div style={{ width: 600, height: 400, display: "flex", flexDirection: "column" }}>
          <NodeBrowserPanel client={fake.client} cwd="/work/app" />
        </div>,
      )
    ).unmount;
    await expect.poll(() => fake.mock.subscribe.mock.calls.length).toBe(1);
    fake.publish({ type: "availability", capability: { available: true } });
    fake.publish({
      type: "tabs",
      tabs: [tab, { ...tab, id: "tab-2", scope: "/work/other", title: "Other project" }],
    });
    await expect.element(page.getByRole("tab", { name: "App" })).toBeVisible();
    expect(page.getByRole("tab", { name: "Other project" }).query()).toBeNull();

    await page.getByRole("button", { name: "New browser tab" }).click();
    await page.getByRole("textbox", { name: "Browser address" }).fill("localhost:5173");
    await page.getByRole("button", { name: "Go" }).click();
    await expect
      .poll(() => fake.mock.command.mock.calls.map(([command]) => command))
      .toContainEqual({ type: "open", scope: "/work/app", url: "http://localhost:5173/" });
  });

  it("warns while the node runs tabs without Chrome's sandbox", async () => {
    const fake = fakeClient();
    unmount = (await render(<NodeBrowserPanel client={fake.client} cwd="/work/app" />)).unmount;
    await expect.poll(() => fake.mock.subscribe.mock.calls.length).toBe(1);
    fake.publish({ type: "availability", capability: { available: true, sandbox: false } });
    await expect.element(page.getByText(/sandbox is off on this node/u)).toBeVisible();
    fake.publish({ type: "availability", capability: { available: true } });
    await expect.poll(() => page.getByText(/sandbox is off on this node/u).query()).toBeNull();
  });

  it("says why the node cannot run tabs", async () => {
    const fake = fakeClient();
    unmount = (await render(<NodeBrowserPanel client={fake.client} cwd="/work/app" />)).unmount;
    await expect.poll(() => fake.mock.subscribe.mock.calls.length).toBe(1);
    fake.publish({ type: "availability", capability: { available: false, reason: "installing" } });
    await expect.element(page.getByText(/installing the browser on this node/u)).toBeVisible();
  });
});
