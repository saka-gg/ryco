import { useLayoutEffect, useMemo } from "react";
import { PROJECT_MEMORY_WS_METHODS, type EnvironmentId, type ProjectId } from "@ryco/contracts";
import { createProjectMemoryController } from "@ryco/client-runtime/state/project-memory";
import { readEnvironmentApi } from "../../environmentApi";
import { selectBootstrapCompleteForEnvironment, useStore } from "../../store";
import { useEnvironmentRpcReadScope } from "../chat/useThreadImageReadScope";

export function useProjectMemoryController(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  scopeKey: string,
) {
  const scope = useEnvironmentRpcReadScope(environmentId, PROJECT_MEMORY_WS_METHODS.mutate);
  const shellCurrent = useStore((state) =>
    selectBootstrapCompleteForEnvironment(state, environmentId),
  );
  // The callback reads authoritative stores synchronously; render is only a subscription.
  const controller = useMemo(
    () =>
      projectId && scopeKey
        ? createProjectMemoryController({
            environmentId,
            projectId,
            readConnection: () => {
              const api = readEnvironmentApi(environmentId)?.projectMemory;
              return api
                ? {
                    api,
                    generation: 0,
                    lifetime: [scope.lifetime],
                    ready:
                      shellCurrent &&
                      scope.isCurrent() &&
                      selectBootstrapCompleteForEnvironment(useStore.getState(), environmentId),
                  }
                : null;
            },
          })
        : null,
    [environmentId, projectId, scopeKey, scope, shellCurrent],
  );
  useLayoutEffect(() => () => controller?.invalidate(), [controller]);
  return controller;
}
