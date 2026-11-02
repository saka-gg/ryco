/**
 * Features that ship in nightly releases but stay off in stable ones.
 *
 * Decided by the node's version: on for every nightly node (Ryco Nightly, the bridge release
 * that retires the in-place nightly, and CLI nodes on the npm `nightly` dist-tag), off on a
 * stable one. The code ships in both; a stable node switches every listed feature off.
 * Promote a feature to stable by deleting its entry, and every gate resolves
 * itself (Synara's BETA_ONLY_FEATURES). The node is authoritative: it refuses
 * the capability on a stable release, and clients only hide entry points, from
 * the node's version rather than their own build. Keep persisted fields of a
 * listed feature additive and inert on stable, so a stored preference survives
 * a Nightly -> stable round trip untouched.
 */
import { releaseChannelForVersion } from "./desktopFlavor.ts";

export const NIGHTLY_ONLY_FEATURES: ReadonlyArray<string> = [];

/** Whether `feature` is on for a node running `nodeVersion`. */
export function isNightlyFeatureEnabled(
  feature: string,
  nodeVersion: string,
  nightlyOnlyFeatures: ReadonlyArray<string> = NIGHTLY_ONLY_FEATURES,
): boolean {
  return (
    !nightlyOnlyFeatures.includes(feature) || releaseChannelForVersion(nodeVersion) === "nightly"
  );
}
