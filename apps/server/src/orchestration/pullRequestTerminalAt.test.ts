import { describe, expect, it } from "vite-plus/test";

import { resolvePullRequestTerminalAt } from "./pullRequestTerminalAt.ts";

const OBSERVED_AT = "2026-10-04T12:00:00.000Z";
const STORED_AT = "2026-10-04T10:00:00.000Z";
const FORGE_AT = "2026-10-04T09:30:00.000Z";

describe("resolvePullRequestTerminalAt", () => {
  it.each(["open", null] as const)("is null while the PR is %s", (nextState) => {
    expect(
      resolvePullRequestTerminalAt({
        previousState: "merged",
        previousTerminalAt: STORED_AT,
        nextState,
        reportedTerminalAt: FORGE_AT,
        observedAt: OBSERVED_AT,
      }),
    ).toBeNull();
  });

  it("prefers the forge-reported time over a stored one", () => {
    expect(
      resolvePullRequestTerminalAt({
        previousState: "merged",
        previousTerminalAt: STORED_AT,
        nextState: "merged",
        reportedTerminalAt: FORGE_AT,
        observedAt: OBSERVED_AT,
      }),
    ).toBe(FORGE_AT);
  });

  it("keeps the first observation while the terminal state is unchanged", () => {
    expect(
      resolvePullRequestTerminalAt({
        previousState: "closed",
        previousTerminalAt: STORED_AT,
        nextState: "closed",
        reportedTerminalAt: null,
        observedAt: OBSERVED_AT,
      }),
    ).toBe(STORED_AT);
  });

  it.each([
    ["open", "merged"],
    [null, "merged"],
    ["merged", "closed"],
    ["closed", "merged"],
  ] as const)("takes the observation time on a %s to %s transition", (previousState, nextState) => {
    expect(
      resolvePullRequestTerminalAt({
        previousState,
        previousTerminalAt: STORED_AT,
        nextState,
        reportedTerminalAt: null,
        observedAt: OBSERVED_AT,
      }),
    ).toBe(OBSERVED_AT);
  });

  it("takes the observation time for a stored terminal state without a time", () => {
    expect(
      resolvePullRequestTerminalAt({
        previousState: "merged",
        previousTerminalAt: null,
        nextState: "merged",
        reportedTerminalAt: null,
        observedAt: OBSERVED_AT,
      }),
    ).toBe(OBSERVED_AT);
  });

  it("clears the time when a closed PR reopens", () => {
    expect(
      resolvePullRequestTerminalAt({
        previousState: "closed",
        previousTerminalAt: STORED_AT,
        nextState: "open",
        reportedTerminalAt: null,
        observedAt: OBSERVED_AT,
      }),
    ).toBeNull();
  });

  it.each(["", "not-a-date"])(
    "falls back when the reported time %j is invalid",
    (reportedTerminalAt) => {
      expect(
        resolvePullRequestTerminalAt({
          previousState: "merged",
          previousTerminalAt: STORED_AT,
          nextState: "merged",
          reportedTerminalAt,
          observedAt: OBSERVED_AT,
        }),
      ).toBe(STORED_AT);
      expect(
        resolvePullRequestTerminalAt({
          previousState: "open",
          previousTerminalAt: null,
          nextState: "merged",
          reportedTerminalAt,
          observedAt: OBSERVED_AT,
        }),
      ).toBe(OBSERVED_AT);
    },
  );

  it("ignores an invalid stored time", () => {
    expect(
      resolvePullRequestTerminalAt({
        previousState: "merged",
        previousTerminalAt: "garbage",
        nextState: "merged",
        reportedTerminalAt: null,
        observedAt: OBSERVED_AT,
      }),
    ).toBe(OBSERVED_AT);
  });
});
