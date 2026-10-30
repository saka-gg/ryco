import type { NativePushCapability, NativePushPlatform } from "@ryco/contracts/push-hub";

/**
 * What a Hub's push capability (`HostedHubApi.getNativePushCapability`) means
 * for one app build (`docs/push-alerts.md`):
 *
 * - `available`: the Hub sends push to this platform and this build.
 * - `hub-unsupported`: the Hub sends no push at all; it answered 404.
 * - `platform-unsupported`: the Hub sends push, but not to this platform.
 * - `topic-unsupported`: the Hub's push key cannot reach this build's bundle id.
 *
 * Only `available` lets a client register a device token with the Hub or a
 * push key with its nodes.
 */
export type NativePushHubSupport =
  | "available"
  | "hub-unsupported"
  | "platform-unsupported"
  | "topic-unsupported";

export function nativePushHubSupport(
  capability: NativePushCapability | null,
  build: { readonly platform: NativePushPlatform; readonly topic: string },
): NativePushHubSupport {
  if (capability === null) return "hub-unsupported";
  if (!capability.platforms.includes(build.platform)) return "platform-unsupported";
  return capability.topics.includes(build.topic) ? "available" : "topic-unsupported";
}
