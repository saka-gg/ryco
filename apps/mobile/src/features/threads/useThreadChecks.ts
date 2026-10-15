import type { EnvironmentId } from "@ryco/contracts";
import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import { useEffect, useState } from "react";

import { readRpcClient } from "../../connection/environmentApi";
import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { useWsConnectionStatusForEnvironment } from "../../rpc/wsConnectionState";
import { buildCheckSummary, type CheckRollupItemInput, type CheckSummary } from "./prCheckSummary";

// Fetches the CI check rollup for the thread that is currently open, and only
// that one.
//
// Deliberately not done for inbox rows: checks are keyed by cwd + PR number, so
// an inbox of N threads across M worktrees means M round trips on every render
// of the list. That is a battery decision, not a UI one, and it needs a caching
// and polling story this does not have. One open thread, one lookup, on mount.
//
// Every failure path lands on `available: false`, which renders as "unknown"
// rather than as a neutral or green state — a device whose role or provider auth
// forbids the call must not look like a PR with passing checks.

// Lives outside the hook so React Compiler can compile it: the compiler cannot
// lower optional or conditional expressions inside a try/catch.
async function readCheckSummary(
  client: WsRpcClient,
  cwd: string,
  prNumber: number,
): Promise<CheckSummary> {
  try {
    const detail = await client.sourceControl.getChangeRequestDetail({
      cwd,
      reference: String(prNumber),
    });
    const rollup = (detail as { checkRollup?: ReadonlyArray<CheckRollupItemInput> }).checkRollup;
    return buildCheckSummary({
      // A detail response with no rollup field at all is not "no checks" —
      // the provider did not tell us, so it stays unknown.
      available: rollup !== undefined,
      items: rollup ?? null,
    });
  } catch {
    // Refused by role, provider unauthenticated, node offline — all the same
    // to the user: we do not know.
    return buildCheckSummary({ available: false });
  }
}

export function useThreadChecks(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly prNumber: number | null;
}): CheckSummary | null {
  const { environmentId, cwd, prNumber } = input;
  const [summary, setSummary] = useState<CheckSummary | null>(null);
  // Wave 3a: `readRpcClient` is snapshotted once per effect run, and a thread
  // opened from cache has no client yet — the retarget lands one a moment
  // later. Without this dep the badge would be stuck on "unknown" for the whole
  // life of the screen even after the node came live. The environment's own
  // socket phase flips to "connected" exactly when a client exists to read.
  const connectionPhase = useWsConnectionStatusForEnvironment(environmentId).phase;

  useEffect(() => {
    // No PR means there is nothing to summarise — distinct from a PR whose
    // checks we failed to read, so render nothing at all rather than "unknown".
    if (!cwd || prNumber === null) {
      setSummary(null);
      return;
    }

    let cancelled = false;
    const releaseVcsScope = mobileHostedConnectionScopes.retain(environmentId, {
      type: "vcs-status",
      cwd,
    });
    const client = readRpcClient(environmentId);
    if (!client) {
      setSummary(buildCheckSummary({ available: false }));
      return releaseVcsScope;
    }

    void readCheckSummary(client, cwd, prNumber).then((next) => {
      if (!cancelled) setSummary(next);
    });

    return () => {
      cancelled = true;
      releaseVcsScope();
    };
  }, [connectionPhase, cwd, environmentId, prNumber]);

  return summary;
}
