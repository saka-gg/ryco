import "../../../index.css";

import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import {
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  fixtureDetail,
  pullRequestsTestNavLog,
  resetPullRequestsTestState,
} from "../testing/PullRequestsTestProvider";
import { CommitsTab } from "./CommitsTab";

afterEach(() => {
  resetPullRequestsTestState();
});

it("lists commits by day, newest first, with the force-push in place", async () => {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(900, 860);
  const screen = await render(
    <PullRequestsTestProvider selected={703} search={{ tab: "commits" }} width={900}>
      <CommitsTab />
    </PullRequestsTestProvider>,
  );
  const head = fixtureDetail(703).headSha!;
  await expect.element(screen.getByRole("heading", { name: "Today" })).toBeVisible();
  const rows = [...document.querySelectorAll<HTMLElement>("[data-commit-oid]")];
  expect(rows).toHaveLength(8);
  expect(rows[0]?.dataset.commitOid).toBe(head);
  // The head's glyph is the live rollup (failing), not the timeline's snapshot.
  await expect.element(screen.getByRole("img", { name: "Checks failing" })).toBeInTheDocument();
  await expect.element(screen.getByText(/force-pushed/u)).toBeVisible();

  // A row scopes Files to its commit.
  await screen.getByRole("button", { name: /client-runtime: depend on @ryco\/shared/u }).click();
  expect(pullRequestsTestNavLog.callsTo("scopeToCommit").map((call) => call.args)).toEqual([
    [head],
  ]);
});
