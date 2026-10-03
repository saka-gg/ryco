import "~/index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import { resetAppearancePreference } from "~/themes/appearancePreferences";

import {
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  resetPullRequestsTestState,
} from "../testing/PullRequestsTestProvider";
import { FilesBarTools } from "./FilesBarTools";
import { usePullRequestFilesUiStore } from "./pullRequestFilesStore";

afterEach(async () => {
  await cleanup();
  resetPullRequestsTestState();
  usePullRequestFilesUiStore.getState().reset();
  resetAppearancePreference("diffLayout");
  document.body.innerHTML = "";
});

async function renderTools() {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(1400, 600);
  return render(
    <PullRequestsTestProvider selected={703} search={{ tab: "files" }} width={1400} height={600}>
      <div className="flex h-[52px] items-center justify-end px-3">
        <FilesBarTools />
      </div>
    </PullRequestsTestProvider>,
  );
}

describe("diff layout radio group", () => {
  it("is one Tab stop on the checked layout", async () => {
    const screen = await renderTools();
    const unified = screen.getByRole("radio", { name: "Unified diff" });
    const split = screen.getByRole("radio", { name: "Split diff" });
    await expect.element(unified).toHaveAttribute("aria-checked", "true");
    await expect.element(split).toHaveAttribute("aria-checked", "false");

    (screen.getByRole("button", { name: "Showing all commits" }).element() as HTMLElement).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(unified.element());
    // Tab leaves the group rather than visiting the unchecked layout.
    await userEvent.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "File tree" }).element(),
    );
  });

  it("moves and selects with the arrows, Home and End", async () => {
    const screen = await renderTools();
    const unified = screen.getByRole("radio", { name: "Unified diff" });
    const split = screen.getByRole("radio", { name: "Split diff" });
    (unified.element() as HTMLElement).focus();

    await userEvent.keyboard("{ArrowRight}");
    await expect.element(split).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(split.element());
    expect(split.element().getAttribute("tabindex")).toBe("0");
    expect(unified.element().getAttribute("tabindex")).toBe("-1");

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(unified).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(unified.element());

    await userEvent.keyboard("{ArrowUp}");
    await expect.element(split).toHaveAttribute("aria-checked", "true");

    await userEvent.keyboard("{Home}");
    await expect.element(unified).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(unified.element());

    await userEvent.keyboard("{End}");
    await expect.element(split).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(split.element());

    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(unified).toHaveAttribute("aria-checked", "true");
  });
});
