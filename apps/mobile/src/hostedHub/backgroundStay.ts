import type { BackgroundStayPolicy } from "@ryco/client-runtime/connection";
import { createHostedBackgroundStayPolicy } from "@ryco/client-runtime/authorization/hostedBackgroundStay";
import { getHostedEnvironmentSessions } from "@ryco/client-runtime/authorization";

import {
  beginNativeBackgroundStay,
  type RycoAppRuntimeNativeModule,
} from "../platform/appRuntimeNative";
import { getMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import { readHostedConnectionHeartbeat } from "./nodeLifecycle";
import { hostedHubStore } from "./state";

/**
 * The phone's background stay for Hub connections (findings F1), or undefined
 * where the binary has no background task (Android, older builds): leaving the
 * foreground then suspends at once, as before.
 */
export function createMobileBackgroundStayPolicy(
  native: RycoAppRuntimeNativeModule | null,
): BackgroundStayPolicy | undefined {
  if (native === null) return undefined;
  return createHostedBackgroundStayPolicy({
    readHosted: () => hostedHubStore.getState(),
    sessions: getHostedEnvironmentSessions(),
    beginPlatformStay: (expire) => beginNativeBackgroundStay(native, expire),
    connectionHeartbeat: readHostedConnectionHeartbeat,
    resumeKept: () => getMobileHostedConnectionCoordinator().reconnectRetainedAfterForeground(),
  });
}
