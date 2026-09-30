import { ORCHESTRATION_WS_METHODS, type MessageId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../composerDraftStore";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import {
  readPrimaryEnvironmentDescriptor,
  writePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import {
  KEYBOARD_INSET_CSS_VAR,
  VISIBLE_VIEWPORT_HEIGHT_CSS_VAR,
  syncDocumentVisualViewportInsets,
} from "../lib/visualViewportInsets";
import { installVisualViewportStub } from "../../test/browserVisualViewport";
import { toastManager } from "./ui/toast";
import {
  setupChatViewBrowserSuite,
  APPROVAL_ACTION_LABELS,
  APPROVAL_DETAIL_HEAD,
  APPROVAL_DETAIL_TAIL,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NARROW_PHONE_VIEWPORT,
  NARROW_TABLET_VIEWPORT,
  NOW_ISO,
  PHONE_LANDSCAPE_VIEWPORT,
  PHONE_VIEWPORT,
  REMOTE_ENVIRONMENT_ID,
  ROTATED_MID_VIEWPORT,
  TABLET_VIEWPORT,
  THREAD_ID,
  THREAD_KEY,
  THREAD_REF,
  createSnapshotForTargetUser,
  createSnapshotWithPendingApproval,
  createSnapshotWithPendingUserInput,
  createSnapshotWithWideMarkdownTable,
  expandPhoneComposerIfCollapsed,
  findButtonByText,
  findComposerProviderModelPicker,
  findScrollToBottomButton,
  findScrollableAncestor,
  fixture,
  mountChatView,
  nextFrame,
  rpcHarness,
  toThreadWindowSnapshot,
  waitForComposerEditor,
  waitForComposerMenuItem,
  waitForElement,
  waitForLayout,
  waitForSendButton,
  withCoarsePointer,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

describe("ChatView PhoneComposer (full app)", () => {
  setupChatViewBrowserSuite();

  it("renders the full approval detail scrollable with all actions visible on a phone", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });

    try {
      const detail = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
        "Unable to find the pending approval detail block.",
      );
      expect(detail.textContent).toContain(APPROVAL_DETAIL_HEAD);
      expect(detail.textContent).toContain(APPROVAL_DETAIL_TAIL);
      const detailStyle = getComputedStyle(detail);
      expect(detailStyle.overflowY).toBe("auto");
      expect(detailStyle.whiteSpace).toBe("pre-wrap");
      expect(detail.scrollHeight).toBeGreaterThan(detail.clientHeight);
      expect(detail.getBoundingClientRect().height).toBeLessThanOrEqual(161);

      for (const label of APPROVAL_ACTION_LABELS) {
        const button = await waitForElement(
          () => findButtonByText(label),
          `Unable to find approval action "${label}".`,
        );
        const rect = button.getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(-0.5);
        expect(rect.right).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width + 0.5);
        expect(rect.top).toBeGreaterThanOrEqual(-0.5);
        expect(rect.bottom).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.height + 0.5);
      }

      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width);
    } finally {
      await mounted.cleanup();
    }
  });

  it("wraps the expanded approval action row so all actions stay visible at 390px", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });

    try {
      await waitForElement(
        () => findButtonByText("Approve once"),
        "Unable to find the expanded approval action row.",
      );

      // 656px total minus the 16rem desktop sidebar leaves the chat column
      // (and the approval action row) at roughly 400px — inside the 320-430px
      // range the acceptance criteria target. The shell sizes itself with
      // viewport units, so the container height must match the viewport.
      await mounted.setContainerSize({
        width: 656,
        height: DEFAULT_VIEWPORT.height,
      });

      const buttons: HTMLElement[] = [];
      for (const label of APPROVAL_ACTION_LABELS) {
        buttons.push(
          await waitForElement(
            () => findButtonByText(label),
            `Unable to find approval action "${label}".`,
          ),
        );
      }
      const actionRow = buttons[0]!.parentElement!;
      const rowRect = actionRow.getBoundingClientRect();
      expect(rowRect.width).toBeGreaterThanOrEqual(320);
      expect(rowRect.width).toBeLessThanOrEqual(430);
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(rowRect.left - 0.5);
        expect(rect.right).toBeLessThanOrEqual(rowRect.right + 0.5);
        expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 0.5);
      }
      // The row is too wide for one line at this width, so it must have
      // wrapped instead of pushing actions out of view.
      const rowTops = new Set(
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
      );
      expect(rowTops.size).toBeGreaterThan(1);
      expect(actionRow.scrollWidth).toBeLessThanOrEqual(actionRow.clientWidth + 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("contains wide markdown tables in their own scroll container on phones", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotWithWideMarkdownTable(),
    });

    try {
      for (const viewport of [NARROW_PHONE_VIEWPORT, PHONE_VIEWPORT]) {
        await mounted.setViewport(viewport);
        const wrapper = await waitForElement(
          () => document.querySelector<HTMLElement>(".chat-markdown-table-scroll"),
          "Unable to find the markdown table scroll container.",
        );
        await vi.waitFor(() => {
          expect(getComputedStyle(wrapper).overflowX).toBe("auto");
          expect(wrapper.scrollWidth).toBeGreaterThan(wrapper.clientWidth);
          expect(wrapper.getBoundingClientRect().width).toBeLessThanOrEqual(viewport.width);
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
        });
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps transient notices clear of the session tab strip at phone widths", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-toast" as MessageId,
        targetText: "phone toast thread",
      }),
    });

    let toastId: ReturnType<typeof toastManager.add> | null = null;
    const onClose = vi.fn();
    try {
      // The phone tier renders the compact app bar (the session tab strip
      // moved into the thread kebab sheet), so notices must clear the app bar.
      const appBar = await waitForElement(
        () =>
          document
            .querySelector<HTMLElement>('button[aria-label="Back to threads"]')
            ?.closest("header") ?? null,
        "Unable to find the phone thread app bar.",
      );

      toastId = toastManager.add({
        title: "Reconnecting",
        description: "Attempting to restore the connection.",
        type: "info",
        // Keep the toast mounted across the viewport sweep below.
        timeout: 0,
        data: { onClose },
      });

      const toastRoot = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="toast-viewport"] [data-position]'),
        "Unable to find the mounted toast.",
      );
      // The notice must clear the app bar across the whole sub-768px range.
      for (const viewport of [PHONE_VIEWPORT, NARROW_PHONE_VIEWPORT, NARROW_TABLET_VIEWPORT]) {
        await mounted.setViewport(viewport);
        await vi.waitFor(() => {
          const toastRect = toastRoot.getBoundingClientRect();
          const appBarRect = appBar.getBoundingClientRect();
          expect(toastRect.height).toBeGreaterThan(0);
          expect(toastRect.top).toBeGreaterThanOrEqual(appBarRect.bottom);
        });

        const composerForm = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
          "Unable to find the composer form.",
        );
        expect(toastRoot.getBoundingClientRect().bottom).toBeLessThan(
          composerForm.getBoundingClientRect().top,
        );
      }

      // A coarse landscape phone (844x390) is md-wide, so a width-keyed
      // offset would fall back to the 52px desktop value and overlap the app
      // bar; the tier keys the 76px phone offset there too.
      await withCoarsePointer(async () => {
        await mounted.setViewport(PHONE_LANDSCAPE_VIEWPORT);
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        await vi.waitFor(() => {
          const toastRect = toastRoot.getBoundingClientRect();
          const appBarRect = appBar.getBoundingClientRect();
          expect(toastRect.height).toBeGreaterThan(0);
          expect(toastRect.top).toBeGreaterThanOrEqual(appBarRect.bottom);
        });
      });

      // Desktop placement sits at the viewport's top edge, over the header
      // chrome (system-notification style).
      await mounted.setViewport(DEFAULT_VIEWPORT);
      await vi.waitFor(() => {
        const toastViewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]');
        expect(toastViewport).not.toBeNull();
        expect(getComputedStyle(toastViewport!).top).toBe("12px");
        expect(getComputedStyle(toastRoot).getPropertyValue("-webkit-app-region")).toBe("no-drag");
        const closeButton = toastRoot.querySelector<HTMLElement>('[data-slot="toast-close"]');
        expect(closeButton).not.toBeNull();
        expect(getComputedStyle(closeButton!).getPropertyValue("-webkit-app-region")).toBe(
          "no-drag",
        );
      });

      await page.getByRole("button", { name: "Dismiss notification" }).click();
      await vi.waitFor(() => {
        expect(onClose).toHaveBeenCalledOnce();
        expect(document.body.contains(toastRoot)).toBe(false);
      });
      toastId = null;
    } finally {
      if (toastId !== null) {
        toastManager.close(toastId);
      }
      await mounted.cleanup();
    }
  });

  it("keeps tablet-width sidebar density unchanged on coarse pointers", async () => {
    const mounted = await mountChatView({
      viewport: TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-tablet-density" as MessageId,
        targetText: "tablet density thread",
      }),
    });

    try {
      // The persistent desktop sidebar renders at md and up; expand the
      // worktree section so a thread row (and its actions) is in the DOM.
      await page.getByRole("button", { name: "Expand main", exact: true }).click();
      const threadRow = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="thread-row-thread-browser-test"]'),
        "Unable to find the sidebar thread row.",
      );
      const archiveAction = await waitForElement(
        () =>
          document.querySelector<HTMLElement>('[data-testid="thread-archive-thread-browser-test"]'),
        "Unable to find the sidebar thread archive action.",
      );
      const settingsTrigger = await waitForElement(
        () => document.querySelector<HTMLElement>('[aria-label^="Open project settings for"]'),
        "Unable to find the project settings action.",
      );
      const headerButton = await waitForElement(
        () =>
          settingsTrigger.parentElement?.querySelector<HTMLElement>(
            '[data-sidebar="menu-button"]',
          ) ?? null,
        "Unable to find the project header row button.",
      );

      // Rect-based values can carry sub-pixel scaling from the shared test
      // iframe, so they get range/tolerance assertions; computed styles are
      // unscaled CSS px and stay exact.
      const measureDensity = () => ({
        threadRowHeight: threadRow.getBoundingClientRect().height,
        archiveActionWidth: archiveAction.getBoundingClientRect().width,
        archiveHitAreaContent: getComputedStyle(archiveAction, "::after").content,
        headerPaddingRight: getComputedStyle(headerButton).paddingRight,
        settingsRight: getComputedStyle(settingsTrigger).right,
        settingsTop: getComputedStyle(settingsTrigger).top,
      });

      const baseline = measureDensity();
      // Desktop values: 28px rows (h-7) and 20px actions (size-5); the coarse
      // variants would be 44px rows and 32px actions.
      expect(baseline.threadRowHeight).toBeLessThanOrEqual(28.5);
      expect(baseline.archiveActionWidth).toBeGreaterThanOrEqual(18);
      expect(baseline.archiveActionWidth).toBeLessThanOrEqual(22);
      expect(baseline.archiveHitAreaContent).toBe("none");
      // pr-26 reserves the four fine-pointer header actions (new thread,
      // overview, new workspace, settings).
      expect(baseline.headerPaddingRight).toBe("104px");
      expect(baseline.settingsRight).toBe("6px");
      expect(baseline.settingsTop).toBe("4px");

      // A coarse pointer at tablet width must not change the desktop density
      // or positioning: 768x1024 stays on the desktop tier, and the
      // touch-target styles are gated on the phone tier.
      await withCoarsePointer(async () => {
        await waitForLayout();
        const coarse = measureDensity();
        expect(Math.abs(coarse.threadRowHeight - baseline.threadRowHeight)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(coarse.archiveActionWidth - baseline.archiveActionWidth),
        ).toBeLessThanOrEqual(1);
        expect(coarse.archiveHitAreaContent).toBe(baseline.archiveHitAreaContent);
        expect(coarse.headerPaddingRight).toBe(baseline.headerPaddingRight);
        expect(coarse.settingsRight).toBe(baseline.settingsRight);
        expect(coarse.settingsTop).toBe(baseline.settingsTop);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses the composer across the whole phone tier, including 640-767px viewports", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-tier-collapse" as MessageId,
        targetText: "tier collapse thread",
      }),
    });

    try {
      // 700px previously kept the expanded desktop composer (collapse applied
      // only below 640); the phone tier now collapses it consistently across
      // the whole sub-768px range.
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
      });

      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows exactly one set of pending-answer actions on a 700px phone-tier viewport", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      // Focus the always-mounted editor so the mobile pending-answer overlay
      // engages. (The collapsed pending row no longer carries a stand-in pill;
      // the collapsed editor is the tap target.)
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
        expect(
          document.querySelector('[data-chat-composer-mobile-pending-actions="true"]'),
        ).not.toBeNull();
      });

      // The footer's own primary actions must be hidden while the overlay
      // renders: at 640-767px the old width-based sm:flex re-showed them and
      // doubled the pending actions.
      const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
      expect(footer).not.toBeNull();
      expect(getComputedStyle(footer!).display).toBe("none");

      const visibleSubmitActions = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-chat-composer-form="true"] button[type="submit"]',
        ),
      ).filter((button) => button.getBoundingClientRect().width > 0);
      expect(visibleSubmitActions.length).toBe(1);
      expect(
        document
          .querySelector('[data-chat-composer-mobile-pending-actions="true"]')
          ?.contains(visibleSubmitActions[0] ?? null),
      ).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows exactly one set of pending-answer actions on a coarse landscape phone", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_LANDSCAPE_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      await withCoarsePointer(async () => {
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        (document.activeElement as HTMLElement | null)?.blur();
        await page.getByTestId("composer-editor").click();
        await vi.waitFor(() => {
          expect(
            document.querySelector('[data-chat-composer-mobile-pending-actions="true"]'),
          ).not.toBeNull();
        });

        const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
        expect(footer).not.toBeNull();
        expect(getComputedStyle(footer!).display).toBe("none");

        const visibleSubmitActions = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-chat-composer-form="true"] button[type="submit"]',
          ),
        ).filter((button) => button.getBoundingClientRect().width > 0);
        expect(visibleSubmitActions.length).toBe(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves route, draft, and panel search state across a mid-size rotation tier flip", async () => {
    const targetMessageId = "msg-user-rotation-flip" as MessageId;
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: "rotation flip thread",
      }),
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?messageId=${targetMessageId}`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const initialPathname = mounted.router.state.location.pathname;
      const initialSearch = mounted.router.state.location.searchStr;
      expect(initialSearch).toContain("messageId");

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "rotation draft probe");

      // Scroll the timeline away from its bottom-anchored start to a
      // mid-list offset and note a message row visible at that position.
      const timelineRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-message-id]"),
        "Unable to find a timeline message row.",
      );
      const scrollContainer = findScrollableAncestor(timelineRow);
      expect(scrollContainer).not.toBeNull();
      // Scroll to the upper quarter of the list: clearly away from the
      // bottom-anchored start and outside the maintain-at-end band. The list
      // keeps re-pinning to the end until its scroll handler observes the
      // user-initiated position, so re-assert the offset until it sticks.
      const targetScrollTop = Math.max(
        300,
        (scrollContainer!.scrollHeight - scrollContainer!.clientHeight) / 4,
      );
      await vi.waitFor(async () => {
        scrollContainer!.scrollTop = targetScrollTop;
        // Match a real user scroll after the viewport is away from the end.
        // The live-follow latch intentionally ignores bare programmatic
        // scrollTop writes so layout corrections cannot turn off streaming
        // follow mode by accident.
        scrollContainer!.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true }),
        );
        await waitForLayout();
        expect(Math.abs(scrollContainer!.scrollTop - targetScrollTop)).toBeLessThan(50);
        expect(findScrollToBottomButton()).not.toBeNull();
      });
      // Confirm the position holds without further re-assertion.
      await waitForLayout();
      await waitForLayout();
      expect(Math.abs(scrollContainer!.scrollTop - targetScrollTop)).toBeLessThan(50);

      // The scroller must survive the flips in place. Losing state would
      // surface as a fresh scroller element, a reset to the top, or a
      // remount re-running the initial scroll-to-end; a preserved position
      // stays strictly interior. (The virtualizer legitimately shifts the
      // pixel offset while re-measuring row heights for the new column
      // width, so an exact-pixel assertion would overconstrain.)
      const expectScrollPositionPreserved = () => {
        expect(scrollContainer!.isConnected).toBe(true);
        const maxScrollTop = scrollContainer!.scrollHeight - scrollContainer!.clientHeight;
        expect(scrollContainer!.scrollTop).toBeGreaterThan(100);
        expect(scrollContainer!.scrollTop).toBeLessThan(maxScrollTop * 0.8);
      };

      // Rotate across the 768px tier boundary: the desktop shell replaces the
      // drawer without resetting route, draft, or panel search state.
      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(document.querySelector('[data-slot="sidebar-container"]')).not.toBeNull();
      });
      expect(mounted.router.state.location.pathname).toBe(initialPathname);
      expect(mounted.router.state.location.searchStr).toBe(initialSearch);
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
        "rotation draft probe",
      );
      // The desktop composer renders the preserved draft.
      await vi.waitFor(() => {
        const editor = document.querySelector('[data-testid="composer-editor"]');
        expect(editor?.textContent ?? "").toContain("rotation draft probe");
      });
      // The timeline keeps its anchored scroll position: the row visible
      // before the flip stays rendered inside the scroll viewport and the
      // offset is not reset.
      await vi.waitFor(expectScrollPositionPreserved);

      // Rotate back: same route, draft, and search state on the phone tier.
      await mounted.setViewport(NARROW_TABLET_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        expect(document.querySelector('[data-slot="sidebar-container"]')).toBeNull();
      });
      expect(mounted.router.state.location.pathname).toBe(initialPathname);
      expect(mounted.router.state.location.searchStr).toBe(initialSearch);
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
        "rotation draft probe",
      );
      // Scroll anchoring survives the round trip as well.
      await vi.waitFor(expectScrollPositionPreserved);
    } finally {
      await mounted.cleanup();
    }
  });

  it("serves the phone structural presentation to a wide coarse-pointer landscape viewport", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_LANDSCAPE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-coarse-landscape" as MessageId,
        targetText: "coarse landscape thread",
      }),
    });

    try {
      // A fine pointer at 844x390 stays on the desktop tier (width-based
      // clause does not match, pointer clause requires coarse).
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(document.querySelector('[data-slot="sidebar-container"]')).not.toBeNull();
      });

      await withCoarsePointer(async () => {
        // The pointer clause reclassifies the same viewport as a phone: the
        // persistent sidebar unmounts and the compact thread app bar renders
        // its back affordance (width-only styling kept the desktop header at
        // 844px before).
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
          expect(document.querySelector('[data-slot="sidebar-container"]')).toBeNull();
          expect(document.querySelector('button[aria-label="Back to threads"]')).not.toBeNull();
          expect(document.querySelector('button[aria-label="Thread actions"]')).not.toBeNull();
        });

        // The composer collapses like any other phone-tier viewport once the
        // editor loses focus (a focused editor is intentionally kept
        // expanded across the tier flip).
        (document.activeElement as HTMLElement | null)?.blur();
        await vi.waitFor(() => {
          expect(
            document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
          ).not.toBeNull();
        });
      });

      // Reverting the pointer restores the desktop presentation in place; the
      // phone app bar unmounts with the tier flip.
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(document.querySelector('button[aria-label="Back to threads"]')).toBeNull();
        expect(document.querySelector('[data-slot="sidebar-container"]')).not.toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("focuses the phone composer editor in the activating task on the first tap", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-first-tap" as MessageId,
        targetText: "first tap focus thread",
      }),
    });

    const order: string[] = [];
    const focusInTargets: EventTarget[] = [];
    const scheduleRacingFrame = () => {
      window.requestAnimationFrame(() => order.push("frame"));
    };
    const recordFocusIn = (event: Event) => {
      focusInTargets.push(event.target as EventTarget);
      order.push("focusin");
    };

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-composer-mobile-collapsed]"),
        "Unable to find the phone composer surface.",
      );
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      // Opening a thread on a phone leaves the composer collapsed: the first
      // tap is the user's, and it is the one that must raise the keyboard.
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
      });

      // Structural: the collapsed composer must present the real editor, not a
      // stand-in. A `display: none` editor cannot receive the activating tap at
      // all, so no amount of focus-timing work can raise the keyboard.
      const editor = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );
      expect(getComputedStyle(editor).display).not.toBe("none");
      expect(editor.offsetParent).not.toBeNull();
      expect(editor.getBoundingClientRect().height).toBeGreaterThan(0);

      // Ordering: a post-await read of document.activeElement cannot tell a
      // synchronous focus from a next-frame focus, because the harness yields
      // across the tap. The racing frame is scheduled from inside the
      // pointerdown of the very same gesture, so "focusin" can only be
      // recorded first when focus lands in the activation task itself.
      document.addEventListener("pointerdown", scheduleRacingFrame, {
        once: true,
        capture: true,
      });
      document.addEventListener("focusin", recordFocusIn, {
        once: true,
        capture: true,
      });

      await page.getByTestId("composer-editor").click();

      await vi.waitFor(() => {
        expect(order).toContain("focusin");
        expect(order).toContain("frame");
      });
      expect(order[0]).toBe("focusin");
      // The recorded focus must be the editor's own, not some other node that
      // happened to take focus first during the same gesture.
      expect(focusInTargets[0]).toBe(editor);
      expect(document.activeElement).toBe(editor);
    } finally {
      document.removeEventListener("pointerdown", scheduleRacingFrame, true);
      document.removeEventListener("focusin", recordFocusIn, true);
      await mounted.cleanup();
    }
  });

  it("sends from the collapsed phone send affordance on a single tap", async () => {
    // Seed the draft before mount so the composer renders collapsed with
    // sendable content and no post-mount controlled update can transiently
    // focus the editor.
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "Collapsed send probe");
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-collapsed-send" as MessageId,
        targetText: "collapsed send thread",
      }),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        }
        return undefined;
      },
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-composer-mobile-collapsed]"),
        "Unable to find the phone composer surface.",
      );
      // The desktop-to-phone viewport switch settles matchMedia a frame late,
      // which can transiently focus the composer before the tier resolves;
      // blur and wait for a stable collapsed state so the tap below is
      // genuinely the collapsed send affordance and not the expanded footer.
      (document.activeElement as HTMLElement | null)?.blur();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
        expect(document.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
      });
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);

      // A real pointer sequence, not element.click(): engines that focus a
      // button on pointerdown would otherwise expand the composer through the
      // surface's focus handler and unmount this button before `click` is
      // dispatched, silently dropping the send.
      await page.getByRole("button", { name: "Send message" }).click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                (request as { type?: string }).type === "thread.turn.start",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the collapsed phone composer expandable while the environment is unavailable", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-unavailable-expand" as MessageId,
        targetText: "unavailable expand thread",
      }),
    });

    const previousPrimaryDescriptor = readPrimaryEnvironmentDescriptor();

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-mobile-collapsed="true"]'),
        "Unable to find the collapsed phone composer.",
      );
      // Re-point the primary environment so the thread's own environment
      // resolves as a saved, non-primary one; with no live runtime it reports
      // as unavailable, which is what disables the composer editor.
      expect(previousPrimaryDescriptor).not.toBeNull();
      writePrimaryEnvironmentDescriptor({
        ...previousPrimaryDescriptor!,
        environmentId: REMOTE_ENVIRONMENT_ID,
      });
      useSavedEnvironmentRegistryStore.getState().upsert({
        environmentId: LOCAL_ENVIRONMENT_ID,
        label: "Workstation",
        httpBaseUrl: "https://workstation.example.test",
        wsBaseUrl: "wss://workstation.example.test/ws",
        createdAt: NOW_ISO,
        lastConnectedAt: NOW_ISO,
      });

      const editor = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );
      // A disabled editor is `contenteditable="false"` and cannot take focus,
      // so the collapsed surface has nothing focusable in it at all.
      await vi.waitFor(() => {
        expect(editor.getAttribute("contenteditable")).toBe("false");
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
        expect(document.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
      });

      await page.getByTestId("composer-editor").click();

      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
      // Reachable, not merely mounted: the model picker is the entry point to
      // the footer control set that the collapsed dead end hid.
      const modelPicker = await waitForElement(
        () => findComposerProviderModelPicker(),
        "Unable to find the composer model picker.",
      );
      expect(getComputedStyle(modelPicker).display).not.toBe("none");
      expect(modelPicker.getBoundingClientRect().width).toBeGreaterThan(0);
    } finally {
      writePrimaryEnvironmentDescriptor(previousPrimaryDescriptor);
      await mounted.cleanup();
    }
  });

  /**
   * The state whose layout the dock relocation changed: the dock now renders
   * inside `ChatComposer`, beneath the approval panel and above the prompt row.
   * The collapsed composer's activating tap must still reach the editor — the
   * dock must not overlay it, intercept the gesture, or remount it.
   *
   * An approval disables the editor (`contenteditable="false"`, pre-existing:
   * the approval must be answered before typing), so this state expands through
   * the surface's explicit onClick path rather than through native focus. The
   * unconditional first-tap focus guarantee is asserted separately by "focuses
   * the phone composer editor in the activating task on the first tap".
   */
  it("expands the collapsed phone composer on a single tap with an approval open", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
        "Unable to find the pending approval detail block.",
      );
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-mobile-collapsed="true"]'),
        "Unable to find the collapsed phone composer.",
      );
      const dock = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="phone-thread-dock"]'),
        "Unable to find the phone thread dock.",
      );
      const editor = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );
      await waitForLayout();

      // The editor is presented, not swapped out: a display:none or zero-size
      // editor could not receive the activating tap at all.
      expect(getComputedStyle(editor).display).not.toBe("none");
      expect(editor.offsetParent).not.toBeNull();
      const editorRect = editor.getBoundingClientRect();
      expect(editorRect.height).toBeGreaterThan(0);

      // The dock is laid out above the prompt row, not over it, and nothing it
      // renders answers a hit test anywhere across the editor's tap target.
      const dockRect = dock.getBoundingClientRect();
      expect(dockRect.bottom).toBeLessThanOrEqual(editorRect.top + 0.5);
      for (let step = 0; step <= 10; step += 1) {
        const x = editorRect.left + (editorRect.width * step) / 10;
        const y = editorRect.top + editorRect.height / 2;
        const hit = document.elementFromPoint(
          Math.min(Math.max(x, editorRect.left + 0.5), editorRect.right - 0.5),
          y,
        );
        expect(
          hit !== null && dock.contains(hit),
          `the thread dock answers the collapsed editor's tap target at (${Math.round(x)}, ${Math.round(y)})`,
        ).toBe(false);
      }

      await page.getByTestId("composer-editor").click();

      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
      // The same editor node, never remounted by the expansion — that identity
      // is what lets the activating tap's focus survive in the enabled case.
      expect(document.querySelector('[data-testid="composer-editor"]')).toBe(editor);
    } finally {
      await mounted.cleanup();
    }
  });

  /**
   * The dock is now a descendant of the composer surface, so the surface's
   * collapse check has to treat focus landing on it as *not* composer focus.
   * Otherwise tapping the workspace toggle blurs the editor — the software
   * keyboard leaves — while the composer keeps its full expanded height, and
   * nothing ever moves focus back out of the surface to correct it.
   */
  it("collapses the expanded phone composer when focus lands on a thread dock control", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-dock-focus-collapse" as MessageId,
        targetText: "dock focus collapse thread",
      }),
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-mobile-collapsed="true"]'),
        "Unable to find the collapsed phone composer.",
      );
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });

      const toggle = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-slot="phone-thread-dock"] button[aria-label="Toggle workspace panel"]',
          ),
        "Unable to find the dock's workspace toggle.",
      );
      // The toggle is a descendant of the composer surface, which is exactly
      // why the collapse check would otherwise keep the composer expanded.
      expect(toggle.closest("[data-chat-composer-mobile-collapsed]")).not.toBeNull();
      expect(toggle.getAttribute("aria-pressed")).toBe("false");

      // Focus is moved explicitly rather than by clicking: engines differ on
      // whether a click focuses a button (Chromium on Android does, Chromium on
      // macOS — where this suite runs — does not), and it is the focus landing,
      // not the click, that this asserts.
      toggle.focus();
      expect(document.activeElement).toBe(toggle);

      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
      });

      // The tap that moved focus there must still land: the dock renders
      // identically in both states, so the collapse relayout cannot unmount the
      // control out from under it.
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
      await page.getByRole("button", { name: "Toggle workspace panel" }).click();
      // The collapse relayout must not steal the tap it was triggered by: the
      // dock renders identically in both states, so the control stays mounted
      // and the toggle still lands.
      await vi.waitFor(() => {
        expect(toggle.getAttribute("aria-pressed")).toBe("true");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a 16px composer type size across the whole phone tier", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-type-size" as MessageId,
        targetText: "phone type size thread",
      }),
    });

    const editorFontSize = (): number => {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      return Number.parseFloat(getComputedStyle(editor!).fontSize);
    };

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );

      // 640-767px portrait is phone tier. A width-based `sm:` boundary dropped
      // the editor to 14px here, which makes iOS zoom the page on focus.
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        expect(editorFontSize()).toBeGreaterThanOrEqual(16);
      });

      // Coarse landscape is phone tier by pointer, not by width.
      await mounted.setViewport(PHONE_LANDSCAPE_VIEWPORT);
      await withCoarsePointer(async () => {
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
          expect(editorFontSize()).toBeGreaterThanOrEqual(16);
        });
      });

      // Desktop keeps its 14px density.
      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(editorFontSize()).toBe(14);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps approval actions visible when an approval arrives while the phone composer is expanded", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-approval-expanded" as MessageId,
        targetText: "phone expanded approval thread",
      }),
    });

    try {
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });

      // Deliver the approval over the live thread subscription, mirroring an
      // approval arriving while the user has the composer open.
      const approvalSnapshot = createSnapshotWithPendingApproval();
      fixture.snapshot = approvalSnapshot;
      const approvalThread = approvalSnapshot.threads.find((thread) => thread.id === THREAD_ID);
      if (!approvalThread) {
        throw new Error("Expected the approval thread in the snapshot.");
      }
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThreadWindow, {
        kind: "snapshot",
        snapshot: toThreadWindowSnapshot(approvalSnapshot.snapshotSequence + 1, approvalThread),
      });

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
        "Unable to find the pending approval detail block.",
      );
      await waitForLayout();

      // Whether the composer stays expanded or collapses once the editor is
      // disabled, every approval action must remain fully visible at 390px.
      const buttons: HTMLElement[] = [];
      for (const label of APPROVAL_ACTION_LABELS) {
        buttons.push(
          await waitForElement(
            () => findButtonByText(label),
            `Unable to find approval action "${label}".`,
          ),
        );
      }
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(-0.5);
        expect(rect.right).toBeLessThanOrEqual(PHONE_VIEWPORT.width + 0.5);
        expect(rect.top).toBeGreaterThanOrEqual(-0.5);
        expect(rect.bottom).toBeLessThanOrEqual(PHONE_VIEWPORT.height + 0.5);
      }
      // The four actions cannot fit one 390px line, so the row must wrap.
      const rowTops = new Set(
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
      );
      expect(rowTops.size).toBeGreaterThan(1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the composer and send action above a stubbed software keyboard on phones", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-keyboard-composer" as MessageId,
        targetText: "keyboard composer thread",
      }),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      const rootStyle = document.documentElement.style;
      for (const { viewport, keyboardInset } of [
        { viewport: PHONE_VIEWPORT, keyboardInset: 300 },
        { viewport: NARROW_PHONE_VIEWPORT, keyboardInset: 250 },
      ]) {
        await mounted.setViewport(viewport);
        await expandPhoneComposerIfCollapsed();

        const composerForm = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
          "Unable to find the composer form.",
        );
        const sendButton = await waitForSendButton();
        const baselineFormBottom = composerForm.getBoundingClientRect().bottom;

        viewportStub.setKeyboardInset(keyboardInset);
        await waitForLayout();

        expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe(`${keyboardInset}px`);
        expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe(
          `${viewport.height - keyboardInset}px`,
        );

        const visibleBottom = viewport.height - keyboardInset;
        await vi.waitFor(() => {
          const formRect = composerForm.getBoundingClientRect();
          const sendRect = sendButton.getBoundingClientRect();
          expect(formRect.height).toBeGreaterThan(0);
          expect(formRect.top).toBeGreaterThanOrEqual(-0.5);
          expect(formRect.bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
          expect(sendRect.height).toBeGreaterThan(0);
          expect(sendRect.top).toBeGreaterThanOrEqual(-0.5);
          expect(sendRect.bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
        });

        // Hiding the keyboard removes the variables and restores the exact
        // keyboard-closed geometry.
        viewportStub.setKeyboardInset(0);
        await waitForLayout();
        expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("");
        expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe("");
        await vi.waitFor(() => {
          expect(composerForm.getBoundingClientRect().bottom).toBeCloseTo(baselineFormBottom, 0);
        });
      }
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("keeps approval detail and actions visible above a stubbed software keyboard", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      const detail = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
        "Unable to find the pending approval detail block.",
      );

      const keyboardInset = 300;
      viewportStub.setKeyboardInset(keyboardInset);
      await waitForLayout();

      const visibleBottom = PHONE_VIEWPORT.height - keyboardInset;
      await vi.waitFor(() => {
        const detailRect = detail.getBoundingClientRect();
        expect(detailRect.height).toBeGreaterThan(0);
        expect(detailRect.top).toBeGreaterThanOrEqual(-0.5);
        expect(detailRect.bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
      });
      for (const label of APPROVAL_ACTION_LABELS) {
        const button = await waitForElement(
          () => findButtonByText(label),
          `Unable to find approval action "${label}".`,
        );
        const rect = button.getBoundingClientRect();
        expect(rect.height).toBeGreaterThan(0);
        expect(rect.top).toBeGreaterThanOrEqual(-0.5);
        expect(rect.bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
      }
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("clamps the mention/command menu to the visible viewport height with the keyboard open", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-keyboard-command-menu" as MessageId,
        targetText: "keyboard command menu thread",
      }),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      for (const { viewport, keyboardInset, expectTopWithinViewport } of [
        {
          viewport: PHONE_VIEWPORT,
          keyboardInset: 300,
          expectTopWithinViewport: true,
        },
        {
          viewport: NARROW_PHONE_VIEWPORT,
          keyboardInset: 250,
          expectTopWithinViewport: true,
        },
        // Landscape with the keyboard open leaves less visible height than
        // the clamp allowance; the 4.5rem floor must keep the menu usable
        // instead of collapsing it to 0px, even if its top edge is cropped.
        {
          viewport: PHONE_LANDSCAPE_VIEWPORT,
          keyboardInset: 160,
          expectTopWithinViewport: false,
        },
      ]) {
        await mounted.setViewport(viewport);
        await expandPhoneComposerIfCollapsed();
        await waitForComposerEditor();
        await page.getByTestId("composer-editor").fill("/");
        await waitForComposerMenuItem("slash:model");

        const menuList = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-slot="command-list"]'),
          "Unable to find the composer command menu list.",
        );
        // Keyboard-closed baseline: the historical 18rem cap applies on every
        // viewport because the fallback never engages without the adapter.
        expect(getComputedStyle(menuList).maxHeight).toBe("288px");

        viewportStub.setKeyboardInset(keyboardInset);
        await waitForLayout();

        const visibleHeight = viewport.height - keyboardInset;
        // 18rem cap clamped by the visible height minus the composer allowance,
        // floored at 4.5rem (see ComposerCommandMenu). The phone tier's control
        // row carries 44px touch targets instead of 28px `xs` controls, so it
        // takes the 13.5rem allowance rather than 12.5rem.
        const composerAllowance =
          document.documentElement.getAttribute("data-tier") === "phone" ? 216 : 200;
        const expectedMaxHeight = Math.min(288, Math.max(72, visibleHeight - composerAllowance));
        await vi.waitFor(() => {
          expect(getComputedStyle(menuList).maxHeight).toBe(`${expectedMaxHeight}px`);
          const menuRect = menuList.getBoundingClientRect();
          expect(menuRect.height).toBeGreaterThan(40);
          if (expectTopWithinViewport) {
            expect(menuRect.top).toBeGreaterThanOrEqual(-0.5);
          }
          expect(menuRect.bottom).toBeLessThanOrEqual(visibleHeight + 0.5);
        });

        viewportStub.setKeyboardInset(0);
        await waitForLayout();
        expect(getComputedStyle(menuList).maxHeight).toBe("288px");
        await page.getByTestId("composer-editor").fill("");
      }
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("tracks keyboard insets across orientation changes and removes them when closed", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_LANDSCAPE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-keyboard-orientation" as MessageId,
        targetText: "keyboard orientation thread",
      }),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      const rootStyle = document.documentElement.style;

      viewportStub.setKeyboardInset(160);
      await waitForLayout();
      expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("160px");
      expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe(
        `${PHONE_LANDSCAPE_VIEWPORT.height - 160}px`,
      );
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find the composer form.",
      );
      await vi.waitFor(() => {
        expect(composerForm.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.height - 160 + 0.5,
        );
      });

      // Rotating to portrait re-derives the inset from the new geometry.
      await mounted.setViewport(PHONE_VIEWPORT);
      viewportStub.setKeyboardInset(300);
      await waitForLayout();
      expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("300px");
      expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe(
        `${PHONE_VIEWPORT.height - 300}px`,
      );

      viewportStub.setKeyboardInset(0);
      await waitForLayout();
      expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("");
      expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe("");
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("publishes no keyboard variables and changes no composer geometry without an inset", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-keyboard-desktop-baseline" as MessageId,
        targetText: "keyboard desktop baseline thread",
      }),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find the composer form.",
      );
      const sendButton = await waitForSendButton();
      // Settle before the baseline is taken, not after.
      //
      // The composer's position depends on the virtualized timeline above it,
      // which converges over several frames after mount. Reading immediately
      // captured a mid-convergence position, and the comparison below then
      // attributed the remaining settling to the resize under test — a
      // ~313px "movement" that no resize caused.
      //
      // That made the assertion sensitive to anything that changes how long
      // style recalculation takes, including the *size of the stylesheet*:
      // adding 80 lines of inert CSS that no element in this suite matches was
      // enough to flip it, reproducibly. Waiting for two consecutive identical
      // readings measures what the test is named for — that a resize with no
      // keyboard inset moves nothing — instead of racing the timeline.
      // Stability is required across consecutive frames, not merely between two
      // reads: the timeline settles in bursts, so two samples taken inside one
      // quiet gap can agree while convergence is still in progress.
      let stableFrames = 0;
      let previousTop = Number.NaN;
      for (let attempt = 0; attempt < 600 && stableFrames < 8; attempt += 1) {
        await nextFrame();
        const top = composerForm.getBoundingClientRect().top;
        stableFrames = top === previousTop ? stableFrames + 1 : 0;
        previousTop = top;
      }
      expect(stableFrames, "composer geometry never stopped converging").toBeGreaterThanOrEqual(8);
      const baselineFormRect = composerForm.getBoundingClientRect();
      const baselineSendRect = sendButton.getBoundingClientRect();

      // A resize without any keyboard inset must publish nothing and move
      // nothing (desktop baseline guard).
      viewportStub.resizeTo({});
      await waitForLayout();

      const rootStyle = document.documentElement.style;
      expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("");
      expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe("");

      const formRect = composerForm.getBoundingClientRect();
      const sendRect = sendButton.getBoundingClientRect();
      expect(formRect.top).toBeCloseTo(baselineFormRect.top, 2);
      expect(formRect.bottom).toBeCloseTo(baselineFormRect.bottom, 2);
      expect(sendRect.top).toBeCloseTo(baselineSendRect.top, 2);
      expect(sendRect.bottom).toBeCloseTo(baselineSendRect.bottom, 2);
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });
});
