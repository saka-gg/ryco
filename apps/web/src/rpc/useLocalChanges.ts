import { createLocalChangesController } from "@ryco/client-runtime/state/comparison";
import type { EnvironmentId } from "@ryco/contracts";
import { useMemo, useSyncExternalStore } from "react";
import { ensureEnvironmentApi } from "../environmentApi";
import { useRepositoryReadLifecycle } from "./useRepositoryReadLifecycle";

export function useLocalChanges(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  enabled: boolean,
) {
  const controller = useMemo(
    () =>
      createLocalChangesController({
        cwd: cwd ?? "",
        read: () => {
          if (!environmentId || !cwd) return Promise.reject(new Error("Repository unavailable."));
          return ensureEnvironmentApi(environmentId).vcs.readLocalChanges({ cwd });
        },
        apply: async (input) => {
          if (!environmentId) throw new Error("Repository unavailable.");
          await ensureEnvironmentApi(environmentId).vcs.applyIndexPatch(input);
        },
      }),
    [environmentId, cwd],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useRepositoryReadLifecycle(controller, environmentId, cwd, enabled, controller.refresh);
  return { ...state, refresh: controller.refresh, apply: controller.apply };
}
