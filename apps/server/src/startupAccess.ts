import { networkInterfaces } from "node:os";

import type { AdvertisedEndpoint } from "@ryco/contracts";
import { DEFAULT_HOSTED_APP_ORIGIN } from "@ryco/shared/hostedApp";
import { buildDirectPairingUrl, buildHostedPairingUrl } from "@ryco/shared/pairingUrl";
import { isTailscaleIpv4Address } from "@ryco/tailscale";
import { DateTime, Effect } from "effect";
import { HttpServer } from "effect/http";

import { ServerConfig } from "./config.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { AdvertisedEndpointRegistry } from "./remote/Services/AdvertisedEndpointRegistry.ts";

export interface HeadlessServeAccessLink {
  readonly label: string;
  readonly url: string;
}

export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  /**
   * Absent when running as a background service: a fresh owner token on every
   * restart would pile up in its log file. Pairing then goes through
   * `ryco auth pairing create`.
   */
  readonly token?: string;
  readonly pairingUrl?: string;
  /** What the QR code holds: `pairingUrl`, or null when only this computer can reach it. */
  readonly qrUrl?: string | null;
  /** Minutes until the one-time token expires, when known. */
  readonly tokenExpiresInMinutes?: number;
  /** Further ways to reach this server, beyond `pairingUrl`. */
  readonly alternativeLinks?: ReadonlyArray<HeadlessServeAccessLink>;
  /** Printed after the links: how this node reaches the Hub, when enabled. */
  readonly hubOrigin?: string;
}

type NetworkInterfacesMap = ReturnType<typeof networkInterfaces>;

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

/**
 * Printed instead of a QR code when the only pairing link is a loopback address: a
 * phone scanning it would reach itself, not this node.
 */
export const LOOPBACK_ONLY_PAIRING_NOTE =
  "Only this computer can reach this node. Turn on network access or Tailscale Serve to pair another device.";

/**
 * A host a phone scanning a QR code cannot reach this node at: loopback in any spelling the URL
 * parser leaves (127/8, `::1`, IPv4-mapped `::ffff:7f..`, `localhost` and its subdomains, with or
 * without a trailing dot) and the unspecified addresses.
 */
const isUnreachableFromAnotherDevice = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    isLoopbackHost(host) ||
    host.endsWith(".localhost") ||
    isWildcardHost(host) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(host) ||
    /^\[::ffff:127\./u.test(host)
  );
};

/** A pairing link worth drawing as a QR code: one another device can reach. */
export const pairingQrUrl = (pairingUrl: string): string | null => {
  try {
    return isUnreachableFromAnotherDevice(new URL(pairingUrl).hostname) ? null : pairingUrl;
  } catch {
    return null;
  }
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

/**
 * Does the listener accept connections on every interface? An unset host does:
 * both the Node and Bun listeners bind all interfaces when given none.
 */
export const bindsAllInterfaces = (host: string | undefined): boolean =>
  host === undefined || host.length === 0 || isWildcardHost(host);

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

export const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = networkInterfaces(),
): string => {
  if (!host) {
    return "localhost";
  }

  if (!isWildcardHost(host)) {
    return normalizeHost(host);
  }

  return resolveExternalInterfaceHost(interfaces) ?? "localhost";
};

/**
 * The address another device on the local network would use, or `undefined`
 * without an external interface. A LAN address is preferred over a Tailnet one,
 * which is advertised separately.
 */
export const resolveExternalInterfaceHost = (
  interfaces: NetworkInterfacesMap = networkInterfaces(),
): string | undefined => {
  const interfaceEntries = Object.values(interfaces).flatMap((entries) => entries ?? []);
  const externalIpv4 = interfaceEntries.filter(
    (entry) => !entry.internal && isIpv4Family(entry.family),
  );
  const lanIpv4 = externalIpv4.find((entry) => !isTailscaleIpv4Address(entry.address));
  if (lanIpv4) {
    return lanIpv4.address;
  }
  if (externalIpv4[0]) {
    return externalIpv4[0].address;
  }

  const externalIpv6 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv6Family(entry.family),
  );
  return externalIpv6 ? normalizeHost(externalIpv6.address) : undefined;
};

export const resolveHeadlessConnectionString = (
  host: string | undefined,
  port: number,
  interfaces: NetworkInterfacesMap = networkInterfaces(),
): string => {
  const connectionHost = resolveHeadlessConnectionHost(host, interfaces);
  return `http://${formatHostForUrl(connectionHost)}:${port}`;
};

export const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};

export const buildPairingUrl = (connectionString: string, token: string): string => {
  const url = new URL(connectionString);
  url.pathname = "/pair";
  url.searchParams.delete("token");
  url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
};

/**
 * `renderTerminalQrCode` of `terminalQrCode.ts`: the QR encoder loads when a command prints a
 * code, never with the server's boot.
 */
export const loadTerminalQrCode = Effect.promise(() => import("./terminalQrCode.ts")).pipe(
  Effect.map((module) => module.renderTerminalQrCode),
);

export const formatHeadlessServeOutput = (
  accessInfo: HeadlessServeAccessInfo,
  renderQrCode: (value: string) => string,
): string => {
  if (accessInfo.token === undefined || accessInfo.pairingUrl === undefined) {
    return [
      "Ryco server is ready.",
      `Connection string: ${accessInfo.connectionString}`,
      `Pair a device with \`ryco auth pairing create --base-url ${accessInfo.connectionString}\`.`,
      ...(accessInfo.hubOrigin === undefined
        ? []
        : [`Hub relay: enabled via ${accessInfo.hubOrigin}.`]),
      "",
    ].join("\n");
  }
  const alternatives = accessInfo.alternativeLinks ?? [];
  const labelWidth = Math.max(0, ...alternatives.map((link) => link.label.length));
  const expiry =
    accessInfo.tokenExpiresInMinutes === undefined
      ? ""
      : ` (one-time, expires in ${accessInfo.tokenExpiresInMinutes} min — mint another with \`ryco auth pairing create\`)`;
  return [
    "Ryco server is ready.",
    `Connection string: ${accessInfo.connectionString}`,
    `Token: ${accessInfo.token}${expiry}`,
    `Pairing URL: ${accessInfo.pairingUrl}`,
    ...(alternatives.length === 0
      ? []
      : [
          "",
          "Also reachable at:",
          ...alternatives.map((link) => `  ${link.label.padEnd(labelWidth)}  ${link.url}`),
        ]),
    ...(accessInfo.hubOrigin === undefined
      ? []
      : [
          "",
          `Hub relay: enabled via ${accessInfo.hubOrigin}. Link this node to your account with \`ryco hub login\` (or \`ryco hub enroll\`); check it with \`ryco hub status\`.`,
        ]),
    "",
    ...(accessInfo.qrUrl === undefined
      ? [renderQrCode(accessInfo.pairingUrl)]
      : accessInfo.qrUrl === null
        ? [LOOPBACK_ONLY_PAIRING_NOTE]
        : [renderQrCode(accessInfo.qrUrl)]),
    "",
  ].join("\n");
};

/**
 * Pairing links for every endpoint another device can use, primary first.
 *
 * The primary is the endpoint the registry marks default — the LAN address when
 * the server binds every interface — and otherwise the first reachable one, so a
 * loopback-only server behind Tailscale Serve leads with its Tailnet HTTPS URL.
 * An HTTPS endpoint also gets a hosted-app link, which is the one form a phone
 * without the native app can open.
 */
export const resolveHeadlessServeLinks = (input: {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly credential: string;
  readonly fallbackConnectionString: string;
  readonly hostedAppOrigin?: string;
}): {
  readonly connectionString: string;
  readonly pairingUrl: string;
  /** `pairingUrl` unless it is a loopback address (the fallback, or a loopback `--base-url`). */
  readonly qrUrl: string | null;
  readonly alternativeLinks: ReadonlyArray<HeadlessServeAccessLink>;
} => {
  const reachable = input.endpoints.filter(
    (endpoint) => endpoint.reachability !== "loopback" && endpoint.status === "available",
  );
  const primary = reachable.find((endpoint) => endpoint.isDefault) ?? reachable[0];
  const connectionString = primary
    ? primary.httpBaseUrl.replace(/\/$/u, "")
    : input.fallbackConnectionString;
  const alternativeLinks: HeadlessServeAccessLink[] = [];
  for (const endpoint of reachable) {
    if (endpoint !== primary) {
      alternativeLinks.push({
        label: endpoint.label,
        url: buildDirectPairingUrl(endpoint.httpBaseUrl, input.credential),
      });
    }
    if (endpoint.compatibility.hostedHttpsApp === "compatible") {
      alternativeLinks.push({
        label: `${endpoint.label} (hosted app)`,
        url: buildHostedPairingUrl({
          hostedAppOrigin: input.hostedAppOrigin ?? DEFAULT_HOSTED_APP_ORIGIN,
          host: endpoint.httpBaseUrl,
          token: input.credential,
        }),
      });
    }
  }
  const pairingUrl = buildPairingUrl(connectionString, input.credential);
  return {
    connectionString,
    pairingUrl,
    qrUrl: pairingQrUrl(pairingUrl),
    alternativeLinks,
  };
};

export const issueHeadlessServeAccessInfo = Effect.fn("issueHeadlessServeAccessInfo")(function* (
  options: { readonly mintToken?: boolean } = {},
) {
  const serverConfig = yield* ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const serverAuth = yield* ServerAuth;
  const registry = yield* AdvertisedEndpointRegistry;
  const fallbackConnectionString = resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
  );
  const hub = serverConfig.hubConnector;
  const hubHint =
    hub?.enabled && hub.origin !== undefined && hub.configurationIssue === undefined
      ? { hubOrigin: hub.origin }
      : {};
  if (options.mintToken === false) {
    const endpoints = yield* registry.list;
    const { connectionString } = resolveHeadlessServeLinks({
      endpoints,
      credential: "",
      fallbackConnectionString,
    });
    return { connectionString, ...hubHint } satisfies HeadlessServeAccessInfo;
  }
  const issued = yield* serverAuth.issuePairingCredential({ role: "owner" });
  const endpoints = yield* registry.list;
  const links = resolveHeadlessServeLinks({
    endpoints,
    credential: issued.credential,
    fallbackConnectionString,
  });
  const now = yield* DateTime.now;
  const tokenExpiresInMinutes = Math.max(
    1,
    Math.round((DateTime.toEpochMillis(issued.expiresAt) - DateTime.toEpochMillis(now)) / 60_000),
  );

  return {
    ...links,
    token: issued.credential,
    tokenExpiresInMinutes,
    ...hubHint,
  } satisfies HeadlessServeAccessInfo;
});
