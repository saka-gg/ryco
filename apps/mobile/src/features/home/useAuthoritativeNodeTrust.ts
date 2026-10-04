import type { WorkspaceNativeTrustState } from "@ryco/client-runtime/state/workspace";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { getMobileE2eeSessionState, subscribeMobileE2eeSession } from "../../hostedHub/e2eeSession";
import { useHostedHubStore } from "../../hostedHub/state";
import {
  authoritativeNodeTrustSourceRevision,
  readAuthoritativeNodeTrustSource,
  subscribeAuthoritativeNodeTrustSource,
} from "./authoritativeNodeTrustSource";
import { resolveAuthoritativeNativeNodeTrust } from "./nativeNodeEligibilityModel";
import {
  getMobileNativeE2eeEnrollmentState,
  subscribeMobileNativeE2eeEnrollment,
} from "../../hostedHub/e2eeEnrollment";

export interface AuthoritativeNodeTrustTarget {
  readonly environmentId: string;
  readonly nodeId: string;
}

export function useAuthoritativeNodeTrust(
  targets: ReadonlyArray<AuthoritativeNodeTrustTarget>,
): ReadonlyMap<string, WorkspaceNativeTrustState> {
  const trustRevision = useSyncExternalStore(
    subscribeAuthoritativeNodeTrustSource,
    authoritativeNodeTrustSourceRevision,
    authoritativeNodeTrustSourceRevision,
  );
  const activeSession = useSyncExternalStore(
    subscribeMobileE2eeSession,
    getMobileE2eeSessionState,
    getMobileE2eeSessionState,
  );
  const enrollment = useSyncExternalStore(
    subscribeMobileNativeE2eeEnrollment,
    getMobileNativeE2eeEnrollmentState,
    getMobileNativeE2eeEnrollmentState,
  );
  const accountId = useHostedHubStore((state) => state.account?.id ?? null);
  const targetKey = targets
    .map((target) => `${target.environmentId}\u0000${target.nodeId}`)
    .join("\u0001");
  const stableTargets = useMemo(
    () =>
      targetKey
        ? targetKey.split("\u0001").map((entry) => {
            const [environmentId = "", nodeId = ""] = entry.split("\u0000");
            return { environmentId, nodeId };
          })
        : [],
    [targetKey],
  );
  const [trust, setTrust] = useState<ReadonlyMap<string, WorkspaceNativeTrustState>>(
    () => new Map(targets.map((target) => [target.environmentId, "unknown"])),
  );

  useEffect(() => {
    let cancelled = false;
    const conflicts = new Set(
      stableTargets
        .filter(
          (target) =>
            getMobileE2eeSessionState(target.environmentId).event?.kind === "identity-change",
        )
        .map((target) => target.environmentId),
    );
    void (async () => {
      const source = readAuthoritativeNodeTrustSource();
      const hubOrigin = source?.hubOrigin() ?? null;
      const next = await resolveAuthoritativeNativeNodeTrust({
        scope:
          source === null || hubOrigin === null || accountId === null
            ? null
            : { hubOrigin, accountId },
        targets: stableTargets,
        classify: (selection) =>
          source === null
            ? Promise.reject(new Error("Trust source unavailable"))
            : source.classify(selection),
        pairing: (selection) => source?.pairing(selection) ?? false,
        identityConflictEnvironmentIds: conflicts,
        accountEnrollmentReady:
          enrollment.status === "ready" && enrollment.ready?.namespace.accountId === accountId,
      });
      if (!cancelled) setTrust(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, activeSession, enrollment, stableTargets, trustRevision]);

  return trust;
}
