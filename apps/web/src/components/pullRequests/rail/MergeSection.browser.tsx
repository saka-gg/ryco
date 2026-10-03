import "~/index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import { MergeSection } from "~/components/pullRequests/rail/MergeSection";
import {
  FIXTURE_703_FAILING_JOB,
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  pullRequestsTestNavLog,
  resetPullRequestsTestState,
} from "~/components/pullRequests/testing/PullRequestsTestProvider";
import {
  fixtureRequiredDetail,
  type FixtureRequiredChecks,
} from "~/components/pullRequests/testing/requiredCheckFixtures";

beforeEach(async () => {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(1100, 800);
});

afterEach(() => {
  resetPullRequestsTestState();
});

/** #703 as a host that marks required checks reports it. */
function renderMerge(input: FixtureRequiredChecks) {
  return render(
    <PullRequestsTestProvider
      selected={703}
      width={1100}
      height={800}
      detailState={{ data: fixtureRequiredDetail(703, input) }}
    >
      <div className="w-72 p-6">
        <MergeSection layout="rail" />
      </div>
    </PullRequestsTestProvider>,
  );
}

describe("merge section checks line", () => {
  it("names the required failure and says it is required", async () => {
    const screen = await renderMerge({ required: ["Typecheck"], failing: ["Typecheck"] });
    const line = screen.getByRole("button", { name: /^Typecheck\s*,\s*Required$/u });
    await expect.element(line).toBeVisible();
    await userEvent.click(line);
    const revealed = pullRequestsTestNavLog.callsTo("revealJob").at(-1)?.args[0];
    expect(revealed).toBeTypeOf("string");
    expect(revealed).not.toBe(FIXTURE_703_FAILING_JOB.jobId);
  });

  it("reads a failure no rule requires as optional", async () => {
    // GitHub reports only optional failures as `unstable` (mergeable).
    const screen = await renderMerge({ required: ["Typecheck"], mergeStateStatus: "unstable" });
    await expect
      .element(screen.getByRole("button", { name: /^Test · web\s*,\s*Optional$/u }))
      .toBeVisible();
  });

  it("does not call a failure optional while the host blocks the merge", async () => {
    // A required check the host still expects is absent from the rollup.
    const screen = await renderMerge({ required: ["Typecheck"], mergeStateStatus: "blocked" });
    await expect.element(screen.getByRole("button", { name: /^Test · web$/u })).toBeVisible();
  });
});
