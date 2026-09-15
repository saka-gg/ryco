import type { EnvironmentId } from "@ryco/contracts";
import {
  createComparisonController,
  comparisonStorageKey,
} from "@ryco/client-runtime/state/comparison";
import { useMemo, useSyncExternalStore } from "react";
import { ensureEnvironmentApi } from "../environmentApi";
import { webKV } from "../platform/kv";
import { useRepositoryReadLifecycle } from "./useRepositoryReadLifecycle";

export function useComparison(input: {
  environmentId: EnvironmentId | null;
  repositoryPath: string | null;
  cwd: string | null;
  ignoreWhitespace: boolean;
  enabled: boolean;
}) {
  const { environmentId, repositoryPath, cwd, ignoreWhitespace, enabled } = input;
  const controller = useMemo(
    () =>
      createComparisonController({
        storage: webKV,
        storageKey: comparisonStorageKey(environmentId ?? "", repositoryPath ?? ""),
        read: (selection) => {
          if (!environmentId || !cwd) return Promise.reject(new Error("Repository unavailable."));
          return ensureEnvironmentApi(environmentId).vcs.readComparison({
            cwd,
            selection,
            ignoreWhitespace,
          });
        },
      }),
    [environmentId, repositoryPath, cwd, ignoreWhitespace],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useRepositoryReadLifecycle(
    controller,
    environmentId,
    cwd,
    enabled && !!repositoryPath,
    controller.hydrate,
  );
  return { ...state, setSelection: controller.setSelection, refresh: controller.refresh };
}
