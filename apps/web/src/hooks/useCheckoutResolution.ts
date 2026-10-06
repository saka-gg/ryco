import type { EnvironmentId } from "@ryco/contracts";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import {
  hasSavedEnvironmentRegistryHydrated,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import {
  classifyCheckoutEnvironmentSync,
  rankCheckoutKeysByThreadActivity,
  type CheckoutEnvironmentSync,
} from "../projectCheckouts.logic";
import {
  selectBootstrapCompleteForEnvironment,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
  type AppState,
} from "../store";

/**
 * How long a checkout named in the URL may stay "waiting" before a page offers
 * the others (its environment may never finish connecting).
 */
export const CHECKOUT_WAIT_GRACE_MS = 8_000;

/**
 * Checkout keys by latest thread activity. Ranked only when a thread summary
 * actually changed, and the same array is returned while the ranking holds, so
 * thread traffic elsewhere does not re-render the page.
 */
export function createRecentCheckoutKeysSelector(): (state: AppState) => readonly string[] {
  let lastThreads: ReturnType<typeof selectSidebarThreadsAcrossEnvironments> = [];
  let lastKeys: readonly string[] = [];
  return (state) => {
    const threads = selectSidebarThreadsAcrossEnvironments(state);
    if (
      threads.length === lastThreads.length &&
      threads.every((thread, index) => thread === lastThreads[index])
    ) {
      return lastKeys;
    }
    lastThreads = threads;
    const keys = rankCheckoutKeysByThreadActivity(threads);
    if (keys.length !== lastKeys.length || keys.some((key, index) => key !== lastKeys[index])) {
      lastKeys = keys;
    }
    return lastKeys;
  };
}

/** Whether the environment a URL names can still deliver its projects, and its label. */
export function useRequestedEnvironment(env: string | undefined): {
  readonly sync: CheckoutEnvironmentSync;
  readonly label: string | null;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const environmentId = (env ?? primaryEnvironmentId ?? null) as EnvironmentId | null;
  const bootstrapComplete = useStore((state) =>
    environmentId === null ? false : selectBootstrapCompleteForEnvironment(state, environmentId),
  );
  const savedRecord = useSavedEnvironmentRegistryStore((state) =>
    environmentId === null ? null : (state.byId?.[environmentId] ?? null),
  );
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId?.[environmentId] ?? null),
  );
  const isPrimary = environmentId !== null && environmentId === primaryEnvironmentId;
  const sync = classifyCheckoutEnvironmentSync({
    bootstrapComplete,
    isPrimary,
    saved: savedRuntime
      ? {
          connectionState: savedRuntime.connectionState,
          disconnectedAt: savedRuntime.disconnectedAt,
        }
      : null,
    savedKnown: savedRecord !== null,
    registryHydrated: hasSavedEnvironmentRegistryHydrated(),
  });
  const label =
    savedRuntime?.descriptor?.label ??
    savedRecord?.label ??
    (isPrimary ? (primaryDescriptor?.label ?? null) : null);
  return { sync, label };
}

/** True once `active` has held for `delayMs` (reset whenever it turns false). */
export function useHeldFor(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setElapsed(true), delayMs);
    // Turning inactive starts the next hold over.
    return () => {
      window.clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && elapsed;
}
