import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@ryco/shared/advertisedEndpoint";
import type { AdvertisedEndpoint, AdvertisedEndpointProvider } from "@ryco/contracts";
import { isTailscaleIpv4Address } from "@ryco/tailscale";
import {
  readCachedTailscaleMagicDnsName,
  resolveTailscaleIpAdvertisedEndpoints,
  resolveTailscaleMagicDnsAdvertisedEndpoint,
} from "@ryco/tailscale/endpoints";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import {
  bindsAllInterfaces,
  formatHostForUrl,
  isLoopbackHost,
  resolveExternalInterfaceHost,
  resolveListeningPort,
} from "../startupAccess.ts";
import {
  AdvertisedEndpointRegistry,
  type AdvertisedEndpointRegistryShape,
} from "./Services/AdvertisedEndpointRegistry.ts";

const SERVER_CORE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "server-core",
  label: "Server",
  kind: "core",
  isAddon: false,
};

function createServerEndpoint(
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint {
  return createAdvertisedEndpoint({
    ...input,
    provider: SERVER_CORE_ENDPOINT_PROVIDER,
    source: "server",
  });
}

function classifyConfiguredHostReachability(host: string): AdvertisedEndpoint["reachability"] {
  if (isLoopbackHost(host)) {
    return "loopback";
  }
  if (isTailscaleIpv4Address(host)) {
    return "private-network";
  }
  if (
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./u.test(host)
  ) {
    return "lan";
  }
  return "public";
}

function buildHttpBaseUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`;
}

export function resolveServerAdvertisedEndpoints(input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
}): readonly AdvertisedEndpoint[] {
  const endpoints: AdvertisedEndpoint[] = [
    createServerEndpoint({
      id: `server-loopback:${input.port}`,
      label: "This machine",
      httpBaseUrl: buildHttpBaseUrl("127.0.0.1", input.port),
      reachability: "loopback",
      status: "available",
      description: "Loopback endpoint for this server.",
    }),
  ];

  const allInterfaces = bindsAllInterfaces(input.host);
  if (!allInterfaces && input.host && isLoopbackHost(input.host)) {
    return endpoints;
  }

  const configuredHost = allInterfaces
    ? resolveExternalInterfaceHost(input.networkInterfaces)
    : input.host?.replace(/^\[(.*)\]$/u, "$1");

  if (
    configuredHost === undefined ||
    isLoopbackHost(configuredHost) ||
    configuredHost === "localhost"
  ) {
    return endpoints;
  }

  const httpBaseUrl = buildHttpBaseUrl(configuredHost, input.port);
  const reachability = classifyConfiguredHostReachability(configuredHost);

  endpoints.push(
    createServerEndpoint({
      id: `server-network:${httpBaseUrl}`,
      label: reachability === "lan" ? "Local network" : "Network",
      httpBaseUrl,
      reachability,
      status: "available",
      isDefault: true,
      description:
        reachability === "lan"
          ? "Reachable from devices on the same network."
          : "Reachable using the configured server host.",
    }),
  );

  return endpoints;
}

/**
 * Server endpoints plus this machine's Tailnet endpoints: its Tailscale IP when
 * the listener accepts it, and its MagicDNS HTTPS URL when Tailscale Serve
 * fronts this server. A desktop-managed backend gets the same Tailnet endpoints
 * from Desktop instead, which owns its Tailscale Serve setup.
 */
export async function resolveServerAdvertisedEndpointsWithTailscale(input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort?: number;
  readonly readMagicDnsName?: () => Promise<string | null>;
  readonly probe?: (baseUrl: string) => Promise<boolean>;
}): Promise<readonly AdvertisedEndpoint[]> {
  const server = resolveServerAdvertisedEndpoints(input);
  const seen = new Set(server.map((endpoint) => endpoint.httpBaseUrl));
  const tailnet: AdvertisedEndpoint[] = [];
  if (bindsAllInterfaces(input.host)) {
    tailnet.push(
      ...resolveTailscaleIpAdvertisedEndpoints({
        port: input.port,
        networkInterfaces: input.networkInterfaces,
        source: "server",
      }),
    );
  }
  if (input.tailscaleServeEnabled) {
    const magicDns = await resolveTailscaleMagicDnsAdvertisedEndpoint({
      dnsName: await (input.readMagicDnsName ?? readCachedTailscaleMagicDnsName)(),
      serveEnabled: true,
      ...(input.tailscaleServePort === undefined ? {} : { servePort: input.tailscaleServePort }),
      ...(input.probe === undefined ? {} : { probe: input.probe }),
      source: "server",
    });
    if (magicDns) tailnet.push(magicDns);
  }
  return [...server, ...tailnet.filter((endpoint) => !seen.has(endpoint.httpBaseUrl))];
}

export const makeAdvertisedEndpointRegistry = Effect.fn("makeAdvertisedEndpointRegistry")(
  function* () {
    const config = yield* ServerConfig;
    const httpServer = yield* HttpServer.HttpServer;

    const list = Effect.promise(() =>
      resolveServerAdvertisedEndpointsWithTailscale({
        host: config.host,
        port: resolveListeningPort(httpServer.address, config.port),
        networkInterfaces: networkInterfaces(),
        // Desktop advertises its backend's Tailnet endpoints itself.
        tailscaleServeEnabled: config.mode !== "desktop" && config.tailscaleServeEnabled,
        tailscaleServePort: config.tailscaleServePort,
      }),
    );

    return {
      list,
    } satisfies AdvertisedEndpointRegistryShape;
  },
);

export const AdvertisedEndpointRegistryLive = Layer.effect(
  AdvertisedEndpointRegistry,
  makeAdvertisedEndpointRegistry(),
);
