import "~/index.css";

import { EMPTY_REVIEW_DRAFT } from "@ryco/client-runtime/state/pull-request-review";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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
  fixtureReviewDraftKey,
  pullRequestFixtureStore,
  resetPullRequestsTestState,
  sourceControlRpcMock,
} from "../testing/PullRequestsTestProvider";
import { ReviewSubmitPopover } from "./ReviewSubmitPopover";

afterEach(() => {
  resetPullRequestsTestState();
  document.body.innerHTML = "";
});

describe("ReviewSubmitPopover", () => {
  it("submits a review the viewer started on GitHub, with no local comments or summary", async () => {
    vi.setSystemTime(FIXTURE_NOW_MS);
    // #712: the viewer reviews it and has one pending comment on GitHub.
    expect(pullRequestFixtureStore.activity(712)?.pendingReview?.commentsCount).toBe(1);
    const onClose = vi.fn();
    await render(
      <PullRequestsTestProvider selected={712} search={{ tab: "files" }} width={1192}>
        <ReviewSubmitPopover
          draftKey={fixtureReviewDraftKey(712)}
          draft={EMPTY_REVIEW_DRAFT}
          onClose={onClose}
        />
      </PullRequestsTestProvider>,
    );
    await expect
      .element(page.getByText("Also submits 1 comment from the review you started on GitHub."))
      .toBeVisible();

    await page.getByRole("button", { name: /Submit review/u }).click();

    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(sourceControlRpcMock.callsTo("useSubmitChangeRequestReviewMutation")[0]?.args).toEqual({
      event: "comment",
      comments: [],
      expectedHeadSha: pullRequestFixtureStore.detail(712)?.headSha,
    });
  });
});
