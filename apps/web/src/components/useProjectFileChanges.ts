import { watchProjectFile } from "@ryco/client-runtime/rpc/projectFileWatch";
import type { EnvironmentId, ProjectFileChangeEvent } from "@ryco/contracts";
import { useEffect } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { useEvent } from "../hooks/useEvent";

/**
 * Subscribes to one workspace file's change notices while `enabled`. Every
 * view of the same file on one connection shares a single subscription
 * (`watchProjectFile`), which starts with the file's current version, so a
 * read made before the subscription cannot miss a change. Callers enable it
 * only on nodes that advertise `projectFileWatch`.
 */
export function useProjectFileChanges(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly enabled: boolean;
  readonly onChange: (event: ProjectFileChangeEvent) => void;
}): void {
  const { environmentId, cwd, relativePath, enabled } = input;
  const onChange = useEvent(input.onChange);
  useEffect(() => {
    if (!enabled || environmentId === null || cwd === null || relativePath === null) return;
    const subscribe = readEnvironmentApi(environmentId)?.projects.subscribeFileChanges;
    if (subscribe === undefined) return;
    return watchProjectFile(subscribe, { cwd, relativePath }, onChange);
  }, [cwd, enabled, environmentId, onChange, relativePath]);
}
