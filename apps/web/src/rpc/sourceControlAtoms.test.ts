import { hostedHubStore } from "@ryco/client-runtime/authorization";
import { classifyOverviewError } from "~/components/overview/overviewErrors.logic";
import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mode = vi.hoisted(() => ({ hosted: false }));
vi.mock("~/env", () => ({ isHostedHubMode: () => mode.hosted }));

const {
  listIssues,
  listChangeRequests,
  searchIssues,
  searchChangeRequests,
  listIssueLabels,
  listIssueAssignees,
  getIssue,
  getChangeRequestDetail,
  listWorkflowRuns,
  getWorkflowRunJobs,
  mergeChangeRequest,
} = vi.hoisted(() => ({
  listIssues: vi.fn(),
  listChangeRequests: vi.fn(),
  searchIssues: vi.fn(),
  searchChangeRequests: vi.fn(),
  listIssueLabels: vi.fn(),
  listIssueAssignees: vi.fn(),
  getIssue: vi.fn(),
  getChangeRequestDetail: vi.fn(),
  listWorkflowRuns: vi.fn(),
  getWorkflowRunJobs: vi.fn(),
  mergeChangeRequest: vi.fn(),
}));

vi.mock("~/environments/runtime", () => ({
  requireEnvironmentConnection: vi.fn(() => ({
    client: {
      sourceControl: {
        listIssues,
        listChangeRequests,
        searchIssues,
        searchChangeRequests,
        listIssueLabels,
        listIssueAssignees,
        getIssue,
        getChangeRequestDetail,
        listWorkflowRuns,
        getWorkflowRunJobs,
        mergeChangeRequest,
      },
    },
  })),
}));

import {
  changeRequestListBinding,
  changeRequestDetailBinding,
  fetchSourceControlChangeRequestDetail,
  fetchSourceControlIssueDetail,
  invalidateSourceControl,
  issueListBinding,
  issueSearchBinding,
  resetSourceControlAtomsForTests,
  workflowRunJobsBinding,
  workflowRunsBinding,
  mergeSourceControlChangeRequest,
} from "./sourceControlAtoms";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-other");
const CWD = "/tmp/workspace";
const OTHER_CWD = "/tmp/other";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function issue(number: number) {
  return {
    provider: "github",
    number,
    title: `Issue ${number}`,
    url: `https://example.test/issues/${number}`,
    state: "open",
  } as never;
}

function changeRequest(number: number) {
  return {
    provider: "github",
    number,
    title: `Pull request ${number}`,
    url: `https://example.test/pull/${number}`,
    state: "open",
  } as never;
}

beforeEach(() => {
  mode.hosted = false;
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetSourceControlAtomsForTests();
});

afterEach(() => {
  mode.hosted = false;
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.useRealTimers();
  resetSourceControlAtomsForTests();
});

describe("sourceControlAtoms — issue list", () => {
  it("does not fetch when the environment or cwd is missing or disabled", () => {
    issueListBinding.watch({ environmentId: null, cwd: CWD, state: "open" });
    issueListBinding.watch({ environmentId: ENVIRONMENT_ID, cwd: null, state: "open" });
    issueListBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      state: "open",
      enabled: false,
    });

    expect(listIssues).not.toHaveBeenCalled();
  });

  it("marks the first watch as loading and commits the resolved result", async () => {
    const deferred = createDeferred<unknown>();
    listIssues.mockReturnValueOnce(deferred.promise);

    const input = { environmentId: ENVIRONMENT_ID, cwd: CWD, state: "open" as const };
    const release = issueListBinding.watch(input);
    await flush();

    expect(listIssues).toHaveBeenCalledWith({ cwd: CWD, state: "open" });
    expect(issueListBinding.snapshotFor(input)).toEqual({
      data: null,
      isLoading: true,
      isFetching: true,
      error: null,
    });

    const data = [issue(1)];
    deferred.resolve(data);
    await flush();

    expect(issueListBinding.snapshotFor(input)).toEqual({
      data,
      isLoading: false,
      isFetching: false,
      error: null,
    });

    release();
  });

  it("dedupes concurrent watchers of the same scope", async () => {
    listIssues.mockReturnValue(createDeferred<unknown>().promise);

    const input = { environmentId: ENVIRONMENT_ID, cwd: CWD, state: "open" as const };
    const releaseA = issueListBinding.watch(input);
    const releaseB = issueListBinding.watch(input);
    await flush();

    expect(listIssues).toHaveBeenCalledTimes(1);
    releaseA();
    releaseB();
  });

  it("surfaces errors while keeping any previously committed data", async () => {
    const first = createDeferred<unknown>();
    listIssues.mockReturnValueOnce(first.promise);
    const input = { environmentId: ENVIRONMENT_ID, cwd: CWD, state: "open" as const };
    const release = issueListBinding.watch(input);
    await flush();
    const firstData = [issue(1)];
    first.resolve(firstData);
    await flush();

    vi.advanceTimersByTime(61_000);
    const second = createDeferred<unknown>();
    listIssues.mockReturnValueOnce(second.promise);
    invalidateSourceControl({ cwd: CWD });
    await flush();
    second.reject(new Error("boom"));
    await flush();

    const state = issueListBinding.snapshotFor(input);
    expect(state.data).toBe(firstData);
    expect(state.error).toEqual(new Error("boom"));
    expect(state.isFetching).toBe(false);

    release();
  });
});

describe("sourceControlAtoms — issue search gating", () => {
  it("only fetches when a non-empty query and enabled flag are present", async () => {
    issueSearchBinding.watch({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "" });
    issueSearchBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      query: "bug",
      enabled: false,
    });
    await flush();
    expect(searchIssues).not.toHaveBeenCalled();

    searchIssues.mockReturnValueOnce(Promise.resolve([issue(5)]));
    const release = issueSearchBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      query: "bug",
      enabled: true,
    });
    await flush();
    expect(searchIssues).toHaveBeenCalledWith({ cwd: CWD, query: "bug" });
    release();
  });
});

describe("sourceControlAtoms — change request list polling", () => {
  it("passes fetched data rather than query state into poll interval resolvers", async () => {
    const data = [changeRequest(1)];
    listChangeRequests.mockResolvedValue(data);
    const resolveIntervalMs = vi.fn((items: ReadonlyArray<unknown> | null) =>
      items?.some(() => false) ? 30_000 : false,
    );

    const input = { environmentId: ENVIRONMENT_ID, cwd: CWD, state: "open" as const };
    const release = changeRequestListBinding.watch(input, resolveIntervalMs);
    await flush();

    expect(listChangeRequests).toHaveBeenCalledWith({ cwd: CWD, state: "open" });
    expect(resolveIntervalMs).toHaveBeenCalledWith(data);
    expect(changeRequestListBinding.snapshotFor(input).data).toBe(data);

    release();
  });
});

describe("sourceControlAtoms — invalidation", () => {
  it("refetches mounted scopes for the matching cwd and leaves others untouched", async () => {
    listIssues.mockResolvedValue([issue(1)]);
    listChangeRequests.mockResolvedValue([]);

    const releaseTarget = issueListBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      state: "open",
    });
    const releaseOther = issueListBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: OTHER_CWD,
      state: "open",
    });
    await flush();
    expect(listIssues).toHaveBeenCalledTimes(2);
    listIssues.mockClear();

    invalidateSourceControl({ cwd: CWD });
    await flush();

    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith({ cwd: CWD, state: "open" });

    releaseTarget();
    releaseOther();
  });

  it("replaces an in-flight read and ignores its stale completion", async () => {
    const stale = createDeferred<unknown>();
    const freshData = [issue(2)];
    listIssues.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(freshData);
    const input = {
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      state: "open" as const,
    };

    const release = issueListBinding.watch(input);
    await flush();
    invalidateSourceControl({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    await flush();

    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(issueListBinding.snapshotFor(input).data).toBe(freshData);

    stale.resolve([issue(1)]);
    await flush();
    expect(issueListBinding.snapshotFor(input).data).toBe(freshData);
    release();
  });
});

describe("sourceControlAtoms — merge mutation", () => {
  it("calls the merge RPC and invalidates all source-control reads for the workspace", async () => {
    listChangeRequests.mockResolvedValue([changeRequest(42)]);
    getChangeRequestDetail.mockResolvedValue({ number: 42 } as never);
    mergeChangeRequest.mockResolvedValue({ outcome: "enqueued" });
    const listInput = { environmentId: ENVIRONMENT_ID, cwd: CWD, state: "open" as const };
    const release = changeRequestListBinding.watch(listInput);
    await flush();
    await fetchSourceControlChangeRequestDetail({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "42",
    });
    listChangeRequests.mockClear();

    await expect(
      mergeSourceControlChangeRequest({
        environmentId: ENVIRONMENT_ID,
        cwd: CWD,
        reference: "42",
        mergeMethod: "squash",
      }),
    ).resolves.toEqual({ outcome: "enqueued" });
    await flush();

    expect(mergeChangeRequest).toHaveBeenCalledWith({
      cwd: CWD,
      reference: "42",
      mergeMethod: "squash",
    });
    expect(listChangeRequests).toHaveBeenCalledWith({ cwd: CWD, state: "open" });
    await fetchSourceControlChangeRequestDetail({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "42",
    });
    expect(getChangeRequestDetail).toHaveBeenCalledTimes(2);
    release();
  });

  it("fails closed when the merge target is incomplete", async () => {
    await expect(
      mergeSourceControlChangeRequest({
        environmentId: ENVIRONMENT_ID,
        cwd: null,
        reference: "42",
        mergeMethod: "merge",
      }),
    ).rejects.toThrow("Pull request merging is unavailable.");
    expect(mergeChangeRequest).not.toHaveBeenCalled();
  });
});

describe("sourceControlAtoms — canonical workflow queries", () => {
  it("includes branch scope and joins duplicate workflow-run observers", async () => {
    const result = { provider: "github", runs: [], headSha: { _tag: "None" } };
    listWorkflowRuns.mockResolvedValue(result);
    const input = {
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      branch: "main",
      limit: 20,
    };

    const releaseOverview = workflowRunsBinding.watch(input, () => false);
    const releaseExplorer = workflowRunsBinding.watch(input, () => false);
    await flush();

    expect(listWorkflowRuns).toHaveBeenCalledTimes(1);
    expect(listWorkflowRuns).toHaveBeenCalledWith({ cwd: CWD, branch: "main", limit: 20 });
    expect(workflowRunsBinding.snapshotFor(input).data).toBe(result);
    releaseOverview();
    releaseExplorer();
  });

  it("joins duplicate per-run job observers", async () => {
    const result = { provider: "github", runId: "run-1", jobs: [] };
    getWorkflowRunJobs.mockResolvedValue(result);
    const input = { environmentId: ENVIRONMENT_ID, cwd: CWD, runId: "run-1" };

    const releaseOverview = workflowRunJobsBinding.watch(input, () => 30_000);
    const releaseExplorer = workflowRunJobsBinding.watch(input, () => 60_000);
    await flush();

    expect(getWorkflowRunJobs).toHaveBeenCalledTimes(1);
    expect(getWorkflowRunJobs).toHaveBeenCalledWith({ cwd: CWD, runId: "run-1" });
    releaseOverview();
    releaseExplorer();
  });
});

describe("sourceControlAtoms — detail fetches", () => {
  it("caches issue detail within the stale window and dedupes in-flight requests", async () => {
    const deferred = createDeferred<unknown>();
    getIssue.mockReturnValueOnce(deferred.promise);

    const params = { environmentId: ENVIRONMENT_ID, cwd: CWD, reference: "42" };
    const first = fetchSourceControlIssueDetail(params);
    const second = fetchSourceControlIssueDetail(params);
    expect(getIssue).toHaveBeenCalledTimes(1);

    const detail = { id: "42" } as never;
    deferred.resolve(detail);
    await expect(first).resolves.toBe(detail);
    await expect(second).resolves.toBe(detail);

    await expect(fetchSourceControlIssueDetail(params)).resolves.toBe(detail);
    expect(getIssue).toHaveBeenCalledTimes(1);
  });

  it("re-fetches issue detail after invalidation clears the cache", async () => {
    getIssue
      .mockResolvedValueOnce({ id: "a" } as never)
      .mockResolvedValueOnce({ id: "b" } as never);
    const params = { environmentId: ENVIRONMENT_ID, cwd: CWD, reference: "42" };

    await fetchSourceControlIssueDetail(params);
    expect(getIssue).toHaveBeenCalledTimes(1);

    invalidateSourceControl({ environmentId: ENVIRONMENT_ID, cwd: CWD });

    await fetchSourceControlIssueDetail(params);
    expect(getIssue).toHaveBeenCalledTimes(2);
  });

  it("rejects detail lookups for incomplete targets", async () => {
    await expect(
      fetchSourceControlChangeRequestDetail({ environmentId: null, cwd: CWD, reference: "1" }),
    ).rejects.toThrow("Change request detail is unavailable.");
    expect(getChangeRequestDetail).not.toHaveBeenCalled();
  });

  it("scopes detail invalidation by environment", async () => {
    getIssue.mockResolvedValue({ id: "x" } as never);
    const params = { environmentId: ENVIRONMENT_ID, cwd: CWD, reference: "7" };
    await fetchSourceControlIssueDetail(params);
    expect(getIssue).toHaveBeenCalledTimes(1);

    // Invalidating a different environment must not drop this entry.
    invalidateSourceControl({ environmentId: OTHER_ENVIRONMENT_ID });
    await fetchSourceControlIssueDetail(params);
    expect(getIssue).toHaveBeenCalledTimes(1);
  });
});

describe("source-control reads in hosted previews", () => {
  const input = { environmentId: ENVIRONMENT_ID, cwd: CWD, reference: "1" };
  function live(environmentId = ENVIRONMENT_ID, generation = 1) {
    hostedHubStore.setState({
      account: { id: "account-a" } as never,
      session: { id: "session-a" } as never,
      nodes: [
        {
          id: String(environmentId),
          environmentId,
          effectiveRole: "operator",
          revokedAt: null,
          presence: { online: true, lastHeartbeatAt: 1 },
        },
      ] as never,
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "current",
      transportStatus: "online",
      sessionStatus: "ready",
      selectionStatus: "online",
      effectiveRole: "operator",
      generation,
      selectedNode: {
        id: String(environmentId),
        environmentId,
        presence: { online: true, lastHeartbeatAt: 1 },
      } as never,
    });
  }

  it("does not fetch an offline preview through another live node and resumes when its live read authority is ready", async () => {
    mode.hosted = true;
    live(OTHER_ENVIRONMENT_ID);
    getChangeRequestDetail.mockResolvedValue(changeRequest(1));
    const release = changeRequestDetailBinding.watch(input, () => 1_000);
    try {
      changeRequestDetailBinding.refresh(input);
      invalidateSourceControl({ environmentId: ENVIRONMENT_ID });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getChangeRequestDetail).not.toHaveBeenCalled();
      expect(changeRequestDetailBinding.snapshotFor(input)).toMatchObject({
        error: null,
        isFetching: false,
      });
      live(ENVIRONMENT_ID, 2);
      await flush();
      expect(getChangeRequestDetail).toHaveBeenCalledOnce();
      expect(changeRequestDetailBinding.snapshotFor(input).data).toEqual(changeRequest(1));
    } finally {
      release();
    }
  });

  it("fences a disconnected PR failure and a stale success across reconnect, keeping the overview error path quiet", async () => {
    mode.hosted = true;
    live();
    const old = createDeferred<unknown>();
    const recovery = createDeferred<unknown>();
    getChangeRequestDetail.mockReturnValueOnce(old.promise).mockReturnValueOnce(recovery.promise);
    const release = changeRequestDetailBinding.watch(input, () => 1_000);
    try {
      hostedHubStore.setState({ transportStatus: "reconnecting", sessionStatus: "stale" });
      old.reject(new Error("Connection closed"));
      await flush();
      expect(classifyOverviewError(changeRequestDetailBinding.snapshotFor(input).error)).toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getChangeRequestDetail).toHaveBeenCalledOnce();
      live(ENVIRONMENT_ID, 2);
      await flush();
      expect(getChangeRequestDetail).toHaveBeenCalledTimes(2);
      hostedHubStore.setState({ transportStatus: "reconnecting", sessionStatus: "stale" });
      getChangeRequestDetail.mockResolvedValue(changeRequest(3));
      live(ENVIRONMENT_ID, 3);
      await flush();
      recovery.resolve(changeRequest(2));
      await flush();
      expect(changeRequestDetailBinding.snapshotFor(input).data).toEqual(changeRequest(3));
      expect(classifyOverviewError(changeRequestDetailBinding.snapshotFor(input).error)).toBeNull();
    } finally {
      release();
    }
  });

  it("still publishes genuine PR errors on the current live connection", async () => {
    mode.hosted = true;
    live();
    getChangeRequestDetail.mockRejectedValue(new Error("unexpected provider failure"));
    const release = changeRequestDetailBinding.watch(input);
    await flush();
    expect(
      classifyOverviewError(changeRequestDetailBinding.snapshotFor(input).error)?.message,
    ).toBe("Couldn't load pull request details. Try refreshing.");
    release();
  });

  it("preserves the existing source-control role policy without issuing denied background reads", async () => {
    mode.hosted = true;
    live();
    hostedHubStore.setState({ effectiveRole: "viewer" });
    const release = changeRequestDetailBinding.watch(input);
    await flush();
    expect(getChangeRequestDetail).not.toHaveBeenCalled();
    expect(changeRequestDetailBinding.snapshotFor(input).error).toBeNull();
    release();
  });

  it.each(["role", "account", "session", "space", "sign-out", "revoked", "authorization-removed"])(
    "clears retained operator data when %s authority changes while already paused",
    async (change) => {
      mode.hosted = true;
      live();
      getChangeRequestDetail.mockResolvedValue(changeRequest(1));
      getIssue.mockResolvedValue({ id: "old" });
      const issueInput = { environmentId: ENVIRONMENT_ID, cwd: CWD, reference: "1" };
      const release = changeRequestDetailBinding.watch(input);
      await flush();
      await fetchSourceControlIssueDetail(issueInput);
      hostedHubStore.setState({ transportStatus: "reconnecting", sessionStatus: "stale" });
      expect(changeRequestDetailBinding.snapshotFor(input).data).toEqual(changeRequest(1));
      await fetchSourceControlIssueDetail(issueInput);
      expect(getIssue).toHaveBeenCalledOnce();
      if (change === "role") hostedHubStore.setState({ effectiveRole: "viewer" });
      else if (change === "account")
        hostedHubStore.setState({ account: { id: "account-b" } as never });
      else if (change === "space")
        hostedHubStore.setState({
          session: { id: "session-a", activeSpaceId: "space-b" } as never,
        });
      else if (change === "session")
        hostedHubStore.setState({ session: { id: "session-b" } as never });
      else if (change === "revoked" || change === "authorization-removed")
        hostedHubStore.setState({ selectionStatus: change, effectiveRole: null });
      else hostedHubStore.setState({ accountStatus: "signing-out" });
      expect(changeRequestDetailBinding.snapshotFor(input)).toMatchObject({
        data: null,
        error: null,
        isFetching: false,
      });
      live(ENVIRONMENT_ID, 2);
      await flush();
      await fetchSourceControlIssueDetail(issueInput);
      expect(getIssue).toHaveBeenCalledTimes(2);
      release();
    },
  );

  it("rejects imperative results from a revoked authority even after permission is restored", async () => {
    mode.hosted = true;
    live();
    const old = createDeferred<unknown>();
    getIssue.mockReturnValueOnce(old.promise).mockResolvedValue({ id: "new" });
    const issueInput = { environmentId: ENVIRONMENT_ID, cwd: CWD, reference: "1" };
    const pending = fetchSourceControlIssueDetail(issueInput);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    invalidateSourceControl({ environmentId: ENVIRONMENT_ID });
    hostedHubStore.setState({ account: { id: "account-b" } as never });
    live(ENVIRONMENT_ID, 2);
    old.resolve({ id: "old" });
    await rejected;
    expect(await fetchSourceControlIssueDetail(issueInput)).toEqual({ id: "new" });
  });

  it("allows reads after uncertain delivery was reconciled without allowing mutations", async () => {
    mode.hosted = true;
    live();
    hostedHubStore.setState({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    getChangeRequestDetail.mockResolvedValue(changeRequest(1));
    const release = changeRequestDetailBinding.watch(input);
    await flush();
    expect(getChangeRequestDetail).toHaveBeenCalledOnce();
    release();
  });
});
