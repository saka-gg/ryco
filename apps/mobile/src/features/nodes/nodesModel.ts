import type { EnvironmentId } from "@ryco/contracts";

export type NodePlane = "hub" | "direct";
export type NodeReadiness = "ready" | "checking" | "reconnecting" | "offline" | "read-only";

export interface NodeModelInput {
  readonly environmentId: EnvironmentId;
  readonly plane: NodePlane;
  readonly label: string;
  readonly role?: string | null;
  readonly presence?: "online" | "offline" | "unknown";
  readonly readiness: NodeReadiness;
  readonly selected: boolean;
  readonly transportLabel?: string | null;
}

export interface NodeSectionModel {
  readonly key: NodePlane;
  /**
   * Bounded to the two headers the machines surface renders. The literal union
   * is the guard that keeps this model from drifting away from
   * `NodesScreen`/`HubNodeSection` copy while `buildNodeSections` is unused.
   */
  readonly title: "Hub nodes" | "Paired directly";
  readonly rows: ReadonlyArray<NodeModelInput>;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first, second] = octets;
  if (first === 10 || first === 127) return true;
  if (first === 192 && second === 168) return true;
  return first === 172 && second !== undefined && second >= 16 && second <= 31;
}

function isTailscaleIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first, second] = octets;
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

export function directTransportLabel(
  httpBaseUrl: string,
): "LAN · Direct" | "Tailscale · Direct" | "Direct" {
  let hostname: string;
  try {
    hostname = new URL(httpBaseUrl).hostname.toLocaleLowerCase();
  } catch {
    return "Direct";
  }
  if (hostname.endsWith(".ts.net") || isTailscaleIpv4(hostname)) return "Tailscale · Direct";
  if (hostname === "localhost" || hostname.endsWith(".local") || isPrivateIpv4(hostname)) {
    return "LAN · Direct";
  }
  return "Direct";
}

/**
 * The connect action of a directly paired machine. A machine that rejected its
 * saved pairing offers Re-pair first; this action then retries the saved
 * pairing as it is, for a rejection that was only a passing fault on the node.
 */
export function directConnectActionLabel(input: {
  readonly connectionState: "connecting" | "connected" | "disconnected" | "error";
  readonly needsRepair: boolean;
}): "Use" | "Retry" | "Connect" {
  if (input.connectionState === "connected") return "Use";
  return input.needsRepair || input.connectionState === "error" ? "Retry" : "Connect";
}

export function directRoleLabel(
  role: "owner" | "client" | null,
): "Owner" | "Client" | "Role pending" {
  if (role === "owner") return "Owner";
  if (role === "client") return "Client";
  return "Role pending";
}

export function buildNodeSections(input: {
  readonly rows: ReadonlyArray<NodeModelInput>;
  readonly query?: string;
}): ReadonlyArray<NodeSectionModel> {
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const filtered = input.rows.filter((row) => {
    if (!query) return true;
    return `${row.label} ${row.role ?? ""} ${row.transportLabel ?? ""}`
      .toLocaleLowerCase()
      .includes(query);
  });
  const hubRows = filtered.filter((row) => row.plane === "hub");
  const directRows = filtered.filter((row) => row.plane === "direct");
  const sections: NodeSectionModel[] = [];
  if (hubRows.length > 0) {
    sections.push({ key: "hub", title: "Hub nodes", rows: hubRows });
  }
  if (directRows.length > 0) {
    sections.push({ key: "direct", title: "Paired directly", rows: directRows });
  }
  return sections;
}

export function canSelectHubNode(input: {
  readonly directoryStatus: "idle" | "loading" | "ready" | "error";
  readonly browserStatus: "idle" | "refreshing" | "current" | "error";
  readonly revokedAt: string | null;
}): boolean {
  return (
    input.directoryStatus === "ready" &&
    input.browserStatus === "current" &&
    input.revokedAt === null
  );
}
