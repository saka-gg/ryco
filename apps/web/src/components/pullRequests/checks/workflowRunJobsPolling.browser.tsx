/**
 * The Checks tab's job polling, through the real source-control bindings (the
 * shared fixture mock replaces `useSourceControlWorkflowRunJobsBatch`, so the
 * cadence wiring is exercised here against a fake host instead).
 */
import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

// A factory that awaits the original module deadlocks on the runtime's import
// cycle; spying keeps the real module and swaps the one function used here.
vi.mock("~/environments/runtime", { spy: true });

import { requireEnvironmentConnection } from "~/environments/runtime";
import { resetSourceControlAtomsForTests } from "~/rpc/sourceControlAtoms";
import { useSourceControlWorkflowRunJobsBatch } from "~/rpc/useSourceControl";

const getWorkflowRunJobs = vi.fn();

const ENVIRONMENT_ID = EnvironmentId.make("environment-checks-polling");
const CWD = "/tmp/checks-polling";

type JobStatus = "queued" | "in_progress" | "completed";
const jobStatusByRun = new Map<string, JobStatus>();

function jobsFor(runId: string) {
  return {
    jobs: [
      {
        jobId: `${runId}-job`,
        name: "build",
        status: jobStatusByRun.get(runId) ?? "completed",
        conclusion: { _tag: "None" },
        startedAt: { _tag: "None" },
        completedAt: { _tag: "None" },
        steps: [],
      },
    ],
  };
}

function Harness(props: {
  readonly runIds: ReadonlyArray<string>;
  readonly incompleteRunIds: ReadonlyArray<string>;
}) {
  useSourceControlWorkflowRunJobsBatch({
    environmentId: ENVIRONMENT_ID,
    cwd: CWD,
    runIds: props.runIds,
    incompleteRunIds: props.incompleteRunIds,
    enabled: true,
  });
  return null;
}

function readsOf(runId: string): number {
  return getWorkflowRunJobs.mock.calls.filter(
    ([input]) => (input as { runId: string }).runId === runId,
  ).length;
}

const RUN_IDS = ["run-a", "run-b", "run-c"];

beforeEach(() => {
  resetSourceControlAtomsForTests();
  jobStatusByRun.clear();
  getWorkflowRunJobs.mockReset();
  getWorkflowRunJobs.mockImplementation(async (input: { runId: string }) => jobsFor(input.runId));
  vi.mocked(requireEnvironmentConnection).mockImplementation(
    () => ({ client: { sourceControl: { getWorkflowRunJobs } } }) as never,
  );
});

afterEach(() => {
  vi.useRealTimers();
  resetSourceControlAtomsForTests();
});

describe("Checks job polling", () => {
  it("reads only the run that finished, not every stale settled run", async () => {
    jobStatusByRun.set("run-a", "in_progress");
    const screen = await render(<Harness runIds={RUN_IDS} incompleteRunIds={["run-a"]} />);
    await expect.poll(() => getWorkflowRunJobs.mock.calls.length).toBe(3);

    // Every cached job list is now older than its stale time.
    vi.setSystemTime(Date.now() + 120_000);
    jobStatusByRun.set("run-a", "completed");
    await screen.rerender(<Harness runIds={RUN_IDS} incompleteRunIds={[]} />);

    // One final read of the run that finished; the settled runs are left alone.
    await expect.poll(() => readsOf("run-a")).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readsOf("run-b")).toBe(1);
    expect(readsOf("run-c")).toBe(1);
  });

  it("follows every running workflow, not only the first one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    jobStatusByRun.set("run-a", "in_progress");
    jobStatusByRun.set("run-b", "in_progress");
    await render(<Harness runIds={RUN_IDS} incompleteRunIds={["run-a", "run-b"]} />);
    await expect.poll(() => getWorkflowRunJobs.mock.calls.length).toBe(3);

    await vi.advanceTimersByTimeAsync(33_000);

    await expect.poll(() => readsOf("run-a")).toBe(2);
    await expect.poll(() => readsOf("run-b")).toBe(2);
    // The settled run is not polled.
    expect(readsOf("run-c")).toBe(1);
  });

  it("starts following a re-run whose cached jobs all look finished", async () => {
    const screen = await render(<Harness runIds={RUN_IDS} incompleteRunIds={[]} />);
    await expect.poll(() => getWorkflowRunJobs.mock.calls.length).toBe(3);

    jobStatusByRun.set("run-c", "queued");
    await screen.rerender(<Harness runIds={RUN_IDS} incompleteRunIds={["run-c"]} />);

    await expect.poll(() => readsOf("run-c")).toBe(2);
    expect(readsOf("run-a")).toBe(1);
    expect(readsOf("run-b")).toBe(1);
  });
});
