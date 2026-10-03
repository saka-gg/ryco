import "../../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import { Sheet, SheetPopup } from "../../ui/sheet";
import {
  PULL_REQUESTS_LIST_MAX_WIDTH,
  PULL_REQUESTS_LIST_MIN_WIDTH,
  usePullRequestsLayoutStore,
} from "../pullRequestsLayoutStore";
import type { PullRequestsSearch } from "../pullRequestsSearch";
import {
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  pullRequestsTestNavLog,
  resetPullRequestsTestState,
} from "../testing/PullRequestsTestProvider";
import { READ_ONLY_HOST_CAPABILITIES } from "../testing/readOnlyHost";
import { ListResizeHandle, PullRequestListPane } from "./PullRequestListPane";

afterEach(() => resetPullRequestsTestState());

function rowButton(number: number): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-pr-row-button="${number}"]`);
  if (!button) throw new Error(`row #${number} is not rendered`);
  return button;
}

function selectedRows(): number[] {
  return [...document.querySelectorAll('[data-pr-row-button][aria-current="true"]')].map((button) =>
    Number(button.getAttribute("data-pr-row-button")),
  );
}

function plate() {
  const element = document.querySelector<HTMLElement>(".pr-list-plate");
  if (!element) throw new Error("no selection plate");
  return element;
}

async function renderDocked(input: {
  readonly selected?: number;
  readonly search?: Partial<PullRequestsSearch>;
  readonly height?: number;
  readonly onSearchChange?: (search: PullRequestsSearch) => void;
}) {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(1100, input.height ?? 860);
  return render(
    <PullRequestsTestProvider
      selected={input.selected}
      search={input.search}
      width={1100}
      height={input.height ?? 860}
      onSearchChange={input.onSearchChange}
      className="flex-row"
    >
      <aside className="flex min-h-0 w-[304px] shrink-0 flex-col border-r">
        <PullRequestListPane variant="docked" />
      </aside>
      <ListResizeHandle />
    </PullRequestsTestProvider>,
  );
}

describe("PullRequestListPane", () => {
  it("groups rows, keeps stacks together and ends them in a foot", async () => {
    const screen = await renderDocked({ selected: 703 });
    await expect
      .element(screen.getByRole("button", { name: /^Needs your review/u }))
      .toHaveAttribute("aria-expanded", "true");
    // Stack #14 reads top layer first, each layer marking its spine edge.
    const edges = [704, 703, 702, 701].map((number) => rowButton(number).dataset.stackEdge);
    expect(edges).toEqual(["top", "mid", "mid", "bottom"]);
    await expect.element(screen.getByText("#701 can land")).toBeVisible();
    // Review requests show who and how big, never the readiness label.
    await expect.element(screen.getByText("anouk-d")).toBeVisible();
  });

  it("selects on click and glides one plate to the selected row", async () => {
    const screen = await renderDocked({ selected: 703 });
    expect(selectedRows()).toEqual([703]);
    await expect.poll(() => plate().dataset.visible).toBe("true");
    await screen.getByRole("button", { name: /, #701,/u }).click();
    expect(pullRequestsTestNavLog.callsTo("selectPullRequest").at(-1)?.args).toEqual([
      701,
      { push: true, via: "list" },
    ]);
    expect(selectedRows()).toEqual([701]);
    const row = rowButton(701).closest<HTMLElement>("[data-pr-row]")!;
    expect(plate().style.transform).toBe(`translateY(${row.offsetTop}px)`);
    expect(plate().style.height).toBe(`${row.offsetHeight}px`);
  });

  it("folds a group, persists it, and J/K skip its rows", async () => {
    const screen = await renderDocked({});
    const header = screen.getByRole("button", { name: /^Needs your review/u });
    await header.click();
    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    expect(usePullRequestsLayoutStore.getState().foldedGroups).toEqual(["needs-your-review"]);
    expect(rowButton(712).closest("[inert]")).not.toBeNull();
    await userEvent.keyboard("j");
    // The first visible row is the first of "Yours".
    expect(selectedRows()).toEqual([697]);
    await header.click();
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    expect(usePullRequestsLayoutStore.getState().foldedGroups).toEqual([]);
  });

  it("keeps the selected row in view as J/K move through the list", async () => {
    await renderDocked({ selected: 698, height: 360 });
    const scroller = rowButton(698).closest<HTMLElement>(".overflow-y-auto")!;
    expect(scroller.scrollTop).toBe(0);
    for (let step = 0; step < 12; step += 1) await userEvent.keyboard("j");
    const selected = selectedRows()[0]!;
    const row = rowButton(selected).getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(row.top).toBeGreaterThanOrEqual(view.top);
    expect(row.bottom).toBeLessThanOrEqual(view.bottom);
  });

  it("shows active filters as removable chips only while they are set", async () => {
    const screen = await renderDocked({ search: { only: "failing", label: ["area:web"] } });
    const chips = screen.getByRole("group", { name: "Active filters" });
    await expect.element(chips.getByText("Failing checks")).toBeVisible();
    await expect.element(chips.getByText("area:web")).toBeVisible();
    await screen.getByRole("button", { name: "Remove filter: Failing checks" }).click();
    expect(pullRequestsTestNavLog.callsTo("setSearch").at(-1)?.args[0]).toEqual({
      only: undefined,
    });
    await expect
      .element(screen.getByRole("button", { name: "Remove filter: area:web" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Remove filter: area:web" }).click();
    // With every filter back at its default the chip row folds away (and goes inert).
    await expect
      .poll(() => document.querySelector('[aria-label="Active filters"]')?.closest("[inert]"))
      .not.toBeNull();

    // Picking a filter from the menu brings the chip back.
    await screen.getByRole("button", { name: "Filter pull requests" }).click();
    await screen.getByRole("menuitemradio", { name: "Merged" }).click();
    await expect.element(chips.getByText("Merged")).toBeVisible();
  });

  it("opens #123 or a pasted link from the search field", async () => {
    const screen = await renderDocked({});
    const input = screen.getByRole("textbox", { name: "Search pull requests" });
    await input.fill("#701");
    await userEvent.keyboard("{Enter}");
    expect(pullRequestsTestNavLog.callsTo("selectPullRequest").at(-1)?.args).toEqual([
      701,
      { push: true, via: "link" },
    ]);
    await expect.element(input).toHaveValue("");
  });

  it("filters locally, opens the first match on Enter, and falls back to the host", async () => {
    const screen = await renderDocked({});
    const input = screen.getByRole("textbox", { name: "Search pull requests" });
    await input.fill("stack");
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => pullRequestsTestNavLog.callsTo("selectPullRequest").at(-1)?.args[0])
      .toBe(704);
    expect(document.querySelector('[data-pr-row-button="697"]')).toBeNull();

    // Nothing loaded matches: the host's search answers instead.
    await input.fill("framer");
    await expect.element(screen.getByText("Found on GitHub")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /, #683,/u })).toBeVisible();
  });

  it("focuses search on /", async () => {
    const screen = await renderDocked({ selected: 703 });
    await userEvent.keyboard("/");
    await expect
      .element(screen.getByRole("textbox", { name: "Search pull requests" }))
      .toHaveFocus();
  });

  it("resizes from the keyboard within the list's bounds", async () => {
    const screen = await renderDocked({});
    const handle = screen.getByRole("separator", { name: "Resize pull request list" });
    await expect.element(handle).toHaveAttribute("aria-valuenow", "304");
    (handle.element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "320");
    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "272");
    await userEvent.keyboard("{Home}");
    await expect
      .element(handle)
      .toHaveAttribute("aria-valuenow", String(PULL_REQUESTS_LIST_MIN_WIDTH));
    await userEvent.keyboard("{ArrowLeft}");
    expect(usePullRequestsLayoutStore.getState().listWidth).toBe(PULL_REQUESTS_LIST_MIN_WIDTH);
    await userEvent.keyboard("{End}");
    expect(usePullRequestsLayoutStore.getState().listWidth).toBe(PULL_REQUESTS_LIST_MAX_WIDTH);
  });

  it("moves with J/K and the arrows inside the drawer, and opens on Enter", async () => {
    vi.setSystemTime(FIXTURE_NOW_MS);
    await page.viewport(680, 860);
    const screen = await render(
      <PullRequestsTestProvider selected={703} width={680} height={860}>
        <Sheet open>
          <SheetPopup side="left" showCloseButton={false} className="w-[22rem] max-w-none p-0">
            <PullRequestListPane variant="drawer" />
          </SheetPopup>
        </Sheet>
      </PullRequestsTestProvider>,
    );
    await expect.poll(() => document.activeElement).toBe(rowButton(703));
    await userEvent.keyboard("j");
    await expect.poll(() => document.activeElement).toBe(rowButton(702));
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => document.activeElement).toBe(rowButton(701));
    await userEvent.keyboard("k");
    await expect.poll(() => document.activeElement).toBe(rowButton(702));
    // Moving focus does not select; Enter does.
    expect(selectedRows()).toEqual([703]);
    await userEvent.keyboard("{Enter}");
    expect(pullRequestsTestNavLog.callsTo("selectPullRequest").at(-1)?.args).toEqual([
      702,
      { push: true, via: "list" },
    ]);
    void screen;
  });

  it("shows one flat list when the host cannot tell involvement apart", async () => {
    vi.setSystemTime(FIXTURE_NOW_MS);
    await page.viewport(400, 600);
    const screen = await render(
      <PullRequestsTestProvider
        host="gitlab"
        capabilities={READ_ONLY_HOST_CAPABILITIES}
        width={320}
        height={600}
      >
        <PullRequestListPane variant="docked" />
      </PullRequestsTestProvider>,
    );
    await expect.element(screen.getByRole("button", { name: /, #712,/u })).toBeVisible();
    // No group headers to fold.
    expect(screen.getByRole("button", { name: /^Others/u }).query()).toBeNull();
  });
});
