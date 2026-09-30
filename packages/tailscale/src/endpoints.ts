import type { NetworkInterfaceInfo } from "node:os";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  AdvertisedEndpoint,
  AdvertisedEndpointProvider,
  AdvertisedEndpointSource,
} from "@ryco/contracts";
import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@ryco/shared/advertisedEndpoint";
import { Effect, Layer } from "effect";

import {
  buildTailscaleHttpsBaseUrl,
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  probeTailscaleHttpsEndpoint,
  readTailscaleStatus,
} from "./tailscale.ts";

/**
 * Tailnet endpoints for a Ryco server, shared by the desktop app (for the
 * backend it spawned) and a headless server (for itself), so both advertise
 * the same addresses the same way.
 */

const TailscaleEndpointLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici);
const TAILSCALE_MAGIC_DNS_CACHE_TTL_MS = 60_000;

export const TAILSCALE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

function createTailscaleEndpoint(
  source: AdvertisedEndpointSource,
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint {
  return createAdvertisedEndpoint({
    ...input,
    provider: TAILSCALE_ENDPOINT_PROVIDER,
    source,
  });
}

let cachedTailscaleMagicDnsName: {
  readonly expiresAtMs: number;
  readonly promise: Promise<string | null>;
} | null = null;

async function readDefaultTailscaleMagicDnsName(): Promise<string | null> {
  return Effect.runPromise(
    readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.catch(() => Effect.succeed(null)),
      Effect.provide(TailscaleEndpointLayer),
    ),
  );
}

/** The local MagicDNS name, or `null` without Tailscale. Cached for a minute. */
export function readCachedTailscaleMagicDnsName(): Promise<string | null> {
  const now = Date.now();
  if (cachedTailscaleMagicDnsName && cachedTailscaleMagicDnsName.expiresAtMs > now) {
    return cachedTailscaleMagicDnsName.promise;
  }

  const promise = readDefaultTailscaleMagicDnsName();
  cachedTailscaleMagicDnsName = {
    expiresAtMs: now + TAILSCALE_MAGIC_DNS_CACHE_TTL_MS,
    promise,
  };
  return promise;
}

export function resolveTailscaleIpAdvertisedEndpoints(input: {
  readonly port: number;
  readonly networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly source?: AdvertisedEndpointSource;
}): readonly AdvertisedEndpoint[] {
  const seen = new Set<string>();
  const endpoints: AdvertisedEndpoint[] = [];

  for (const interfaceAddresses of Object.values(input.networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isTailscaleIpv4Address(address.address)) continue;
      if (seen.has(address.address)) continue;
      seen.add(address.address);

      endpoints.push(
        createTailscaleEndpoint(input.source ?? "desktop-addon", {
          id: `tailscale-ip:http://${address.address}:${input.port}`,
          label: "Tailscale IP",
          httpBaseUrl: `http://${address.address}:${input.port}`,
          reachability: "private-network",
          status: "available",
          description: "Reachable from devices on the same Tailnet.",
        }),
      );
    }
  }

  return endpoints;
}

export async function resolveTailscaleMagicDnsAdvertisedEndpoint(input: {
  readonly dnsName: string | null;
  readonly serveEnabled: boolean;
  readonly servePort?: number;
  readonly probe?: (baseUrl: string) => Promise<boolean>;
  readonly source?: AdvertisedEndpointSource;
}): Promise<AdvertisedEndpoint | null> {
  if (!input.dnsName) {
    return null;
  }

  const httpBaseUrl = buildTailscaleHttpsBaseUrl({
    magicDnsName: input.dnsName,
    ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
  });
  const isReachable = input.serveEnabled
    ? await (input.probe?.(httpBaseUrl) ??
        Effect.runPromise(
          probeTailscaleHttpsEndpoint({ baseUrl: httpBaseUrl }).pipe(
            Effect.provide(TailscaleEndpointLayer),
          ),
        ))
    : false;

  return createTailscaleEndpoint(input.source ?? "desktop-addon", {
    id: `tailscale-magicdns:${httpBaseUrl}`,
    label: "Tailscale HTTPS",
    httpBaseUrl,
    reachability: "private-network",
    hostedHttpsCompatibility: isReachable ? "compatible" : "requires-configuration",
    status: isReachable ? "available" : "unavailable",
    description: isReachable
      ? "HTTPS endpoint served by Tailscale Serve."
      : "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
  });
}

export async function resolveTailscaleAdvertisedEndpoints(input: {
  readonly port: number;
  readonly serveEnabled?: boolean;
  readonly servePort?: number;
  readonly networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly statusJson?: string | null;
  readonly readMagicDnsName?: () => Promise<string | null>;
  readonly probe?: (baseUrl: string) => Promise<boolean>;
  readonly source?: AdvertisedEndpointSource;
}): Promise<readonly AdvertisedEndpoint[]> {
  const ipEndpoints = resolveTailscaleIpAdvertisedEndpoints(input);
  const dnsName =
    input.statusJson === undefined
      ? await (input.readMagicDnsName ?? readCachedTailscaleMagicDnsName)()
      : input.statusJson
        ? await Effect.runPromise(
            parseTailscaleMagicDnsName(input.statusJson).pipe(
              Effect.catch(() => Effect.succeed(null)),
            ),
          )
        : null;
  const magicDnsEndpoint = await resolveTailscaleMagicDnsAdvertisedEndpoint({
    dnsName,
    serveEnabled: input.serveEnabled === true,
    ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    ...(input.source === undefined ? {} : { source: input.source }),
  });

  return magicDnsEndpoint ? [...ipEndpoints, magicDnsEndpoint] : ipEndpoints;
}
