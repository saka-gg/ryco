import { describe, expect, it } from "vite-plus/test";
import { Option, Result } from "effect";

import {
  applyGitHubRequiredChecks,
  decodeGitHubRequiredChecksPageJson,
  type NormalizedGitHubRequiredCheck,
} from "./gitHubRequiredChecks.ts";

/**
 * Shaped exactly like `gh api graphql` answers to GITHUB_REQUIRED_CHECKS_QUERY
 * (captured read-only from public pull requests and trimmed): one page of
 * `StatusCheckRollupContext` nodes with `isRequired(pullRequestNumber:)`.
 */
function page(nodes: ReadonlyArray<unknown>, pageInfo = { hasNextPage: false, endCursor: "Mw" }) {
  return JSON.stringify({
    data: {
      repository: {
        object: { statusCheckRollup: { contexts: { nodes, pageInfo } } },
      },
    },
  });
}

const STATIC_URL = "https://github.com/Effect-TS/effect/actions/runs/37089821128/job/111107572263";
const BUNDLE_URL = "https://github.com/Effect-TS/effect/actions/runs/37089821128/job/111107572410";

describe("decodeGitHubRequiredChecksPageJson", () => {
  it("reads check runs and status contexts with their required flag", () => {
    const decoded = decodeGitHubRequiredChecksPageJson(
      page(
        [
          { __typename: "CheckRun", name: "Static", detailsUrl: STATIC_URL, isRequired: true },
          { __typename: "CheckRun", name: "Bundle", detailsUrl: BUNDLE_URL, isRequired: false },
          {
            __typename: "StatusContext",
            context: "node-test-commit",
            targetUrl: "https://ci.nodejs.org/job/node-test-commit/92963/",
            isRequired: false,
          },
        ],
        { hasNextPage: true, endCursor: "NA" },
      ),
    );
    expect(Result.isSuccess(decoded) && decoded.success).toEqual({
      checks: [
        { kind: "check-run", name: "Static", url: STATIC_URL, isRequired: true },
        { kind: "check-run", name: "Bundle", url: BUNDLE_URL, isRequired: false },
        {
          kind: "status-context",
          name: "node-test-commit",
          url: "https://ci.nodejs.org/job/node-test-commit/92963/",
          isRequired: false,
        },
      ],
      hasNextPage: true,
      endCursor: "NA",
    });
  });

  it("reads a commit with no checks, or no such commit, as an empty page", () => {
    for (const object of [null, {}, { statusCheckRollup: null }]) {
      const decoded = decodeGitHubRequiredChecksPageJson(
        JSON.stringify({ data: { repository: { object } } }),
      );
      expect(Result.isSuccess(decoded) && decoded.success).toEqual({
        checks: [],
        hasNextPage: false,
        endCursor: null,
      });
    }
  });

  it("skips nodes it cannot name and fails on a GraphQL error body", () => {
    const decoded = decodeGitHubRequiredChecksPageJson(
      page([null, { __typename: "CheckRun", name: " ", detailsUrl: null, isRequired: true }]),
    );
    expect(Result.isSuccess(decoded) && decoded.success.checks).toEqual([]);

    const failed = decodeGitHubRequiredChecksPageJson(
      JSON.stringify({
        data: null,
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
      }),
    );
    expect(Result.isFailure(failed)).toBe(true);
  });
});

describe("applyGitHubRequiredChecks", () => {
  const item = (kind: "check-run" | "status-context" | "unknown", name: string, url?: string) => ({
    kind,
    name,
    url: url ? Option.some(url) : Option.none<string>(),
  });
  const required = (
    name: string,
    isRequired: boolean,
    url: string | null = null,
    kind: NormalizedGitHubRequiredCheck["kind"] = "check-run",
  ): NormalizedGitHubRequiredCheck => ({ kind, name, url, isRequired });

  it("matches by kind, name and link", () => {
    const marked = applyGitHubRequiredChecks(
      [item("check-run", "Static", STATIC_URL), item("check-run", "Bundle", BUNDLE_URL)],
      [required("Static", true, STATIC_URL), required("Bundle", false, BUNDLE_URL)],
    );
    expect(marked.map((check) => check.isRequired)).toEqual([true, false]);
  });

  it("falls back to the name for a run that started between the two reads", () => {
    const marked = applyGitHubRequiredChecks(
      [item("check-run", "Static", "https://github.com/o/r/actions/runs/2/job/99")],
      [required("Static", true, STATIC_URL)],
    );
    expect(marked[0]?.isRequired).toBe(true);
  });

  it("never guesses: unmatched, ambiguous and unknown-kind items stay unmarked", () => {
    const marked = applyGitHubRequiredChecks(
      [
        item("check-run", "Missing", STATIC_URL),
        item("check-run", "Shared", "https://ci.example.com/3"),
        item("status-context", "Static", STATIC_URL),
        item("unknown", "Static", STATIC_URL),
      ],
      [
        required("Static", true, STATIC_URL),
        required("Shared", true, "https://ci.example.com/1"),
        required("Shared", false, "https://ci.example.com/2"),
      ],
    );
    expect(marked.map((check) => "isRequired" in check)).toEqual([false, false, false, false]);
  });

  it("returns the rollup untouched when nothing was looked up", () => {
    const rollup = [item("check-run", "Static", STATIC_URL)];
    expect(applyGitHubRequiredChecks(rollup, [])).toBe(rollup);
  });
});
