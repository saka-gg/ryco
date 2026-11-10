import type { EnvironmentId, ProjectFileChangeEvent } from "@ryco/contracts";
import { watchProjectFile } from "@ryco/client-runtime/rpc/projectFileWatch";
import { useEffect, useEffectEvent, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { readEnvironmentApi } from "../connection/environmentApi";
import { useEnvironmentServerConfigs } from "../state/environmentServerConfigs";

/**
 * Keeps an open text file fresh while the app is in front: on nodes that
 * advertise `projectFileWatch` the file's change notices (no content) arrive
 * as the file changes on disk, and a version the screen does not hold reads
 * the file again. Every view of the file on one connection shares one watch
 * (`watchProjectFile`), which starts with the file's current version, so a
 * read made before the watch cannot miss a change. Older nodes: no watch, the
 * screen re-reads on open and pull-to-refresh as before.
 */
export function useProjectFileWatch(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly relativePath: string | null;
  /** The version the screen shows; null until the first read lands (nothing to compare yet). */
  readonly heldVersion: string | null;
  readonly onStale: () => void;
}): void {
  const { environmentId, cwd, relativePath, heldVersion } = input;
  const configs = useEnvironmentServerConfigs();
  const watches = configs.get(environmentId)?.environment.capabilities.projectFileWatch === true;
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const onChange = useEffectEvent((event: ProjectFileChangeEvent) => {
    // The version the screen holds already (after its own save, or the first notice).
    if (event.type !== "deleted" && event.version === heldVersion) return;
    input.onStale();
  });
  const hasRead = heldVersion !== null;

  useEffect(() => {
    if (!watches || !appActive || !hasRead || cwd === null || relativePath === null) return;
    const subscribe = readEnvironmentApi(environmentId)?.projects.subscribeFileChanges;
    if (subscribe === undefined) return;
    return watchProjectFile(subscribe, { cwd, relativePath }, (event) => onChange(event));
  }, [appActive, cwd, environmentId, hasRead, relativePath, watches]);
}
