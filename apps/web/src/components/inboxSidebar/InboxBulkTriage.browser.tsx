import "../../index.css";

import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId, TurnId, type ScopedThreadRef } from "@ryco/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { isMacPlatform } from "../../lib/utils";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { shouldClearThreadSelectionOnMouseDown } from "../Sidebar.logic";
import { useTierOverrideStore } from "../../tierOverrideStore";
import { useUiStateStore } from "../../uiStateStore";
import { useInboxFilterStore } from "./inboxFilterStore";
import { InboxSidebar, type InboxSidebarProps, preloadInboxSettleFinished } from "./InboxSidebar";
import type { InboxSidebarEnvironment } from "./inboxSidebarModel";

const lifecycle = vi.hoisted(() => ({
  settlementBatch: vi.fn(async () => null),
  snoozeBatch: vi.fn(async () => null),
  skipped: vi.fn(),
}));

vi.mock("../../threadLifecycleCommands", () => ({
  dispatchThreadSettlement: vi.fn(async () => true),
  dispatchThreadSnooze: vi.fn(async () => undefined),
  dispatchThreadSettlementBatch: lifecycle.settlementBatch,
  dispatchThreadSnoozeBatch: lifecycle.snoozeBatch,
  presentSkippedThreads: lifecycle.skipped,
  attemptThreadArchive: vi.fn(async () => undefined),
  requestThreadArchive: vi.fn(async () => undefined),
}));

const READY = EnvironmentId.make("selection-ready");
const NOT_READY = EnvironmentId.make("selection-not-ready");
const PROJECT_ID = ProjectId.make("selection-project");

const MACHINE: InboxSidebarEnvironment = {
  environmentId: READY,
  label: "Alpha",
  connectionState: "connected",
  stale: false,
  role: "owner",
  trust: "not-required",
  deliveryUnknown: false,
  threadSettlementSupported: true,
  threadSnoozeSupported: true,
  mutationReady: true,
  shellCurrent: true,
};
const MACHINES = [
  MACHINE,
  { ...MACHINE, environmentId: NOT_READY, label: "Bravo", mutationReady: false },
];

const ref = (id: string) => scopeThreadRef(id === "n1" ? NOT_READY : READY, ThreadId.make(id));
const keyOf = (id: string) => scopedThreadKey(ref(id));

/** A finished thread, last active at 10:`minute`. */
function thread(
  id: string,
  minute: number,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  const at = `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id: ThreadId.make(id),
    environmentId: ref(id).environmentId,
    projectId: PROJECT_ID,
    title: `Task ${id}`,
    interactionMode: "default",
    session: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      assistantMessageId: null,
    },
    branch: null,
    worktreePath: null,
    latestUserMessageAt: at,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

/** Newest first, so the list shows them in this order (Pinned above Recent). */
const THREADS = [
  thread("pinned", 6),
  thread("r1", 5),
  thread("r2", 4),
  thread("n1", 3),
  thread("r3", 2),
];

function props(overrides: Partial<InboxSidebarProps> = {}): InboxSidebarProps {
  return {
    projects: [],
    worktrees: [],
    environments: MACHINES,
    threads: THREADS,
    deliveryUnknownThreadKeys: new Set(),
    localQueuedThreadKeys: new Set(),
    activeThreadKey: null,
    aiFocusEnabled: false,
    autoSettleAfterDays: null,
    pinnedThreadKeys: new Set([keyOf("pinned")]),
    onOpenThread: vi.fn(),
    ...overrides,
  };
}

const TOGGLE_KEY = isMacPlatform(navigator.platform) ? "Meta" : "Control";
const title = (id: string) => page.getByText(`Task ${id}`, { exact: true });
const select = async (...ids: string[]) => {
  for (const id of ids) await title(id).click({ modifiers: [TOGGLE_KEY] });
};
const rowButton = (id: string) =>
  document.querySelector<HTMLElement>(
    `[data-inbox-row-key="${keyOf(id)}"] [data-testid="inbox-thread-row"]`,
  )!;
/** Selected rows as the list shows them. */
const selectedRows = () =>
  [...document.querySelectorAll('[data-testid="inbox-thread-row"][data-selected]')].map((row) =>
    row.querySelector(".inbox-row-title")?.textContent?.trim(),
  );
const menuItem = (name: string) => page.getByRole("menuitem", { name, exact: true });
const menuClosed = () =>
  vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mountInbox(overrides: Partial<InboxSidebarProps> = {}) {
  await page.viewport(1280, 900);
  const sidebarProps = props(overrides);
  mounted = await render(
    <div style={{ width: 320 }}>
      <InboxSidebar {...sidebarProps} />
    </div>,
  );
  return sidebarProps;
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  useThreadSelectionStore.getState().clearSelection();
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  const filters = useInboxFilterStore.getState();
  filters.setDraft("");
  filters.setStatus("all");
  lifecycle.settlementBatch.mockClear();
  lifecycle.snoozeBatch.mockClear();
  lifecycle.skipped.mockClear();
  document.body.innerHTML = "";
});

describe("Inbox row selection", () => {
  it("toggles a row with the selection key and never opens it", async () => {
    const { onOpenThread } = await mountInbox();
    await select("r1");
    expect(selectedRows()).toEqual(["Task r1"]);
    expect(rowButton("r1").getAttribute("aria-description")).toBe("Selected");
    expect(getComputedStyle(rowButton("r1")).userSelect).toBe("none");

    await select("r1");
    expect(selectedRows()).toEqual([]);
    expect(rowButton("r1").hasAttribute("aria-description")).toBe(false);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("selects the displayed range with Shift across sections, and a plain click opens", async () => {
    // As the sidebar's navigateToThread: opening clears the selection and anchors the next range.
    const onOpenThread = vi.fn((threadRef: ScopedThreadRef) => {
      const store = useThreadSelectionStore.getState();
      store.clearSelection();
      store.setAnchor(scopedThreadKey(threadRef));
    });
    await mountInbox({ onOpenThread });
    await title("pinned").click();
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(ref("pinned"));

    await title("r2").click({ modifiers: ["Shift"] });
    expect(selectedRows()).toEqual(["Task pinned", "Task r1", "Task r2"]);
    expect(onOpenThread).toHaveBeenCalledOnce();

    await title("r3").click();
    expect(onOpenThread).toHaveBeenLastCalledWith(ref("r3"));
    expect(selectedRows()).toEqual([]);
  });

  it("settles and snoozes the selection from a selected row's menu", async () => {
    await mountInbox({ onDeleteThreads: vi.fn(async () => true) });
    await select("r1", "r2", "n1");
    await title("r2").click({ button: "right" });
    await expect.element(page.getByRole("menu", { name: "3 selected threads" })).toBeVisible();
    // Bravo takes no changes now: its row is in no count but Mark unread's.
    await expect.element(menuItem("Settle (2)")).toBeVisible();
    await expect.element(menuItem("Snooze (2)")).toBeVisible();
    await expect.element(menuItem("Mark unread (3)")).toBeVisible();
    await expect.element(menuItem("Delete (2)")).toBeVisible();
    expect(document.body.textContent).not.toContain("Move to Active");
    expect(document.body.textContent).not.toContain("Unsnooze");

    await menuItem("Settle (2)").click();
    expect(lifecycle.settlementBatch).toHaveBeenCalledExactlyOnceWith([ref("r1"), ref("r2")], true);
    expect(selectedRows()).toEqual([]);
    await menuClosed();

    await select("r2", "r3");
    await title("r3").click({ button: "right" });
    await menuItem("Snooze (2)").hover();
    await page.getByRole("menuitem", { name: /In 1 hour/ }).click();
    expect(lifecycle.snoozeBatch).toHaveBeenCalledExactlyOnceWith(
      [ref("r2"), ref("r3")],
      expect.any(String),
    );
    expect(selectedRows()).toEqual([]);
  });

  it("opens the selection menu from a selected row's actions button", async () => {
    // As the sidebar does: a press outside rows and their menus clears the selection.
    const clearOutside = (event: MouseEvent) => {
      if (shouldClearThreadSelectionOnMouseDown(event.target)) {
        useThreadSelectionStore.getState().clearSelection();
      }
    };
    window.addEventListener("mousedown", clearOutside);
    try {
      await mountInbox();
      await select("r1", "r2");
      // The press lands on the button's icon, an SVG element.
      await page.getByRole("button", { name: "Thread actions for Task r2" }).click();
      await expect.element(page.getByRole("menu", { name: "2 selected threads" })).toBeVisible();
      await expect.element(menuItem("Settle (2)")).toBeVisible();
      expect(selectedRows()).toEqual(["Task r1", "Task r2"]);
    } finally {
      window.removeEventListener("mousedown", clearOutside);
    }
  });

  it("deletes only the rows whose machine takes changes and reports the others", async () => {
    const onDeleteThreads = vi.fn(async (_targets: readonly ScopedThreadRef[]) => true);
    await mountInbox({ onDeleteThreads });
    await select("r1", "n1");
    await title("n1").click({ button: "right" });
    await menuItem("Delete (1)").click();
    expect(onDeleteThreads).toHaveBeenCalledExactlyOnceWith([ref("r1")]);
    await vi.waitFor(() => expect(lifecycle.skipped).toHaveBeenCalledExactlyOnceWith(1));
    expect(selectedRows()).toEqual([]);
  });

  it("opens the single menu on a row outside the selection and drops the selection", async () => {
    await mountInbox();
    await select("r1", "r2");
    await title("r3").click({ button: "right" });
    await expect.element(menuItem("Settle")).toBeVisible();
    expect(document.body.textContent).not.toContain("Settle (2)");
    expect(selectedRows()).toEqual([]);
  });

  it("keeps rows the list no longer shows out of the selection", async () => {
    const host = thread("host", 7);
    const child = (needsInput: boolean) =>
      thread("child", 1, {
        hasPendingApprovals: needsInput,
        lineage: {
          parentThreadId: host.id,
          rootThreadId: host.id,
          relationship: "delegated",
        },
      });
    const sidebarProps = await mountInbox({ threads: [host, child(true), ...THREADS] });
    // The host stays open while its child needs input.
    await select("host", "child", "r1");
    expect(selectedRows()).toHaveLength(3);

    // The child no longer needs input: its host folds it away, and no action reaches it.
    await mounted!.rerender(
      <div style={{ width: 320 }}>
        <InboxSidebar {...sidebarProps} threads={[host, child(false), ...THREADS]} />
      </div>,
    );
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Task child"));
    expect(selectedRows()).toEqual(["Task host", "Task r1"]);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.has(keyOf("child"))).toBe(false);
    await title("host").click({ button: "right" });
    await expect.element(page.getByRole("menu", { name: "2 selected threads" })).toBeVisible();
    await expect.element(menuItem("Settle (2)")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await menuClosed();

    // Shown again, the child is not selected again.
    await page.getByRole("button", { name: "Show 1 delegated thread from Task host" }).click();
    await expect.element(title("child")).toBeVisible();
    expect(selectedRows()).toEqual(["Task host", "Task r1"]);

    // A filter keeps the selected rows it still shows.
    useInboxFilterStore.getState().setDraft("Task r1");
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Task r2"));
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([keyOf("r1")]);
  });
});

describe("Inbox on the frozen phone tier", () => {
  // Loaded, so a missing Settle finished is the phone tier's doing, not its chunk's.
  beforeAll(() => preloadInboxSettleFinished());
  let stopTierSync: (() => void) | null = null;
  afterEach(() => {
    stopTierSync?.();
    stopTierSync = null;
    useTierOverrideStore.setState({ override: null });
  });

  it("opens rows as before and offers neither selection nor Settle finished", async () => {
    useTierOverrideStore.setState({ override: "phone" });
    stopTierSync = syncDocumentPresentationTier();
    useUiStateStore.getState().markThreadVisited(keyOf("r1"));
    const { onOpenThread } = await mountInbox();
    await title("r1").click({ modifiers: [TOGGLE_KEY] });
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(ref("r1"));
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
    expect(getComputedStyle(rowButton("r1")).userSelect).not.toBe("none");
    expect(page.getByRole("button", { name: /^Settle \d+ finished thread/ }).query()).toBeNull();
  });
});

describe("Inbox Settle finished", () => {
  // It loads in an idle slot after the shell; loaded first, it renders with the list.
  beforeAll(() => preloadInboxSettleFinished());
  const visit = (...ids: string[]) => {
    const { markThreadVisited } = useUiStateStore.getState();
    for (const id of ids) markThreadVisited(keyOf(id));
  };
  const settleFinished = () => page.getByRole("button", { name: /^Settle \d+ finished thread/ });
  const header = (section: string) =>
    page.getByRole("heading", { name: section, exact: true }).element().parentElement!;

  it("is absent while every Recent row is unseen or on a machine that is not ready", async () => {
    visit("pinned", "n1");
    await mountInbox();
    await expect.element(title("r1")).toBeInTheDocument();
    expect(settleFinished().query()).toBeNull();
  });

  it("settles the seen finished rows of Recent, oldest first", async () => {
    // u1 is unseen, Bravo (n1) takes no changes now, and Pinned is not Recent.
    visit("pinned", "r1", "r2", "n1", "r3");
    await mountInbox({ threads: [...THREADS, thread("u1", 1)] });
    await expect.element(settleFinished()).toHaveAccessibleName("Settle 3 finished threads");
    expect(settleFinished().all()).toHaveLength(1);
    expect(settleFinished().element().closest("section")?.querySelector("h2")?.textContent).toBe(
      "Recent",
    );
    expect(header("Recent").offsetHeight).toBe(header("Pinned").offsetHeight);

    let finish: (result: null) => void = () => undefined;
    lifecycle.settlementBatch.mockImplementationOnce(
      () => new Promise<null>((resolve) => (finish = resolve)),
    );
    await settleFinished().click();
    expect(lifecycle.settlementBatch).toHaveBeenCalledExactlyOnceWith(
      [ref("r3"), ref("r2"), ref("r1")],
      true,
    );
    await expect.element(settleFinished()).toBeDisabled();
    finish(null);
    await expect.element(settleFinished()).toBeEnabled();
  });

  it("settles the finished children folded under a Recent host with it", async () => {
    const host = thread("host", 7);
    const child = thread("child", 1, {
      lineage: { parentThreadId: host.id, rootThreadId: host.id, relationship: "delegated" },
    });
    visit("host", "child");
    await mountInbox({ threads: [host, child] });
    await expect.element(settleFinished()).toHaveAccessibleName("Settle 2 finished threads");
    expect(document.body.textContent).not.toContain("Task child");

    await settleFinished().click();
    expect(lifecycle.settlementBatch).toHaveBeenCalledExactlyOnceWith(
      [ref("child"), ref("host")],
      true,
    );
  });
});
