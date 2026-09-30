import "../../index.css";

import { FolderIcon, GitBranchIcon, GitCompareIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { cdpSession, parkPointer, resetPointerEmulation } from "../../../test/browserPointer";
import { MenuItem } from "../ui/menu";
import {
  OverviewRail,
  OverviewRailButton,
  OverviewRailMenuAction,
  OverviewRailPopover,
} from "./OverviewRail";

const COLLAPSED_WIDTH = 44;
const EXPANDED_WIDTH = 256;

function Harness(props: {
  onRunScript?: (name: string) => void;
  initialPinned?: boolean;
  disabledRun?: boolean;
  height?: number;
}) {
  const [pinned, setPinned] = useState(props.initialPinned ?? false);
  return (
    <div
      data-testid="host"
      className="relative"
      style={{ width: 900, height: props.height ?? 600, padding: 24, boxSizing: "border-box" }}
    >
      <textarea aria-label="Composer" />
      <p data-testid="conversation" style={{ width: "100%" }}>
        The conversation keeps its layout while the rail widens over it.
      </p>
      <div className="pointer-events-none absolute top-3 right-3 bottom-3 flex flex-col items-end">
        <OverviewRail
          label="Overview"
          pinned={pinned}
          onPinnedChange={setPinned}
          className="pointer-events-auto"
        >
          <OverviewRailButton icon={<GitBranchIcon />} label="feature/overview-rail" value="↑2" />
          <OverviewRailPopover
            title="Changes"
            trigger={
              <OverviewRailButton
                icon={<GitCompareIcon />}
                label="Changes"
                value="+12 −3"
                tone="primary"
              />
            }
          >
            <p className="px-3 py-2 text-sm">2 uncommitted files</p>
          </OverviewRailPopover>
          <OverviewRailMenuAction
            icon={<PlayIcon />}
            label="Run dev"
            disabled={props.disabledRun}
            onClick={() => props.onRunScript?.("dev")}
            optionsLabel="Choose script"
          >
            <MenuItem onClick={() => props.onRunScript?.("dev")}>dev</MenuItem>
            <MenuItem onClick={() => props.onRunScript?.("test")}>test</MenuItem>
          </OverviewRailMenuAction>
          <OverviewRailButton icon={<FolderIcon />} label="Files" disabled />
        </OverviewRail>
      </div>
    </div>
  );
}

function rail(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="overview-rail"]');
  if (!element) throw new Error("Overview rail is not mounted.");
  return element;
}

function railItem(name: string): HTMLButtonElement {
  const item = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-overview-rail-item]"),
  ).find((button) =>
    (button.getAttribute("aria-label") ?? button.textContent ?? "").includes(name),
  );
  if (!item) throw new Error(`Rail item "${name}" is not mounted.`);
  return item;
}

function iconRects(): Array<{ left: number; top: number }> {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-overview-rail-item] > span[aria-hidden]"),
  ).map((icon) => {
    const rect = icon.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top) };
  });
}

// Rows are fixed-width and right-anchored, so while collapsed only their icon
// cell (the rightmost 36px) is on screen — point at it like a user would.
const ICON_POSITION = { position: { x: 230, y: 16 } };

function row(name: string): HTMLElement {
  return railItem(name).closest<HTMLElement>("[data-overview-rail-row]")!;
}

async function expectRowRevealed(name: string, revealed = true) {
  await vi.waitFor(() => {
    expect(row(name).dataset.revealed).toBe(String(revealed));
    const label = railItem(name).querySelector<HTMLElement>("[data-overview-rail-label]");
    expect(Number(getComputedStyle(label!).opacity)).toBe(revealed ? 1 : 0);
  });
}

async function expectRailWidth(width: number) {
  await vi.waitFor(
    () => {
      expect(Math.round(rail().getBoundingClientRect().width)).toBe(width);
    },
    { timeout: 2_000, interval: 16 },
  );
}

describe("OverviewRail", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  beforeEach(async () => {
    await resetPointerEmulation();
    await page.viewport(1_100, 700);
    await parkPointer(0, 0);
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("reveals only the hovered row without moving icons or the conversation", async () => {
    mounted = await render(<Harness />);
    await expectRailWidth(COLLAPSED_WIDTH);
    const railRight = Math.round(rail().getBoundingClientRect().right);
    const iconsBefore = iconRects();
    const conversationBefore = page.getByTestId("conversation").element().getBoundingClientRect();

    await userEvent.hover(railItem("Changes"), ICON_POSITION);
    await expectRowRevealed("Changes");
    await expectRailWidth(COLLAPSED_WIDTH);
    expect(row("feature/overview-rail").dataset.revealed).toBe("false");
    expect(row("Run dev").dataset.revealed).toBe("false");
    // Revealing happens on the left edge only: the right edge and every icon
    // stay put, and the absolutely positioned rail never reflows content.
    expect(Math.round(rail().getBoundingClientRect().right)).toBe(railRight);
    expect(iconRects()).toEqual(iconsBefore);
    const conversationAfter = page.getByTestId("conversation").element().getBoundingClientRect();
    expect(conversationAfter.width).toBe(conversationBefore.width);
    expect(conversationAfter.left).toBe(conversationBefore.left);
    await vi.waitFor(() => {
      const label = Array.from(railItem("Changes").querySelectorAll("span")).find(
        (span) => span.textContent === "Changes",
      );
      expect(Number(getComputedStyle(label!.parentElement!).opacity)).toBe(1);
    });
    expect(railItem("Changes").querySelector("[data-overview-rail-tone='primary']")).not.toBeNull();

    await userEvent.hover(page.getByTestId("conversation"));
    await expectRowRevealed("Changes", false);
    await expectRailWidth(COLLAPSED_WIDTH);
    expect(iconRects()).toEqual(iconsBefore);
  });

  it("stays open while the pointer moves into a portaled menu and settles after it closes", async () => {
    const onRunScript = vi.fn();
    mounted = await render(<Harness onRunScript={onRunScript} />);

    await userEvent.hover(railItem("Run dev"), ICON_POSITION);
    await expectRowRevealed("Run dev");
    await userEvent.click(page.getByRole("button", { name: "Choose script" }));
    const testItem = page.getByRole("menuitem", { name: "test" });
    await expect.element(testItem).toBeVisible();
    const popup = document.querySelector<HTMLElement>('[data-slot="menu-popup"]')!;
    expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(
      row("Run dev").getBoundingClientRect().left,
    );

    // The menu is portaled outside the rail; the pointer leaving the rail for
    // it must not collapse the rail under the menu.
    await userEvent.hover(testItem);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(row("Run dev").dataset.revealed).toBe("true");
    expect(row("Changes").dataset.revealed).toBe("false");

    await userEvent.click(testItem);
    expect(onRunScript).toHaveBeenCalledWith("test");
    await expectRowRevealed("Run dev", false);
    await expectRailWidth(COLLAPSED_WIDTH);
  });

  it("moves through items with arrow keys and hands focus back on Escape", async () => {
    mounted = await render(<Harness />);
    const composer = page.getByRole("textbox", { name: "Composer" });
    await userEvent.click(composer);
    await userEvent.tab();

    // One tab stop for the whole rail; keyboard focus reveals its row.
    const branch = railItem("feature/overview-rail");
    expect(document.activeElement).toBe(branch);
    expect(
      Array.from(document.querySelectorAll("[data-overview-rail-item]")).filter(
        (item) => (item as HTMLElement).tabIndex === 0,
      ),
    ).toHaveLength(1);
    await expectRowRevealed("feature/overview-rail");
    await expectRailWidth(COLLAPSED_WIDTH);

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(railItem("Changes"));
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    // The disabled Files item is skipped; the pin toggle closes the loop.
    expect(document.activeElement).toBe(railItem("Expand overview"));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(branch);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(railItem("Expand overview"));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(branch);

    await userEvent.keyboard("{Escape}");
    await expectRailWidth(COLLAPSED_WIDTH);
    expect(document.activeElement).toBe(composer.element());
  });

  it("runs the primary action directly and reaches alternatives with Left/Right", async () => {
    const onRunScript = vi.fn();
    mounted = await render(<Harness onRunScript={onRunScript} />);
    await userEvent.click(railItem("Run dev"), ICON_POSITION);
    expect(onRunScript).toHaveBeenCalledExactlyOnceWith("dev");
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await userEvent.click(page.getByRole("textbox", { name: "Composer" }));
    await userEvent.tab();
    await userEvent.keyboard("{Home}{ArrowDown}{ArrowDown}");
    await expectRowRevealed("Run dev");
    await userEvent.keyboard("{ArrowLeft}");
    const options = page.getByRole("button", { name: "Choose script" }).element();
    expect(document.activeElement).toBe(options);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(railItem("Run dev"));
    await userEvent.keyboard("{ArrowLeft}{Enter}");
    await expect.element(page.getByRole("menuitem", { name: "test" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(options));
    expect(row("Run dev").dataset.revealed).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(railItem("Expand overview"));
  });

  it("keeps alternatives keyboard-accessible when the primary action is unavailable", async () => {
    const onRunScript = vi.fn();
    mounted = await render(<Harness disabledRun onRunScript={onRunScript} />);
    await userEvent.click(page.getByRole("textbox", { name: "Composer" }));
    await userEvent.tab();
    await userEvent.keyboard("{Home}{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(railItem("Run dev"));
    await userEvent.keyboard("{Enter}");
    expect(onRunScript).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowLeft}{Enter}");
    await expect.element(page.getByRole("menuitem", { name: "test" })).toBeVisible();
  });

  it("reveals rows in a scrolling short rail and leaves hidden labels out of hit testing", async () => {
    mounted = await render(<Harness height={145} />);
    const branch = railItem("feature/overview-rail");
    const hiddenLabel = branch.getBoundingClientRect();
    const hit = document.elementFromPoint(hiddenLabel.left + 24, hiddenLabel.top + 16);
    expect(hit?.closest("[data-overview-rail-row]")).toBeNull();
    const list = branch.parentElement!;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    await userEvent.click(page.getByRole("textbox", { name: "Composer" }));
    await userEvent.tab();
    await userEvent.keyboard("{Home}{ArrowDown}{ArrowDown}");
    await expectRowRevealed("Run dev");
    expect(list.scrollTop).toBeGreaterThan(0);
    const runRect = railItem("Run dev").getBoundingClientRect();
    const runHit = document.elementFromPoint(runRect.left + 24, runRect.top + 16);
    expect(runHit?.closest("[data-overview-rail-item]")).toBe(railItem("Run dev"));
    expect(rail().getBoundingClientRect().bottom).toBeLessThanOrEqual(145);
  });

  it("lets Escape close a detail popover first, restoring focus to its trigger", async () => {
    mounted = await render(<Harness />);
    const composer = page.getByRole("textbox", { name: "Composer" });
    await userEvent.click(composer);
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}{Enter}");

    const popover = page.getByRole("dialog");
    await expect.element(popover).toBeVisible();
    expect(popover.element().textContent).toContain("2 uncommitted files");
    expect(row("Changes").dataset.revealed).toBe("true");

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
    expect(document.activeElement).toBe(railItem("Changes"));
    expect(row("Changes").dataset.revealed).toBe("true");

    await userEvent.keyboard("{Escape}");
    await expectRailWidth(COLLAPSED_WIDTH);
    expect(document.activeElement).toBe(composer.element());
  });

  it("pins open explicitly and collapses on request even under the pointer", async () => {
    mounted = await render(<Harness />);
    await userEvent.hover(railItem("Expand overview"), ICON_POSITION);
    await expectRowRevealed("Expand overview");
    await userEvent.click(railItem("Expand overview"), ICON_POSITION);
    expect(rail().dataset.pinned).toBe("true");
    expect(railItem("Collapse overview").getAttribute("aria-expanded")).toBe("true");

    await userEvent.hover(page.getByTestId("conversation"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(Math.round(rail().getBoundingClientRect().width)).toBe(EXPANDED_WIDTH);

    await userEvent.hover(railItem("Collapse overview"), ICON_POSITION);
    await userEvent.click(railItem("Collapse overview"), ICON_POSITION);
    expect(rail().dataset.pinned).toBe("false");
    await expectRailWidth(COLLAPSED_WIDTH);
  });

  it("drops the width animation under reduced motion", async () => {
    try {
      await cdpSession().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await vi.waitFor(() => {
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      });
      mounted = await render(<Harness initialPinned />);
      expect(getComputedStyle(rail()).transitionProperty).toBe("none");
      // Pinned renders at full width immediately — no transition to wait for.
      expect(Math.round(rail().getBoundingClientRect().width)).toBe(EXPANDED_WIDTH);
    } finally {
      await cdpSession().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "" }],
      });
    }
  });
});
