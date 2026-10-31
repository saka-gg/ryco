/**
 * Features that ship in Ryco Nightly builds but stay off in stable releases.
 *
 * The code ships in both; a stable node switches every listed feature off.
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
