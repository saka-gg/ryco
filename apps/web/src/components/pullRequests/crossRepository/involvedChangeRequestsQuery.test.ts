import { hostedHubStore } from "@ryco/client-runtime/authorization";
import { EnvironmentId } from "@ryco/contracts";
import type { SourceControlInvolvedChangeRequestsResult } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/env", () => ({ isHostedHubMode: () => false }));

const { listInvolvedChangeRequests, mergeChangeRequest, submitChangeRequestReview } = vi.hoisted(
  () => ({
    listInvolvedChangeRequests: vi.fn(),
    mergeChangeRequest: vi.fn(),
    submitChangeRequestReview: vi.fn(),
  }),
);

vi.mock("~/environments/runtime", () => ({
  requireEnvironmentConnection: vi.fn(() => ({
    client: {
      sourceControl: { listInvolvedChangeRequests, mergeChangeRequest, submitChangeRequestReview },
    },
  })),
}));

import {
  invalidateSourceControl,
  mergeSourceControlChangeRequest,
  resetSourceControlAtomsForTests,
  submitChangeRequestReview as submitReview,
} from "~/rpc/sourceControlAtoms";
import {
  CROSS_REPOSITORY_LOADING_RETRY_MS,
  crossRepositoryPollDelay,
  involvedChangeRequestsBinding,
  requestInvolvedChangeRequestsRefresh,
  resetInvolvedChangeRequestsForTests,
  type InvolvedChangeRequestsInput,
} from "./involvedChangeRequestsQuery";

const LOCAL = EnvironmentId.make("environment-local");
const OTHER = EnvironmentId.make("environment-other");

const hosts: InvolvedChangeRequestsInput = {
  environmentId: LOCAL,
  sources: "hosts",
  cwds: ["/repo/app"],
  state: "open",
};
const repositories: InvolvedChangeRequestsInput = {
  environmentId: LOCAL,
  sources: "all",
  cwds: ["/repo/tools"],
  state: "open",
};
const otherNode: InvolvedChangeRequestsInput = { ...hosts, environmentId: OTHER };

function answer(
  overrides: Partial<SourceControlInvolvedChangeRequestsResult> = {},
): SourceControlInvolvedChangeRequestsResult {
  return { entries: [], sources: [], skippedCwds: [], truncated: false, ...overrides };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetSourceControlAtomsForTests();
  resetInvolvedChangeRequestsForTests();
  listInvolvedChangeRequests.mockResolvedValue(answer());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("involved change requests reads", () => {
  it("keys each read by node, state, sources and checkouts", () => {
    const key = involvedChangeRequestsBinding.targetKey(hosts);
    expect(key).not.toBe(involvedChangeRequestsBinding.targetKey(repositories));
    expect(key).not.toBe(involvedChangeRequestsBinding.targetKey(otherNode));
    expect(key).not.toBe(involvedChangeRequestsBinding.targetKey({ ...hosts, state: "merged" }));
    expect(key).not.toBe(
      involvedChangeRequestsBinding.targetKey({ ...hosts, cwds: ["/repo/app", "/repo/api"] }),
    );
    expect(involvedChangeRequestsBinding.targetKey({ ...hosts, cwds: [] })).toBeNull();
  });

  it("asks ahead of background work while nothing is shown, then polls in the background", async () => {
    const release = involvedChangeRequestsBinding.watch(hosts);
    await flush();
    expect(listInvolvedChangeRequests).toHaveBeenLastCalledWith({
      cwds: ["/repo/app"],
      state: "open",
      involvements: ["review-requested", "authored"],
      limit: 100,
      sources: "hosts",
      interactive: true,
    });
    involvedChangeRequestsBinding.refresh(hosts);
    await flush();
    expect(listInvolvedChangeRequests).toHaveBeenLastCalledWith({
      cwds: ["/repo/app"],
      state: "open",
      involvements: ["review-requested", "authored"],
      limit: 100,
      sources: "hosts",
    });
    release();
  });

  it("passes refresh exactly once after Refresh", async () => {
    const release = involvedChangeRequestsBinding.watch(repositories);
    await flush();
    requestInvolvedChangeRequestsRefresh([repositories]);
    await flush();
    expect(listInvolvedChangeRequests).toHaveBeenLastCalledWith(
      expect.objectContaining({ refresh: true }),
    );
    expect(listInvolvedChangeRequests.mock.lastCall?.[0]).not.toHaveProperty("sources");
    involvedChangeRequestsBinding.refresh(repositories);
    await flush();
    expect(listInvolvedChangeRequests.mock.lastCall?.[0]).not.toHaveProperty("refresh");
    release();
  });

  it("asks again soon while a source is still loading", () => {
    expect(
      crossRepositoryPollDelay(
        "manual",
        answer({
          sources: [
            {
              scope: "repository",
              provider: "gitlab",
              name: "acme/tools",
              status: "loading",
              truncated: false,
            },
          ],
        }),
      ),
    ).toBe(CROSS_REPOSITORY_LOADING_RETRY_MS);
    expect(crossRepositoryPollDelay("automatic", answer())).toBe(5 * 60_000);
    expect(crossRepositoryPollDelay("manual", answer())).toBe(false);
  });
});

describe("involved change requests invalidation", () => {
  async function watchBoth() {
    const releases = [
      involvedChangeRequestsBinding.watch(hosts),
      involvedChangeRequestsBinding.watch(otherNode),
    ];
    await flush();
    listInvolvedChangeRequests.mockClear();
    return () => releases.forEach((release) => release());
  }

  const calledFor = () =>
    listInvolvedChangeRequests.mock.calls.map((call) => (call[0] as { cwds: string[] }).cwds);

  it("rereads the environment's lists after a merge, not other nodes'", async () => {
    const release = await watchBoth();
    mergeChangeRequest.mockResolvedValue({ status: "merged" });
    await mergeSourceControlChangeRequest({
      environmentId: LOCAL,
      cwd: "/repo/somewhere-else",
      reference: "12",
      mergeMethod: "squash",
    });
    await flush();
    expect(listInvolvedChangeRequests).toHaveBeenCalledTimes(1);
    expect(involvedChangeRequestsBinding.snapshotFor(otherNode).data).not.toBeNull();
    release();
  });

  it("rereads after a mutation that changes list rows (a review)", async () => {
    const release = await watchBoth();
    submitChangeRequestReview.mockResolvedValue({ detail: null });
    await submitReview({ environmentId: LOCAL, cwd: "/repo/other", reference: "12" }, {
      event: "approve",
      body: "",
    } as never).catch(() => undefined);
    await flush();
    expect(calledFor()).toEqual([["/repo/app"]]);
    release();
  });

  it("rereads after a checkout's manual refresh", async () => {
    const release = await watchBoth();
    invalidateSourceControl({ environmentId: OTHER, cwd: "/repo/any" });
    await flush();
    expect(listInvolvedChangeRequests).toHaveBeenCalledTimes(1);
    release();
  });
});
