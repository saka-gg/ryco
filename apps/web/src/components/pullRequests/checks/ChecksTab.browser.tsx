import "../../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

const handoffStart = vi.fn(async (_request: unknown) => undefined);
vi.mock("~/components/pullRequests/agentHandoff", () => ({
  usePullRequestAgentHandoff: () => ({
    supported: true,
    available: true,
    start: handoffStart,
    openWorktreeThread: async () => undefined,
  }),
}));

import { usePullRequestsPage } from "../PullRequestsPageContext";
import { usePullRequestReaderStore } from "../pullRequestsLayoutStore";
import {
  FIXTURE_688_FAILING_JOB,
  FIXTURE_703_FAILING_JOB,
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  pullRequestsTestNavLog,
  resetPullRequestsTestState,
  sourceControlRpcMock,
} from "../testing/PullRequestsTestProvider";
import {
  GITLAB_FIXTURE_EXTERNAL_STATUS,
  GITLAB_FIXTURE_FAILING_JOB,
  GITLAB_FIXTURE_PIPELINE_NAME,
  GITLAB_FIXTURE_RUN_ID,
  gitLabFixtureDetail,
  gitLabFixtureJobs,
  gitLabFixtureRuns,
} from "../testing/gitLabCheckFixtures";
import { fixtureRequiredDetail } from "../testing/requiredCheckFixtures";
import { ChecksTab } from "./ChecksTab";

beforeEach(() => {
  vi.setSystemTime(FIXTURE_NOW_MS);
  handoffStart.mockClear();
});

afterEach(() => {
  resetPullRequestsTestState();
});

/** Reveals a job through nav, as the rail's "View failing check" link does. */
function RevealJobButton(props: { readonly job: string }) {
  const { nav } = usePullRequestsPage();
  return (
    <button type="button" onClick={() => nav.revealJob(props.job)}>
      Reveal job
    </button>
  );
}

async function renderChecks(pr: number, job?: string) {
  await page.viewport(900, 860);
  return render(
    <PullRequestsTestProvider
      selected={pr}
      search={{ tab: "checks", ...(job ? { job } : {}) }}
      width={900}
      height={860}
    >
      {job ? <RevealJobButton job={job} /> : null}
      <ChecksTab />
    </PullRequestsTestProvider>,
  );
}

/** #703 as a host that marks required checks reports it. */
async function renderRequiredChecks(required: ReadonlyArray<string>) {
  await page.viewport(900, 860);
  return render(
    <PullRequestsTestProvider
      selected={703}
      search={{ tab: "checks" }}
      width={900}
      height={860}
      detailState={{ data: fixtureRequiredDetail(703, { required }) }}
    >
      <ChecksTab />
    </PullRequestsTestProvider>,
  );
}

/** Job and status rows whose header carries the "Required" tag. */
function requiredRows(): ReadonlyArray<string> {
  return [...document.querySelectorAll<HTMLElement>("[data-inbox-row-key]")]
    .filter((row) => /^(?:job|status):/u.test(row.dataset.inboxRowKey ?? ""))
    .filter((row) =>
      [...(row.firstElementChild?.querySelectorAll("span") ?? [])].some(
        (span) => span.textContent === "Required",
      ),
    )
    .map((row) => (row.dataset.inboxRowKey ?? "").replaceAll("\u0000", ""));
}

function jobToggle(screen: Awaited<ReturnType<typeof renderChecks>>, name: string) {
  return screen.getByRole("button", { name: new RegExp(`^\\S+ ${name}$`, "u") });
}

describe("ChecksTab", () => {
  it("summarizes what it lists and opens the failing job at its log tail", async () => {
    const screen = await renderChecks(703);
    await expect.element(screen.getByText("failing")).toBeVisible();
    expect(document.body.textContent).toContain("1 failing·8 passed");

    // The failing job and its failing step open on their own; passing jobs stay closed.
    await expect
      .element(jobToggle(screen, FIXTURE_703_FAILING_JOB.name))
      .toHaveAttribute("aria-expanded", "true");
    await expect
      .element(jobToggle(screen, "Format & lint"))
      .toHaveAttribute("aria-expanded", "false");
    const log = screen.getByRole("log", { name: "Step log" });
    await expect.element(log).toBeVisible();
    await expect.element(log).toHaveTextContent(/Process completed with exit code 1/u);

    // A `path:line` in the log opens the changed file at that line.
    await screen
      .getByRole("button", { name: "src/components/pullRequests/stackLayers.logic.test.ts:40:43" })
      .click();
    expect(pullRequestsTestNavLog.callsTo("revealFile").map((call) => call.args)).toEqual([
      [FIXTURE_703_FAILING_JOB.path, FIXTURE_703_FAILING_JOB.line],
    ]);
  });

  it("counts and tags the checks the base branch requires", async () => {
    const screen = await renderRequiredChecks([
      FIXTURE_703_FAILING_JOB.name,
      "Typecheck",
      "Vercel – ryco-web",
    ]);
    await expect.element(screen.getByText("Required", { exact: true }).first()).toBeVisible();
    expect(document.body.textContent).toContain("1 failing·8 passed·3 required");
    expect(requiredRows()).toEqual([
      `job:CI#0/${FIXTURE_703_FAILING_JOB.name}`,
      "job:CI#0/Typecheck",
      "status:Vercel – ryco-web",
    ]);
    // The tag sits beside the duration, outside the job's toggle.
    await expect.element(jobToggle(screen, "Typecheck")).toBeVisible();
  });

  it("leaves the required count and tags out when the host does not mark them", async () => {
    const screen = await renderChecks(703);
    await expect.element(screen.getByText("failing")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\d required/u);
    expect(requiredRows()).toEqual([]);
  });

  it("re-runs the failed jobs of every finished run", async () => {
    const screen = await renderChecks(703);
    await screen.getByRole("button", { name: "Re-run failed" }).click();
    await expect
      .poll(() => sourceControlRpcMock.callsTo("useRerunWorkflowMutation"))
      .toEqual([
        expect.objectContaining({
          target: expect.objectContaining({ runId: FIXTURE_703_FAILING_JOB.runId }),
          args: { target: "failed-jobs" },
        }),
      ]);
  });

  it("re-runs one job from its menu", async () => {
    const screen = await renderChecks(703);
    await screen.getByRole("button", { name: `${FIXTURE_703_FAILING_JOB.name} actions` }).click();
    await screen.getByRole("menuitem", { name: "Re-run job" }).click();
    await expect
      .poll(() => sourceControlRpcMock.callsTo("useRerunWorkflowMutation").map((call) => call.args))
      .toEqual([{ target: "job", jobId: FIXTURE_703_FAILING_JOB.jobId }]);
  });

  it("hands the failing log to an agent", async () => {
    const screen = await renderChecks(703);
    await userEvent.hover(jobToggle(screen, FIXTURE_703_FAILING_JOB.name));
    await screen.getByRole("button", { name: "Fix with agent" }).click();
    expect(handoffStart).toHaveBeenCalledTimes(1);
    expect(handoffStart.mock.calls[0]?.[0]).toMatchObject({
      kind: "fix-check",
      prompt: expect.stringContaining(`"CI / ${FIXTURE_703_FAILING_JOB.name}"`),
      context: expect.stringContaining("AssertionError: expected undefined to be 2"),
    });
  });

  it("remembers a collapsed failing job for the pull request", async () => {
    const first = await renderChecks(703);
    await jobToggle(first, FIXTURE_703_FAILING_JOB.name).click();
    await expect
      .element(jobToggle(first, FIXTURE_703_FAILING_JOB.name))
      .toHaveAttribute("aria-expanded", "false");
    await first.unmount();

    const second = await renderChecks(703);
    await expect
      .element(jobToggle(second, FIXTURE_703_FAILING_JOB.name))
      .toHaveAttribute("aria-expanded", "false");
    await jobToggle(second, "Typecheck").click();
    const memory = Object.values(usePullRequestReaderStore.getState().expandedJobs)[0];
    expect(memory).toEqual(
      expect.arrayContaining([`collapsed:CI#0/${FIXTURE_703_FAILING_JOB.name}`, "CI#0/Typecheck"]),
    );
  });

  it("opens and flashes the job a link points at", async () => {
    const screen = await renderChecks(703, "CI/Typecheck");
    await expect.element(jobToggle(screen, "Typecheck")).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => document.querySelector('[data-checks-job="CI#0/Typecheck"] > div')?.className)
      .toMatch(/\blanding-flash\b/u);
  });

  it("lands again when the job already in the URL is revealed again", async () => {
    const screen = await renderChecks(703, "CI/Typecheck");
    const rowClass = () =>
      document.querySelector('[data-checks-job="CI#0/Typecheck"] > div')?.className ?? "";
    await expect.poll(rowClass).toMatch(/\blanding-flash\b/u);
    expect(rowClass()).not.toMatch(/landing-flash-replay/u);

    // Mid-flash: the URL is unchanged, the reveal count restarts the pass.
    await screen.getByRole("button", { name: "Reveal job" }).click();
    await expect.poll(rowClass).toMatch(/landing-flash-replay/u);

    // After the flash ends, a repeat flashes again from the start.
    await expect.poll(rowClass, { timeout: 4000 }).not.toMatch(/landing-flash/u);
    await screen.getByRole("button", { name: "Reveal job" }).click();
    await expect.poll(rowClass).toMatch(/\blanding-flash\b/u);
  });

  it("lists a GitLab merged-results pipeline's jobs once and counts them once", async () => {
    // GitLab: the head pipeline ran on a merge commit of the head, and the
    // rollup carries its jobs (every CI job is also a commit status).
    sourceControlRpcMock.queryOverrides.useSourceControlWorkflowRuns = () => ({
      data: gitLabFixtureRuns(),
    });
    sourceControlRpcMock.workflowRunJobs[GITLAB_FIXTURE_RUN_ID] = gitLabFixtureJobs();
    await page.viewport(900, 860);
    const screen = await render(
      <PullRequestsTestProvider
        host="gitlab"
        selected={703}
        search={{ tab: "checks" }}
        width={900}
        height={860}
        detailState={{ data: gitLabFixtureDetail() }}
      >
        <ChecksTab />
      </PullRequestsTestProvider>,
    );
    await expect.element(screen.getByText(GITLAB_FIXTURE_PIPELINE_NAME)).toBeVisible();
    expect(document.body.textContent).toContain("1 failing·9 passed");
    await expect
      .element(jobToggle(screen, GITLAB_FIXTURE_FAILING_JOB.name))
      .toHaveAttribute("aria-expanded", "true");
    // Each job once (not again as a status); the external status stays a status.
    const rowKeys = [...document.querySelectorAll<HTMLElement>("[data-inbox-row-key]")].map((row) =>
      (row.dataset.inboxRowKey ?? "").replaceAll("\u0000", ""),
    );
    expect(rowKeys.filter((key) => key.includes(GITLAB_FIXTURE_FAILING_JOB.name))).toHaveLength(1);
    expect(rowKeys.filter((key) => key.startsWith("status:"))).toHaveLength(1);
    await expect.element(screen.getByText(GITLAB_FIXTURE_EXTERNAL_STATUS)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Re-run failed" })).toBeVisible();
  });

  it("reaches a failing job in another workflow by its job id", async () => {
    const screen = await renderChecks(688, FIXTURE_688_FAILING_JOB.jobId);
    await expect
      .element(jobToggle(screen, FIXTURE_688_FAILING_JOB.name))
      .toHaveAttribute("aria-expanded", "true");
    await expect
      .element(screen.getByRole("button", { name: "apps/desktop/scripts/notarize.ts:31:11" }))
      .toBeVisible();
  });
});
