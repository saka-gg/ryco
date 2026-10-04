import { directTransportLabel } from "./nodesModel";

export type DirectConnectionMode = "url" | "lan" | "tailscale";

export interface DirectConnectionMethod {
  readonly id: DirectConnectionMode;
  readonly title: string;
  readonly detail: string;
}

export const DIRECT_CONNECTION_METHODS: ReadonlyArray<DirectConnectionMethod> = [
  {
    id: "url",
    title: "Pairing URL",
    detail: "Paste the full link copied from Ryco Desktop.",
  },
  {
    id: "lan",
    title: "LAN host + code",
    detail: "Reach the machine directly while both devices are on the same network.",
  },
  {
    id: "tailscale",
    title: "Tailscale host + code",
    detail: "Use your tailnet for direct reachability — no Hub account.",
  },
];

export function canSubmitDirectConnection(input: {
  readonly mode: DirectConnectionMode;
  readonly pairingUrl: string;
  readonly host: string;
  readonly code: string;
}): boolean {
  if (input.mode === "url") return input.pairingUrl.trim().length > 0;
  return input.host.trim().length > 0 && input.code.trim().length > 0;
}

/**
 * Pairing a saved machine again starts from the address it was saved with, so
 * only the new pairing code is missing. The scheme stays: a LAN node usually
 * serves plain http, and a bare host would be read as https.
 */
export function directRepairPrefill(httpBaseUrl: string): {
  readonly mode: Exclude<DirectConnectionMode, "url">;
  readonly host: string;
} {
  const mode = directTransportLabel(httpBaseUrl) === "Tailscale · Direct" ? "tailscale" : "lan";
  try {
    const url = new URL(httpBaseUrl);
    const atRoot = url.pathname === "/" && url.search === "" && url.hash === "";
    return { mode, host: atRoot ? url.origin : httpBaseUrl };
  } catch {
    return { mode, host: httpBaseUrl };
  }
}
