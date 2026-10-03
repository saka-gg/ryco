import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useEffect, useState } from "react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});
// Every git status push is a fresh object (as in the app).
vi.mock("~/lib/gitStatusState", () => {
  const idle = { data: null, error: null, cause: null, isPending: false };
  return {
    useGitStatus: () => ({
      ...idle,
      data: {
        sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      },
    }),
    getGitStatusSnapshot: () => idle,
    watchGitStatus: () => () => undefined,
    refreshGitStatus: () => Promise.resolve(null),
    resetGitStatusStateForTests: () => undefined,
  };
});

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { PullRequestsSearch } from "./pullRequestsSearch";
import {
  fixtureRepositoryOption,
  resetPullRequestsTestState,
} from "./testing/PullRequestsTestProvider";
import { usePullRequestsModel, type PullRequestsModel } from "./usePullRequestsModel";

afterEach(() => resetPullRequestsTestState());

const seen: PullRequestsModel[] = [];
let rerender: (() => void) | null = null;
let navigate: ((search: PullRequestsSearch) => void) | null = null;

function Probe(props: { readonly initial: PullRequestsSearch }) {
  const [, setTick] = useState(0);
  const [search, setSearch] = useState(props.initial);
  // Hand the test its controls once mounted (writing module state is an effect).
  useEffect(() => {
    rerender = () => setTick((tick) => tick + 1);
    navigate = setSearch;
  }, []);
  seen.push(usePullRequestsModel({ repository: fixtureRepositoryOption, search }));
  return null;
}

describe("usePullRequestsModel", () => {
  it("keeps the model's identity across unrelated renders, and the list's across URL moves", async () => {
    seen.length = 0;
    await render(
      <AppAtomRegistryProvider>
        <Probe initial={{ pr: 703 }} />
      </AppAtomRegistryProvider>,
    );
    await expect.poll(() => seen.at(-1)?.selection?.detail.data?.number).toBe(703);
    await expect.poll(() => seen.at(-1)?.selection?.activity.data !== null).toBe(true);
    const settled = seen.at(-1)!;

    // A render caused by something else (thread traffic, git status pushes).
    rerender?.();
    await expect.poll(() => seen.length).toBeGreaterThan(seen.indexOf(settled) + 1);
    expect(seen.at(-1)).toBe(settled);

    // A tab switch changes the URL but not what the list or the selection read.
    navigate?.({ pr: 703, tab: "checks" });
    await expect.poll(() => seen.length).toBeGreaterThan(seen.lastIndexOf(settled) + 1);
    const moved = seen.at(-1)!;
    expect(moved.list).toBe(settled.list);
    expect(moved.selection?.threads).toBe(settled.selection?.threads);
  });

  it("reads no pull request without a resolved repository", async () => {
    seen.length = 0;
    function Unresolved() {
      seen.push(usePullRequestsModel({ repository: null, search: { pr: 703 } }));
      return null;
    }
    await render(
      <AppAtomRegistryProvider>
        <Unresolved />
      </AppAtomRegistryProvider>,
    );
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.selection).toBeNull();
  });
});
