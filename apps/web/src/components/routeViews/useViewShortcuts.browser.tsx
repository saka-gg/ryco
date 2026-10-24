import "../../index.css";

import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { APP_DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/client-runtime/state/settings";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@ryco/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import { useChatPanesStore } from "../../chatPanesStore";
import { resetClosedViewsForTests, type ClosedViewOwner } from "../../closedViews";
import { type RightPanelSearchUpdate, useRightPanelTabs } from "../../hooks/useRightPanelTabs";
import { isMacPlatform } from "../../lib/utils";
import {
  getRightPanelMode,
  isRightPanelOpen,
  parseRightPanelRouteSearch,
  type RightPanelRouteSearch,
} from "../../rightPanelRouteSearch";
import { selectEnvironmentState, useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { buildOpenFilesSearch, buildOpenReviewSearch } from "../../workspaceRouteSearch";
import { CommentField } from "../pullRequests/threads/ReplyComposer";
import { RightPanelSheet } from "../RightPanelSheet";
import { toastManager } from "../ui/toast";
import { useViewShortcuts } from "./useViewShortcuts";

const environmentId = EnvironmentId.make("view-test");
const a = scopeThreadRef(environmentId, ThreadId.make("a"));
const b = scopeThreadRef(environmentId, ThreadId.make("b"));
let layout: "inline" | "sheet" = "inline";

/** The review tab's content: a reply field, like the pull request and note composers. */
function ReviewSurface() {
  const [comment, setComment] = useState("");
  return (
    <CommentField
      value={comment}
      onChange={setComment}
      placeholder="Reply…"
      ariaLabel="Reply"
      onSubmit={() => {}}
      onCancel={() => setComment("")}
      actions={null}
    />
  );
}

/** A thread route view reduced to the panel's tab memory, its content and the shortcuts. */
function ThreadRouteProbe() {
  // The route's own types would refer back to this component.
  const params = threadRoute.useParams() as { environmentId: string; threadId: string };
  const search = threadRoute.useSearch() as RightPanelRouteSearch;
  const navigate = useNavigate();
  const threadRef = useMemo(
    () => scopeThreadRef(EnvironmentId.make(params.environmentId), ThreadId.make(params.threadId)),
    [params.environmentId, params.threadId],
  );
  const owner = useMemo<ClosedViewOwner>(() => ({ kind: "thread", ref: threadRef }), [threadRef]);
  const rightPanelMode = getRightPanelMode(search);
  const rightPanelOpen = isRightPanelOpen(search);
  const navigateSearch = useCallback(
    (update: RightPanelSearchUpdate) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: update,
      });
    },
    [navigate, threadRef],
  );
  const tabs = useRightPanelTabs({
    scopeKey: scopedThreadKey(threadRef),
    rightPanelMode,
    rightPanelOpen,
    activeAgentKey: null,
    defaultLastMode: "review",
    navigateSearch,
    closedViewOwner: owner,
  });
  useViewShortcuts({
    owner,
    keybindings: APP_DEFAULT_RESOLVED_KEYBINDINGS,
    closeActiveView: tabs.closeActiveView,
    isPanelTargetOpen: tabs.isPanelTargetOpen,
    openPanelTarget: tabs.openPanelTarget,
  });
  const panel = (
    <div data-slot="workspace-tabpanel">
      {rightPanelMode === "review" ? <ReviewSurface /> : <p>{rightPanelMode ?? "Launcher"}</p>}
    </div>
  );
  return (
    <>
      {/* What this render shows: the next key press acts on it. */}
      <output aria-label="Panel">
        {rightPanelOpen ? (rightPanelMode ?? "launcher") : "closed"}
      </output>
      {layout === "sheet" ? (
        <RightPanelSheet open={rightPanelOpen} onClose={tabs.closeRightPanel}>
          {panel}
        </RightPanelSheet>
      ) : rightPanelOpen ? (
        panel
      ) : null}
    </>
  );
}

const rootRoute = createRootRoute();
const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$environmentId/$threadId",
  validateSearch: (search) => parseRightPanelRouteSearch(search),
  component: ThreadRouteProbe,
});

async function mount(thread: ScopedThreadRef = a) {
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history: createMemoryHistory({
      initialEntries: [`/${thread.environmentId}/${thread.threadId}`],
    }),
  });
  await render(<RouterProvider router={router} />);
  const show = async (mode: "files" | "review") => {
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(thread),
      search: (previous) =>
        mode === "files" ? buildOpenFilesSearch(previous) : buildOpenReviewSearch(previous),
    });
    await expect.poll(shown).toBe(mode);
  };
  return { router, show };
}

const shown = () => document.querySelector('output[aria-label="Panel"]')?.textContent;

const mac = isMacPlatform(navigator.platform);
function press(
  key: "w" | "t",
  options: { readonly shift?: boolean; readonly repeat?: boolean; readonly from?: Element } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: options.shift ? key.toUpperCase() : key,
    code: `Key${key.toUpperCase()}`,
    metaKey: mac,
    ctrlKey: !mac,
    shiftKey: options.shift === true,
    repeat: options.repeat === true,
    bubbles: true,
    cancelable: true,
  });
  (options.from ?? document.body).dispatchEvent(event);
  return event;
}

/** Puts a thread on its environment's shell, so reopening can show it. */
function seedThread(ref: ScopedThreadRef) {
  useStore.setState((state) => {
    const environment = selectEnvironmentState(state, ref.environmentId);
    return {
      environmentStateById: {
        ...state.environmentStateById,
        [ref.environmentId]: {
          ...environment,
          threadShellById: {
            ...environment.threadShellById,
            [ref.threadId]: { id: ref.threadId } as never,
          },
        },
      },
    };
  });
}

afterEach(async () => {
  await cleanup();
  layout = "inline";
  resetClosedViewsForTests();
  useChatPanesStore.setState({ controller: null });
  useStore.setState({ environmentStateById: {} });
  vi.restoreAllMocks();
});

it("closes the active tab, then the panel on its launcher, then leaves the key alone", async () => {
  const { show } = await mount();
  await show("files");
  await show("review");

  expect(press("w").defaultPrevented).toBe(true);
  await expect.poll(shown).toBe("files");
  expect(press("w").defaultPrevented).toBe(true);
  await expect.poll(shown).toBe("launcher");
  expect(press("w").defaultPrevented).toBe(true);
  await expect.poll(shown).toBe("closed");
  // Nothing left to close: the window's Close command gets the key.
  expect(press("w").defaultPrevented).toBe(false);
});

it("closes the focused split pane once the panel is closed", async () => {
  await mount();
  const closeFocused = vi.fn(() => true);
  useChatPanesStore.getState().registerController({ focusSibling: () => false, closeFocused });

  expect(press("w").defaultPrevented).toBe(true);
  expect(closeFocused).toHaveBeenCalledOnce();
});

it("acts once while the key is held", async () => {
  const { show } = await mount();
  await show("files");

  expect(press("w", { repeat: true }).defaultPrevented).toBe(true);
  expect(press("t", { shift: true, repeat: true }).defaultPrevented).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(shown()).toBe("files");
});

it("keeps a tab holding an unsent comment open", async () => {
  const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
  const { show } = await mount();
  await show("review");
  const reply = page.getByRole("textbox", { name: "Reply" });
  await reply.fill("Looks good");

  expect(press("w", { from: reply.element() }).defaultPrevented).toBe(true);
  expect(add).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Finish or discard your comment before closing this tab" }),
  );
  expect(shown()).toBe("review");

  await reply.fill("");
  expect(press("w", { from: reply.element() }).defaultPrevented).toBe(true);
  await expect.poll(shown).toBe("launcher");
});

it("works inside the workspace sheet but leaves other dialogs alone", async () => {
  layout = "sheet";
  const { show } = await mount();
  await show("review");
  const reply = page.getByRole("textbox", { name: "Reply" });
  await expect.element(reply).toBeVisible();

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.textContent = "Another dialog";
  document.body.append(dialog);
  expect(press("w", { from: reply.element() }).defaultPrevented).toBe(false);
  dialog.remove();

  // The sheet stops keys from bubbling out of it; the shortcut still sees them.
  expect(press("w", { from: reply.element() }).defaultPrevented).toBe(true);
  await expect.poll(shown).toBe("launcher");
  const sheet = document.querySelector('[data-slot="sheet-popup"]')!;
  expect(press("w", { from: sheet }).defaultPrevented).toBe(true);
  await expect.poll(shown).toBe("closed");
});

it("reopens closed tabs newest first, then leaves the key alone", async () => {
  const { show } = await mount();
  await show("files");
  await show("review");
  press("w");
  await expect.poll(shown).toBe("files");
  press("w");
  await expect.poll(shown).toBe("launcher");

  expect(press("t", { shift: true }).defaultPrevented).toBe(true);
  await expect.poll(shown).toBe("files");
  expect(press("t", { shift: true }).defaultPrevented).toBe(true);
  await expect.poll(shown).toBe("review");
  expect(press("t", { shift: true }).defaultPrevented).toBe(false);
});

it("reopens a tab closed in another thread there, once that thread is known", async () => {
  const { router, show } = await mount();
  await show("files");
  press("w");
  await expect.poll(shown).toBe("launcher");
  await router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(b) });
  await expect.poll(shown).toBe("closed");

  // Thread a's environment has not sent its threads yet: the entry waits.
  expect(press("t", { shift: true }).defaultPrevented).toBe(false);
  seedThread(a);
  expect(press("t", { shift: true }).defaultPrevented).toBe(true);
  await expect.poll(() => router.state.location.pathname).toBe("/view-test/a");
  await expect.poll(shown).toBe("files");
});
