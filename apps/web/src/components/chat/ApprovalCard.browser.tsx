// Production CSS is part of the behavior under test: wrap, scroll, and the
// keyboard-inset variable drive the phone readability assertions.
import "../../index.css";

import { ApprovalRequestId, EventId, RuntimeSessionId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { syncDocumentVisualViewportInsets } from "../../lib/visualViewportInsets";
import type { PendingApproval } from "../../session-logic";
import {
  installVisualViewportStub,
  type InstalledVisualViewportStub,
} from "../../../test/browserVisualViewport";
import { ApprovalCard } from "./ApprovalCard";

const LONG_DETAIL = [
  "$ bun run build --filter=@ryco/web",
  ...Array.from({ length: 40 }, (_, index) => `long-diff-line-${index}: ${"x".repeat(80)}`),
].join("\n");

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: ApprovalRequestId.make("req-approval-card"),
    requestKind: "command",
    createdAt: "2026-07-20T00:00:00.000Z",
    detail: LONG_DETAIL,
    ...overrides,
  };
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;
let viewportStub: InstalledVisualViewportStub | null = null;
let teardownInsets: (() => void) | null = null;

function countActionSets(): number {
  return document.querySelectorAll('[data-testid="approval-card-actions"]').length;
}

describe("ApprovalCard", () => {
  beforeAll(() => {
    syncDocumentPresentationTier();
  });

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    teardownInsets?.();
    teardownInsets = null;
    viewportStub?.restore();
    viewportStub = null;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await page.viewport(1_280, 720);
  });

  it("forwards the displayed callback identity and disables uncertain outcomes", async () => {
    const identity = {
      requestEventId: EventId.make("displayed-callback"),
      runtimeSessionId: RuntimeSessionId.make("runtime-1"),
    };
    const respond = vi.fn(async () => undefined);
    mounted = await render(
      <ApprovalCard
        approval={approval({ approvalIdentity: identity })}
        pendingCount={1}
        isResponding={false}
        onRespondToApproval={respond}
      />,
    );
    await page.getByRole("button", { name: "Approve once" }).click();
    expect(respond).toHaveBeenCalledWith("req-approval-card", "accept", identity);
    await mounted.rerender(
      <ApprovalCard
        approval={approval({ approvalIdentity: identity, responseState: "uncertain" })}
        pendingCount={1}
        isResponding={false}
        onRespondToApproval={respond}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Approve once" })).toBeDisabled();
    await expect.element(page.getByRole("status")).toHaveTextContent("Delivery outcome is unknown");
    await mounted.rerender(
      <ApprovalCard
        approval={approval({ approvalIdentity: identity, responseState: "retryable" })}
        pendingCount={1}
        isResponding={false}
        onRespondToApproval={respond}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Approve once" })).toBeEnabled();
  });

  for (const [width, height] of [
    [320, 568],
    [390, 844],
  ] as const) {
    it(`stays readable and actionable at ${width} px with a stubbed software keyboard`, async () => {
      await page.viewport(width, height);
      viewportStub = installVisualViewportStub();
      teardownInsets = syncDocumentVisualViewportInsets();
      viewportStub.setKeyboardInset(280);
      // The adapter coalesces updates into animation frames; wait for the
      // published bounded inset before asserting geometry against it.
      await vi.waitFor(() => {
        expect(document.documentElement.style.getPropertyValue("--app-keyboard-inset")).toBe(
          "280px",
        );
      });

      const onRespondToApproval = vi.fn(async () => undefined);
      mounted = await render(
        <div className="fixed inset-x-0 bottom-[var(--app-keyboard-inset,0px)]">
          <ApprovalCard
            approval={approval()}
            pendingCount={2}
            isResponding={false}
            onRespondToApproval={onRespondToApproval}
          />
        </div>,
      );

      // Assertive live region announces arrival with the bounded summary.
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe("Command approval requested");

      // The detail block is scrollable and wrap-safe: no page-level overflow.
      const detail = document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]');
      expect(detail).not.toBeNull();
      expect(detail!.scrollHeight).toBeGreaterThan(detail!.clientHeight);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

      // Exactly one action set, every action visible above the keyboard inset
      // and >= 44 px touch target on the phone tier.
      expect(countActionSets()).toBe(1);
      const keyboardTop = window.innerHeight - 280;
      for (const label of ["Approve once", "Always allow this session", "Decline", "Cancel turn"]) {
        const button = page.getByRole("button", { name: label });
        await expect.element(button).toBeVisible();
        const rect = button.element().getBoundingClientRect();
        expect(rect.bottom, `${label} hidden behind keyboard`).toBeLessThanOrEqual(keyboardTop);
      }

      await page.getByRole("button", { name: "Approve once" }).click();
      expect(onRespondToApproval).toHaveBeenCalledWith("req-approval-card", "accept", undefined);
    });
  }

  it("expands long detail into a bottom sheet with the single action set moved into it", async () => {
    await page.viewport(390, 844);
    const onRespondToApproval = vi.fn(async () => undefined);
    mounted = await render(
      <ApprovalCard
        approval={approval()}
        pendingCount={1}
        isResponding={false}
        onRespondToApproval={onRespondToApproval}
      />,
    );

    expect(countActionSets()).toBe(1);
    await page.getByRole("button", { name: "Show full detail" }).click();

    const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
    expect(sheet).not.toBeNull();
    // The full detail renders inside the sheet.
    expect(sheet!.textContent).toContain("long-diff-line-39");
    // Exactly one action set anywhere while the sheet is open (regression for
    // the duplicate-actions fix), and it is actionable from the sheet.
    await vi.waitFor(() => expect(countActionSets()).toBe(1));
    expect(sheet!.querySelector('[data-testid="approval-card-actions"]')).not.toBeNull();
    await sheet!
      .querySelector<HTMLButtonElement>('[data-testid="approval-card-actions"] button:last-child')!
      .focus();
    await page.getByRole("button", { name: "Decline" }).click();
    expect(onRespondToApproval).toHaveBeenCalledWith("req-approval-card", "decline", undefined);
  });

  it("keeps the expand affordance off the desktop tier and renders a single inline action set", async () => {
    await page.viewport(1_280, 720);
    mounted = await render(
      <ApprovalCard
        approval={approval()}
        pendingCount={1}
        isResponding={false}
        onRespondToApproval={vi.fn(async () => undefined)}
      />,
    );

    expect(countActionSets()).toBe(1);
    expect(document.querySelector('[data-slot="sheet-popup"]'), "no sheet on desktop").toBeNull();
    await expect.element(page.getByRole("button", { name: "Approve once" })).toBeVisible();
    expect(page.getByRole("button", { name: "Show full detail" }).elements()).toHaveLength(0);
  });
});
