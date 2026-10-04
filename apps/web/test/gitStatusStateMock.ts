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

import type { GitStatusState } from "../src/lib/gitStatusState";

const IDLE_GIT_STATUS: GitStatusState = { data: null, error: null, cause: null, isPending: false };

let refreshResult: VcsStatusResult | null = null;

/** What a one-off `refreshGitStatus` read returns until the next reset (default: unknown). */
export function setGitStatusRefreshResultForTests(result: VcsStatusResult | null): void {
  refreshResult = result;
}

export function useGitStatus(): GitStatusState {
  return IDLE_GIT_STATUS;
}

export function refreshGitStatus(): Promise<VcsStatusResult | null> {
  return Promise.resolve(refreshResult);
}

export function resetGitStatusStateForTests(): void {
  refreshResult = null;
}
