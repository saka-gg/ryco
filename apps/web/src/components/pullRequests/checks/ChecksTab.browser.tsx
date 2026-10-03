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
    available: true,
    start: handoffStart,
    openWorktreeThread: async () => undefined,
  }),
}));

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
import { ChecksTab } from "./ChecksTab";

beforeEach(() => {
  vi.setSystemTime(FIXTURE_NOW_MS);
  handoffStart.mockClear();
});

afterEach(() => {
  resetPullRequestsTestState();
});

async function renderChecks(pr: number, job?: string) {
  await page.viewport(900, 860);
  return render(
    <PullRequestsTestProvider
      selected={pr}
      search={{ tab: "checks", ...(job ? { job } : {}) }}
      width={900}
      height={860}
    >
      <ChecksTab />
    </PullRequestsTestProvider>,
  );
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
      .toMatch(/pr-checks-flash/u);
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
