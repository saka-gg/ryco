import {
  hostedSessionAdmits,
  resolveHostedDeliveryNotice,
  resolveHostedRpcCapability,
  type HostedDeliveryNotice,
  type HostedRpcCapability,
} from "@ryco/client-runtime/authorization";
import type { EnvironmentId } from "@ryco/contracts";
import { useMemo } from "react";

import { isHostedHubMode } from "../env";
import { hostedHubController, useHostedHubStore } from "./state";

export { resolveHostedRpcCapability };
export type { HostedDeliveryNotice, HostedRpcCapability };

/** React binding only; capability policy is package-owned. */
export function useHostedRpcCapability(method: string): HostedRpcCapability {
  const state = useHostedHubStore((value) => value);
  return resolveHostedRpcCapability({
    hosted: isHostedHubMode(),
    role: state.effectiveRole,
    fresh: state.directoryStatus === "ready" && state.transportStatus === "online",
    browserCurrent: state.browserStatus === "current",
    sessionReady: hostedSessionAdmits(state, method),
    method,
  });
}

export interface HostedDeliveryNoticeBinding extends HostedDeliveryNotice {
  readonly acknowledge: () => void;
}

/** The unconfirmed-delivery notice for `environmentId`, when it is the hosted selection. */
export function useHostedDeliveryNotice(
  environmentId: EnvironmentId | null | undefined,
): HostedDeliveryNoticeBinding | null {
  const sessionStatus = useHostedHubStore((state) => state.sessionStatus);
  const sessionRecoveredAfterUnknown = useHostedHubStore(
    (state) => state.sessionRecoveredAfterUnknown,
  );
  const selectedEnvironmentId = useHostedHubStore(
    (state) => state.selectedNode?.environmentId ?? null,
  );
  const selectedLabel = useHostedHubStore((state) => state.selectedNode?.label ?? null);
  const applies = isHostedHubMode() && !!environmentId && environmentId === selectedEnvironmentId;
  return useMemo(() => {
    if (!applies) return null;
    const notice = resolveHostedDeliveryNotice(
      { sessionStatus, sessionRecoveredAfterUnknown },
      selectedLabel,
    );
    return notice
      ? { ...notice, acknowledge: () => hostedHubController.acknowledgeDeliveryUnknown() }
      : null;
  }, [applies, selectedLabel, sessionRecoveredAfterUnknown, sessionStatus]);
}
