import { EventId, ORCHESTRATION_WS_METHODS, type MessageId, type TurnId } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { syncDocumentVisualViewportInsets } from "../lib/visualViewportInsets";
import { cdpSession } from "../../test/browserPointer";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { installVisualViewportStub } from "../../test/browserVisualViewport";
import { DEFAULT_CLIENT_SETTINGS } from "@ryco/contracts/settings";
import {
  setupChatViewBrowserSuite,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NARROW_PHONE_VIEWPORT,
  NARROW_TABLET_VIEWPORT,
  PHONE_LANDSCAPE_VIEWPORT,
  PHONE_VIEWPORT,
  ROTATED_MID_VIEWPORT,
  THREAD_ID,
  THREAD_TITLE,
  WIDE_FOOTER_VIEWPORT,
  composerEditorHasFocus,
  createSnapshotForTargetUser,
  createSnapshotWithPendingApproval,
  createSnapshotWithWorkSurfaceCheckpoint,
  expectThreadDockInBottomThird,
  fixture,
  hasContainedHorizontalDiffOverflow,
  isElementVisible,
  isoAt,
  mountChatView,
  queryPhoneSurfacePopup,
  resolveWorkSurfaceRpc,
  rpcHarness,
  surfaceContainsText,
  toThreadWindowSnapshot,
  waitForElement,
  waitForLayout,
  withCoarsePointer,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/** The docked Crown rail, once it is open and visible. */
function queryVisibleCrownRail(): HTMLElement | null {
  const crown = document.querySelector<HTMLElement>('[data-slot="crown-overview"]');
  if (crown?.dataset.state !== "open") return null;
  const rail = crown.querySelector<HTMLElement>('nav[aria-label="Overview"]');
  return rail && isElementVisible(rail) ? rail : null;
}

/** Streams a thread snapshot whose latest turn carries a live plan (and a new title to wait on). */
function emitPlanSnapshot(input: { turnId: string; title: string; offset: number }) {
  const base = fixture.snapshot;
  const nextThreads = base.threads.map((thread) =>
    thread.id === THREAD_ID
      ? Object.assign({}, thread, {
          title: input.title,
          activities: [
            ...thread.activities,
            {
              id: EventId.make(`activity-plan-${input.turnId}`),
              tone: "info" as const,
              kind: "turn.plan.updated",
              summary: "Plan updated",
              payload: {
                plan: [
                  { step: "Draft the change", status: "inProgress" },
                  { step: "Verify the change", status: "pending" },
                ],
              },
              turnId: input.turnId as TurnId,
              sequence: input.offset,
              createdAt: isoAt(1_000 + input.offset),
            },
          ],
          updatedAt: isoAt(1_000 + input.offset),
        })
      : thread,
  );
  const next = {
    ...base,
    snapshotSequence: base.snapshotSequence + 1,
    threads: nextThreads,
  };
  fixture.snapshot = next;
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThreadWindow, {
    kind: "snapshot",
    snapshot: toThreadWindowSnapshot(
      next.snapshotSequence,
      nextThreads.find((thread) => thread.id === THREAD_ID)!,
    ),
  });
}

function threadTitleShown(title: string): boolean {
  return [...document.querySelectorAll<HTMLElement>("header p")].some(
    (element) => element.textContent === title,
  );
}

describe("ChatView PhoneSurfaces (full app)", () => {
  setupChatViewBrowserSuite();

  it("navigates the phone stack from the thread app bar to Home with 44px coarse-pointer targets", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-stack" as MessageId,
        targetText: "phone stack thread",
      }),
    });

    try {
      // The phone tier renders the compact thread app bar instead of the
      // persistent sidebar or a navigation drawer.
      const backButton = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the phone app bar back affordance.",
      );
      // The thread-actions overflow left the app bar's top-right corner for
      // the dock row above the composer.
      const threadActions = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Thread actions"]'),
        "Unable to find the thread-actions overflow.",
      );
      expect(document.querySelector('[data-slot="sidebar-container"]')).toBeNull();
      expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();
      expect(
        threadActions.closest('[data-slot="phone-thread-dock"]'),
        "the thread-actions overflow is still in the app bar",
      ).not.toBeNull();
      expect(threadActions.getBoundingClientRect().top).toBeGreaterThan(
        backButton.getBoundingClientRect().bottom,
      );

      await withCoarsePointer(async () => {
        // Back keeps the shared button's coarse-pointer hit-area expansion; the
        // dock's overflow meets the floor with its own border box instead, so
        // each is measured the way it actually resolves.
        const back = document.querySelector<HTMLElement>('button[aria-label="Back to threads"]')!;
        const backHitArea = getComputedStyle(back, "::after");
        expect(backHitArea.position).toBe("absolute");
        expect(parseFloat(backHitArea.width)).toBeGreaterThanOrEqual(44);
        expect(parseFloat(backHitArea.height)).toBeGreaterThanOrEqual(44);

        const overflowRect = document
          .querySelector<HTMLElement>('button[aria-label="Thread actions"]')!
          .getBoundingClientRect();
        expect(overflowRect.width).toBeGreaterThanOrEqual(44);
        expect(overflowRect.height).toBeGreaterThanOrEqual(44);
      });

      // Back navigates the URL-driven stack to Home (the thread list).
      backButton.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/");
      });
      const homeHeading = await waitForElement(
        () => document.querySelector<HTMLElement>("h1"),
        "Unable to find the Home heading.",
      );
      expect(homeHeading.textContent).toBe("Threads");

      // Home renders the same store-backed thread with a >=44px row and a
      // visible kebab (no hover-only affordances on the phone tier).
      const homeRow = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `button[aria-label="Thread actions for ${THREAD_TITLE}"]`,
          ),
        "Unable to find the Home thread row kebab.",
      );
      const rowRect = homeRow.getBoundingClientRect();
      expect(rowRect.height).toBeGreaterThanOrEqual(44);
      expect(rowRect.width).toBeGreaterThanOrEqual(44);

      // The kebab opens the bottom-sheet action inventory.
      homeRow.click();
      await vi.waitFor(() => {
        const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
        expect(sheet).not.toBeNull();
        expect(sheet!.textContent).toContain("Rename thread");
        expect(sheet!.textContent).toContain("Mark unread");
      });

      // Deep links keep working: navigating forward re-enters the thread.
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
      });
      mounted.router.history.back();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(
          `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`,
        );
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the app bar after returning to the thread.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes the workspace panel to a full-screen phone surface with history-coherent back", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-work-surface-promotion" as MessageId,
        targetText: "work surface promotion thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: "/",
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });

      // Home -> thread: the navigation stack the surface must unwind through.
      const homeHeading = await waitForElement(
        () => document.querySelector<HTMLElement>("h1"),
        "Unable to find the Home heading.",
      );
      expect(homeHeading.textContent).toBe("Threads");
      const threadRow = await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>('[role="listitem"] button')].find((button) =>
            button.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the Home thread row.",
      );
      threadRow.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(
          `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`,
        );
      });

      // The app-bar workspace toggle opens the full-screen surface (launcher).
      const workspaceToggle = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Toggle workspace panel"]'),
        "Unable to find the workspace toggle.",
      );
      workspaceToggle.click();
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(PHONE_VIEWPORT.height - 0.5);
      });
      expect(mounted.router.state.location.searchStr).toContain("workspaceOpen");

      // Launcher content fits the phone pane: the card stack scrolls instead
      // of clipping above the scroll start.
      const launcherViewport = await waitForElement(
        () => popup.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]'),
        "Unable to find the launcher scroll viewport.",
      );
      await vi.waitFor(() => {
        expect(launcherViewport.scrollHeight).toBeGreaterThan(launcherViewport.clientHeight);
      });
      launcherViewport.scrollTop = 0;
      await waitForLayout();
      const filesCard = await waitForElement(
        () =>
          [...launcherViewport.querySelectorAll<HTMLElement>("button")].find((button) =>
            button.textContent?.includes("Browse project files"),
          ) ?? null,
        "Unable to find the Files launcher card.",
      );
      expect(filesCard.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        launcherViewport.getBoundingClientRect().top - 0.5,
      );

      // Launcher -> Review pushes the diff surface through the same URL
      // params desktop uses.
      const reviewCard = await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find((button) =>
            button.textContent?.includes("View code changes"),
          ) ?? null,
        "Unable to find the Review launcher card.",
      );
      reviewCard.click();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceTab).toBe("review");
        expect(search.diff).toBe("1");
      });

      // Surface bar: visible back affordance with a 44px coarse hit area.
      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the surface back affordance.",
      );
      await withCoarsePointer(async () => {
        const hitArea = getComputedStyle(backButton, "::after");
        expect(hitArea.position).toBe("absolute");
        expect(parseFloat(hitArea.width)).toBeGreaterThanOrEqual(44);
        expect(parseFloat(hitArea.height)).toBeGreaterThanOrEqual(44);
      });

      // Phone review surface: wrap defaults on, the split toggle is gone, and
      // the page never scrolls horizontally.
      await waitForElement(
        () => popup.querySelector<HTMLElement>('[aria-label="Disable diff line wrapping"]'),
        "Unable to find the pressed wrap toggle.",
      );
      expect(popup.querySelector('[aria-label="Split diff view"]')).toBeNull();
      expect(popup.querySelector('[aria-label="Stacked diff view"]')).toBeNull();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE_VIEWPORT.width);

      // Browser back exits the surface to the thread, then Home — never the
      // app. (Tab pushes replace the launcher entry, so one back suffices.)
      mounted.router.history.back();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceTab).toBeUndefined();
        expect(search.diff).toBeUndefined();
        expect(search.workspaceOpen).toBeUndefined();
        expect(isElementVisible(popup)).toBe(false);
      });
      expect(mounted.router.state.location.pathname).toBe(`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`);
      mounted.router.history.back();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/");
      });
      await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>("h1")].find(
            (heading) => heading.textContent === "Threads",
          ) ?? null,
        "Unable to find the Home heading after unwinding history.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders desktop-shaped workspace links full-screen at 320px with contained diff scrolling and a files push", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-work-surface-roundtrip" as MessageId,
        targetText: "work surface roundtrip thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=review&diff=1`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });

      // The desktop-shaped deep link lands directly on the full-screen diff.
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(NARROW_PHONE_VIEWPORT.height - 0.5);
      });
      await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the surface back affordance.",
      );

      // The wide diff renders wrapped by default with no page-level overflow.
      await waitForElement(
        () => popup.querySelector<HTMLElement>('[data-diff-file-path="src/wide.ts"]'),
        "Unable to find the rendered diff file.",
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width);

      // Disabling wrap keeps the horizontal overflow inside the diff surface.
      const wrapToggle = await waitForElement(
        () => popup.querySelector<HTMLElement>('[aria-label="Disable diff line wrapping"]'),
        "Unable to find the wrap toggle.",
      );
      wrapToggle.click();
      const wideDiffFile = await waitForElement(
        () => popup.querySelector<HTMLElement>('[data-diff-file-path="src/wide.ts"]'),
        "Unable to find the rendered diff file after toggling wrap.",
      );
      await vi.waitFor(
        () => {
          expect(hasContainedHorizontalDiffOverflow(wideDiffFile)).toBe(true);
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
            NARROW_PHONE_VIEWPORT.width,
          );
        },
        { timeout: 10_000, interval: 50 },
      );

      // Files surface: single-pane tree -> full-width file view -> back.
      const launcherButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Workspace launcher"]'),
        "Unable to find the workspace launcher button.",
      );
      launcherButton.click();
      const filesCard = await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find((button) =>
            button.textContent?.includes("Browse project files"),
          ) ?? null,
        "Unable to find the Files launcher card.",
      );
      filesCard.click();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceTab).toBe("files");
        expect(search.preview).toBe("1");
      });
      // The tree renders full-width (no split rail, no tree toggle).
      const readmeRow = await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find(
            (button) => button.textContent?.trim() === "README.md",
          ) ?? null,
        "Unable to find the README.md tree row.",
      );
      expect(popup.querySelector("[data-preview-file-rail]")).toBeNull();
      expect(popup.querySelector('[aria-label="Hide workspace tree"]')).toBeNull();
      expect(readmeRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      readmeRow.click();
      const backToTree = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to workspace tree"]'),
        "Unable to find the back-to-tree affordance.",
      );
      // The file view replaces the tree in the single pane and renders the
      // fetched contents (inside the @pierre/diffs shadow DOM).
      expect(popup.querySelector('[aria-label="Filter files"]')).toBeNull();
      await vi.waitFor(
        () => {
          expect(surfaceContainsText(popup, "Work surface readme")).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );
      backToTree.click();
      await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find(
            (button) => button.textContent?.trim() === "README.md",
          ) ?? null,
        "Unable to find the tree after backing out of the file view.",
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width);

      // Back clears the same URL params desktop writes and returns to the
      // thread (no trap).
      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the surface back affordance.",
      );
      backButton.click();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceOpen).toBeUndefined();
        expect(search.workspaceTab).toBeUndefined();
        expect(search.preview).toBeUndefined();
        expect(isElementVisible(popup)).toBe(false);
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the thread app bar after closing the surface.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the terminal surface full-screen with a 44px toolbar above a stubbed keyboard", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-work-surface-terminal" as MessageId,
        targetText: "work surface terminal thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=terminal`,
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      await vi.waitFor(() => {
        expect(popup.getBoundingClientRect().width).toBeGreaterThanOrEqual(
          PHONE_VIEWPORT.width - 0.5,
        );
      });
      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the surface back affordance.",
      );

      // The terminal toolbar reaches the 44px phone floor.
      const toolbar = await waitForElement(
        () => popup.querySelector<HTMLElement>('[role="tablist"][aria-label="Terminals"]'),
        "Unable to find the terminal toolbar.",
      );
      await vi.waitFor(() => {
        expect(toolbar.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      });
      const newTerminalButton = await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find((button) =>
            button.getAttribute("aria-label")?.startsWith("New Terminal"),
          ) ?? null,
        "Unable to find the New Terminal action.",
      );
      expect(newTerminalButton.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      expect(newTerminalButton.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

      // With the software keyboard open, the surface shrinks by the published
      // inset: the terminal container (toolbar included) stays fully visible.
      const keyboardInset = 300;
      viewportStub.setKeyboardInset(keyboardInset);
      await waitForLayout();
      const visibleBottom = PHONE_VIEWPORT.height - keyboardInset;
      await vi.waitFor(() => {
        const drawer = popup.querySelector<HTMLElement>(".thread-terminal-drawer");
        expect(drawer).not.toBeNull();
        expect(drawer!.getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
        expect(toolbar.getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
        expect(toolbar.getBoundingClientRect().top).toBeGreaterThanOrEqual(-0.5);
      });
      viewportStub.setKeyboardInset(0);
      await waitForLayout();

      // The terminal surface exits cleanly back to the thread through its own
      // back affordance (acceptance criterion, asserted on this surface).
      backButton.click();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceOpen).toBeUndefined();
        expect(search.workspaceTab).toBeUndefined();
        expect(isElementVisible(popup)).toBe(false);
      });
      expect(mounted.router.state.location.pathname).toBe(`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`);
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the thread app bar after closing the terminal surface.",
      );
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("keeps the Crown rail docked beside the workspace panel", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-crown-rail-docked" as MessageId,
        targetText: "crown rail docked thread",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      const workspaceToggle = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Toggle workspace panel"]'),
        "Unable to find the workspace toggle.",
      );
      workspaceToggle.click();
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Close workspace panel"]'),
        "Unable to find the opened inline workspace panel.",
      );

      // Wide layouts open the overview by default; the rail keeps its docked
      // column while the workspace panel is open.
      const rail = await waitForElement(queryVisibleCrownRail, "Unable to find the Crown rail.");
      const slot = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="crown-rail-slot"]'),
        "Unable to find the Crown rail slot.",
      );
      await vi.waitFor(() => {
        expect(Math.round(slot.getBoundingClientRect().width)).toBe(72);
      });
      const crownRoot = rail.closest<HTMLElement>('[data-slot="crown-overview"]')!;

      // An icon click expands the island into the card on that section.
      rail.querySelector<HTMLElement>('[data-nav-key="branch"]')!.click();
      await vi.waitFor(() => {
        expect(crownRoot.dataset.mode).toBe("card");
      });
      const branchSection = await waitForElement(
        () =>
          crownRoot.querySelector<HTMLElement>(
            '[data-slot="crown-card-detail"] [data-section="branch"]',
          ),
        "Unable to find the card's branch section.",
      );
      const branchSelector = await waitForElement(
        () => branchSection.querySelector<HTMLElement>('[data-appearance="panelRow"]'),
        "Unable to find the full-width overview branch selector.",
      );
      await waitForLayout();
      await vi.waitFor(() => {
        expect(Math.round(branchSelector.getBoundingClientRect().height)).toBe(36);
        expect(branchSelector.getBoundingClientRect().width).toBeGreaterThan(200);
      });

      const branchTrigger = branchSelector.querySelector<HTMLButtonElement>(
        '[data-slot="combobox-trigger"]',
      );
      expect(branchTrigger).not.toBeNull();
      await vi.waitFor(() => {
        expect(branchTrigger!.disabled).toBe(false);
      });
      branchTrigger!.click();
      await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to open the overview branch picker.",
      );
      // Escape closes only the picker; the card stays expanded.
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('input[placeholder="Search refs..."]')).toBeNull();
      });
      expect(crownRoot.dataset.mode).toBe("card");

      const collapse = await waitForElement(
        () => crownRoot.querySelector<HTMLElement>('button[aria-label="Collapse overview"]'),
        "Unable to find the card's collapse affordance.",
      );
      collapse.click();
      await vi.waitFor(() => {
        expect(crownRoot.dataset.mode).toBe("dot");
      });

      // The header toggle hides the whole rail.
      const overviewToggle = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Toggle overview panel"]'),
        "Unable to find the overview toggle.",
      );
      overviewToggle.click();
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-slot="crown-overview"]')).toBeNull();
          expect(Math.round(slot.getBoundingClientRect().width)).toBe(0);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes the overview to a full-screen phone surface with a back affordance", async () => {
    // Rotation coverage: enter the overview on the desktop tier and rotate
    // across the boundary — the tier flip must preserve the open panel and
    // re-present it as a full-screen surface. (The phone-tier launcher path —
    // the thread kebab's Source control entry — is covered separately below.)
    const mounted = await mountChatView({
      viewport: ROTATED_MID_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-overview-phone-surface" as MessageId,
        targetText: "overview phone surface thread",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      const overviewToggle = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Toggle overview panel"]'),
        "Unable to find the overview toggle.",
      );
      overviewToggle.click();
      // Desktop <=980 regression guard: the overview docks the 48px Crown
      // rail rather than opening a sheet, and there is no phone surface bar.
      const rail = await waitForElement(queryVisibleCrownRail, "Unable to find the Crown rail.");
      await vi.waitFor(() => {
        expect(Math.round(rail.getBoundingClientRect().width)).toBe(48);
      });
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-slot="sheet-popup"]')].some(
          isElementVisible,
        ),
      ).toBe(false);
      expect(document.querySelector('button[aria-label="Back to thread"]')).toBeNull();

      // Rotate across the tier boundary: the open overview re-presents as a
      // full-screen phone surface with an explicit back affordance (no trap).
      await mounted.setViewport(NARROW_TABLET_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Overview"),
        "Unable to find the phone overview surface.",
      );
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(true);
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.height - 0.5);
      });
      expect(popup.textContent).toContain("Overview");

      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the overview back affordance.",
      );
      backButton.click();
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(false);
      });
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        NARROW_TABLET_VIEWPORT.width,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the desktop inline panel and the sub-980 sheet presentation for workspace links", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-desktop-panel-guard" as MessageId,
        targetText: "desktop panel guard thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=review&diff=1`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });

      // 960px (desktop tier, <=980): the right sheet, not a full-screen
      // surface and not the phone surface bar. (The overview sheet keeps a
      // hidden keep-mounted popup in the DOM, so select the visible one.)
      const sheetPopup = await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>('[data-slot="sheet-popup"]')].find(
            isElementVisible,
          ) ?? null,
        "Unable to find the desktop right-panel sheet.",
      );
      await vi.waitFor(() => {
        const width = sheetPopup.getBoundingClientRect().width;
        expect(width).toBeGreaterThan(300);
        expect(width).toBeLessThan(DEFAULT_VIEWPORT.width * 0.6);
      });
      expect(queryPhoneSurfacePopup("Workspace")).toBeNull();
      expect(document.querySelector('button[aria-label="Back to thread"]')).toBeNull();
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Close workspace panel"]'),
        "Unable to find the desktop panel close button.",
      );
      // Desktop keeps the settings-driven wrap default (off) and the split
      // toggle.
      await waitForElement(
        () => document.querySelector<HTMLElement>('[aria-label="Enable diff line wrapping"]'),
        "Unable to find the desktop wrap toggle.",
      );
      await waitForElement(
        () => document.querySelector<HTMLElement>('[aria-label="Split diff view"]'),
        "Unable to find the desktop split toggle.",
      );

      // Above 980px the same URL renders the inline right panel.
      await mounted.setViewport(WIDE_FOOTER_VIEWPORT);
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>('[data-slot="sidebar"][data-side="right"]'),
        ).not.toBeNull();
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Close workspace panel"]'),
        "Unable to find the inline panel close button.",
      );
      expect(queryPhoneSurfacePopup("Workspace")).toBeNull();
      expect(document.querySelector('button[aria-label="Back to thread"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  for (const viewport of [PHONE_VIEWPORT, NARROW_PHONE_VIEWPORT]) {
    it(`keeps every thread dock control in the bottom third at ${viewport.width}x${viewport.height}`, async () => {
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: `msg-user-reach-${viewport.name}` as MessageId,
          targetText: `reachability ${viewport.name} thread`,
        }),
      });

      try {
        await withCoarsePointer(async () => {
          await expectThreadDockInBottomThird(viewport);
        });
      } finally {
        await mounted.cleanup();
      }
    });

    // The same full-strength assertion as the two tests above, in the state
    // that used to break it: `ApprovalCard` and `ComposerPendingUserInputPanel`
    // render inside `ChatComposer`, so while the dock row sat above the whole
    // composer form an open approval grew the composer upward and carried the
    // dock with it (measured y=305 against 562.7 at 390x844, and y=75 against
    // 378.7 at 320x568 — back in the top third). The dock now renders inside
    // the composer beneath those panels, so the panel grows past it instead.
    it(`keeps every thread dock control in the bottom third with an approval open at ${viewport.width}x${viewport.height}`, async () => {
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotWithPendingApproval(),
      });

      try {
        await waitForElement(
          () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
          "Unable to find the pending approval detail block.",
        );
        await withCoarsePointer(async () => {
          await expectThreadDockInBottomThird(viewport);
        });
      } finally {
        await mounted.cleanup();
      }
    });
  }

  it("mounts no phone thread dock on the desktop tier", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-desktop-no-dock" as MessageId,
        targetText: "desktop no dock thread",
      }),
    });

    try {
      await waitForLayout();
      expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      // The real desktop path: the dock, its strip, and the two controls it
      // owns are absent, and the desktop header keeps them instead.
      expect(document.querySelector('[data-slot="phone-thread-dock"]')).toBeNull();
      expect(document.querySelector('[data-slot="mobile-context-strip"]')).toBeNull();
      expect(document.querySelector('[data-slot="mobile-dock"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the overview surface from the thread dock's Source control pill", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-kebab-source-control" as MessageId,
        targetText: "kebab source control thread",
      }),
    });

    try {
      // Source control is a context-strip pill on the dock row now, not an
      // entry buried one level down inside the overflow sheet.
      const sourceControlPill = await waitForElement(
        () =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              '[data-slot="phone-thread-dock"] [data-slot="mobile-context-strip-pill"]',
            ),
          ].find((pill) => pill.textContent?.startsWith("Source control")) ?? null,
        "Unable to find the Source control pill.",
      );
      const pillRect = sourceControlPill.getBoundingClientRect();
      expect(pillRect.height).toBeGreaterThanOrEqual(44);
      expect(pillRect.width).toBeGreaterThanOrEqual(44);
      sourceControlPill.scrollIntoView({ block: "nearest", inline: "nearest" });
      sourceControlPill.click();

      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Overview"),
        "Unable to find the phone overview surface.",
      );
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(true);
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(PHONE_VIEWPORT.height - 0.5);
      });
      // The full-screen surface honors reduced motion and pads the landscape
      // side insets in addition to top/bottom.
      expect(popup.className).toContain("motion-reduce:transition-none");
      expect(popup.className).toContain("pl-safe");
      expect(popup.className).toContain("pr-safe");
      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the overview back affordance.",
      );
      backButton.click();
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(false);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("defers the plan auto-open while the phone composer is focused", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        autoOpenPlanSidebar: true,
      }),
    );
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-plan-auto-open" as MessageId,
        targetText: "plan auto-open thread",
      }),
    });

    try {
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(composerEditorHasFocus()).toBe(true);
      });

      // A plan arriving mid-composition must not steal focus into the
      // full-screen overview takeover or close the keyboard.
      emitPlanSnapshot({
        turnId: "turn-plan-live-1",
        title: "Planned thread",
        offset: 1,
      });
      await vi.waitFor(() => {
        expect(threadTitleShown("Planned thread")).toBe(true);
      });
      await waitForLayout();
      await waitForLayout();
      const overviewPopup = queryPhoneSurfacePopup("Overview");
      expect(overviewPopup === null || !isElementVisible(overviewPopup)).toBe(true);
      expect(composerEditorHasFocus()).toBe(true);

      // The deferred auto-open is dropped for this turn (not replayed on
      // blur): the plan stays reachable through the kebab's Source control
      // entry instead of a surprise takeover.
      (document.activeElement as HTMLElement).blur();
      await waitForLayout();
      await waitForLayout();
      const popupAfterBlur = queryPhoneSurfacePopup("Overview");
      expect(popupAfterBlur === null || !isElementVisible(popupAfterBlur)).toBe(true);

      // With the composer no longer focused, the next turn's plan auto-opens
      // the overview surface as configured.
      emitPlanSnapshot({
        turnId: "turn-plan-live-2",
        title: "Planned thread again",
        offset: 2,
      });
      await vi.waitFor(() => {
        expect(threadTitleShown("Planned thread again")).toBe(true);
      });
      await vi.waitFor(() => {
        const popup = queryPhoneSurfacePopup("Overview");
        expect(popup).not.toBeNull();
        expect(isElementVisible(popup!)).toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the overview sheet closed while the workspace sheet is open", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        autoOpenPlanSidebar: true,
      }),
    );
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-plan-under-workspace" as MessageId,
        targetText: "plan under workspace thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
    });

    try {
      const workspaceToggle = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Toggle workspace panel"]'),
        "Unable to find the workspace toggle.",
      );
      workspaceToggle.click();
      const workspace = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );

      // A plan arriving under the full-screen workspace must not stack a
      // second full-screen sheet on top of it.
      emitPlanSnapshot({ turnId: "turn-plan-under-workspace", title: "Planned", offset: 1 });
      await vi.waitFor(() => {
        expect(threadTitleShown("Planned")).toBe(true);
      });
      await waitForLayout();
      await waitForLayout();
      const overviewWhileWorkspace = queryPhoneSurfacePopup("Overview");
      expect(overviewWhileWorkspace === null || !isElementVisible(overviewWhileWorkspace)).toBe(
        true,
      );

      // Once the workspace sheet closes, the opened overview shows.
      mounted.router.history.back();
      await vi.waitFor(() => {
        expect(isElementVisible(workspace)).toBe(false);
      });
      await vi.waitFor(() => {
        const popup = queryPhoneSurfacePopup("Overview");
        expect(popup).not.toBeNull();
        expect(isElementVisible(popup!)).toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("presents phone settings full-screen from Home with the labeled section list", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-settings-entry" as MessageId,
        targetText: "phone settings entry thread",
      }),
      initialPath: "/",
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const settingsButton = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Open settings"]'),
        "Unable to find the Home settings affordance.",
      );
      settingsButton.click();

      const popup = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="phone-settings-surface"]'),
        "Unable to find the phone settings surface.",
      );
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(PHONE_VIEWPORT.height - 0.5);
      });
      // The desktop dialog presentation stays off the phone tier.
      expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
      // Labeled 44px rows instead of the icon-only rail.
      for (const label of ["General", "Appearance", "Source Control", "Advanced"]) {
        const row = [...popup.querySelectorAll<HTMLButtonElement>("nav button")].find(
          (button) => button.textContent?.trim() === label,
        );
        expect(row, `Missing settings row "${label}".`).not.toBeUndefined();
        expect(row!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }

      // Escape closes the surface (desktop dialog parity).
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="phone-settings-surface"]')).toBeNull();
      });
    } finally {
      useSettingsDialogStore.setState({ open: false, section: "general" });
      await mounted.cleanup();
    }
  });

  it("presents settings as a page on desktop viewports and returns to the thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-desktop-settings-guard" as MessageId,
        targetText: "desktop settings guard thread",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      const threadPath = mounted.router.state.location.pathname;
      useSettingsDialogStore.getState().openSettings();
      const settingsPage = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="settings-page"]'),
        "Unable to find the desktop settings page.",
      );
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/settings");
      });
      // Settings replace the main content instead of floating over it.
      expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
      await waitForElement(
        () => settingsPage.querySelector<HTMLElement>('nav[aria-label="Settings sections"]'),
        "Unable to find the desktop settings section nav.",
      );
      expect(document.querySelector('[data-testid="phone-settings-surface"]')).toBeNull();

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(threadPath);
        expect(useSettingsDialogStore.getState().open).toBe(false);
      });
      expect(document.querySelector('[data-slot="settings-page"]')).toBeNull();
    } finally {
      useSettingsDialogStore.setState({ open: false, section: "general" });
      await mounted.cleanup();
    }
  });

  it("keeps the collapsed desktop sidebar chrome outside the window drag region", async () => {
    localStorage.setItem("chat_thread_sidebar_open", "false");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-collapsed-sidebar-chrome" as MessageId,
        targetText: "collapsed sidebar chrome thread",
      }),
    });

    try {
      const chrome = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-slot="collapsed-app-sidebar-chrome"]:not([inert])',
          ),
        "Unable to find the interactive collapsed sidebar chrome.",
      );
      expect(getComputedStyle(chrome).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      expect(chrome.querySelector('a[aria-label="Go to threads"]')).not.toBeNull();
      expect(chrome.querySelector('a[aria-label="Open statistics"]')).not.toBeNull();

      const breadcrumb = await waitForElement(
        () => document.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"]'),
        "Unable to find the thread breadcrumb beside the collapsed sidebar chrome.",
      );
      expect(chrome.getBoundingClientRect().right).toBeLessThanOrEqual(
        breadcrumb.getBoundingClientRect().left + 0.5,
      );

      const settingsButton = chrome.querySelector<HTMLButtonElement>(
        'button[aria-label="Settings"]',
      );
      expect(settingsButton).not.toBeNull();
      settingsButton!.click();
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="settings-page"]'),
        "Settings did not open from the collapsed sidebar chrome.",
      );
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="settings-page"]')).toBeNull();
      });

      const showSidebarButton = chrome.querySelector<HTMLButtonElement>(
        'button[aria-label="Show sidebar"]',
      );
      expect(showSidebarButton).not.toBeNull();
      showSidebarButton!.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-slot="sidebar"][data-state="expanded"]'),
        ).not.toBeNull();
        expect(localStorage.getItem("chat_thread_sidebar_open")).toBe("true");
      });
    } finally {
      useSettingsDialogStore.setState({ open: false, section: "general" });
      await mounted.cleanup();
    }
  });

  it("keeps phone app-bar controls visible at 200% text scale at 320px and 390px", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-text-scale" as MessageId,
        targetText: "text scale thread",
      }),
    });

    const assertControlWithinViewport = (selector: string, viewportWidth: number) => {
      const control = document.querySelector<HTMLElement>(selector);
      expect(control, `Missing control ${selector} at 200% text scale.`).not.toBeNull();
      const rect = control!.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(-0.5);
      expect(
        rect.right,
        `Control ${selector} pushed past the viewport at 200% text scale.`,
      ).toBeLessThanOrEqual(viewportWidth + 0.5);
    };

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the phone app bar before scaling text.",
      );
      // The harness host is a grid whose auto track sizes to the content's
      // min-width; index.html's #root is a block that lays the app out at the
      // viewport width and clips. Cap the track so scaled layout matches
      // production geometry.
      const appHost = document.querySelector<HTMLElement>(
        "div.group\\/sidebar-wrapper",
      )?.parentElement;
      if (appHost instanceof HTMLElement) {
        appHost.style.gridTemplateColumns = "minmax(0, 1fr)";
        appHost.style.gridTemplateRows = "minmax(0, 1fr)";
      }
      // Emulate 200% browser text scaling: the layout is rem-based, so
      // doubling the root font size scales typography and rem-sized controls.
      document.documentElement.style.fontSize = "32px";
      const APP_BAR_SELECTORS = [
        'button[aria-label="Back to threads"]',
        'button[aria-label="Thread actions"]',
        'button[aria-label="Toggle workspace panel"]',
      ] as const;
      for (const viewport of [NARROW_PHONE_VIEWPORT, PHONE_VIEWPORT]) {
        await mounted.setViewport(viewport);
        await waitForLayout();
        for (const selector of APP_BAR_SELECTORS) {
          assertControlWithinViewport(selector, viewport.width);
        }
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
      }

      // Landscape (844x390) classifies as phone only with a coarse pointer;
      // with the landscape side safe-area padding it is the most
      // width-constrained case in the matrix.
      await withCoarsePointer(async () => {
        await mounted.setViewport(PHONE_LANDSCAPE_VIEWPORT);
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        await waitForLayout();
        for (const selector of APP_BAR_SELECTORS) {
          assertControlWithinViewport(selector, PHONE_LANDSCAPE_VIEWPORT.width);
        }
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.width,
        );
      });
      await mounted.setViewport(PHONE_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });

      // Home at 200%: the app-bar actions stay visible and tappable.
      document.querySelector<HTMLElement>('button[aria-label="Back to threads"]')!.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/");
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Search threads"]'),
        "Unable to find the Home app bar after navigating back.",
      );
      await waitForLayout();
      for (const selector of [
        'button[aria-label="Search threads"]',
        'button[aria-label="Open settings"]',
        'button[aria-label="New thread"]',
      ]) {
        assertControlWithinViewport(selector, PHONE_VIEWPORT.width);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    } finally {
      document.documentElement.style.fontSize = "";
      await mounted.cleanup();
    }
  });

  it("gives every visible phone control an accessible name across Home, thread, and sheets", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-label-audit" as MessageId,
        targetText: "phone label audit thread",
      }),
    });

    const accessibleControlName = (control: HTMLElement): string => {
      const ariaLabel = control.getAttribute("aria-label")?.trim();
      if (ariaLabel) return ariaLabel;
      const labelledBy = control.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const content = control.textContent?.trim();
      if (content) return content;
      return control.getAttribute("title")?.trim() ?? "";
    };
    // Enumerate every visible control: anything without an accessible name is
    // an icon-only affordance a screen reader cannot describe.
    const unnamedVisibleControls = () =>
      [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter((control) => control.checkVisibility?.() ?? true)
        .filter((control) => accessibleControlName(control) === "")
        .map((control) => control.outerHTML.slice(0, 160));

    try {
      // Thread surface (app bar, timeline, collapsed composer).
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the phone thread app bar.",
      );
      await waitForLayout();
      expect(unnamedVisibleControls()).toEqual([]);

      // The thread kebab sheet. (The keep-mounted work-surface popups stay in
      // the DOM while closed, so visibility decides open/closed here.)
      const visibleSheetPopups = () =>
        [...document.querySelectorAll<HTMLElement>('[data-slot="sheet-popup"]')].filter(
          isElementVisible,
        );
      await page.getByRole("button", { name: "Thread actions" }).click();
      await vi.waitFor(() => {
        expect(visibleSheetPopups().length).toBeGreaterThan(0);
      });
      expect(unnamedVisibleControls()).toEqual([]);
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(visibleSheetPopups().length).toBe(0);
      });

      // The expanded composer control set.
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
      await waitForLayout();
      expect(unnamedVisibleControls()).toEqual([]);

      // Home (app bar, project rows, thread rows and their kebabs).
      document.querySelector<HTMLElement>('button[aria-label="Back to threads"]')!.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/");
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Search threads"]'),
        "Unable to find the Home app bar.",
      );
      await waitForLayout();
      expect(unnamedVisibleControls()).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("pads phone surfaces from the safe-area insets directly instead of the root inset", async () => {
    // Chromium can stub env(safe-area-inset-*) through CDP; when this build
    // does not support the override the test still asserts the declared
    // classes, so the padding contract never goes unchecked.
    const setSafeAreaInsets = async (inset: number): Promise<boolean> => {
      try {
        await cdpSession().send("Emulation.setSafeAreaInsetsOverride", {
          insets: { top: inset, left: inset, right: inset, bottom: inset },
        });
      } catch {
        return false;
      }
      const probe = document.createElement("div");
      probe.style.paddingTop = "env(safe-area-inset-top, 0px)";
      document.body.append(probe);
      const resolved = Number.parseFloat(getComputedStyle(probe).paddingTop);
      probe.remove();
      return resolved === inset;
    };

    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-safe-area" as MessageId,
        targetText: "safe area thread",
      }),
    });

    let insetsStubbed = false;
    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const appBarHeader = await waitForElement(
        () => document.querySelector<HTMLElement>("header"),
        "Unable to find the phone thread app bar.",
      );
      // Declared contract: the phone tier pads its own app bar; the
      // root-level inset is scoped out for the phone tier.
      expect(appBarHeader.className).toContain("phone:pt-safe");
      // The harness mounts into its own host (index.html's #root is absent),
      // so probe the `#root` cascade with an empty element carrying the id.
      const root = document.createElement("div");
      root.id = "root";
      document.body.append(root);

      insetsStubbed = await setSafeAreaInsets(24);
      // The pinned Playwright Chromium supports the override; this assertion
      // keeps the geometry checks from silently degrading to class checks.
      expect(insetsStubbed).toBe(true);
      if (insetsStubbed) {
        await waitForLayout();
        // The root inset is disabled on the phone tier (no double padding,
        // no dvh overflow past the visual viewport bottom).
        expect(getComputedStyle(root).paddingTop).toBe("0px");
        // The app bar pads the top inset itself.
        expect(Number.parseFloat(getComputedStyle(appBarHeader).paddingTop)).toBeGreaterThanOrEqual(
          24,
        );
        // The composer stays clear of the bottom inset.
        const composerForm = document.querySelector<HTMLElement>(
          '[data-chat-composer-form="true"]',
        )!;
        expect(composerForm.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          PHONE_VIEWPORT.height - 24 + 0.5,
        );

        // The desktop tier keeps the root-level inset.
        await mounted.setViewport(DEFAULT_VIEWPORT);
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        });
        await vi.waitFor(() => {
          expect(getComputedStyle(root).paddingTop).toBe("24px");
        });
      }
    } finally {
      if (insetsStubbed) {
        await setSafeAreaInsets(0);
      }
      await mounted.cleanup();
    }
  });

  // --- Acceptance-matrix gap fills (delivery step 10) ---
  // The consolidated cell → proving-test mapping lives in
  // AcceptanceMatrix.browser.tsx; the tests below fill the matrix cells only
  // this file's full-app harness can prove.

  it("hides keyboard-shortcut hints in the command palette on coarse pointers", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-kbd-hints" as MessageId,
        targetText: "shortcut hint thread",
      }),
      initialPath: "/",
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const openPaletteFromHome = async (): Promise<HTMLElement> => {
        const searchButton = await waitForElement(
          () => document.querySelector<HTMLElement>('button[aria-label="Search threads"]'),
          "Unable to find the Home search affordance.",
        );
        searchButton.click();
        return waitForElement(
          () => document.querySelector<HTMLElement>('[data-testid="command-palette"]'),
          "Unable to find the command palette.",
        );
      };
      const paletteShortcutHints = (palette: HTMLElement): HTMLElement[] => [
        ...palette.querySelectorAll<HTMLElement>('[data-slot="kbd"], [data-slot="kbd-group"]'),
      ];

      await withCoarsePointer(async () => {
        // The visible search entry point replaces the ⌘K hint on touch: the
        // palette opens from a button, and every rendered shortcut hint
        // inside it is hidden on the coarse pointer.
        const palette = await openPaletteFromHome();
        const hints = paletteShortcutHints(palette);
        expect(hints.length).toBeGreaterThan(0);
        for (const hint of hints) {
          expect(
            hint.checkVisibility?.() ?? true,
            "A keyboard-shortcut hint stayed visible on a coarse pointer.",
          ).toBe(false);
        }
        await userEvent.keyboard("{Escape}");
        await vi.waitFor(() => {
          expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
        });
      });

      // Fine-pointer guard: the same hints render again once the pointer is
      // hover-capable. (Device-less CI reports `pointer: none` after the
      // emulation revert, so the visibility leg gates on a fine pointer.)
      if (window.matchMedia("(pointer: fine)").matches) {
        const palette = await openPaletteFromHome();
        await vi.waitFor(() => {
          const visible = paletteShortcutHints(palette).filter(
            (hint) => hint.checkVisibility?.() ?? false,
          );
          expect(visible.length).toBeGreaterThan(0);
        });
        await userEvent.keyboard("{Escape}");
        await vi.waitFor(() => {
          expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
        });
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("contains the terminal surface at 320px and on a coarse landscape phone", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-terminal-matrix" as MessageId,
        targetText: "terminal matrix thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=terminal`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      // 320×568: the terminal surface is full-screen, its toolbar keeps the
      // 44px floor, and the page never scrolls horizontally.
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(NARROW_PHONE_VIEWPORT.height - 0.5);
      });
      const toolbar = await waitForElement(
        () => popup.querySelector<HTMLElement>('[role="tablist"][aria-label="Terminals"]'),
        "Unable to find the terminal toolbar.",
      );
      await vi.waitFor(() => {
        expect(toolbar.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      });
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width);

      // Rotate to the coarse landscape phone: the surface survives the flip
      // (fine 844px is desktop; the coarse clause reclassifies it) with the
      // terminal contained, the URL untouched, and no horizontal overflow.
      // The tier flip re-presents the surface, so the landscape elements are
      // re-queried instead of reusing the portrait references.
      await mounted.setViewport(PHONE_LANDSCAPE_VIEWPORT);
      await withCoarsePointer(async () => {
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        const landscapePopup = await waitForElement(
          () => queryPhoneSurfacePopup("Workspace"),
          "Unable to find the phone work surface after rotating to landscape.",
        );
        await vi.waitFor(() => {
          expect(isElementVisible(landscapePopup)).toBe(true);
          const rect = landscapePopup.getBoundingClientRect();
          expect(rect.width).toBeGreaterThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.width - 0.5);
          expect(rect.height).toBeGreaterThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.height - 0.5);
        });
        const landscapeToolbar = await waitForElement(
          () =>
            landscapePopup.querySelector<HTMLElement>('[role="tablist"][aria-label="Terminals"]'),
          "Unable to find the terminal toolbar after rotating to landscape.",
        );
        await vi.waitFor(() => {
          const rect = landscapeToolbar.getBoundingClientRect();
          expect(rect.height).toBeGreaterThanOrEqual(44);
          expect(rect.bottom).toBeLessThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.height + 0.5);
        });
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.width,
        );
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceTab).toBe("terminal");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("contains the review and files surfaces on a coarse landscape phone", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_LANDSCAPE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-landscape-work-surface" as MessageId,
        targetText: "landscape work surface thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=review&diff=1`,
    });

    try {
      await withCoarsePointer(async () => {
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        // The desktop-shaped deep link presents full-screen on the coarse
        // landscape phone with the wrapped diff contained.
        const popup = await waitForElement(
          () => queryPhoneSurfacePopup("Workspace"),
          "Unable to find the phone work surface.",
        );
        await vi.waitFor(() => {
          expect(isElementVisible(popup)).toBe(true);
          const rect = popup.getBoundingClientRect();
          expect(rect.width).toBeGreaterThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.width - 0.5);
          expect(rect.height).toBeGreaterThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.height - 0.5);
        });
        await waitForElement(
          () => popup.querySelector<HTMLElement>('[data-diff-file-path="src/wide.ts"]'),
          "Unable to find the rendered diff file.",
        );
        await waitForElement(
          () => popup.querySelector<HTMLElement>('[aria-label="Disable diff line wrapping"]'),
          "Unable to find the pressed wrap toggle.",
        );
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.width,
        );

        // Every rendered surface-bar tab keeps the 44px floor in landscape.
        const tabs = [...popup.querySelectorAll<HTMLElement>('[role="tab"]')];
        expect(tabs.length).toBeGreaterThan(0);
        for (const tab of tabs) {
          expect(tab.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        }

        // The launcher pushes the single-pane files tree, still without
        // horizontal overflow.
        const launcherButton = await waitForElement(
          () => popup.querySelector<HTMLElement>('button[aria-label="Workspace launcher"]'),
          "Unable to find the workspace launcher button.",
        );
        launcherButton.click();
        const filesCard = await waitForElement(
          () =>
            [...popup.querySelectorAll<HTMLElement>("button")].find((button) =>
              button.textContent?.includes("Browse project files"),
            ) ?? null,
          "Unable to find the Files launcher card.",
        );
        filesCard.click();
        await vi.waitFor(() => {
          const search = mounted.router.state.location.search as Record<string, unknown>;
          expect(search.workspaceTab).toBe("files");
        });
        const readmeRow = await waitForElement(
          () =>
            [...popup.querySelectorAll<HTMLElement>("button")].find(
              (button) => button.textContent?.trim() === "README.md",
            ) ?? null,
          "Unable to find the README.md tree row.",
        );
        expect(readmeRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.width,
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves the open review surface across a mid-size rotation tier flip", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-review-rotation" as MessageId,
        targetText: "review rotation thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=review&diff=1`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(true);
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.width - 0.5);
      });
      await waitForElement(
        () => popup.querySelector<HTMLElement>('[data-diff-file-path="src/wide.ts"]'),
        "Unable to find the rendered diff file.",
      );
      const initialSearch = mounted.router.state.location.searchStr;
      expect(initialSearch).toContain("workspaceTab");

      // Rotate across the 768px boundary: the same URL params re-present the
      // panel in the desktop sub-980 sheet without dropping the open state.
      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      expect(mounted.router.state.location.searchStr).toBe(initialSearch);
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(false);
        const desktopSheet = [
          ...document.querySelectorAll<HTMLElement>('[data-slot="sheet-popup"]'),
        ].find(
          (sheet) =>
            isElementVisible(sheet) &&
            sheet.querySelector('[role="tablist"][aria-label="Workspace tabs"]') !== null,
        );
        expect(desktopSheet, "Missing the desktop workspace sheet.").not.toBeUndefined();
        expect(desktopSheet!.getBoundingClientRect().width).toBeLessThan(
          ROTATED_MID_VIEWPORT.width * 0.7,
        );
      });

      // Rotate back: the full-screen phone surface returns with the same
      // route state and no document-level overflow. (The tier flip
      // re-presents the surface, so the popup is re-queried.)
      await mounted.setViewport(NARROW_TABLET_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const restoredPopup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface after rotating back.",
      );
      await vi.waitFor(() => {
        expect(isElementVisible(restoredPopup)).toBe(true);
        const rect = restoredPopup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.height - 0.5);
      });
      expect(mounted.router.state.location.searchStr).toBe(initialSearch);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        NARROW_TABLET_VIEWPORT.width,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves open settings across a mid-size rotation tier flip", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-settings-rotation" as MessageId,
        targetText: "settings rotation thread",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      useSettingsDialogStore.getState().openSettings("appearance");
      const surface = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="phone-settings-surface"]'),
        "Unable to find the phone settings surface.",
      );
      // The open-to-section entry lands directly on the pushed section page.
      await vi.waitFor(() => {
        const heading = surface.querySelector<HTMLElement>("h1[tabindex]");
        expect(heading?.textContent).toContain("Appearance");
      });

      // Rotate across the boundary: the desktop page takes over the same
      // open settings state; the phone surface unmounts.
      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="settings-page"]'),
        "Unable to find the desktop settings page after the tier flip.",
      );
      expect(document.querySelector('[data-testid="phone-settings-surface"]')).toBeNull();
      expect(useSettingsDialogStore.getState().open).toBe(true);
      expect(useSettingsDialogStore.getState().section).toBe("appearance");

      // Rotate back: the phone surface returns on the same section page.
      await mounted.setViewport(NARROW_TABLET_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const restoredSurface = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="phone-settings-surface"]'),
        "Unable to find the phone settings surface after rotating back.",
      );
      await vi.waitFor(() => {
        const heading = restoredSurface.querySelector<HTMLElement>("h1[tabindex]");
        expect(heading?.textContent).toContain("Appearance");
      });
      expect(useSettingsDialogStore.getState().section).toBe("appearance");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        NARROW_TABLET_VIEWPORT.width,
      );
    } finally {
      useSettingsDialogStore.setState({ open: false, section: "general" });
      await mounted.cleanup();
    }
  });
});
