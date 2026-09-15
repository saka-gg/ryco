import { reportPreviewNavigationBlocked } from "../../previewNavigation";
import { flushPreviewFiles } from "../previewFileSessions";
import "../../index.css";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  useBlocker,
} from "@tanstack/react-router";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render, cleanup } from "vitest-browser-react";
import { ChatPanes } from "./ChatPanes";
import { usePaneEffect, usePaneThreadRef, usePaneCloseGuard } from "./PaneFocus";
import { CHAT_PANES_STORAGE_KEY, useChatPanesStore } from "../../chatPanesStore";
import { PANE_DRAG_TYPE, decodePaneLayout, paneLeaves, type PaneNode } from "../../chatPanes.logic";
vi.mock("../previewFileSessions", () => ({ flushPreviewFiles: vi.fn(async () => true) }));
let preventClose = false;
const a = { environmentId: EnvironmentId.make("pane-test"), threadId: ThreadId.make("a") };
const b = { ...a, threadId: ThreadId.make("b") };
const calls: string[] = [];
function ThreadContent({ threadRef }: { threadRef: typeof a }) {
  const ref = usePaneThreadRef() ?? threadRef;
  usePaneCloseGuard(() => !preventClose);
  const [draft, setDraft] = useState("");
  usePaneEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "F8") calls.push(ref.threadId);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [ref.threadId]);
  return (
    <>
      <button
        type="button"
        aria-label={`Action ${ref.threadId}`}
        onClick={() => calls.push(`action-${ref.threadId}`)}
      >
        Action
      </button>
      <textarea
        aria-label={`Draft ${ref.threadId}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </>
  );
}
async function mount(block: boolean | (() => Promise<boolean>) = false) {
  await page.viewport(1400, 1000);
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/$environmentId/$threadId",
    component: () => {
      const params = route.useParams() as { environmentId: string; threadId: string };
      useBlocker({
        shouldBlockFn: async ({ next }) => {
          const blocked = typeof block === "function" ? await block() : block;
          if (blocked) reportPreviewNavigationBlocked(next.pathname);
          return blocked;
        },
        enableBeforeUnload: false,
      });
      return (
        <div style={{ width: "1200px", height: "800px", display: "flex" }} data-test-frame>
          <ChatPanes
            threadRef={{
              environmentId: EnvironmentId.make(params.environmentId),
              threadId: ThreadId.make(params.threadId),
            }}
          >
            {(ref) => <ThreadContent threadRef={ref} />}
          </ChatPanes>
        </div>
      );
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/pane-test/a"] }),
  });
  await render(<RouterProvider router={router} />);
  await expect.element(page.getByRole("textbox", { name: "Draft a" })).toBeVisible();
  return router;
}
function drop(source: typeof a, target: Element, side: "right" | "bottom") {
  const rect = target.getBoundingClientRect();
  const transfer = new DataTransfer();
  transfer.setData(PANE_DRAG_TYPE, JSON.stringify(source));
  const init = {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
    clientX: side === "right" ? rect.right - 2 : rect.left + rect.width / 2,
    clientY: side === "bottom" ? rect.bottom - 2 : rect.top + rect.height / 2,
  };
  target.dispatchEvent(new DragEvent("dragover", init));
  target.dispatchEvent(new DragEvent("drop", init));
}
afterEach(async () => {
  await cleanup();
  useChatPanesStore.setState({ root: null, activeRef: null });
  calls.length = 0;
  preventClose = false;
  vi.mocked(flushPreviewFiles).mockResolvedValue(true);
});
it("drops a neighbor, transfers the only global listener, preserves drafts and closes", async () => {
  const router = await mount();
  await page.getByRole("textbox", { name: "Draft a" }).fill("Keep this draft");
  drop(b, document.querySelector("[data-pane-thread]")!, "right");
  await expect.element(page.getByRole("textbox", { name: "Draft b" })).toBeVisible();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", bubbles: true }));
  expect(calls).toEqual(["a"]);
  await router.navigate({ to: "/$environmentId/$threadId", params: b });
  await expect
    .poll(() =>
      document.querySelector('[data-pane-focused="true"]')?.getAttribute("data-pane-thread"),
    )
    .toContain("b");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", bubbles: true }));
  expect(calls).toEqual(["a", "b"]);
  await expect
    .element(page.getByRole("textbox", { name: "Draft a" }))
    .toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Close pane 2" }).click();
  await expect.poll(() => document.querySelectorAll("[data-pane-thread]").length).toBe(1);
  await expect
    .element(page.getByRole("textbox", { name: "Draft a" }))
    .toHaveValue("Keep this draft");
});
it("resizes by keyboard and preserves a 2x2 layout across narrow desktop", async () => {
  await mount();
  const store = useChatPanesStore.getState();
  store.open(b, "right", a);
  store.open({ ...a, threadId: ThreadId.make("c") }, "bottom", a);
  store.open({ ...a, threadId: ThreadId.make("d") }, "bottom", b);
  await expect.poll(() => document.querySelectorAll('[role="separator"]').length).toBe(3);
  const divider = document.querySelector('[role="separator"]')!;
  divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await expect.poll(() => useChatPanesStore.getState().root).toMatchObject({ ratio: 0.55 });
  const saved = JSON.stringify({ version: 1, root: useChatPanesStore.getState().root });
  const frame = document.querySelector<HTMLElement>("[data-test-frame]")!;
  frame.style.width = "700px";
  await expect.element(page.getByRole("tablist", { name: "Split threads" })).toBeVisible();
  expect(document.querySelectorAll("[data-pane-thread]:not([hidden])")).toHaveLength(1);
  frame.style.width = "1200px";
  await expect
    .poll(() => document.querySelectorAll("[data-pane-thread]:not([hidden])").length)
    .toBe(4);
  expect(useChatPanesStore.getState().root).toEqual(decodePaneLayout(saved));
});
it("does not close the focused pane when navigation is blocked", async () => {
  await mount(true);
  useChatPanesStore.getState().open(b, "right", a);
  await expect.element(page.getByRole("button", { name: "Close pane 1" })).toBeVisible();
  await page.getByRole("button", { name: "Close pane 1" }).click();
  expect(paneLeaves(useChatPanesStore.getState().root!)).toHaveLength(2);
  expect(
    document.querySelector('[data-pane-focused="true"]')?.getAttribute("data-pane-thread"),
  ).toContain("a");
});
it("restores a persisted tree and removes listeners on unmount", async () => {
  const root: PaneNode = {
    kind: "split",
    axis: "horizontal",
    ratio: 0.6,
    first: { kind: "thread", ref: a },
    second: { kind: "thread", ref: b },
  };
  useChatPanesStore.getState().setRoot(root);
  const saved = JSON.parse(localStorage.getItem(CHAT_PANES_STORAGE_KEY)!);
  useChatPanesStore.setState({ root: null });
  useChatPanesStore.setState({ root: decodePaneLayout(saved) });
  await mount();
  await expect.element(page.getByRole("textbox", { name: "Draft b" })).toBeVisible();
  await cleanup();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", bubbles: true }));
  expect(calls).toEqual([]);
});

it("serializes blocked pointer and keyboard activation without dispatching another pane's action", async () => {
  let resolveBlock: ((value: boolean) => void) | undefined;
  const blocker = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolveBlock = resolve;
      }),
  );
  const router = await mount(blocker);
  useChatPanesStore.getState().open(b, "right", a);
  await expect.element(page.getByRole("textbox", { name: "Draft b" })).toBeVisible();
  const source = page.getByRole("textbox", { name: "Draft a" }).element() as HTMLElement;
  source.focus();
  const button = page.getByRole("button", { name: "Action b" }).element();
  button.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
  );
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  (page.getByRole("textbox", { name: "Draft b" }).element() as HTMLElement).focus();
  await expect.poll(() => blocker.mock.calls.length).toBe(1);
  resolveBlock!(true);
  await expect.poll(() => document.activeElement).toBe(source);
  expect(router.state.location.pathname).toBe("/pane-test/a");
  expect(calls).toEqual([]);
});
it("vetoes focused and inactive closing for failed file saves and unfinished local actions", async () => {
  await mount();
  useChatPanesStore.getState().open(b, "right", a);
  await expect.element(page.getByRole("button", { name: "Close pane 2" })).toBeVisible();
  vi.mocked(flushPreviewFiles).mockResolvedValue(false);
  await page.getByRole("button", { name: "Close pane 2" }).click();
  await expect.poll(() => vi.mocked(flushPreviewFiles).mock.calls.length).toBeGreaterThan(0);
  expect(paneLeaves(useChatPanesStore.getState().root!)).toHaveLength(2);
  vi.mocked(flushPreviewFiles).mockResolvedValue(true);
  preventClose = true;
  await page.getByRole("button", { name: "Close pane 1" }).click();
  await page.getByRole("button", { name: "Close pane 2" }).click();
  expect(paneLeaves(useChatPanesStore.getState().root!)).toHaveLength(2);
  preventClose = false;
  await page.getByRole("button", { name: "Close pane 2" }).click();
  await expect.poll(() => document.querySelectorAll("[data-pane-thread]").length).toBe(1);
});
it("persists pointer resize only on release and cancels a lost drag", async () => {
  await mount();
  useChatPanesStore.getState().open(b, "right", a);
  const divider = page.getByRole("separator");
  await expect.element(divider).toBeVisible();
  const element = divider.element();
  let ratioWhileDragging: number | undefined;
  element.addEventListener("pointermove", () => {
    const root = useChatPanesStore.getState().root;
    if (root?.kind === "split") ratioWhileDragging = root.ratio;
  });
  await divider.dropTo(page.getByRole("textbox", { name: "Draft b" }));
  expect(ratioWhileDragging).toBe(0.5);
  await expect.poll(() => useChatPanesStore.getState().root).not.toMatchObject({ ratio: 0.5 });
  const saved = useChatPanesStore.getState().root;
  const cancel = (event: Event) => {
    if (!(event instanceof PointerEvent) || event.buttons !== 1) return;
    element.removeEventListener("pointermove", cancel);
    element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
  };
  element.addEventListener("pointermove", cancel);
  await divider.dropTo(page.getByRole("textbox", { name: "Draft a" }));
  expect(useChatPanesStore.getState().root).toBe(saved);
});

it("keeps layout changes usable when persistent storage rejects a write", async () => {
  await mount();
  const reject = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  try {
    expect(useChatPanesStore.getState().open(b, "right", a)).toBe(true);
    await expect.element(page.getByRole("textbox", { name: "Draft b" })).toBeVisible();
  } finally {
    reject.mockRestore();
  }
});
