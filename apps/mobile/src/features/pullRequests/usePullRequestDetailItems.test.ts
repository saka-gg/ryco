import { derivePullRequestSelectionChecks } from "@ryco/client-runtime/state/pull-request-review";
import type { SourceControlChangeRequestDetail } from "@ryco/contracts";
import { getChangeRequestHostCapabilities } from "@ryco/shared/changeRequestHostCapabilities";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

// The pull request screen's rows feed a list of native Markdown views: new
// rows re-render every visible one. The reads around the rows' data are new
// objects on every render, so the rows must be keyed on the data itself. Run
// as a plain function over a `useMemo` that keeps its last value across calls
// the way React keeps it across renders (no React renderer exists here).

const hoisted = vi.hoisted(() => ({
  memo: null as null | { deps: ReadonlyArray<unknown>; value: unknown },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: <T>(factory: () => T, deps: ReadonlyArray<unknown>): T => {
      const kept = hoisted.memo;
      if (
        kept !== null &&
        kept.deps.length === deps.length &&
        kept.deps.every((dep, index) => Object.is(dep, deps[index]))
      ) {
        return kept.value as T;
      }
      const value = factory();
      hoisted.memo = { deps, value };
      return value;
    },
  };
});
vi.mock("../../connection/useEnvironmentApi", () => ({ useEnvironmentApi: () => undefined }));
vi.mock("../../connection/hostedConnectionScopes", () => ({
  mobileHostedConnectionScopes: { retain: () => () => undefined },
}));
vi.mock("../../rpc/pullRequestAtoms", () => ({}));
vi.mock("../../rpc/useMobileQuery", () => ({}));
vi.mock("../../state/threadsRuntime", () => ({}));

import { usePullRequestDetailItems } from "./usePullRequestData";

const DETAIL = {
  provider: "github",
  number: 42,
  title: "Phone pull requests",
  url: "https://github.com/acme/app/pull/42",
  baseRefName: "main",
  headRefName: "feature/prs",
  state: "open",
  updatedAt: Option.none(),
  headSha: "abc1234",
  body: "Adds the pull request screens.",
  comments: [],
  truncated: false,
} as SourceControlChangeRequestDetail;
const CHECKS = derivePullRequestSelectionChecks(DETAIL, null);
const CAPABILITIES = getChangeRequestHostCapabilities("github");

/** One render's inputs: every read result is a fresh object, as the hooks return them. */
function render(tab: "conversation" | "checks" = "conversation") {
  const read = <T>(data: T) => ({
    data,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: async () => ({ data }),
  });
  return usePullRequestDetailItems({
    tab,
    hostName: "GitHub",
    hostKnown: true,
    pullRequest: {
      detail: read(DETAIL),
      activity: read(null),
      capabilities: CAPABILITIES,
      checks: CHECKS,
    },
    diff: { status: "waiting", files: null, error: null },
  });
}

describe("usePullRequestDetailItems", () => {
  it("keeps the rows while the data under them is the same", () => {
    const first = render();
    expect(first.some((item) => item.kind === "description")).toBe(true);
    expect(render()).toBe(first);
  });

  it("derives them again when what they show changes", () => {
    const conversation = render();
    expect(render("checks")).not.toBe(conversation);
  });
});
