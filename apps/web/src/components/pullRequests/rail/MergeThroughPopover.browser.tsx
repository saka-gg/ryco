import "~/index.css";

import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import {
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  pullRequestFixtureStore,
  resetPullRequestsTestState,
  sourceControlRpcMock,
} from "../testing/PullRequestsTestProvider";
import { MergeThroughPopover } from "./MergeThroughPopover";
import { usePullRequestRailStore } from "./railStore";

afterEach(async () => {
  await cleanup();
  resetPullRequestsTestState();
  pullRequestFixtureStore.reset();
  window.localStorage.removeItem("ryco:pull-requests-merge-method:v1");
  usePullRequestRailStore.setState({ mergeMethod: {}, deleteBranch: {} });
  document.body.innerHTML = "";
});

function Harness() {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div className="flex justify-end p-6">
      <div ref={anchor}>anchor</div>
      <MergeThroughPopover
        open
        onOpenChange={() => undefined}
        anchor={anchor}
        initialThrough={null}
      />
    </div>
  );
}

/**
 * Stack #14 with #702 and #703 cleared to land, so three layers can be picked
 * (#701–#703) and the draft #704 on top cannot.
 */
async function renderPicker() {
  vi.setSystemTime(FIXTURE_NOW_MS);
  pullRequestFixtureStore.updateDetail(703, (detail) =>
    detail.stack
      ? {
          ...detail,
          stack: {
            ...detail.stack,
            entries: detail.stack.entries.map((entry) =>
              entry.number === 702 || entry.number === 703
                ? Object.assign({}, entry, { mergeStateStatus: "clean" as const })
                : entry,
            ),
          },
        }
      : detail,
  );
  await render(
    <PullRequestsTestProvider selected={703} width={1100} height={800}>
      <Harness />
    </PullRequestsTestProvider>,
  );
  const layers = page.getByRole("radiogroup", { name: "Merge through" });
  const layer = (number: number) => layers.getByRole("radio", { name: `Merge through #${number}` });
  const methods = page.getByRole("radiogroup", { name: "Merge method" });
  const method = (name: string) => methods.getByRole("radio", { name });
  await expect.element(layer(703)).toBeVisible();
  return { layers, layer, methods, method };
}

/** Radios of a group that are in the Tab order. */
function tabStops(group: { element(): Element }): Element[] {
  return Array.from(group.element().querySelectorAll<HTMLElement>('[role="radio"]')).filter(
    (radio) => radio.tabIndex === 0,
  );
}

describe("merge-through layers", () => {
  it("is one Tab stop on the picked layer; arrows, Home and End move and pick, past the draft", async () => {
    const { layers, layer } = await renderPicker();
    // Opens on the selected pull request, the highest layer that can land.
    await expect.element(layer(703)).toHaveAttribute("aria-checked", "true");
    await expect.element(layer(704)).toBeDisabled();
    expect(tabStops(layers)).toEqual([layer(703).element()]);

    (layer(703).element() as HTMLElement).focus();
    // Rows run top-down: ↓ goes to the layer beneath.
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(layer(702)).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(layer(702).element());
    await expect.element(page.getByRole("button", { name: "Merge 2 pull requests" })).toBeVisible();

    await userEvent.keyboard("{ArrowRight}");
    await expect.element(layer(701)).toHaveAttribute("aria-checked", "true");
    // Wrapping past the bottom skips the draft #704 on top.
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(layer(703)).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(layer(703).element());
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(layer(701)).toHaveAttribute("aria-checked", "true");

    await userEvent.keyboard("{Home}");
    await expect.element(layer(703)).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{End}");
    await expect.element(layer(701)).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(layer(701).element());
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(layer(702)).toHaveAttribute("aria-checked", "true");
    expect(tabStops(layers)).toEqual([layer(702).element()]);
  });

  it("still picks a layer by clicking its row", async () => {
    const { layer } = await renderPicker();
    await userEvent.click(page.getByText("#701", { exact: true }));
    await expect.element(layer(701)).toHaveAttribute("aria-checked", "true");
    await userEvent.click(page.getByRole("button", { name: "Merge 1 pull request" }));
    await vi.waitFor(() =>
      expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")).toEqual([
        expect.objectContaining({ target: expect.objectContaining({ reference: "701" }) }),
      ]),
    );
  });
});

describe("merge method", () => {
  it("is one Tab stop after the layers; arrows skip the method the repository disallows", async () => {
    // The fixture repository allows squash and rebase, not merge commits.
    const { layer, methods, method } = await renderPicker();
    await expect.element(method("Squash")).toHaveAttribute("aria-checked", "true");
    await expect.element(method("Merge commit")).toBeDisabled();
    expect(tabStops(methods)).toEqual([method("Squash").element()]);

    (layer(703).element() as HTMLElement).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(method("Squash").element());

    await userEvent.keyboard("{ArrowRight}");
    await expect.element(method("Rebase")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(method("Rebase").element());
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(method("Squash")).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(method("Rebase")).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Home}");
    await expect.element(method("Squash")).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{End}");
    await expect.element(method("Rebase")).toHaveAttribute("aria-checked", "true");

    await userEvent.click(page.getByRole("button", { name: "Merge 3 pull requests" }));
    await vi.waitFor(() =>
      expect(sourceControlRpcMock.callsTo("useMergeChangeRequestMutation")).toEqual([
        expect.objectContaining({ args: expect.objectContaining({ mergeMethod: "rebase" }) }),
      ]),
    );
  });
});
