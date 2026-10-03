import "~/index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import { PullRequestReader } from "../PullRequestReader";
import { pullRequestReaderKey, usePullRequestReaderStore } from "../pullRequestsLayoutStore";
import {
  FIXTURE_703_THREADS,
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  fixtureActivity,
  fixtureDetail,
  fixtureRepositoryOption,
  pullRequestFixtureStore,
  pullRequestsTestNavLog,
  resetPullRequestsTestState,
  sourceControlRpcMock,
  type BuildTestPullRequestsModelInput,
} from "../testing/PullRequestsTestProvider";
import { ConversationTab } from "./ConversationTab";
import { DESCRIPTION_CHANGED_MESSAGE } from "./descriptionTaskQueue";

afterEach(async () => {
  // Unmount first: the pane writes its scroll offset to the reader store on unmount.
  await cleanup();
  resetPullRequestsTestState();
  document.body.innerHTML = "";
});

const READER_KEY_703 = pullRequestReaderKey(fixtureRepositoryOption.key, 703);

async function renderConversation(
  options: BuildTestPullRequestsModelInput & { readonly width?: number } = {},
) {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(1280, 900);
  return render(
    <PullRequestsTestProvider
      selected={options.selected ?? 703}
      width={options.width ?? 887}
      height={860}
      search={options.search}
      supportsReview={options.supportsReview}
      detailState={options.detailState}
      activityState={options.activityState}
    >
      <ConversationTab />
    </PullRequestsTestProvider>,
  );
}

const BODY_703 = fixtureDetail(703)?.body ?? "";
const DRAFT_TASK = "Draft layers below the target block the merge (review feedback)";
const SCREENSHOT_TASK = "Screenshot pass in light and dark";

function editCalls(): ReadonlyArray<string | undefined> {
  return sourceControlRpcMock
    .callsTo("useUpdateChangeRequestMutation")
    .map((call) => (call.args as { body?: string }).body);
}

function scroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-pr-conversation]");
  if (!element) throw new Error("Conversation pane not rendered.");
  return element;
}

describe("ConversationTab", () => {
  it("renders the masthead, description and grouped timeline for #703", async () => {
    const screen = await renderConversation();
    await expect
      .element(
        screen.getByRole("heading", { name: "Web: stack layers rail and merge-through-layer" }),
      )
      .toBeVisible();
    await expect.element(screen.getByText("ryco/stack-3-web-rail")).toBeVisible();
    await expect
      .element(screen.getByText("Third layer of the stacked-PR work.", { exact: false }))
      .toBeVisible();

    // Commit runs collapse; minor events by one person merge into one line.
    await expect
      .element(screen.getByRole("button", { name: "pushed 4 commits" }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("assigned themselves", { exact: false }))
      .toBeInTheDocument();
    await expect.element(screen.getByText("force-pushed", { exact: false })).toBeInTheDocument();
    await expect.element(screen.getByText("requested changes")).toBeInTheDocument();
    await expect
      .element(screen.getByText("mentioned this in", { exact: false }))
      .toBeInTheDocument();

    // Every review thread sits under the review that opened it.
    const threads = document.querySelectorAll("[data-pr-thread]");
    expect(threads.length).toBe(fixtureActivity(703).reviewThreads.length);
    expect(document.querySelectorAll("[data-pr-thread][data-unresolved]").length).toBe(2);

    // The composer closes the timeline.
    await expect.element(screen.getByRole("textbox", { name: "Comment" })).toBeInTheDocument();
    // Rail layout at 887: the facts column is docked beside the content.
    expect(document.querySelector('aside[aria-label="Pull request facts"]')).not.toBeNull();
  });

  it("folds the facts rail into the band below 800px", async () => {
    await renderConversation({ width: 680 });
    expect(document.querySelector('aside[aria-label="Pull request facts"]')).toBeNull();
  });

  it("edits the title in place and saves it as an edit", async () => {
    const screen = await renderConversation();
    await screen.getByRole("button", { name: "Edit title" }).click();
    const input = screen.getByRole("textbox", { name: "Pull request title" });
    await expect.element(input).toHaveFocus();
    await userEvent.fill(input, "Web: stack rail with merge-through");
    await userEvent.keyboard("{Enter}");

    await expect
      .element(screen.getByRole("heading", { name: "Web: stack rail with merge-through" }))
      .toBeVisible();
    expect(
      sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation").map((call) => call.args),
    ).toEqual([{ kind: "edit", title: "Web: stack rail with merge-through" }]);
  });

  it("opens the title editor when the bar requests it, and Esc cancels", async () => {
    const screen = await renderConversation();
    usePullRequestReaderStore.getState().requestTitleEdit(READER_KEY_703);
    const input = screen.getByRole("textbox", { name: "Pull request title" });
    await expect.element(input).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(input).not.toBeInTheDocument();
    expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation")).toEqual([]);
  });

  it("opens a title edit requested off Conversation only once the tab shows, with focus", async () => {
    // The router commits tab switches in a transition, so the edit request
    // (a store bump) can land while Conversation is still hidden and inert.
    vi.setSystemTime(FIXTURE_NOW_MS);
    await page.viewport(1280, 900);
    const screen = await render(
      <PullRequestsTestProvider selected={703} width={1280} height={860}>
        <PullRequestReader />
      </PullRequestsTestProvider>,
    );
    await expect.element(screen.getByRole("button", { name: "Edit title" })).toBeInTheDocument();
    await userEvent.keyboard("4");
    await expect
      .element(screen.getByRole("tab", { name: /Commits/u }))
      .toHaveAttribute("aria-selected", "true");

    usePullRequestReaderStore.getState().requestTitleEdit(READER_KEY_703);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await userEvent.keyboard("1");

    const input = screen.getByRole("textbox", { name: "Pull request title" });
    await expect.element(input).toHaveFocus();
    // Typing goes to the title, not to the page shortcuts (`4` would switch tabs).
    await userEvent.keyboard("4");
    await expect
      .element(screen.getByRole("tab", { name: /Conversation/u }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("names the facts rail landmark once", async () => {
    await renderConversation();
    expect(document.querySelectorAll('[aria-label="Pull request facts"]')).toHaveLength(1);
  });

  it("toggles a description task by rewriting that task in the body", async () => {
    const screen = await renderConversation();
    const task = screen.getByRole("checkbox", { name: DRAFT_TASK });
    await expect.element(task).not.toBeChecked();
    await task.click();
    await expect.element(task).toBeChecked();
    await expect.poll(() => editCalls().length).toBe(1);
    const [body = ""] = editCalls();
    expect(body).toContain("- [x] Draft layers below the target block the merge");
    expect(body.replace("- [x] Draft layers", "- [ ] Draft layers")).toBe(BODY_703);
  });

  it("saves a task onto the current description, keeping a teammate's tick", async () => {
    // The page still shows the body it loaded; GitHub has a teammate's tick since.
    pullRequestFixtureStore.updateDetail(703, (detail) => ({
      ...detail,
      body: detail.body.replace("- [ ] Screenshot pass", "- [x] Screenshot pass"),
    }));
    const screen = await renderConversation({ detailState: { data: fixtureDetail(703) } });
    await expect.element(screen.getByRole("checkbox", { name: SCREENSHOT_TASK })).not.toBeChecked();
    await screen.getByRole("checkbox", { name: DRAFT_TASK }).click();

    await expect.poll(() => editCalls().length).toBe(1);
    expect(editCalls()[0]).toBe(
      BODY_703.replace("- [ ] Draft layers", "- [x] Draft layers").replace(
        "- [ ] Screenshot pass",
        "- [x] Screenshot pass",
      ),
    );
  });

  it("does not save a task over a description edited elsewhere since it loaded", async () => {
    pullRequestFixtureStore.updateDetail(703, (detail) => ({
      ...detail,
      body: `> Summary added by a bot.\n\n${detail.body}`,
    }));
    const screen = await renderConversation({ detailState: { data: fixtureDetail(703) } });
    const task = screen.getByRole("checkbox", { name: DRAFT_TASK });
    await task.click();

    await expect.element(screen.getByText(DESCRIPTION_CHANGED_MESSAGE)).toBeVisible();
    await expect.element(task).not.toBeChecked();
    expect(editCalls()).toEqual([]);
  });

  it("saves quick task toggles one at a time, each built on the last", async () => {
    const saves: Array<() => void> = [];
    sourceControlRpcMock.mutationOverrides.useUpdateChangeRequestMutation = ((action: {
      readonly body: string;
    }) =>
      new Promise<void>((resolve) => {
        saves.push(() => {
          pullRequestFixtureStore.updateDetail(703, (detail) => ({ ...detail, body: action.body }));
          resolve();
        });
      })) as never;
    const screen = await renderConversation();
    const draft = screen.getByRole("checkbox", { name: DRAFT_TASK });
    const screenshot = screen.getByRole("checkbox", { name: SCREENSHOT_TASK });

    await draft.click();
    await expect.poll(() => saves.length).toBe(1);
    await screenshot.click();
    // Both show at once; the second waits for the first save.
    await expect.element(draft).toBeChecked();
    await expect.element(screenshot).toBeChecked();
    expect(editCalls()).toHaveLength(1);

    saves[0]?.();
    await expect.poll(() => saves.length).toBe(2);
    await expect.element(screenshot).toBeChecked();
    const both = BODY_703.replace("- [ ] Draft layers", "- [x] Draft layers").replace(
      "- [ ] Screenshot pass",
      "- [x] Screenshot pass",
    );
    expect(editCalls()).toEqual([
      BODY_703.replace("- [ ] Draft layers", "- [x] Draft layers"),
      both,
    ]);
    saves[1]?.();
    await expect.poll(() => pullRequestFixtureStore.detail(703)?.body).toBe(both);
    await expect.element(draft).toBeChecked();
    await expect.element(screenshot).toBeChecked();
  });

  it("expands a commit run and scopes Files to the clicked commit", async () => {
    const screen = await renderConversation();
    const run = screen.getByRole("button", { name: "pushed 4 commits" });
    await expect.element(run).toHaveAttribute("aria-expanded", "false");
    await run.click();
    await expect.element(run).toHaveAttribute("aria-expanded", "true");

    const first = fixtureActivity(703).timeline.find((item) => item.kind === "commit");
    if (first?.kind !== "commit") throw new Error("#703 has no commits");
    await screen.getByTitle(`Show changes in ${first.shortOid}`).first().click();
    expect(pullRequestsTestNavLog.callsTo("scopeToCommit").map((call) => call.args)).toEqual([
      [first.oid],
    ]);
  });

  it("posts a comment from the composer", async () => {
    const screen = await renderConversation();
    const composer = screen.getByRole("textbox", { name: "Comment" });
    await userEvent.fill(composer, "Rebased onto the new base; CI should go green.");
    await screen.getByRole("button", { name: "Comment", exact: true }).click();

    await expect
      .element(screen.getByText("Rebased onto the new base; CI should go green."))
      .toBeVisible();
    await expect.element(composer).toHaveValue("");
    const calls = sourceControlRpcMock.callsTo("useAddChangeRequestCommentMutation");
    expect(calls.map((call) => (call.args as { body: string }).body)).toEqual([
      "Rebased onto the new base; CI should go green.",
    ]);
    expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation")).toEqual([]);
  });

  it("closes with a comment", async () => {
    const screen = await renderConversation();
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Comment" }),
      "Superseded by the stack merge.",
    );
    await screen.getByRole("button", { name: "Close with comment" }).click();
    await expect
      .poll(() => sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation").length)
      .toBe(1);
    expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation")[0]?.args).toEqual({
      kind: "close",
    });
    expect(sourceControlRpcMock.callsTo("useAddChangeRequestCommentMutation")).toHaveLength(1);
  });

  it("quotes a comment into the composer and toggles reactions", async () => {
    const screen = await renderConversation();
    await screen.getByRole("button", { name: "Hooray: 1, including you" }).click();
    expect(
      sourceControlRpcMock
        .callsTo("useAddChangeRequestCommentReactionMutation")
        .map((call) => call.args),
    ).toEqual([{ commentId: "703-ic2", content: "hooray" }]);

    const comment = document.getElementById("comment-703-ic2");
    if (!comment) throw new Error("tkessler's comment is missing");
    await page.elementLocator(comment).getByRole("button", { name: "Comment actions" }).click();
    await screen.getByRole("menuitem", { name: "Quote reply" }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Comment" }))
      .toHaveValue(expect.stringContaining("> Tried this against the sandbox repo"));
  });

  it("reports the masthead to the bar once it scrolls away", async () => {
    await renderConversation();
    expect(usePullRequestReaderStore.getState().mastheadHidden[READER_KEY_703] ?? false).toBe(
      false,
    );
    scroller().scrollTop = 1200;
    await expect
      .poll(() => usePullRequestReaderStore.getState().mastheadHidden[READER_KEY_703])
      .toBe(true);
    scroller().scrollTop = 0;
    await expect
      .poll(() => usePullRequestReaderStore.getState().mastheadHidden[READER_KEY_703])
      .toBe(false);
  });

  it("lands on a linked thread and flashes it", async () => {
    await renderConversation({ search: { thread: FIXTURE_703_THREADS.draftWalk } });
    const slot = document.querySelector<HTMLElement>(
      `[data-pr-thread="${FIXTURE_703_THREADS.draftWalk}"]`,
    );
    expect(slot?.classList.contains("pr-thread-flash")).toBe(true);
    const paneTop = scroller().getBoundingClientRect().top;
    const top = slot!.getBoundingClientRect().top - paneTop;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(scroller().clientHeight / 2);
  });

  it("steps through unresolved threads with N", async () => {
    await renderConversation();
    await userEvent.keyboard("n");
    await expect
      .poll(() => document.querySelector(".pr-thread-flash")?.getAttribute("data-pr-thread"))
      .toBe(FIXTURE_703_THREADS.ariaCurrent);
  });

  it("remembers the scroll offset per pull request", async () => {
    const first = await renderConversation();
    scroller().scrollTop = 900;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await first.unmount();
    await renderConversation();
    expect(Math.round(scroller().scrollTop)).toBe(900);
  });

  it("links to earlier activity when the timeline is truncated", async () => {
    const activity = fixtureActivity(703);
    const screen = await renderConversation({
      activityState: { data: { ...activity, timelineTruncated: true } },
    });
    await expect
      .element(screen.getByRole("link", { name: "Earlier activity on GitHub" }))
      .toHaveAttribute("href", fixtureDetail(703)?.url);
  });

  it("falls back to the detail's comments on hosts without the activity read", async () => {
    const screen = await renderConversation({ supportsReview: false });
    await expect
      .element(screen.getByText("Tried this against the sandbox repo", { exact: false }))
      .toBeInTheDocument();
    await expect.element(screen.getByRole("textbox", { name: "Comment" })).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Edit title" }))
      .not.toBeInTheDocument();
  });

  it("shows a geometry-matched skeleton while loading", async () => {
    const screen = await renderConversation({
      detailState: { data: null, isLoading: true },
      activityState: { data: null, isLoading: true },
    });
    // The list row still names the pull request; the body waits.
    await expect.element(screen.getByRole("heading", { level: 1 })).toBeVisible();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(4);
    await expect.element(screen.getByRole("textbox", { name: "Comment" })).not.toBeInTheDocument();
  });
});
