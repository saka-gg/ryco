import { useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import { wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";
import { useEffect, useState } from "react";
import type { EnvironmentId, VcsStatusResult } from "@ryco/contracts";
import { readEnvironmentApi } from "../../connection/environmentApi";
import {
  readRepositoryStatus,
  recordRepositoryFailure,
  recordRepositoryStatus,
  UNKNOWN_REPOSITORY_STATUS,
  type RepositoryStatusRead,
  type RepositoryStatusSnapshot,
} from "./repositoryStatus";
const noEnvironmentAtom = Atom.make(null);

/**
 * Read a checkout's VCS status on its own machine, without borrowing another machine's branch:
 * the status once it arrives, or the failure of the last refresh, so a caller can stop waiting
 * (`resolveThreadForkSourceGit` treats a failed read as not a repository).
 */
export function useRepositoryStatus(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): RepositoryStatusRead {
  const connection = useAtomValue(
    environmentId ? wsConnectionStatusForEnvironmentAtom(environmentId) : noEnvironmentAtom,
  );
  const api =
    environmentId && connection?.phase === "connected" ? readEnvironmentApi(environmentId) : null;
  const [snapshot, setSnapshot] = useState<RepositoryStatusSnapshot<{
    api: typeof api;
    connection: typeof connection;
    cwd: string;
  }> | null>(null);

  useEffect(() => {
    if (!api || !cwd) return;
    let current = true;
    const scope = { api, connection, cwd };
    const publish = (status: VcsStatusResult) => {
      if (current) setSnapshot(recordRepositoryStatus(scope, status));
    };
    const refresh = () => {
      void api.vcs
        .refreshStatus({ cwd })
        .then(publish)
        .catch((error: unknown) => {
          if (current) setSnapshot((previous) => recordRepositoryFailure(previous, scope, error));
        });
    };
    refresh();
    const unsubscribe = api.vcs.onStatus({ cwd }, publish, { onResubscribe: refresh });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [api, connection, cwd]);

  return api && cwd
    ? readRepositoryStatus(snapshot, { api, connection, cwd })
    : UNKNOWN_REPOSITORY_STATUS;
}

/** Read the selected project's checkout without borrowing another machine's branch. */
export function useNewTaskRepository(environmentId: EnvironmentId | null, cwd: string | null) {
  return useRepositoryStatus(environmentId, cwd).data;
}
