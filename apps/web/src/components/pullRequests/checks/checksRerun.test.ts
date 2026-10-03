import { describe, expect, it } from "vitest";

import { checksRerunStartedTitle, describeChecksRerunFailure } from "./checksRerun";

describe("describeChecksRerunFailure", () => {
  it("names missing permissions", () => {
    const failure = describeChecksRerunFailure(
      new Error(
        "Source control provider github failed in rerunWorkflow: Resource not accessible by integration",
      ),
    );
    expect(failure.kind).toBe("permission-denied");
  });

  it("explains runs that are still going", () => {
    expect(describeChecksRerunFailure(new Error("HTTP 422: Unprocessable Entity")).kind).toBe(
      "not-rerunnable",
    );
  });

  it("passes other messages through without the provider prefix", () => {
    expect(
      describeChecksRerunFailure(
        new Error("Source control provider github failed in rerunWorkflow: network down"),
      ),
    ).toEqual({ kind: "error", title: "Re-run failed", description: "network down" });
  });
});

describe("checksRerunStartedTitle", () => {
  it("names one job or counts failed ones", () => {
    expect(checksRerunStartedTitle({ jobName: "Test · web" })).toBe("Re-running Test · web");
    expect(checksRerunStartedTitle({ failedJobs: 1 })).toBe("Re-running 1 failed job");
    expect(checksRerunStartedTitle({ failedJobs: 3 })).toBe("Re-running 3 failed jobs");
  });
});
