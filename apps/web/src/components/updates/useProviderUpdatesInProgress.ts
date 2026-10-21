import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@ryco/contracts";

import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useServerProviders } from "../../rpc/serverState";
import { useStore } from "../../store";
import { isProviderUpdateActive } from "../ProviderUpdateLaunchNotification.logic";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** Display names of providers updating on the active device right now, one per driver. */
export function providerUpdatesInProgress(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const provider of providers) {
    if (!isProviderUpdateActive(provider)) continue;
    names.add(PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver);
  }
  return [...names];
}

/**
 * Provider updates started outside "Update everything" (a provider's settings or
 * the launch toast) on the active device, so the sidebar pill still shows them.
 */
export function useProviderUpdatesInProgress(): ReadonlyArray<string> {
  const primaryEnvironment = usePrimaryEnvironmentDescriptor();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const primaryProviders = useServerProviders();
  const remoteProviders = useSavedEnvironmentRuntimeStore((state) =>
    activeEnvironmentId ? state.byId[activeEnvironmentId]?.serverConfig?.providers : undefined,
  );
  const providers =
    activeEnvironmentId && activeEnvironmentId !== primaryEnvironment?.environmentId
      ? (remoteProviders ?? NO_PROVIDERS)
      : primaryProviders;
  return providerUpdatesInProgress(providers);
}
