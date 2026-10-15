import "../../index.css";
import "./pullRequests.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ chunksFail: true }));

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

// Code-split chunks fail to load (offline, or a deploy replaced them) until the
// test lets them through; the loaders themselves are the app's own.
vi.mock("../../lib/preloadableLazy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/preloadableLazy")>();
  return {
    ...actual,
    preloadableLazy: <P extends object>(load: () => Promise<React.ComponentType<P>>) =>
      actual.preloadableLazy(() =>
        harness.chunksFail
          ? Promise.reject(new Error("Failed to fetch dynamically imported module"))
          : load(),
      ),
  };
});

// The diff renderer itself is not under test.
vi.mock("./files/FilesTab", () => ({
  FilesTab: function StubFilesTab() {
    return <p>Changed files</p>;
  },
}));

import { PullRequestsPageBody } from "./PullRequestsPageBody";
import {
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  resetPullRequestsTestState,
} from "./testing/PullRequestsTestProvider";

afterEach(() => resetPullRequestsTestState());

describe("PullRequestReader — Files tab load failure", () => {
  it("keeps the page and offers a retry inside the tab when its chunk fails to load", async () => {
    vi.setSystemTime(FIXTURE_NOW_MS);
    await page.viewport(1_180, 800);
    const screen = await render(
      <PullRequestsTestProvider
        selected={703}
        search={{ tab: "files" }}
        width={1_180}
        height={800}
        className="flex-row"
      >
        <PullRequestsPageBody />
      </PullRequestsTestProvider>,
    );

    const alert = screen.getByRole("alert").filter({ hasText: /changed files/u });
    await expect.element(alert).toBeVisible();
    // The rest of the reader is still there: the failure stayed in the tab.
    await expect.element(screen.getByRole("tab", { name: /Commits/u })).toBeVisible();

    harness.chunksFail = false;
    await screen.getByRole("button", { name: "Retry" }).click();

    await expect.element(screen.getByText("Changed files", { exact: true })).toBeVisible();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
