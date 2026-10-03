import type { EnvironmentId } from "@ryco/contracts";
import { useCallback, useEffect, useState } from "react";

import { readEnvironmentApi } from "../../../environmentApi";
import { CREATE_PULL_REQUEST_REMOTE, type RemoteBranchPresence } from "./createPullRequest.logic";

/**
 * Whether `origin/<branch>` exists among the checkout's remote-tracking refs.
 * The default ref list hides a remote ref behind its local namesake, so this
 * asks for the remote's refs alone (no fetch: what the last fetch or push
 * recorded). `branch: null` skips the lookup.
 */
export function useRemoteBranchPresence(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly branch: string | null;
}): { readonly presence: RemoteBranchPresence; readonly recheck: () => void } {
  const { environmentId, cwd, branch } = input;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    readonly key: string;
    readonly presence: RemoteBranchPresence;
  } | null>(null);
  const key = `${environmentId}\0${cwd}\0${branch ?? ""}\0${attempt}`;

  useEffect(() => {
    if (branch === null) return;
    let cancelled = false;
    const remoteRef = `${CREATE_PULL_REQUEST_REMOTE}/${branch}`;
    const api = readEnvironmentApi(environmentId);
    const lookup = api
      ? api.vcs.listRefs({ cwd, originOnly: true, query: remoteRef, limit: 100 })
      : Promise.reject(new Error("Git refs are unavailable."));
    lookup.then(
      (refs) => {
        if (cancelled) return;
        const present = refs.refs.some((ref) => ref.isRemote && ref.name === remoteRef);
        setResult({ key, presence: present ? "present" : "absent" });
      },
      () => {
        if (!cancelled) setResult({ key, presence: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [branch, cwd, environmentId, key]);

  const recheck = useCallback(() => setAttempt((value) => value + 1), []);
  const presence: RemoteBranchPresence =
    branch === null ? "failed" : result?.key === key ? result.presence : "checking";
  return { presence, recheck };
}
