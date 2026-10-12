import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useServerConfigSelector } from "../../rpc/serverState";

/** `null` while the environment's config is unknown. */
export function readAgentControlEnabled(config: ServerConfig | null | undefined): boolean | null {
  return config ? config.settings.agentControl.enabled : null;
}

const selectPrimaryAgentControlEnabled = (config: ServerConfig | null) =>
  readAgentControlEnabled(config);

/**
 * The environments whose Agent Control queue may be subscribed. The TARGET
 * environment's server still owns the policy; this only skips environments
 * whose own config already says the feature is off, so a disabled node does
 * not answer every load with a refused subscription (and a console warning).
 * Unknown config keeps the old behaviour: attempt and let the server decide.
 * Turning the feature on updates the config, which re-admits the environment.
 */
export function filterAgentControlSyncEnvironmentIds(input: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly isDisabled: (environmentId: EnvironmentId) => boolean;
}): EnvironmentId[] {
  return input.environmentIds.filter((environmentId) => !input.isDisabled(environmentId));
}

export function useAgentControlSyncEnvironmentIds(
  environmentIds: readonly EnvironmentId[],
): EnvironmentId[] {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnabled = useServerConfigSelector(selectPrimaryAgentControlEnabled);
  // A joined key keeps the selection a primitive, so unrelated runtime-store
  // updates do not re-render the caller.
  const savedDisabledKey = useSavedEnvironmentRuntimeStore((state) =>
    environmentIds
      .filter(
        (environmentId) =>
          environmentId !== primaryEnvironmentId &&
          readAgentControlEnabled(state.byId[environmentId]?.serverConfig) === false,
      )
      .join("\u0000"),
  );
  return useMemo(() => {
    const savedDisabled = new Set(
      savedDisabledKey.length > 0 ? savedDisabledKey.split("\u0000") : [],
    );
    return filterAgentControlSyncEnvironmentIds({
      environmentIds,
      isDisabled: (environmentId) =>
        environmentId === primaryEnvironmentId
          ? primaryEnabled === false
          : savedDisabled.has(environmentId),
    });
  }, [environmentIds, primaryEnabled, primaryEnvironmentId, savedDisabledKey]);
}
