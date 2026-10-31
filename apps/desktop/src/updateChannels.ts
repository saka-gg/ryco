import type { DesktopUpdateChannel } from "@ryco/contracts";
import { isNightlyVersion, releaseChannelForVersion } from "@ryco/shared/desktopFlavor";

export function isNightlyDesktopVersion(version: string): boolean {
  return isNightlyVersion(version);
}

/**
 * Whether an offered update belongs to the channel this app follows. electron-updater's GitHub
 * provider can fall back to another channel's manifest; a version outside the app's own lane
 * would swap Ryco for Ryco Nightly (or back), so it is never offered.
 */
export function doesVersionMatchDesktopUpdateChannel(
  version: string,
  channel: DesktopUpdateChannel,
): boolean {
  return releaseChannelForVersion(version) === channel;
}
