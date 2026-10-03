import "~/index.css";

import {
  EMPTY_REVIEW_DRAFT,
  selectReviewDraft,
} from "@ryco/client-runtime/state/pull-request-review";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import { usePullRequestReviewDraftStore } from "~/pullRequestReviewDraftStore";

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

/** The popover fed from the draft store, as the bar's Review button feeds it. */
function StoreBackedPopover(props: { readonly number: number }) {
  const draftKey = fixtureReviewDraftKey(props.number);
  const draft = usePullRequestReviewDraftStore((state) => selectReviewDraft(state, draftKey));
  return <ReviewSubmitPopover draftKey={draftKey} draft={draft} onClose={() => undefined} />;
}

async function renderVerdicts(number: number) {
  vi.setSystemTime(FIXTURE_NOW_MS);
  const screen = await render(
    <PullRequestsTestProvider selected={number} search={{ tab: "files" }} width={1192}>
      <StoreBackedPopover number={number} />
    </PullRequestsTestProvider>,
  );
  const verdict = (name: string) =>
    screen.getByRole("radiogroup", { name: "Verdict" }).getByRole("radio", { name });
  await expect.element(verdict("Comment")).toBeVisible();
  return { screen, verdict };
}

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

describe("ReviewSubmitPopover verdict", () => {
  it("is one Tab stop that the arrows, Home and End move and select", async () => {
    // #712: the viewer reviews it, so every verdict is open to them.
    const { screen, verdict } = await renderVerdicts(712);
    const storedEvent = () =>
      selectReviewDraft(usePullRequestReviewDraftStore.getState(), fixtureReviewDraftKey(712))
        .event;
    await expect.element(verdict("Comment")).toHaveAttribute("aria-checked", "true");

    (screen.getByRole("textbox", { name: "Review summary" }).element() as HTMLElement).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(verdict("Comment").element());

    await userEvent.keyboard("{ArrowRight}");
    await expect.element(verdict("Approve")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(verdict("Approve").element());
    expect(storedEvent()).toBe("approve");

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(verdict("Request changes")).toHaveAttribute("aria-checked", "true");
    expect(storedEvent()).toBe("request_changes");

    // Wraps around, both ways.
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(verdict("Comment")).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(verdict("Request changes")).toHaveAttribute("aria-checked", "true");

    await userEvent.keyboard("{Home}");
    await expect.element(verdict("Comment")).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{End}");
    await expect.element(verdict("Request changes")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(verdict("Request changes").element());

    // Only the checked verdict is in the Tab order.
    expect(
      screen
        .getByRole("radio")
        .elements()
        .map((radio) => radio.getAttribute("tabindex")),
    ).toEqual(["-1", "-1", "0"]);
  });

  it("keeps the author on Comment: the verdicts they cannot give are skipped", async () => {
    // #703 is the viewer's own pull request.
    const { screen, verdict } = await renderVerdicts(703);
    await expect.element(verdict("Approve")).toBeDisabled();
    await expect.element(verdict("Request changes")).toBeDisabled();

    (verdict("Comment").element() as HTMLElement).focus();
    for (const key of ["{ArrowRight}", "{ArrowLeft}", "{End}", "{Home}"]) {
      await userEvent.keyboard(key);
      expect(document.activeElement).toBe(verdict("Comment").element());
    }
    await expect.element(verdict("Comment")).toHaveAttribute("aria-checked", "true");
    expect(
      selectReviewDraft(usePullRequestReviewDraftStore.getState(), fixtureReviewDraftKey(703))
        .event,
    ).toBeNull();
    expect(
      screen
        .getByRole("radio")
        .elements()
        .filter((radio) => radio.tabIndex === 0),
    ).toEqual([verdict("Comment").element()]);
  });
});
