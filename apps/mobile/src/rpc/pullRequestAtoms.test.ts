import type { ChangeRequest, EnvironmentId } from "@ryco/contracts";
import { PULL_REQUESTS_LIST_LIMIT } from "@ryco/client-runtime/state/pull-request-review";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  clients: new Map<string, unknown>(),
}));

// The live RPC client comes off the connection supervisor; here it is a plain
// map, so the cache runs without the native connection stack.
vi.mock("../connection/environmentApi", () => ({
  readRpcClient: (environmentId: string) => mocks.clients.get(environmentId) ?? null,
}));

import {
  clearPullRequestStateForEnvironment,
  pullRequestDetailQuery,
  pullRequestDiffQuery,
  pullRequestListQuery,
  PullRequestNodeOfflineError,
  resetPullRequestAtomsForTests,
} from "./pullRequestAtoms";

const ENV = "env-a" as EnvironmentId;
const OTHER_ENV = "env-b" as EnvironmentId;
const CWD = "/work/project";

function row(number: number): ChangeRequest {
  return {
    provider: "github",
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    baseRefName: "main",
    headRefName: `feature-${number}`,
    state: "open",
    updatedAt: Option.none(),
  };
}

function setSourceControl(environmentId: EnvironmentId, sourceControl: Record<string, unknown>) {
  mocks.clients.set(environmentId, { sourceControl });
}

/** Let every pending microtask (including runWithRetry's link) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

beforeEach(() => {
  resetPullRequestAtomsForTests();
  mocks.clients.clear();
});

describe("pull request reads", () => {
  it("reads one list per state and involvement, with the web's row limit", async () => {
    const listChangeRequests = vi.fn(async () => [row(1)]);
    setSourceControl(ENV, { listChangeRequests });
    const all = {
      environmentId: ENV,
      cwd: CWD,
      state: "open",
      limit: PULL_REQUESTS_LIST_LIMIT,
    } as const;
    const authored = { ...all, involvement: "authored" } as const;
    expect(pullRequestListQuery.keyOf(all)).not.toBe(pullRequestListQuery.keyOf(authored));

    const releaseAll = pullRequestListQuery.watch(all);
    const releaseAuthored = pullRequestListQuery.watch(authored);
    await flush();

    expect(listChangeRequests).toHaveBeenCalledWith({
      cwd: CWD,
      state: "open",
      limit: PULL_REQUESTS_LIST_LIMIT,
    });
    expect(listChangeRequests).toHaveBeenCalledWith({
      cwd: CWD,
      state: "open",
      limit: PULL_REQUESTS_LIST_LIMIT,
      involvement: "authored",
    });
    expect(
      pullRequestListQuery.getSnapshot(pullRequestListQuery.keyOf(all)).data?.map((e) => e.number),
    ).toEqual([1]);
    releaseAll();
    releaseAuthored();
  });

  it("reads the full detail by number", async () => {
    const getChangeRequestDetail = vi.fn(async () => ({ ...row(7), body: "" }));
    setSourceControl(ENV, { getChangeRequestDetail });
    const input = { environmentId: ENV, cwd: CWD, number: 7 };
    const release = pullRequestDetailQuery.watch(input);
    await flush();
    expect(getChangeRequestDetail).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      fullContent: true,
    });
    expect(
      pullRequestDetailQuery.getSnapshot(pullRequestDetailQuery.keyOf(input)).data?.number,
    ).toBe(7);
    release();
  });

  it("reads the diff at the head it was asked for", async () => {
    const getChangeRequestDiff = vi.fn(async () => PATCH);
    setSourceControl(ENV, { getChangeRequestDiff });
    const input = { environmentId: ENV, cwd: CWD, number: 7, headSha: "abc1234" };
    // A new head is a new read.
    expect(pullRequestDiffQuery.keyOf(input)).not.toBe(
      pullRequestDiffQuery.keyOf({ ...input, headSha: "def5678" }),
    );
    const release = pullRequestDiffQuery.watch(input);
    await flush();
    expect(getChangeRequestDiff).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "7",
      expectedHeadSha: "abc1234",
    });
    expect(pullRequestDiffQuery.getSnapshot(pullRequestDiffQuery.keyOf(input)).data).toBe(PATCH);
    release();
  });

  it("says the node is offline instead of reading through nothing", async () => {
    const input = { environmentId: ENV, cwd: CWD, number: 7 };
    const release = pullRequestDetailQuery.watch(input);
    await flush();
    const state = pullRequestDetailQuery.getSnapshot(pullRequestDetailQuery.keyOf(input));
    expect(state.data).toBeNull();
    expect(state.error).toBeInstanceOf(PullRequestNodeOfflineError);
    release();
  });

  it("has no key until the checkout and number are known", () => {
    expect(pullRequestDetailQuery.keyOf({ environmentId: ENV, cwd: null, number: 7 })).toBeNull();
    expect(pullRequestDetailQuery.keyOf({ environmentId: ENV, cwd: CWD, number: null })).toBeNull();
  });
});

describe("teardown", () => {
  it("forgets one node's pull requests and keeps another's", async () => {
    setSourceControl(ENV, { listChangeRequests: async () => [row(1)] });
    setSourceControl(OTHER_ENV, { listChangeRequests: async () => [row(2)] });
    const mine = { environmentId: ENV, cwd: CWD, state: "open", limit: 100 } as const;
    const theirs = { environmentId: OTHER_ENV, cwd: CWD, state: "open", limit: 100 } as const;
    const releaseMine = pullRequestListQuery.watch(mine);
    const releaseTheirs = pullRequestListQuery.watch(theirs);
    await flush();
    releaseMine();
    releaseTheirs();

    clearPullRequestStateForEnvironment(ENV);

    expect(pullRequestListQuery.getSnapshot(pullRequestListQuery.keyOf(mine)).data).toBeNull();
    expect(
      pullRequestListQuery
        .getSnapshot(pullRequestListQuery.keyOf(theirs))
        .data?.map((e) => e.number),
    ).toEqual([2]);
  });
});
