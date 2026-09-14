import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";
import { useEffect, useState } from "react";
import type { EnvironmentId, VcsStatusResult } from "@ryco/contracts";
import { readEnvironmentApi } from "../../connection/environmentApi";
const noEnvironmentAtom = Atom.make(null);

/** Read the selected project's checkout without borrowing another machine's branch. */
export function useNewTaskRepository(environmentId: EnvironmentId | null, cwd: string | null) {
  const connection = useAtomValue(
    environmentId ? wsConnectionStatusForEnvironmentAtom(environmentId) : noEnvironmentAtom,
  );
  const api =
    environmentId && connection?.phase === "connected" ? readEnvironmentApi(environmentId) : null;
  const [snapshot, setSnapshot] = useState<{
    api: typeof api;
    connection: typeof connection;
    cwd: string;
    status: VcsStatusResult;
  } | null>(null);

  useEffect(() => {
    if (!api || !cwd) return;
    let current = true;
    const publish = (status: VcsStatusResult) => {
      if (current) setSnapshot({ api, connection, cwd, status });
    };
    const refresh = () => {
      void api.vcs
        .refreshStatus({ cwd })
        .then(publish)
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = api.vcs.onStatus({ cwd }, publish, { onResubscribe: refresh });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [api, connection, cwd]);

  return api && snapshot?.api === api && snapshot.connection === connection && snapshot.cwd === cwd
    ? snapshot.status
    : null;
}
