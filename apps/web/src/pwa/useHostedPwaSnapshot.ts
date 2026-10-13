import { useSyncExternalStore } from "react";

import type { HostedPwaLifecycle, HostedPwaSnapshot } from "./lifecycle";

const absentLifecycle = {
  subscribe: () => () => undefined,
  getSnapshot: () => null,
};

/** The hosted PWA lifecycle's snapshot, or null where the build has no lifecycle. */
export function useHostedPwaSnapshot(lifecycle: HostedPwaLifecycle): HostedPwaSnapshot;
export function useHostedPwaSnapshot(
  lifecycle: HostedPwaLifecycle | null,
): HostedPwaSnapshot | null;
export function useHostedPwaSnapshot(
  lifecycle: HostedPwaLifecycle | null,
): HostedPwaSnapshot | null {
  const source = lifecycle ?? absentLifecycle;
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
