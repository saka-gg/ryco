/**
 * Stand-in for `~/lib/gitStatusState` in browser suites that never assert on
 * git status. Register it from the suite file itself:
 *
 *   vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));
 *
 * Vitest hoists `vi.mock` only within the module that calls it. A mock
 * registered from a shared helpers module runs after the suite's own static
 * imports have already loaded the real module, so it silently has no effect.
 */
import type { VcsStatusResult } from "@ryco/contracts";

import type { GitStatusState, GitStatusTarget } from "../src/lib/gitStatusState";

const IDLE_GIT_STATUS: GitStatusState = { data: null, error: null, cause: null, isPending: false };

let localRefName: string | null | undefined;
let folderStatus: GitStatusState = IDLE_GIT_STATUS;
const watchedCwds = new Set<string>();

/** What a one-off `readLocalGitRefName` read returns until the next reset (default: unknown). */
export function setLocalGitRefNameForTests(refName: string | null | undefined): void {
  localRefName = refName;
}

/**
 * What `useGitStatus` reports for every folder it is asked about until the next
 * reset (default: nothing loaded). A watch without a folder stays idle.
 */
export function setGitStatusForTests(status: VcsStatusResult | null): void {
  folderStatus = status ? { ...IDLE_GIT_STATUS, data: status } : IDLE_GIT_STATUS;
}

/** Every folder an enabled `useGitStatus` watched since the last reset. */
export function watchedGitStatusCwdsForTests(): ReadonlySet<string> {
  return watchedCwds;
}

export function useGitStatus(
  target?: GitStatusTarget,
  options?: { readonly enabled?: boolean | undefined },
): GitStatusState {
  if (target?.cwd && options?.enabled !== false) watchedCwds.add(target.cwd);
  return target?.cwd ? folderStatus : IDLE_GIT_STATUS;
}

export function refreshGitStatus(): Promise<VcsStatusResult | null> {
  return Promise.resolve(null);
}

export function readLocalGitRefName(): Promise<string | null | undefined> {
  return Promise.resolve(localRefName);
}

export function resetGitStatusStateForTests(): void {
  localRefName = undefined;
  folderStatus = IDLE_GIT_STATUS;
  watchedCwds.clear();
}
