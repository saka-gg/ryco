import "~/index.css";

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

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

import { usePullRequestReviewDraftStore } from "~/pullRequestReviewDraftStore";
import type { SourceControlChangeRequestDiffInput } from "~/rpc/sourceControlAtoms";

import {
  FIXTURE_703_THREADS,
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  fixtureDiff,
  fixtureDiffAnchor,
  fixtureReviewDraftKey,
  fixtureSha,
  pullRequestFixtureStore,
  resetPullRequestsTestState,
  sourceControlRpcMock,
  type PullRequestsTestProviderProps,
} from "../testing/PullRequestsTestProvider";
import { findDiffLineElement } from "./diffReveal";
import { FilesTab } from "./FilesTab";
import { toggleFileTree, usePullRequestFilesUiStore } from "./pullRequestFilesStore";

/*
 * These run against the real `@pierre/diffs` renderer (worker pool, shadow
 * DOM, virtualizer): only the rpc hooks are fixtures.
 */

const LAYERS = "apps/web/src/components/pullRequests/stackLayers.logic.ts";
const DRAFT_LINE = "if (target?.entry.isDraft) return";
/** A head the author pushed while the reader was open. */
const NEW_HEAD = "f".repeat(40);

afterEach(() => {
  resetPullRequestsTestState();
  usePullRequestFilesUiStore.getState().reset();
  document.body.innerHTML = "";
});

function section(path: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-diff-file-path="${CSS.escape(path)}"]`,
  );
  if (!element) throw new Error(`No diff section for ${path}`);
  return element;
}

function shadowOf(path: string): ShadowRoot {
  const root = section(path).querySelector("diffs-container")?.shadowRoot;
  if (!root) throw new Error(`${path} has no rendered diff yet`);
  return root;
}

type FilesProviderProps = Partial<Omit<PullRequestsTestProviderProps, "children">> & {
  readonly before?: ReactNode;
};

function filesTree(search: Record<string, unknown>, props: FilesProviderProps) {
  const { before, ...providerProps } = props;
  const width = providerProps.width ?? 1192;
  return (
    <PullRequestsTestProvider
      selected={703}
      search={{ tab: "files", ...search }}
      height={860}
      {...providerProps}
      width={width}
    >
      {before}
      <FilesTab />
    </PullRequestsTestProvider>
  );
}

async function renderFiles(search: Record<string, unknown> = {}, props: FilesProviderProps = {}) {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(props.width ?? 1192, 860);
  const screen = await render(filesTree(search, props));
  return {
    ...screen,
    /** Same search (nav owns it after mount), new provider props. */
    rerenderWith: (next: FilesProviderProps) => screen.rerender(filesTree(search, next)),
  };
}

function threadElement(threadId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-review-thread-id="${CSS.escape(threadId)}"]`);
}

/** Open the gutter composer on a head-side line of `path` (the line must be on screen). */
async function openLineComposer(path: string, line: number) {
  const field = page.getByRole("textbox", { name: `Comment on line ${line}` });
  // pierre re-lays out lines while the highlighter settles, which can move
  // the gutter button between hover and click; hover and click again until
  // the composer opens.
  await expect
    .poll(
      async () => {
        if (field.query()) return true;
        const number = shadowOf(path).querySelector<HTMLElement>(
          `code[data-unified] [data-column-number="${line}"]`,
        );
        if (!number) return false;
        await userEvent.hover(number);
        const utility = shadowOf(path).querySelector<HTMLElement>("[data-utility-button]");
        if (utility) await userEvent.click(utility);
        return field.query() !== null;
      },
      { timeout: 15_000, interval: 250 },
    )
    .toBe(true);
  await expect.element(field).toHaveFocus();
  return field;
}

function diffReads(): ReadonlyArray<SourceControlChangeRequestDiffInput> {
  return sourceControlRpcMock.queries
    .filter((query) => query.hook === "useSourceControlChangeRequestDiff")
    .map((query) => query.input as SourceControlChangeRequestDiffInput)
    .filter((input) => input.enabled !== false);
}

/** The author pushes `diff` as a new head; `null` keeps the new head's diff loading. */
function pushNewHead(diff: () => string | null) {
  sourceControlRpcMock.queryOverrides.useSourceControlChangeRequestDiff = (
    input: SourceControlChangeRequestDiffInput,
  ) => {
    if (input.headSha !== NEW_HEAD) return undefined;
    const data = diff();
    return data === null ? { data: null, isLoading: true, isFetching: true } : { data };
  };
  pullRequestFixtureStore.updateDetail(703, (detail) => ({ ...detail, headSha: NEW_HEAD }));
}

/** Re-read every fixture query (overrides are read on render). */
function refetchFixtures() {
  pullRequestFixtureStore.updateActivity(703, (activity) => ({ ...activity }));
}

describe("Files tab (real pierre)", () => {
  it("renders a review thread under the line it was written on", async () => {
    const anchor = fixtureDiffAnchor(703, LAYERS, "if (target?.entry.isDraft) return");
    await renderFiles({ thread: FIXTURE_703_THREADS.draftWalk });

    await expect
      .poll(() =>
        document.querySelector(`[data-review-thread-id="${FIXTURE_703_THREADS.draftWalk}"]`),
      )
      .not.toBeNull();
    const thread = document.querySelector<HTMLElement>(
      `[data-review-thread-id="${FIXTURE_703_THREADS.draftWalk}"]`,
    )!;
    // Pierre slots the annotation under exactly that line on the head side.
    expect(thread.closest("[slot]")?.getAttribute("slot")).toBe(
      `annotation-additions-${anchor.line}`,
    );
    await expect.element(thread).toBeVisible();
    await expect
      .poll(() => findDiffLineElement(section(LAYERS), "additions", anchor.line))
      .not.toBeNull();
    const line = findDiffLineElement(section(LAYERS), "additions", anchor.line)!;
    const lineRect = line.getBoundingClientRect();
    const threadRect = thread.getBoundingClientRect();
    expect(threadRect.top).toBeGreaterThanOrEqual(lineRect.bottom - 1);
    expect(threadRect.top - lineRect.bottom).toBeLessThan(24);
    // Both comments of the conversation are there, in order.
    expect(thread.textContent).toContain("mvogt");
    expect(thread.textContent).toContain("Right, the walk should treat");
  });

  it("adds a pending draft from the gutter composer", async () => {
    const anchor = fixtureDiffAnchor(703, LAYERS, "if (target?.entry.isDraft) return");
    await renderFiles({ file: LAYERS, line: anchor.line, side: "right" });
    await expect
      .poll(() => findDiffLineElement(section(LAYERS), "additions", anchor.line))
      .not.toBeNull();

    const target = anchor.line - 2;
    const field = await openLineComposer(LAYERS, target);
    await expect.element(field).toBeVisible();
    await userEvent.type(field, "Check the layer below too.");
    await page.getByRole("button", { name: /Start a review/u }).click();

    const draft = usePullRequestReviewDraftStore.getState().draftsByKey[fixtureReviewDraftKey(703)];
    expect(draft?.comments).toHaveLength(1);
    expect(draft?.comments[0]).toMatchObject({
      path: LAYERS,
      line: target,
      side: "right",
      body: "Check the layer below too.",
      headSha: pullRequestFixtureStore.detail(703)?.headSha,
    });
    const card = page.getByRole("region", { name: "Pending comment" });
    await expect.element(card).toBeVisible();
    await expect.element(card.getByText("Pending")).toBeVisible();
    await expect.element(card.getByText("Check the layer below too.")).toBeVisible();
    expect(card.element().closest("[slot]")?.getAttribute("slot")).toBe(
      `annotation-additions-${target}`,
    );
    expect(sourceControlRpcMock.callsTo("useSubmitChangeRequestReviewMutation")).toEqual([]);
  });

  it("collapses a thread as soon as Resolve is pressed, before the host answers", async () => {
    let finish!: () => void;
    sourceControlRpcMock.mutationOverrides.useSetReviewThreadResolvedMutation = () =>
      new Promise((resolve) => {
        finish = () => resolve({ threadId: FIXTURE_703_THREADS.draftWalk, isResolved: true });
      });
    const anchor = fixtureDiffAnchor(703, LAYERS, "if (target?.entry.isDraft) return");
    await renderFiles({ thread: FIXTURE_703_THREADS.draftWalk });
    const thread = page.getByRole("region", {
      name: `Conversation on ${LAYERS}:${anchor.line}`,
      exact: true,
    });
    const resolve = thread.getByRole("button", { name: "Resolve", exact: true });
    await expect.element(resolve).toBeVisible();

    await resolve.click();
    const element = document.querySelector<HTMLElement>(
      `[data-review-thread-id="${FIXTURE_703_THREADS.draftWalk}"]`,
    )!;
    // Optimistic: collapsed to its one-line summary while the request is in flight.
    expect(element.dataset.resolved).toBe("true");
    await expect.element(thread.getByRole("button", { name: /^Resolved mvogt/u })).toBeVisible();
    await expect.element(resolve).not.toBeInTheDocument();
    expect(sourceControlRpcMock.callsTo("useSetReviewThreadResolvedMutation")).toHaveLength(1);
    expect(sourceControlRpcMock.callsTo("useSetReviewThreadResolvedMutation")[0]?.args).toEqual({
      threadId: FIXTURE_703_THREADS.draftWalk,
      resolved: true,
    });
    finish();
  });

  it("V marks the file being read as viewed, folds it, and moves on", async () => {
    await renderFiles();
    const first = "apps/web/src/components/pullRequests/PullRequestMergeBox.tsx";
    const toggle = page.getByRole("button", { name: `Collapse ${first}`, exact: true });
    await expect.element(toggle).toBeVisible();
    await expect.poll(() => section(first).querySelector("diffs-container")).not.toBeNull();

    await userEvent.keyboard("v");
    expect(sourceControlRpcMock.callsTo("setChangeRequestFileViewed")[0]?.args).toMatchObject({
      path: first,
      viewed: true,
    });
    await expect
      .element(page.getByRole("button", { name: `Expand ${first}`, exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByRole("checkbox", { name: `Viewed ${first}`, exact: true }).first())
      .toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByText("3 of 12 viewed")).toBeVisible();
  });

  it("reads the diff once, after the head is known (a cold link)", async () => {
    // The previous test's tree re-renders on the shared fixture store until
    // it is cleaned up; start this one's read log from nothing.
    sourceControlRpcMock.reset();
    // Nothing knows the head yet: the detail and activity are loading, and the
    // list (filtered to closed pull requests) has no row for #703.
    const screen = await renderFiles(
      { state: "closed" },
      {
        detailState: { data: null, isLoading: true },
        activityState: { data: null, isLoading: true },
      },
    );
    await expect.element(page.getByLabelText("Loading the diff")).toBeInTheDocument();
    expect(diffReads()).toEqual([]);

    await screen.rerenderWith({});
    await expect.poll(() => document.querySelector("[data-diff-file-path]")).not.toBeNull();
    // One read, at the head; never a head-less one followed by a second.
    expect(diffReads().map((input) => input.headSha)).toEqual([
      pullRequestFixtureStore.detail(703)?.headSha,
    ]);
  });

  it("keeps the diff and the comment being written while a new head's diff loads", async () => {
    const anchor = fixtureDiffAnchor(703, LAYERS, DRAFT_LINE);
    await renderFiles({ file: LAYERS, line: anchor.line, side: "right" });
    await expect
      .poll(() => findDiffLineElement(section(LAYERS), "additions", anchor.line))
      .not.toBeNull();
    const target = anchor.line - 2;
    const field = await openLineComposer(LAYERS, target);
    await userEvent.type(field, "Half a thought");

    let arrived = false;
    pushNewHead(() => (arrived ? fixtureDiff(703) : null));
    await expect.poll(() => diffReads().some((input) => input.headSha === NEW_HEAD)).toBe(true);
    // The previous head's diff stays up (no skeleton), and so does the composer.
    expect(document.querySelector('[aria-label="Loading the diff"]')).toBeNull();
    await expect.element(field).toHaveValue("Half a thought");
    await expect.element(field).toHaveFocus();

    // The new head leaves this file as it was: the comment now refers to the new head.
    arrived = true;
    refetchFixtures();
    await expect.element(field).toHaveValue("Half a thought");
    await page.getByRole("button", { name: /Start a review/u }).click();
    const draft = usePullRequestReviewDraftStore.getState().draftsByKey[fixtureReviewDraftKey(703)];
    expect(draft?.comments[0]).toMatchObject({
      path: LAYERS,
      line: target,
      body: "Half a thought",
      headSha: NEW_HEAD,
    });
  });

  it("keeps a comment on a file a new push changed as an outdated pending comment", async () => {
    const anchor = fixtureDiffAnchor(703, LAYERS, DRAFT_LINE);
    const oldHead = pullRequestFixtureStore.detail(703)?.headSha;
    await renderFiles({ file: LAYERS, line: anchor.line, side: "right" });
    await expect
      .poll(() => findDiffLineElement(section(LAYERS), "additions", anchor.line))
      .not.toBeNull();
    const target = anchor.line - 2;
    const field = await openLineComposer(LAYERS, target);
    await userEvent.type(field, "Still needed?");

    const changed = fixtureDiff(703).replace(DRAFT_LINE, `${DRAFT_LINE} null`);
    expect(changed).not.toBe(fixtureDiff(703));
    pushNewHead(() => changed);

    await expect.element(field).not.toBeInTheDocument();
    const draft = usePullRequestReviewDraftStore.getState().draftsByKey[fixtureReviewDraftKey(703)];
    expect(draft?.comments).toHaveLength(1);
    // Stamped with the head it was written on, so it is outdated and never sent.
    expect(draft?.comments[0]).toMatchObject({
      path: LAYERS,
      line: target,
      body: "Still needed?",
      headSha: oldHead,
    });
    const card = page.getByRole("region", { name: "Pending comment" });
    await expect.element(card.getByText("Outdated · written on an earlier commit")).toBeVisible();
    await expect.element(card.getByText("Still needed?")).toBeVisible();
  });

  it("lands on a thread link when the conversations arrive after the diff", async () => {
    const screen = await renderFiles(
      { thread: FIXTURE_703_THREADS.draftWalk },
      { activityState: { data: null, isLoading: true } },
    );
    await expect.poll(() => document.querySelector("[data-diff-file-path]")).not.toBeNull();
    expect(threadElement(FIXTURE_703_THREADS.draftWalk)).toBeNull();

    await screen.rerenderWith({});
    await expect
      .poll(
        () => {
          const thread = threadElement(FIXTURE_703_THREADS.draftWalk);
          return (
            thread !== null &&
            (thread.classList.contains("pr-jump-flash") ||
              thread.classList.contains("pr-jump-ring"))
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  it("shows a commit only the conversations written on it", async () => {
    const commit = fixtureSha("c3e81a0");
    pullRequestFixtureStore.updateActivity(703, (activity) => ({
      ...activity,
      reviewThreads: activity.reviewThreads.map((thread) =>
        thread.id === FIXTURE_703_THREADS.draftWalk
          ? { ...thread, originalCommitOid: commit }
          : thread.id === FIXTURE_703_THREADS.outdatedSort
            ? { ...thread, originalCommitOid: fixtureSha("a41c9e2") }
            : thread,
      ),
    }));
    await renderFiles({ commit, thread: FIXTURE_703_THREADS.draftWalk });

    await expect.poll(() => threadElement(FIXTURE_703_THREADS.draftWalk)).not.toBeNull();
    const anchor = fixtureDiffAnchor(703, LAYERS, DRAFT_LINE);
    expect(
      threadElement(FIXTURE_703_THREADS.draftWalk)?.closest("[slot]")?.getAttribute("slot"),
    ).toBe(`annotation-additions-${anchor.line}`);
    // Written on an earlier commit: its line 23 there is other code in this commit.
    expect(threadElement(FIXTURE_703_THREADS.outdatedSort)).toBeNull();
    const tree = page.getByRole("navigation", { name: "Changed files" });
    await expect
      .element(tree.getByRole("img", { name: "1 conversation, 1 unresolved" }))
      .toBeVisible();
  });

  it("closes the overlay tree with Esc and hands focus to the file picked from it", async () => {
    const first = "apps/web/src/components/pullRequests/PullRequestMergeBox.tsx";
    await renderFiles(
      {},
      {
        width: 680,
        before: (
          <button type="button" onClick={() => toggleFileTree(false)}>
            Toggle tree
          </button>
        ),
      },
    );
    await expect.poll(() => document.querySelector("[data-diff-file-path]")).not.toBeNull();
    const opener = page.getByRole("button", { name: "Toggle tree" });
    const overlay = page.getByRole("complementary", { name: "Files" });

    await opener.click();
    await expect.element(overlay).toHaveAttribute("data-open", "true");
    // Focus moves into the tree, then Esc closes it and returns focus to the opener.
    await expect.poll(() => overlay.element().contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.element(overlay).toHaveAttribute("data-open", "false");
    await expect.element(opener).toHaveFocus();

    await opener.click();
    await expect.poll(() => overlay.element().contains(document.activeElement)).toBe(true);
    const row = overlay.getByRole("button", { name: /PullRequestMergeBox\.tsx/u });
    row.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(overlay).toHaveAttribute("data-open", "false");
    await expect
      .element(page.getByRole("button", { name: `Collapse ${first}`, exact: true }))
      .toHaveFocus();
  });

  it("keeps focus in a thread when Resolve or the reply field folds away", async () => {
    sourceControlRpcMock.mutationOverrides.useSetReviewThreadResolvedMutation = () =>
      new Promise(() => undefined);
    const anchor = fixtureDiffAnchor(703, LAYERS, DRAFT_LINE);
    await renderFiles({ thread: FIXTURE_703_THREADS.draftWalk });
    const thread = page.getByRole("region", {
      name: `Conversation on ${LAYERS}:${anchor.line}`,
      exact: true,
    });

    // Reply… → Esc in the field → back on Reply….
    const reply = thread.getByRole("button", { name: "Reply…" });
    await expect.element(reply).toBeVisible();
    await reply.click();
    const field = thread.getByRole("textbox", { name: "Reply" });
    await expect.element(field).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(reply).toHaveFocus();

    // Resolve folds the thread to one line; focus lands on that line.
    thread.getByRole("button", { name: "Resolve", exact: true }).element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(thread.getByRole("button", { name: /^Resolved mvogt/u })).toHaveFocus();
  });

  it("returns focus to the file header when the line composer is cancelled", async () => {
    const anchor = fixtureDiffAnchor(703, LAYERS, DRAFT_LINE);
    await renderFiles({ file: LAYERS, line: anchor.line, side: "right" });
    await expect
      .poll(() => findDiffLineElement(section(LAYERS), "additions", anchor.line))
      .not.toBeNull();
    const field = await openLineComposer(LAYERS, anchor.line - 2);
    await userEvent.keyboard("{Escape}");
    await expect.element(field).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: `Collapse ${LAYERS}`, exact: true }))
      .toHaveFocus();
  });
});
