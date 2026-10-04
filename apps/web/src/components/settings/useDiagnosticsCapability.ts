import {
  hostedSessionAdmits,
  resolveHostedRpcCapability,
} from "@ryco/client-runtime/authorization";
import { isHostedHubMode } from "../../env";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useHostedWorkspaceState } from "../../hostedHub/hostedConnectionCoordinator";
import { useHostedHubStore } from "../../hostedHub/state";
import { useSettingsTarget } from "../../settingsTarget";
import { canRequestDirectDiagnostics } from "./diagnosticsCapability";

/** Apply the shared policy to the selected node, including its current shell. */
export function useDiagnosticsCapability(method: string) {
  const target = useSettingsTarget();
  const state = useHostedHubStore((value) => value);
  const workspace = useHostedWorkspaceState();
  const runtime = useSavedEnvironmentRuntimeStore((value) =>
    target ? value.byId[target.environmentId] : undefined,
  );
  const machine = workspace.machines.find((entry) => entry.environmentId === target?.environmentId);
  const hosted = isHostedHubMode();
  const capability = resolveHostedRpcCapability({
    hosted,
    role: machine ? machine.effectiveRole : target && !target.primary ? null : state.effectiveRole,
    fresh:
      state.directoryStatus === "ready" &&
      (machine
        ? machine.connectionState === "connected" &&
          machine.canMutate &&
          machine.cacheDisposition === "available" &&
          machine.presence.online
        : state.transportStatus === "online"),
    browserCurrent: state.browserStatus === "current",
    sessionReady: hostedSessionAdmits(state, method),
    method,
  });
  if (
    !hosted &&
    target &&
    !canRequestDirectDiagnostics({
      primary: target.primary,
      connected: target.connected && (!runtime || runtime.connectionState === "connected"),
      role: runtime?.role,
    })
  ) {
    return { hosted, allowed: false, reason: "Diagnostics require a connected owner session." };
  }
  return capability;
}
