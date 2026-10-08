import "../../../../index.css";

import type { ReactNode } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { CROWN_FLYOUT_WIDTH_PX } from "../crownLayout";
import type { CrownSectionDetailProps } from "../crownTypes";
import { CrownSectionDetail } from "./CrownSectionDetail";
import { crownLayoutFixture, crownPullRequestFixture } from "../crownTestFixtures";

const hosts: HTMLElement[] = [];

/** Mounts a detail inside a flyout-sized box (272px with the prototype's 14px padding). */
async function mountDetail(props: CrownSectionDetailProps) {
  const host = document.createElement("div");
  host.style.width = `${CROWN_FLYOUT_WIDTH_PX}px`;
  host.style.padding = "14px";
  host.style.boxSizing = "border-box";
  document.body.append(host);
  hosts.push(host);
  return render(<CrownSectionDetail {...props} />, { container: host });
}

/**
 * Records whether the app prevented a click's default action, then prevents it
 * anyway so tests never navigate or open tabs. Window bubble listeners run
 * after React's root listener.
 */
function guardLinkClicks() {
  const state = { preventedByApp: null as boolean | null };
  const guard = (event: MouseEvent) => {
    state.preventedByApp = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener("click", guard);
  return { state, dispose: () => window.removeEventListener("click", guard) };
}

function BranchControlStub(): ReactNode {
  return <button type="button" className="flex h-9 w-full items-center px-3" aria-label="Branch" />;
}

describe("CrownSectionDetail interactions", () => {
  afterEach(() => {
    for (const host of hosts.splice(0)) host.remove();
  });

  it("opens the review from the Changes detail", async () => {
    const onOpenReview = vi.fn();
    await mountDetail({
      section: "changes",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture({ onOpenReview }),
    });

    await page.getByRole("button", { name: "Open review" }).click();
    expect(onOpenReview).toHaveBeenCalledTimes(1);
  });

  it("opens a subagent from its row", async () => {
    const onOpenSubagent = vi.fn();
    const layout = crownLayoutFixture({ onOpenSubagent });
    await mountDetail({ section: "agents", variant: "flyout", isGitRepo: true, layout });

    await page.getByRole("button", { name: "Test writer — Working" }).click();
    expect(onOpenSubagent).toHaveBeenCalledTimes(1);
    expect(onOpenSubagent).toHaveBeenCalledWith(layout.subagents![1]);
  });

  it("opens the pull request in Ryco on a plain click and leaves modified clicks to the link", async () => {
    const onOpenPullRequestInApp = vi.fn();
    const guard = guardLinkClicks();
    try {
      await mountDetail({
        section: "pr",
        variant: "card",
        isGitRepo: true,
        layout: crownLayoutFixture({ onOpenPullRequestInApp }),
      });
      const link = page.getByRole("link", { name: "Open in Ryco" });
      await expect.element(link).toHaveAttribute("href", crownPullRequestFixture.url!);
      await expect.element(link).toHaveAttribute("target", "_blank");
      await expect.element(link).toHaveAttribute("rel", "noreferrer");

      await link.click();
      expect(guard.state.preventedByApp).toBe(true);
      expect(onOpenPullRequestInApp).toHaveBeenCalledTimes(1);

      // ⌘/Ctrl-click keeps the host link: the app neither intercepts nor handles it.
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        guard.state.preventedByApp = null;
        link
          .element()
          .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier }));
        expect(guard.state.preventedByApp).toBe(false);
      }
      expect(onOpenPullRequestInApp).toHaveBeenCalledTimes(1);
    } finally {
      guard.dispose();
    }
  });

  it("falls back to a plain button when the pull request has no host URL", async () => {
    const onOpenPullRequestInApp = vi.fn();
    const { url: _url, ...pullRequest } = crownPullRequestFixture;
    await mountDetail({
      section: "pr",
      variant: "flyout",
      isGitRepo: true,
      layout: crownLayoutFixture({ pullRequest, onOpenPullRequestInApp }),
    });

    await page.getByRole("button", { name: "Open in Ryco" }).click();
    expect(onOpenPullRequestInApp).toHaveBeenCalledTimes(1);
  });

  it("names the plan actions menu for the overview", async () => {
    await mountDetail({
      section: "plan",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture(),
    });

    await expect
      .element(page.getByRole("button", { name: "Overview plan actions" }))
      .toBeInTheDocument();
  });

  it("keeps the pre-rendered branch picker at its 36px row height and full width", async () => {
    await mountDetail({
      section: "branch",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture({ branchControl: <BranchControlStub /> }),
    });

    const picker = page.getByRole("button", { name: "Branch" }).element();
    const rect = picker.getBoundingClientRect();
    expect(rect.height).toBe(36);
    expect(rect.width).toBeGreaterThan(200);
  });
});
