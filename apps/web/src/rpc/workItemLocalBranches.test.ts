import { EnvironmentId, type VcsRef } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { listRefs } = vi.hoisted(() => ({ listRefs: vi.fn() }));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: vi.fn(() => ({ vcs: { listRefs } })),
}));
vi.mock("~/environments/runtime", () => ({ requireEnvironmentConnection: vi.fn() }));

import {
  invalidateWorkItemLocalBranches,
  invalidateWorkItems,
  resetWorkItemsAtomsForTests,
  workItemLocalBranchesQuery,
} from "./workItemsAtoms";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CWD = "/tmp/workspace";

function ref(name: string): VcsRef {
  return { name, current: false, isDefault: false, worktreePath: null };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function snapshot(input: { readonly query?: string }) {
  return workItemLocalBranchesQuery.getSnapshot(
    workItemLocalBranchesQuery.keyOf({ environmentId: ENVIRONMENT_ID, cwd: CWD, ...input }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetWorkItemsAtomsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetWorkItemsAtomsForTests();
});

describe("workItemLocalBranchesQuery", () => {
  it("reads the checkout's refs, or only those matching a work item's key", async () => {
    listRefs.mockResolvedValue({ refs: [ref("feature/ABC-1")] });
    const releaseAll = workItemLocalBranchesQuery.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
    });
    const releaseOne = workItemLocalBranchesQuery.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      query: "ABC-1",
    });
    await flush();

    expect(listRefs).toHaveBeenCalledWith({ cwd: CWD, limit: 100 });
    expect(listRefs).toHaveBeenCalledWith({ cwd: CWD, query: "ABC-1", limit: 100 });
    expect(snapshot({}).data).toEqual([ref("feature/ABC-1")]);
    releaseAll();
    releaseOne();
  });

  it("is refreshed by its own invalidation, not by the work items'", async () => {
    listRefs.mockResolvedValue({ refs: [] });
    const release = workItemLocalBranchesQuery.watch({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    await flush();
    expect(listRefs).toHaveBeenCalledTimes(1);

    invalidateWorkItems({ environmentId: ENVIRONMENT_ID });
    await flush();
    expect(listRefs).toHaveBeenCalledTimes(1);

    invalidateWorkItemLocalBranches();
    await flush();
    expect(listRefs).toHaveBeenCalledTimes(2);
    release();
  });

  it("shows no refs once a read failed after its retries", async () => {
    listRefs.mockResolvedValueOnce({ refs: [ref("main")] });
    const release = workItemLocalBranchesQuery.watch({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    await flush();
    expect(snapshot({}).data).toEqual([ref("main")]);

    listRefs.mockRejectedValue(new Error("offline"));
    invalidateWorkItemLocalBranches();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(listRefs).toHaveBeenCalledTimes(5);
    expect(snapshot({})).toMatchObject({ data: null, isError: true });
    release();
  });
});
