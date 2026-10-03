/**
 * Test-only git reads for the create dialog: a `vi.mock("~/rpc/useGit")`
 * factory serving refs and status from `createPullRequestGitMock`, and an
 * environment API whose `vcs.listRefs` answers the dialog's remote lookup from
 * `originBranches`. Imports only contracts and fixtures (never the modules it
 * replaces), so it is safe to `import()` inside a `vi.mock` factory:
 *
 * ```ts
 * vi.mock("~/rpc/useGit", async (importOriginal) => {
 *   const { createUseGitMock } = await import(
 *     "~/components/pullRequests/create/createPullRequestGitMock"
 *   );
 *   return createUseGitMock(await importOriginal());
 * });
 * ```
 */
import type {
  EnvironmentApi,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRef,
  VcsStatusResult,
} from "@ryco/contracts";

import { fixtureProvider } from "../testing/pullRequestFixtures";

export const FIXTURE_CURRENT_BRANCH = "ryco/create-pr-dialog";

export function fixtureLocalRef(name: string, extra: Partial<VcsRef> = {}): VcsRef {
  return { name, current: false, isDefault: false, worktreePath: null, isRemote: false, ...extra };
}

export function fixtureRemoteRef(name: string): VcsRef {
  return {
    name: `origin/${name}`,
    current: false,
    isDefault: false,
    worktreePath: null,
    isRemote: true,
    remoteName: "origin",
  };
}

/** The checkout's refs, in the server's order (current, default, recent; then remote-only). */
export function fixtureRefs(): VcsRef[] {
  return [
    fixtureLocalRef(FIXTURE_CURRENT_BRANCH, { current: true }),
    fixtureLocalRef("main", { isDefault: true }),
    fixtureLocalRef("ryco/local-only"),
    fixtureLocalRef("ryco/pushed-elsewhere"),
    fixtureLocalRef("mvogt/pr-diff-virtualization"),
    fixtureRemoteRef("release/2026.10"),
  ];
}

export function fixtureGitStatus(patch: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    sourceControlProvider: fixtureProvider,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: FIXTURE_CURRENT_BRANCH,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...patch,
  };
}

export const createPullRequestGitMock = {
  refs: fixtureRefs(),
  status: fixtureGitStatus() as VcsStatusResult | null,
  statusPending: false,
  /** Branches `origin` has, for the remote lookup of non-current local branches. */
  originBranches: new Set<string>([
    FIXTURE_CURRENT_BRANCH,
    "main",
    "ryco/pushed-elsewhere",
    "mvogt/pr-diff-virtualization",
    "release/2026.10",
  ]),
  /** Every remote lookup, in order. */
  listRefsCalls: [] as VcsListRefsInput[],
  reset(): void {
    createPullRequestGitMock.refs = fixtureRefs();
    createPullRequestGitMock.status = fixtureGitStatus();
    createPullRequestGitMock.statusPending = false;
    createPullRequestGitMock.originBranches = new Set([
      FIXTURE_CURRENT_BRANCH,
      "main",
      "ryco/pushed-elsewhere",
      "mvogt/pr-diff-virtualization",
      "release/2026.10",
    ]);
    createPullRequestGitMock.listRefsCalls.length = 0;
  },
};

const NOOP = () => undefined;

export function createUseGitMock<T extends object>(original: T) {
  return {
    ...original,
    useGitBranches: (target: { cwd: string | null; query: string }) => {
      const needle = target.query.toLowerCase();
      const refs =
        target.cwd === null
          ? []
          : createPullRequestGitMock.refs.filter((ref) => ref.name.toLowerCase().includes(needle));
      return {
        refs,
        totalCount: refs.length,
        hasNextPage: false,
        isFetchingNextPage: false,
        isPending: false,
        error: null,
        fetchNextPage: NOOP,
        refresh: NOOP,
      };
    },
    useGitStatus: (target: { cwd: string | null }) => ({
      data: target.cwd === null ? null : createPullRequestGitMock.status,
      error: null,
      cause: null,
      isPending: createPullRequestGitMock.statusPending,
    }),
    refreshGitStatus: async () => createPullRequestGitMock.status,
  };
}

/** `vcs.listRefs({ originOnly })` over `originBranches`; install with `__setEnvironmentApiOverrideForTests`. */
export function createPullRequestEnvironmentApi(): EnvironmentApi {
  const listRefs = async (input: VcsListRefsInput): Promise<VcsListRefsResult> => {
    createPullRequestGitMock.listRefsCalls.push(input);
    const refs = [...createPullRequestGitMock.originBranches]
      .map(fixtureRemoteRef)
      .filter((ref) => ref.name.includes(input.query ?? ""));
    return {
      refs,
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: refs.length,
    };
  };
  return { vcs: { listRefs } } as unknown as EnvironmentApi;
}
