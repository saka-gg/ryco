import type { EnvironmentId } from "@ryco/contracts";
import { ensureDeviceRuntime } from "@ryco/client-runtime/state/device";
import { useEffect } from "react";

/**
 * Keeps an environment's device event stream running while the calling
 * surface is mounted: a thread view that the agent may ask to open the
 * simulator pane in, or the pane itself. Nothing device-related runs on
 * connect; the stream starts with the first such surface.
 */
export function useDeviceRuntime(environmentId: EnvironmentId | null | undefined): void {
  useEffect(
    () => (environmentId ? ensureDeviceRuntime(environmentId) : undefined),
    [environmentId],
  );
}
