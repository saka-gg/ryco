import { describe, expect, it } from "vite-plus/test";

import {
  type JobList,
  main,
  producerFailure,
  waitForArtifact,
  type WaitDependencies,
} from "./wait-for-artifact.ts";

type Jobs = JobList["jobs"];

function fakeDependencies(steps: ReadonlyArray<{ readonly count: number; readonly jobs: Jobs }>) {
  let clock = 0;
  let index = 0;
  const current = () => steps[Math.min(index, steps.length - 1)]!;
  const messages: string[] = [];
  const dependencies: WaitDependencies = {
    artifactCount: async () => current().count,
    jobs: async () => current().jobs,
    sleep: async (milliseconds) => {
      clock += milliseconds;
      index += 1;
    },
    now: () => clock,
    log: (message) => messages.push(message),
  };
  return { dependencies, messages, polls: () => index };
}

const running: Jobs = [{ name: "Build JS bundle", status: "in_progress", conclusion: null }];
const options = {
  artifact: "js-bundle",
  job: "Build JS bundle",
  timeoutMs: 60_000,
  intervalMs: 5_000,
};

describe("producerFailure", () => {
  it("waits while the job is missing, queued, or running", () => {
    expect(producerFailure([], "Build JS bundle")).toBeNull();
    expect(producerFailure(running, "Build JS bundle")).toBeNull();
  });

  it("reports a job that finished without success", () => {
    expect(
      producerFailure(
        [{ name: "Build JS bundle", status: "completed", conclusion: "failure" }],
        "Build JS bundle",
      ),
    ).toBe('job "Build JS bundle" finished with failure');
    expect(
      producerFailure(
        [{ name: "Release / Build JS bundle", status: "completed", conclusion: "skipped" }],
        "Build JS bundle",
      ),
    ).toContain("skipped");
  });

  it("does not match other jobs that share a suffix", () => {
    expect(
      producerFailure(
        [{ name: "Rebuild JS bundle", status: "completed", conclusion: "failure" }],
        "Build JS bundle",
      ),
    ).toBeNull();
  });

  it("treats a successful job as still able to deliver", () => {
    expect(
      producerFailure(
        [{ name: "Build JS bundle", status: "completed", conclusion: "success" }],
        "Build JS bundle",
      ),
    ).toBeNull();
  });
});

describe("waitForArtifact", () => {
  it("returns once the artifact appears", async () => {
    const fake = fakeDependencies([
      { count: 0, jobs: running },
      { count: 0, jobs: running },
      { count: 1, jobs: running },
    ]);
    await waitForArtifact(options, fake.dependencies);
    expect(fake.polls()).toBe(2);
  });

  it("fails fast when the producing job fails", async () => {
    const fake = fakeDependencies([
      { count: 0, jobs: running },
      { count: 0, jobs: [{ name: "Build JS bundle", status: "completed", conclusion: "failure" }] },
    ]);
    await expect(waitForArtifact(options, fake.dependencies)).rejects.toThrow(
      'Artifact js-bundle will not arrive: job "Build JS bundle" finished with failure.',
    );
    expect(fake.polls()).toBe(1);
  });

  it("times out when nothing changes", async () => {
    const fake = fakeDependencies([{ count: 0, jobs: running }]);
    await expect(waitForArtifact(options, fake.dependencies)).rejects.toThrow(
      "Timed out after 60s waiting for js-bundle.",
    );
  });
});

describe("main", () => {
  it("rejects missing or unsafe arguments", async () => {
    expect(await main([])).toBe(2);
    expect(await main(["--artifact", "../x", "--job", "Build JS bundle"])).toBe(2);
    expect(await main(["--artifact", "js-bundle", "--job", "J", "--timeout-minutes", "0"])).toBe(2);
  });
});
