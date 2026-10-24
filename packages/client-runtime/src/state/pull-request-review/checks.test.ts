import type { SourceControlCheckRollupItem } from "@ryco/contracts";
import * as SharedChecks from "@ryco/shared/changeRequestChecks";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  classifyCheckState,
  checkStateGroup,
  pullRequestCheckJobParam,
  summarizeChangeRequestChecks,
  workflowJobIdFromUrl,
} from "./checks.ts";
import { epochMillis, optionalValue } from "./internal.ts";
function check(
  name: string,
  input: {
    readonly workflowName?: string;
    readonly status?: string;
    readonly conclusion?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly url?: string;
    readonly isRequired?: boolean;
  } = {},
): SourceControlCheckRollupItem {
  return {
    kind: "check-run",
    name,
    ...(input.workflowName ? { workflowName: input.workflowName } : {}),
    status: input.status ? Option.some(input.status) : Option.none(),
    conclusion: input.conclusion ? Option.some(input.conclusion) : Option.none(),
    url: input.url ? Option.some(input.url) : Option.none(),
    startedAt: input.startedAt ? Option.some(DateTime.makeUnsafe(input.startedAt)) : Option.none(),
    completedAt: input.completedAt
      ? Option.some(DateTime.makeUnsafe(input.completedAt))
      : Option.none(),
    ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
  };
}

describe("workflowJobIdFromUrl", () => {
  it("reads GitHub Actions and GitLab CI job links only", () => {
    expect(
      workflowJobIdFromUrl("https://github.com/o/r/actions/runs/18214433871/job/52004433871"),
    ).toBe("52004433871");
    expect(workflowJobIdFromUrl("https://gitlab.example.com/group/project/-/jobs/91")).toBe("91");
    expect(workflowJobIdFromUrl("https://gitlab.example.com/group/project/-/jobs/91/raw")).toBe(
      "91",
    );
    expect(workflowJobIdFromUrl("https://gitlab.example.com/group/project/-/pipelines/47")).toBe(
      null,
    );
    expect(workflowJobIdFromUrl("https://ci.example.com/job/build/12")).toBe(null);
    expect(workflowJobIdFromUrl(null)).toBe(null);
  });
});

describe("pullRequestCheckJobParam", () => {
  it("prefers the host's job id, then workflow/name, then the bare name", () => {
    expect(
      pullRequestCheckJobParam({
        name: "lint",
        workflowName: "CI",
        url: "https://github.com/o/r/actions/runs/1/jobs/42",
      }),
    ).toBe("42");
    expect(
      pullRequestCheckJobParam({
        name: "lint",
        workflowName: "CI",
        url: "https://gitlab.example.com/group/project/-/jobs/91",
      }),
    ).toBe("91");
    expect(pullRequestCheckJobParam({ name: "lint", workflowName: "CI", url: null })).toBe(
      "CI/lint",
    );
    expect(
      pullRequestCheckJobParam({
        name: "lint",
        workflowName: "CI",
        url: "https://ci.example.com/job/build/12",
      }),
    ).toBe("CI/lint");
    expect(pullRequestCheckJobParam({ name: "ci/circleci", workflowName: null, url: null })).toBe(
      "ci/circleci",
    );
  });

  it("builds the param from a summarized rollup check", () => {
    const summary = summarizeChangeRequestChecks([
      check("test", {
        workflowName: "CI",
        conclusion: "FAILURE",
        url: "https://github.com/o/r/actions/runs/7/job/99",
      }),
    ]);
    expect(pullRequestCheckJobParam(summary.failing[0]!)).toBe("99");
  });
});

describe("moved check classification", () => {
  it("re-exports the shared module, so every import site keeps one implementation", () => {
    expect(summarizeChangeRequestChecks).toBe(SharedChecks.summarizeChangeRequestChecks);
    expect(classifyCheckState).toBe(SharedChecks.classifyCheckState);
    expect(checkStateGroup).toBe(SharedChecks.checkStateGroup);
    expect(epochMillis).toBe(SharedChecks.epochMillis);
    expect(optionalValue).toBe(SharedChecks.optionalValue);
  });
});
