import "../../../index.css";

import {
  ChangeRequest,
  ChangeRequestActivity,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestFilesViewed,
  SourceControlWorkflowJobLogResult,
  SourceControlWorkflowRunJobsResult,
  SourceControlWorkflowRunListResult,
  type ChangeRequestTimelineItemKind,
} from "@ryco/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import { PullRequestReader } from "../PullRequestReader";
import {
  FIXTURE_688_FAILING_JOB,
  FIXTURE_703_FAILING_JOB,
  FIXTURE_703_THREADS,
  FIXTURE_DETAILED_NUMBERS,
  PullRequestsTestProvider,
  buildTestPullRequestsModel,
  fixtureActivity,
  fixtureAuthoredNumbers,
  fixtureChangeRequests,
  fixtureDetail,
  fixtureDiff,
  fixtureFilesViewed,
  fixtureReviewRequestedNumbers,
  fixtureTimelineKinds,
  fixtureWorkflowJobLog,
  fixtureWorkflowRunJobs,
  fixtureWorkflowRuns,
  pullRequestFixtureStore,
  pullRequestsTestNavLog,
  resetPullRequestsTestState,
  sourceControlRpcMock,
} from "./PullRequestsTestProvider";

afterEach(() => {
  resetPullRequestsTestState();
  document.body.innerHTML = "";
});

/** Every timeline kind in the contract; a new kind fails to compile here until covered. */
const ALL_TIMELINE_KINDS: Record<ChangeRequestTimelineItemKind, true> = {
  comment: true,
  review: true,
  commit: true,
  "force-pushed": true,
  "review-requested": true,
  "review-request-removed": true,
  labeled: true,
  unlabeled: true,
  assigned: true,
  unassigned: true,
  renamed: true,
  merged: true,
  closed: true,
  reopened: true,
  "ready-for-review": true,
  "converted-to-draft": true,
  "head-ref-deleted": true,
  "head-ref-restored": true,
  "base-ref-changed": true,
  "cross-referenced": true,
  "auto-merge-enabled": true,
  "auto-merge-disabled": true,
  "review-dismissed": true,
};

/** Line `line` on `side` of `path` in a unified diff, or null. */
function diffLineText(
  diff: string,
  path: string,
  line: number,
  side: "left" | "right",
): string | null {
  const section = diff.split(/^diff --git /mu).find((part) => part.startsWith(`a/${path} `));
  if (!section) return null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of section.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/u.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    const marker = raw[0];
    if (marker === "+") {
      if (side === "right" && newLine === line) return raw.slice(1);
      newLine += 1;
    } else if (marker === "-") {
      if (side === "left" && oldLine === line) return raw.slice(1);
      oldLine += 1;
    } else if (marker === " ") {
      if ((side === "right" ? newLine : oldLine) === line) return raw.slice(1);
      oldLine += 1;
      newLine += 1;
    }
  }
  return null;
}

describe("pull request fixtures", () => {
  it("are valid contract values", () => {
    for (const row of fixtureChangeRequests) Schema.encodeSync(ChangeRequest)(row);
    for (const row of fixtureChangeRequests) {
      Schema.encodeSync(SourceControlChangeRequestDetail)(fixtureDetail(row.number));
      Schema.encodeSync(ChangeRequestActivity)(fixtureActivity(row.number));
      Schema.encodeSync(SourceControlWorkflowRunListResult)(fixtureWorkflowRuns(row.number));
      Schema.encodeSync(SourceControlChangeRequestFilesViewed)(fixtureFilesViewed(row.number));
      for (const run of fixtureWorkflowRuns(row.number).runs) {
        const jobs = fixtureWorkflowRunJobs(run.runId);
        Schema.encodeSync(SourceControlWorkflowRunJobsResult)(jobs);
        for (const job of jobs.jobs) {
          Schema.encodeSync(SourceControlWorkflowJobLogResult)(
            fixtureWorkflowJobLog(run.runId, job.jobId),
          );
        }
      }
    }
    expect(fixtureChangeRequests).toHaveLength(22);
    expect(fixtureAuthoredNumbers).toContain(703);
    expect(fixtureReviewRequestedNumbers).toContain(712);
  });

  it("cover every timeline kind", () => {
    const covered = fixtureTimelineKinds();
    expect(
      Object.keys(ALL_TIMELINE_KINDS).filter(
        (kind) => !covered.has(kind as ChangeRequestTimelineItemKind),
      ),
    ).toEqual([]);
  });

  it("anchor review threads to real diff lines", () => {
    for (const number of FIXTURE_DETAILED_NUMBERS) {
      const diff = fixtureDiff(number);
      for (const thread of fixtureActivity(number).reviewThreads) {
        if (thread.line === null) continue;
        const text = diffLineText(diff, thread.path, thread.line, thread.side);
        expect(text, `${thread.id} → ${thread.path}:${thread.line}`).not.toBeNull();
        const lastHunkLine = thread.diffHunk?.split("\n").at(-1)?.slice(1);
        expect(text, thread.id).toBe(lastHunkLine);
        if (thread.startLine) {
          expect(diffLineText(diff, thread.path, thread.startLine, thread.side)).not.toBeNull();
        }
      }
    }
    const threads = fixtureActivity(703).reviewThreads;
    expect(threads.filter((thread) => !thread.isResolved).map((thread) => thread.id)).toEqual([
      FIXTURE_703_THREADS.draftWalk,
      FIXTURE_703_THREADS.ariaCurrent,
    ]);
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    expect(byId.get(FIXTURE_703_THREADS.outdatedSort)).toMatchObject({
      line: null,
      isOutdated: true,
    });
    expect(byId.get(FIXTURE_703_THREADS.fileLevelCss)).toMatchObject({ subjectType: "file" });
    expect(byId.get(FIXTURE_703_THREADS.deletedBlocker)).toMatchObject({ side: "left", line: 43 });
    expect(byId.get(FIXTURE_703_THREADS.keyboardRange)).toMatchObject({ startLine: 31, line: 37 });
  });

  it("point the failing job logs at lines in the diff", () => {
    for (const [number, job] of [
      [703, FIXTURE_703_FAILING_JOB],
      [688, FIXTURE_688_FAILING_JOB],
    ] as const) {
      const log = fixtureWorkflowJobLog(job.runId, job.jobId).log;
      expect(log).toContain(`${job.path.replace(/^apps\/web\//u, "")}:${job.line}`);
      expect(diffLineText(fixtureDiff(number), job.path, job.line, "right")).not.toBeNull();
    }
  });

  it("derive the expected page model", () => {
    const model = buildTestPullRequestsModel({ selected: 703 });
    expect(model.list.groups.map((group) => group.key)).toEqual([
      "needs-your-review",
      "yours",
      "others",
    ]);
    expect(model.list.viewerLogin).toBe("sak0a");
    expect(model.selection?.checks.overall).toBe("failing");
    expect(model.selection?.checks.checks).toHaveLength(9);
    expect(model.selection?.nextAction?.kind).toBe("fix-checks");
    expect(model.selection?.threads.unresolvedCount).toBe(2);
    const nextAction = (number: number) =>
      buildTestPullRequestsModel({ selected: number }).selection?.nextAction?.kind;
    expect(nextAction(701)).toBe("merge");
    expect(nextAction(702)).toBe("checks-running");
    expect(nextAction(704)).toBe("mark-ready");
    expect(nextAction(712)).toBe("awaiting-review");
    expect(fixtureDetail(703).stack?.entries.map((entry) => entry.number)).toEqual([
      701, 702, 703, 704,
    ]);
  });
});

describe("PullRequestsTestProvider", () => {
  it("renders the reader bar for #703 and switches tabs", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <PullRequestsTestProvider selected={703} width={1280}>
        <PullRequestReader />
      </PullRequestsTestProvider>,
    );

    const conversation = screen.getByRole("tab", { name: /Conversation/u });
    const files = screen.getByRole("tab", { name: /Files/u });
    await expect.element(conversation).toHaveAttribute("aria-selected", "true");
    await expect.element(files).toMatchTextContent("12");
    await expect.element(screen.getByRole("tab", { name: /Checks/u })).toBeVisible();
    await expect.element(screen.getByRole("tab", { name: /Commits/u })).toMatchTextContent("8");

    await files.click();
    await expect.element(files).toHaveAttribute("aria-selected", "true");
    await expect.element(conversation).toHaveAttribute("aria-selected", "false");
    expect(pullRequestsTestNavLog.callsTo("setTab").map((call) => call.args)).toEqual([["files"]]);
    // Off Conversation, the bar shows the condensed title (the masthead and
    // rail name the PR too, so scope to the bar's title slot).
    await expect
      .poll(() => document.querySelector(".pr-bar-title")?.getAttribute("data-visible"))
      .toBe("true");
    expect(document.querySelector(".pr-bar-title")?.textContent).toContain(
      "Web: stack layers rail and merge-through-layer",
    );
    // Visited tabs stay mounted behind the active one.
    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(2);

    await userEvent.keyboard("3");
    await expect
      .element(screen.getByRole("tab", { name: /Checks/u }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("moves between list rows and stack layers in memory", async () => {
    await page.viewport(1280, 800);
    const seen: Array<number | undefined> = [];
    const screen = await render(
      <PullRequestsTestProvider
        selected={703}
        width={1280}
        onSearchChange={(search) => seen.push(search.pr)}
      >
        <PullRequestReader />
      </PullRequestsTestProvider>,
    );
    await expect.element(screen.getByRole("tab", { name: /Conversation/u })).toBeVisible();

    const ordered = buildTestPullRequestsModel({ selected: 703 }).list.ordered.map(
      (entry) => entry.number,
    );
    const below703 = ordered[ordered.indexOf(703) + 1];

    await userEvent.keyboard("]");
    // user-event escapes a literal `[` as `[[`.
    await userEvent.keyboard("[[");
    await userEvent.keyboard("j");
    expect(seen).toEqual([704, 703, below703]);
    expect(pullRequestsTestNavLog.callsTo("stepStackLayer").map((call) => call.args)).toEqual([
      [1],
      [-1],
    ]);
  });

  it("applies mocked mutations to the fixture store and re-derives the model", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <PullRequestsTestProvider selected={703} width={1280}>
        <PullRequestReader />
      </PullRequestsTestProvider>,
    );
    await screen.getByRole("button", { name: "More actions" }).click();
    await screen.getByRole("menuitem", { name: "Convert to draft" }).click();

    await expect.poll(() => pullRequestFixtureStore.detail(703)?.isDraft).toBe(true);
    expect(sourceControlRpcMock.callsTo("useUpdateChangeRequestMutation")).toEqual([
      {
        hook: "useUpdateChangeRequestMutation",
        target: expect.objectContaining({ reference: "703" }),
        args: { kind: "set-draft", draft: true },
      },
    ]);
    await screen.getByRole("button", { name: "More actions" }).click();
    await expect
      .element(screen.getByRole("menuitem", { name: "Mark ready for review" }))
      .toBeVisible();
  });
});
