import type { AdvertisedEndpoint } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface AdvertisedEndpointRegistryShape {
  readonly list: Effect.Effect<readonly AdvertisedEndpoint[]>;
  /**
   * This machine's own Tailscale addresses, IPv4 and IPv6, as `tailscale status` lists them
   * (cached for a minute); `undefined` when it cannot say (no Tailscale, or no CLI).
   */
  readonly tailscaleAddresses: Effect.Effect<ReadonlyArray<string> | undefined>;
}

export class AdvertisedEndpointRegistry extends Context.Service<
  AdvertisedEndpointRegistry,
  AdvertisedEndpointRegistryShape
>()("ryco/remote/Services/AdvertisedEndpointRegistry") {}
