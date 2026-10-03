import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});
vi.mock("~/components/projectExplorer/usePullRequestFilesViewed", async () => {
  const { createPullRequestFilesViewedMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createPullRequestFilesViewedMock();
});

import type { SourceControlProviderKind } from "@ryco/contracts";
import type { ChangeRequestHostCapabilities } from "@ryco/shared/sourceControl";

import { FilesTab } from "./files/FilesTab";
import { usePullRequestFilesUiStore } from "./files/pullRequestFilesStore";
import { PullRequestsPageBody } from "./PullRequestsPageBody";
import type { PullRequestsSearch } from "./pullRequestsSearch";
import {
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  resetPullRequestsTestState,
  sourceControlRpcMock,
  type SourceControlRpcReadHook,
} from "./testing/PullRequestsTestProvider";
import { READ_ONLY_HOST_CAPABILITIES } from "./testing/readOnlyHost";

/*
 * The page on hosts other than GitHub, with each host's real capability matrix
 * entry (`@ryco/shared/sourceControl`): controls a host does not implement are
 * hidden, and reads it cannot serve are never made.
 */

afterEach(async () => {
  // Unmount first: panes write their scroll offsets and menus their state on unmount.
  await cleanup();
  resetPullRequestsTestState();
  usePullRequestFilesUiStore.getState().reset();
  document.body.innerHTML = "";
});

async function renderPage(input: {
  readonly host: SourceControlProviderKind;
  readonly search?: Partial<PullRequestsSearch>;
  readonly capabilities?: Partial<ChangeRequestHostCapabilities>;
  readonly width?: number;
}) {
  const width = input.width ?? 1280;
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(width, 860);
  return render(
    <PullRequestsTestProvider
      host={input.host}
      capabilities={input.capabilities}
      selected={703}
      search={input.search}
      width={width}
      height={860}
      className="flex-row"
    >
      <PullRequestsPageBody />
    </PullRequestsTestProvider>,
  );
}

/** Reads a component asked for with `enabled` not set to false. */
function enabledReads(hook: SourceControlRpcReadHook): ReadonlyArray<unknown> {
  return sourceControlRpcMock.queries.filter(
    (query) =>
      query.hook === hook && (query.input as { readonly enabled?: boolean }).enabled !== false,
  );
}

// GitLab terminology on a host that implements only reads, checkout and create.
const READ_ONLY = { host: "gitlab", capabilities: READ_ONLY_HOST_CAPABILITIES } as const;

describe("a GitLab merge request", () => {
  it("offers review, comments and the merge section from GitLab's entry", async () => {
    const screen = await renderPage({ host: "gitlab" });
    await expect.element(screen.getByRole("button", { name: /^Review/u })).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "Comment" })).toBeVisible();
    expect(document.querySelector('[aria-label="Merge status"]')).not.toBeNull();
  });
});

/** The list rows' text (title, readiness label, meta), never the reader's. */
function rowTexts(): ReadonlyArray<string> {
  return [...document.querySelectorAll<HTMLElement>("[data-pr-row]")].map(
    (row) => row.textContent ?? "",
  );
}

describe("hosts whose list rows carry less than the detail", () => {
  it("merges a Bitbucket pull request from its detail while rows state only open", async () => {
    const screen = await renderPage({ host: "bitbucket" });
    // The detail reports readiness, so the merge section (and merge) is offered.
    await expect.element(screen.getByRole("region", { name: "Merge status" })).toBeVisible();
    await expect.poll(() => rowTexts().length).toBeGreaterThan(0);
    // Rows carry no readiness: no "Ready to merge" (or any other verdict).
    expect(rowTexts().some((text) => text.includes("Ready to merge"))).toBe(false);
  });

  it("never labels an Azure DevOps row ready to merge", async () => {
    const screen = await renderPage({ host: "azure-devops" });
    await expect.element(screen.getByRole("region", { name: "Merge status" })).toBeVisible();
    await expect.poll(() => rowTexts().length).toBeGreaterThan(0);
    // Without branch policies on rows, a conflict-free row reads "Open"; a known
    // blocker (a conflict) still shows.
    expect(rowTexts().some((text) => text.includes("Ready to merge"))).toBe(false);
    expect(rowTexts().some((text) => text.includes("Open"))).toBe(true);
  });
});

describe("a read-only host", () => {
  it("shows the conversation without review, merge or lifecycle controls", async () => {
    const screen = await renderPage(READ_ONLY);
    // The detail's comments stand in for the activity timeline.
    await expect
      .element(screen.getByText("Tried this against the sandbox repo", { exact: false }))
      .toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Open on GitLab" })).toBeVisible();
    // No review, no comment composer, no guessed merge verdict.
    expect(screen.getByRole("button", { name: /^Review/u }).query()).toBeNull();
    expect(screen.getByRole("textbox", { name: "Comment" }).query()).toBeNull();
    expect(document.querySelector('[aria-label="Merge status"]')).toBeNull();
    // Rows state only what the host reports: open, not "Ready to merge".
    expect(document.body.textContent).not.toContain("Ready to merge");
    // Checkout works on GitLab, so agent hand-offs are offered.
    await expect.element(screen.getByRole("button", { name: "Ask an agent" })).toBeVisible();
  });

  it("offers no title edit, draft toggle or close in the overflow menu", async () => {
    const screen = await renderPage(READ_ONLY);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await expect
      .element(page.getByRole("menuitem", { name: "Check out in a worktree" }))
      .toBeVisible();
    for (const name of ["Edit title", "Convert to draft", "Close pull request"]) {
      expect(page.getByRole("menuitem", { name }).query()).toBeNull();
    }
  });

  it("sends Files to the host instead of reading a diff it cannot produce", async () => {
    const screen = await renderPage({ ...READ_ONLY, search: { tab: "files" } });
    await expect.element(screen.getByText("Diff not available here")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Open on GitLab" }).first())
      .toBeVisible();
    // No diff tools in the bar, and no diff or viewed reads.
    expect(screen.getByRole("button", { name: "Showing all commits" }).query()).toBeNull();
    expect(screen.getByRole("radio", { name: "Unified diff" }).query()).toBeNull();
    expect(enabledReads("useSourceControlChangeRequestDiff")).toEqual([]);
  });

  it("says Checks are not readable rather than that none ran", async () => {
    const screen = await renderPage({ ...READ_ONLY, search: { tab: "checks" } });
    await expect.element(screen.getByText("Ryco can't read checks from GitLab yet.")).toBeVisible();
    expect(enabledReads("useSourceControlWorkflowRuns")).toEqual([]);
  });

  it("leaves involvement and check filters out of the filter menu", async () => {
    const screen = await renderPage(READ_ONLY);
    await userEvent.click(screen.getByRole("button", { name: "Filter pull requests" }));
    await expect
      .element(page.getByRole("menuitemradio", { name: "Open", exact: true }))
      .toBeVisible();
    for (const name of ["Review requested", "Yours", "Failing checks"]) {
      expect(page.getByRole("menuitemradio", { name }).query()).toBeNull();
    }
  });
});

describe("a Bitbucket pull request (diff, no review)", () => {
  it("renders the diff without viewed marks, commit scope or the review button", async () => {
    vi.setSystemTime(FIXTURE_NOW_MS);
    await page.viewport(1192, 860);
    await render(
      <PullRequestsTestProvider
        host="bitbucket"
        selected={703}
        search={{ tab: "files" }}
        width={1192}
        height={860}
      >
        <FilesTab />
      </PullRequestsTestProvider>,
    );
    await expect
      .poll(() => document.querySelectorAll("[data-diff-file-path]").length)
      .toBeGreaterThan(0);
    // No viewed checkboxes in the file headers or the tree.
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    expect(enabledReads("useSourceControlChangeRequestDiff").length).toBeGreaterThan(0);
  });
});

describe("a host Ryco cannot check out", () => {
  it("hides every agent hand-off and the worktree checkout", async () => {
    const screen = await renderPage({ host: "unknown" });
    await expect.element(screen.getByRole("button", { name: "More actions" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Ask an agent" }).query()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await expect.element(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Check out in a worktree" }).query()).toBeNull();
  });
});

describe("single capabilities on GitHub", () => {
  it("offers reactions where the host takes them", async () => {
    await renderPage({ host: "github" });
    await expect
      .poll(() => document.querySelectorAll('[aria-label="Add reaction"]').length)
      .toBeGreaterThan(0);
  });

  it("drops reactions (and nothing else) when the host does not take them", async () => {
    await renderPage({ host: "github", capabilities: { reactions: false } });
    // The rest of the conversation stays: the composer and the merge box.
    await expect.element(page.getByRole("textbox", { name: "Comment" })).toBeInTheDocument();
    await expect.element(page.getByRole("region", { name: "Merge status" })).toBeVisible();
    expect(document.querySelectorAll('[aria-label="Add reaction"]')).toHaveLength(0);
  });
});
