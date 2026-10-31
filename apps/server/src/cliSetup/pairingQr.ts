/**
 * Pairing links and the terminal QR code for CLI commands that pair a device with
 * a node that is already running (`ryco auth pairing create`, `ryco setup`).
 *
 * The links follow the headless serve rule (`resolveHeadlessServeLinks`): the
 * primary link is the endpoint another device can reach, and a QR code is drawn
 * only for a link that is not loopback. The QR encoder itself still loads only
 * when a code is printed (`loadTerminalQrCode`).
 */
import { networkInterfaces } from "node:os";

import { readCachedTailscaleMagicDnsName } from "@ryco/tailscale/endpoints";

import { resolveServerAdvertisedEndpointsWithTailscale } from "../remote/AdvertisedEndpointRegistry.ts";
import {
  type HeadlessServeAccessLink,
  LOOPBACK_ONLY_PAIRING_NOTE,
  resolveHeadlessServeLinks,
} from "../startupAccess.ts";

export interface PairingLinks {
  readonly pairingUrl: string;
  /** Null when the only link is loopback: no QR code then. */
  readonly qrUrl: string | null;
  readonly alternativeLinks: ReadonlyArray<HeadlessServeAccessLink>;
}

/** Links to the node listening at `origin`, through every endpoint it advertises. */
export async function discoverPairingLinks(input: {
  readonly credential: string;
  /** The running node's own origin (its runtime file). */
  readonly origin: string;
  readonly host: string | undefined;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort?: number | undefined;
}): Promise<PairingLinks> {
  const port = Number(new URL(input.origin).port) || 3773;
  const endpoints = await resolveServerAdvertisedEndpointsWithTailscale({
    host: input.host,
    port,
    networkInterfaces: networkInterfaces(),
    tailscaleServeEnabled: input.tailscaleServeEnabled,
    ...(input.tailscaleServePort === undefined
      ? {}
      : { tailscaleServePort: input.tailscaleServePort }),
    readMagicDnsName: readCachedTailscaleMagicDnsName,
  });
  return resolveHeadlessServeLinks({
    endpoints,
    credential: input.credential,
    fallbackConnectionString: input.origin.replace(/\/$/u, ""),
  });
}

/** Links through one base URL the owner named (`--base-url`). */
export function pairingLinksForBaseUrl(credential: string, baseUrl: string): PairingLinks {
  return resolveHeadlessServeLinks({
    endpoints: [],
    credential,
    fallbackConnectionString: baseUrl.replace(/\/$/u, ""),
  });
}

/**
 * The QR block: the code (or why there is none), the primary link, the other
 * links, then `footer`. Lines are indented by `indent`.
 */
export function formatPairingQrBlock(input: {
  readonly links: PairingLinks;
  readonly renderQrCode: (value: string) => string;
  readonly heading?: string;
  readonly footer: ReadonlyArray<string>;
  readonly dim?: (text: string) => string;
  readonly indent?: string;
}): string {
  const dim = input.dim ?? ((text: string) => text);
  const indent = input.indent ?? "";
  const { links } = input;
  return [
    "",
    ...(input.heading === undefined ? [] : [`${indent}${input.heading}`, ""]),
    ...(links.qrUrl === null
      ? [`${indent}${LOOPBACK_ONLY_PAIRING_NOTE}`]
      : [input.renderQrCode(links.qrUrl)]),
    "",
    `${indent}${links.pairingUrl}`,
    ...links.alternativeLinks.map((link) => `${indent}${dim(`${link.label}:`)} ${link.url}`),
    "",
    ...input.footer.map((line) => `${indent}${dim(line)}`),
    "",
  ].join("\n");
}
