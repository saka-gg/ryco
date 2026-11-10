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
  clearPullRequestCache,
  clearPullRequestStateForEnvironment,
  pullRequestCacheBytes,
  pullRequestRepositoryLabelsQuery,
  pullRequestRepositoryPeopleQuery,
  pullRequestDetailQuery,
  pullRequestDiffQuery,
  pullRequestListQuery,
  PullRequestNodeOfflineError,
  refreshPullRequestReads,
  resetPullRequestAtomsForTests,
} from "./pullRequestAtoms";
import { resetSavedQueryStoreForTests, setSavedQueryStore } from "./savedQueries";
import { createMemorySavedQueryStore } from "./savedQueries.testSupport";

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
  resetSavedQueryStoreForTests();
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

  it("keeps each live read and shows it first the next time, while the node reads again", async () => {
    const store = createMemorySavedQueryStore();
    setSavedQueryStore(store);
    const input = {
      environmentId: ENV,
      cwd: CWD,
      state: "open",
      limit: PULL_REQUESTS_LIST_LIMIT,
    } as const;
    setSourceControl(ENV, { listChangeRequests: vi.fn(async () => [row(1)]) });
    const live = pullRequestListQuery.watch(input);
    await flush();
    live();
    await store.flush();
    expect(store.rows.size).toBe(1);

    // The node goes away; a fresh cache shows the kept copy with the offline error.
    resetPullRequestAtomsForTests();
    mocks.clients.clear();
    const offline = pullRequestListQuery.watch(input);
    await flush();
    let state = pullRequestListQuery.getSnapshot(pullRequestListQuery.keyOf(input));
    expect(state.data).toEqual([row(1)]);
    expect(state.savedAt).toBe(1);
    expect(state.error).toBeInstanceOf(PullRequestNodeOfflineError);
    offline();

    // Back online: the kept copy shows at once, and the live answer replaces it.
    resetPullRequestAtomsForTests();
    let answer: (rows: ChangeRequest[]) => void = () => {};
    setSourceControl(ENV, {
      listChangeRequests: vi.fn(
        () =>
          new Promise<ChangeRequest[]>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const online = pullRequestListQuery.watch(input);
    await flush();
    state = pullRequestListQuery.getSnapshot(pullRequestListQuery.keyOf(input));
    expect(state).toMatchObject({ data: [row(1)], isLoading: false, isFetching: true });
    answer([row(2)]);
    await flush();
    state = pullRequestListQuery.getSnapshot(pullRequestListQuery.keyOf(input));
    expect(state).toMatchObject({ data: [row(2)], savedAt: null, isFetching: false });
    online();
    await store.flush();
    expect([...store.rows.values()][0]?.payload).toContain('"number":2');

    // Nothing kept for a pull request: the offline error stays.
    mocks.clients.clear();
    const detail = { environmentId: ENV, cwd: CWD, number: 9 };
    const releaseDetail = pullRequestDetailQuery.watch(detail);
    await flush();
    expect(pullRequestDetailQuery.getSnapshot(pullRequestDetailQuery.keyOf(detail))).toMatchObject({
      data: null,
    });
    expect(
      pullRequestDetailQuery.getSnapshot(pullRequestDetailQuery.keyOf(detail)).error,
    ).toBeInstanceOf(PullRequestNodeOfflineError);
    releaseDetail();
  });

  it("has no key until the checkout and number are known", () => {
    expect(pullRequestDetailQuery.keyOf({ environmentId: ENV, cwd: null, number: 7 })).toBeNull();
    expect(pullRequestDetailQuery.keyOf({ environmentId: ENV, cwd: CWD, number: null })).toBeNull();
  });
});

describe("refresh after a change", () => {
  it("reads again only what the change made stale", async () => {
    const getChangeRequestDetail = vi.fn(async (input: { reference: string }) => ({
      ...row(Number(input.reference)),
      body: "",
    }));
    const listChangeRequests = vi.fn(async () => [row(7), row(8)]);
    const getChangeRequestDiff = vi.fn(async () => PATCH);
    setSourceControl(ENV, { getChangeRequestDetail, listChangeRequests, getChangeRequestDiff });
    const releases = [
      pullRequestDetailQuery.watch({ environmentId: ENV, cwd: CWD, number: 7 }),
      pullRequestDetailQuery.watch({ environmentId: ENV, cwd: CWD, number: 8 }),
      pullRequestListQuery.watch({ environmentId: ENV, cwd: CWD, state: "open", limit: 100 }),
      pullRequestDiffQuery.watch({ environmentId: ENV, cwd: CWD, number: 7, headSha: "abc1234" }),
    ];
    await flush();
    expect([
      getChangeRequestDetail.mock.calls.length,
      listChangeRequests.mock.calls.length,
      getChangeRequestDiff.mock.calls.length,
    ]).toEqual([2, 1, 1]);

    // A review moves #7's detail and the list rows, never a diff or another pull request.
    refreshPullRequestReads({
      environmentId: ENV,
      cwd: CWD,
      number: 7,
      scope: { checkout: false, detail: true, activity: true, lists: true },
    });
    await flush();
    expect(getChangeRequestDetail.mock.calls.map(([input]) => input.reference)).toEqual([
      "7",
      "8",
      "7",
    ]);
    expect(listChangeRequests).toHaveBeenCalledTimes(2);
    expect(getChangeRequestDiff).toHaveBeenCalledTimes(1);

    // A merge moves the whole checkout.
    refreshPullRequestReads({
      environmentId: ENV,
      cwd: CWD,
      number: 7,
      scope: { checkout: true, detail: false, activity: false, lists: false },
    });
    await flush();
    expect(getChangeRequestDetail).toHaveBeenCalledTimes(5);
    expect(listChangeRequests).toHaveBeenCalledTimes(3);
    expect(getChangeRequestDiff).toHaveBeenCalledTimes(2);
    for (const release of releases) release();
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

describe("repository people and labels", () => {
  it("are kept in the pull request cache: counted and cleared in Storage, dropped with the node", async () => {
    setSourceControl(ENV, {
      listIssueAssignees: async () => [{ login: "ada" }],
      listIssueLabels: async () => [{ name: "bug", color: "d73a4a" }],
    });
    const input = { environmentId: ENV, cwd: CWD } as const;
    const releasePeople = pullRequestRepositoryPeopleQuery.watch(input);
    const releaseLabels = pullRequestRepositoryLabelsQuery.watch(input);
    await flush();
    const peopleKey = pullRequestRepositoryPeopleQuery.keyOf(input);
    const labelsKey = pullRequestRepositoryLabelsQuery.keyOf(input);
    expect(pullRequestRepositoryPeopleQuery.getSnapshot(peopleKey).data).toEqual([
      { login: "ada" },
    ]);
    releasePeople();
    releaseLabels();
    expect(pullRequestCacheBytes(ENV)).toBeGreaterThan(0);

    clearPullRequestCache(ENV);
    expect(pullRequestRepositoryPeopleQuery.getSnapshot(peopleKey).data).toBeNull();
    expect(pullRequestCacheBytes(ENV)).toBe(0);

    const again = pullRequestRepositoryLabelsQuery.watch(input);
    await flush();
    again();
    clearPullRequestStateForEnvironment(ENV);
    expect(pullRequestRepositoryLabelsQuery.getSnapshot(labelsKey).data).toBeNull();
  });
});
