import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import type {
  PullRequestSelectionMotion,
  PullRequestsRepositoryStatus,
} from "./PullRequestsPageContext";
import { PullRequestReader } from "./PullRequestReader";
import { PullRequestsPageBody } from "./PullRequestsPageBody";
import { usePullRequestsLayoutStore } from "./pullRequestsLayoutStore";
import type { PullRequestsSearch } from "./pullRequestsSearch";
import {
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  fixtureChangeRequests,
  fixtureDetail,
  pullRequestsTestNavLog,
  resetPullRequestsTestState,
} from "./testing/PullRequestsTestProvider";

afterEach(() => resetPullRequestsTestState());

async function renderPage(input: {
  readonly width: number;
  readonly selected?: number;
  readonly search?: Partial<PullRequestsSearch>;
  readonly repositoryStatus?: PullRequestsRepositoryStatus;
  readonly selectionMotion?: PullRequestSelectionMotion;
}) {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(input.width, 800);
  return render(
    <PullRequestsTestProvider
      selected={input.selected}
      search={input.search}
      width={input.width}
      height={800}
      repositoryStatus={input.repositoryStatus}
      selectionMotion={input.selectionMotion}
      className="flex-row"
    >
      <PullRequestsPageBody />
    </PullRequestsTestProvider>,
  );
}

function rowButton(number: number): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-pr-row-button="${number}"]`);
  if (!button) throw new Error(`row #${number} is not rendered`);
  return button;
}

function keydown(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

describe("PullRequestsPageBody — repository", () => {
  it("never reads another repository for one the URL names, and offers a picker", async () => {
    const screen = await renderPage({
      width: 1280,
      selected: 703,
      repositoryStatus: {
        kind: "unavailable",
        reason: "offline",
        environmentLabel: "Build box",
        requested: { env: "env-remote", project: "p-remote" },
      },
    });
    await expect.element(screen.getByText("Build box is offline")).toBeVisible();
    // No reader for `#703`: it would be another repository's pull request.
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector("[data-pr-row-button]")).toBeNull();
    await screen.getByRole("button", { name: /ryco/u }).first().click();
    expect(pullRequestsTestNavLog.callsTo("selectRepository")).toHaveLength(1);
  });

  it("waits quietly while the named environment syncs", async () => {
    const screen = await renderPage({
      width: 1280,
      selected: 703,
      repositoryStatus: {
        kind: "waiting",
        stalled: false,
        environmentLabel: "Build box",
        requested: { env: "env-remote", project: "p-remote" },
      },
    });
    await expect.element(screen.getByText("Connecting to Build box…")).toBeVisible();
    expect(screen.getByText("Open another repository").query()).toBeNull();
  });
});

describe("PullRequestsPageBody — drawer", () => {
  it("names the drawer and closes it when the open row is chosen again", async () => {
    const screen = await renderPage({ width: 820, selected: 703 });
    await screen.getByRole("button", { name: "Pull requests", exact: true }).click();
    const drawer = screen.getByRole("dialog", { name: "Pull requests" });
    await expect.element(drawer).toBeVisible();
    await expect.poll(() => document.activeElement).toBe(rowButton(703));
    rowButton(703).click();
    expect(usePullRequestsLayoutStore.getState().drawerOpen).toBe(false);
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("PullRequestsPageBody — empty reader", () => {
  it("keeps ?, / and the list toggle working with the list hidden", async () => {
    usePullRequestsLayoutStore.setState({ listHidden: true });
    const screen = await renderPage({ width: 1280 });
    await expect.element(screen.getByText("Choose a pull request.")).toBeVisible();
    // The empty reader's bar offers the list back.
    const toggle = screen.getByRole("button", { name: "Pull requests", exact: true });
    await expect.element(toggle).toBeVisible();

    await userEvent.keyboard("?");
    await expect.element(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();

    await userEvent.keyboard("/");
    expect(usePullRequestsLayoutStore.getState().listHidden).toBe(false);
    await expect
      .element(screen.getByRole("textbox", { name: "Search pull requests" }))
      .toHaveFocus();
  });

  it("opens the drawer on / when the list is not docked, and focuses its search", async () => {
    const screen = await renderPage({ width: 820, selected: 703, search: { tab: "checks" } });
    await expect.element(screen.getByRole("tab", { name: /Checks/u })).toBeVisible();
    await userEvent.keyboard("/");
    await expect.element(screen.getByRole("dialog", { name: "Pull requests" })).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: "Search pull requests" }))
      .toHaveFocus();
  });
});

describe("PullRequestsPageBody — docked list motion", () => {
  it("hides the list with \\ typed through Option, sliding a ghost out", async () => {
    const screen = await renderPage({ width: 1280, selected: 703 });
    await expect.element(screen.getByRole("tab", { name: /Conversation/u })).toBeVisible();
    // German macOS: `\` is ⌥⇧7.
    keydown("\\", { altKey: true, shiftKey: true });
    expect(usePullRequestsLayoutStore.getState().listHidden).toBe(true);
    const column = document.querySelector<HTMLElement>(".pr-reader-column")!;
    await expect.poll(() => column.dataset.listMotion).toBe("exit");
    const ghost = document.querySelector<HTMLElement>("aside.pr-list-column")!;
    expect(ghost.inert).toBe(true);
    expect(getComputedStyle(column).animationName).toBe("pr-reader-shift-from-right");
    // The ghost leaves once its slide ends; the reader keeps the full width.
    await expect
      .poll(() => document.querySelector("aside.pr-list-column"), { timeout: 3000 })
      .toBeNull();
    expect(column.dataset.listMotion).toBeUndefined();

    keydown("\\");
    await expect.poll(() => column.dataset.listMotion).toBe("enter");
    expect(getComputedStyle(column).animationName).toBe("pr-reader-shift-from-left");
    await expect.poll(() => column.dataset.listMotion, { timeout: 3000 }).toBeUndefined();
  });

  it("moves focus to the reader when the list it was in hides", async () => {
    await renderPage({ width: 1280, selected: 703 });
    rowButton(703).focus();
    keydown("\\");
    await expect
      .poll(() => document.activeElement?.getAttribute("data-sliding-tab-id"))
      .toBe("conversation");
  });

  it("drags the list edge without re-rendering or persisting until release", async () => {
    await renderPage({ width: 1280, selected: 703 });
    const handle = document.querySelector<HTMLElement>('[role="separator"]')!;
    handle.setPointerCapture = () => undefined;
    handle.hasPointerCapture = () => false;
    const pointer = (type: string, clientX: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 7,
          clientX,
        }),
      );
    pointer("pointerdown", 300);
    pointer("pointermove", 360);
    const root = document.querySelector<HTMLElement>(".pr-page")!;
    await expect.poll(() => root.style.getPropertyValue("--pr-list-width")).toBe("364px");
    expect(usePullRequestsLayoutStore.getState().listWidth).toBe(304);
    expect(document.querySelector<HTMLElement>("aside.pr-list-column")!.offsetWidth).toBe(364);
    pointer("pointerup", 360);
    expect(usePullRequestsLayoutStore.getState().listWidth).toBe(364);
    expect(root.style.getPropertyValue("--pr-list-width")).toBe("");
  });
});

describe("PullRequestsPageBody — bar", () => {
  it("keeps the title, stack position and next action at the 1180 reference width", async () => {
    // 1180 window → 932 page → a 627px reader beside the docked list.
    const screen = await renderPage({ width: 932, selected: 703, search: { tab: "checks" } });
    const title = document.querySelector<HTMLElement>(".pr-bar-title")!;
    await expect.poll(() => title.dataset.visible).toBe("true");
    expect(title.textContent).toContain(fixtureDetail(703).title);
    expect(title.getBoundingClientRect().width).toBeGreaterThan(40);
    await expect.element(screen.getByRole("button", { name: /^Stack #14/u })).toBeVisible();
    // The next action stays even though it points at Checks.
    await expect.element(screen.getByRole("button", { name: "View failing check" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "More merge options" })).toBeVisible();
    const header = title.closest("header")!;
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
    // Below a 640 reader the tab counts drop.
    expect(screen.getByRole("tab", { name: /Commits/u }).element().textContent).toBe("Commits");
  });

  it("keeps the title and facts on Files at the 920 reference width", async () => {
    const screen = await renderPage({ width: 672, selected: 703, search: { tab: "files" } });
    const title = document.querySelector<HTMLElement>(".pr-bar-title")!;
    await expect.poll(() => title.dataset.visible).toBe("true");
    await expect.element(screen.getByRole("button", { name: /^Stack #14/u })).toBeVisible();
    const header = title.closest("header")!;
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
    // 672 ≥ 640: counts stay.
    await expect.element(screen.getByRole("tab", { name: /Commits/u })).toMatchTextContent(/\d/u);
  });
});

describe("PullRequestReader", () => {
  it("pushes the body only and rolls the bar title from the layer that was left", async () => {
    await page.viewport(1280, 800);
    const from = { number: 703, title: fixtureDetail(703).title };
    await render(
      <PullRequestsTestProvider
        selected={704}
        search={{ tab: "checks" }}
        width={1280}
        selectionMotion={{ kind: "push", direction: 1, token: 1, from }}
      >
        <PullRequestReader />
      </PullRequestsTestProvider>,
    );
    const title = document.querySelector<HTMLElement>(".pr-bar-title")!;
    const text = title.querySelector<HTMLElement>(".pr-bar-title-text")!;
    await expect
      .poll(() => text.querySelector('[data-roll-phase="enter"]')?.textContent)
      .toBe(fixtureDetail(704).title);
    expect(text.querySelector('[data-roll-phase="leave"]')?.textContent).toBe(from.title);
    const reader = document.querySelector<HTMLElement>(".pr-reader")!;
    const body = document.querySelector<HTMLElement>(".pr-reader-body")!;
    expect(getComputedStyle(reader).viewTransitionName).toBe("none");
    expect(getComputedStyle(body).viewTransitionName).toBe("pr-reader-body");
    // The bar is outside the pushed body.
    expect(body.contains(title)).toBe(false);
  });

  it("gives tabs one Tab stop, arrow keys, and labelled panels", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <PullRequestsTestProvider selected={703} width={1280}>
        <PullRequestReader />
      </PullRequestsTestProvider>,
    );
    const conversation = screen.getByRole("tab", { name: /Conversation/u });
    await expect.element(conversation).toHaveAttribute("tabindex", "0");
    await expect
      .element(screen.getByRole("tab", { name: /Checks/u }))
      .toHaveAttribute("tabindex", "-1");
    const panel = document.querySelector<HTMLElement>(
      '[role="tabpanel"][data-tab="conversation"]',
    )!;
    expect(panel.getAttribute("aria-labelledby")).toBe(conversation.element().id);
    expect(conversation.element().getAttribute("aria-controls")).toBe(panel.id);

    (conversation.element() as HTMLElement).focus();
    await userEvent.keyboard("{End}");
    const commits = screen.getByRole("tab", { name: /Commits/u });
    await expect.element(commits).toHaveAttribute("aria-selected", "true");
    await expect.element(commits).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(conversation).toHaveAttribute("aria-selected", "true");
    await expect.element(conversation).toHaveFocus();
  });

  it("keeps keyboard focus in the reader across PR and tab switches", async () => {
    const screen = await renderPage({ width: 1280, selected: 703 });
    const more = screen.getByRole("button", { name: "More actions" });
    await expect.element(more).toBeVisible();
    (more.element() as HTMLElement).focus();
    await userEvent.keyboard("j");
    await expect.poll(() => pullRequestsTestNavLog.callsTo("stepPullRequest").length).toBe(1);
    // The reader that held focus was replaced: its successor's tab takes it.
    await expect.poll(() => document.activeElement?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.getAttribute("role")).toBe("tab");

    // `3` inside the Conversation panel: focus moves to the Checks tab, not <body>.
    const inPanel = document.querySelector<HTMLElement>(
      '[role="tabpanel"][data-tab="conversation"] button',
    )!;
    inPanel.focus();
    await userEvent.keyboard("3");
    await expect
      .poll(() => document.activeElement?.getAttribute("data-sliding-tab-id"))
      .toBe("checks");
  });
});

describe("PullRequestListPane rows", () => {
  it("shows reviewer rows' file count and offers checkout in a worktree", async () => {
    const screen = await renderPage({ width: 1280, selected: 703 });
    const row = rowButton(712);
    const files = fixtureChangeRequests.find((entry) => entry.number === 712)?.changedFiles;
    expect(files).toBeGreaterThan(0);
    expect(row.textContent).toContain(`${files} files`);
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    await expect
      .element(screen.getByRole("menuitem", { name: "Check out in worktree" }))
      .toBeVisible();
  });
});
