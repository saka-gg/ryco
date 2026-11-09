import type {
  ServerClientSessionRecord,
  ServerPairingLinkRecord,
} from "@ryco/client-runtime/connection";
import { AuthSessionId, type AdvertisedEndpoint } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addDeviceDescription,
  addDeviceTitle,
  agoLabel,
  clientSessionRows,
  deadCodeTitle,
  deriveDirectAccessAvailability,
  deriveHubRevokeAvailability,
  deriveNetworkExposure,
  derivePairingShare,
  expiresInLabel,
  hasOtherClientSessions,
  hubNodePlatformLabel,
  machineAccessHeader,
  pairingLinkRows,
  pairingLinkShareUrl,
  revokedOthersNotice,
} from "./machineAccessModel";

const NOW = Date.parse("2036-04-07T10:00:00.000Z");

function endpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:3773",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:3773/",
    wsBaseUrl: "ws://192.168.1.42:3773/",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

const loopback = endpoint({
  id: "desktop-loopback:3773",
  label: "This machine",
  httpBaseUrl: "http://127.0.0.1:3773/",
  reachability: "loopback",
  isDefault: true,
});
const lan = endpoint({});
const tailscale = endpoint({
  id: "tailscale-ip:http://100.84.12.7:3773",
  label: "Tailscale IP",
  httpBaseUrl: "http://100.84.12.7:3773/",
  reachability: "private-network",
});

const directOwner = {
  label: "Studio",
  role: "owner" as const,
  connected: true,
  switchedOff: false,
  requiresAuth: false,
};

describe("deriveDirectAccessAvailability", () => {
  it("offers pairing and clients to a connected owner pairing", () => {
    expect(deriveDirectAccessAvailability(directOwner, "Studio")).toEqual({ kind: "available" });
  });

  it("explains a Hub-only machine instead of offering what the relay cannot carry", () => {
    const result = deriveDirectAccessAvailability(null, "Studio");
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("hub-only");
    expect(result.detail).toContain("owner pairing link");
  });

  it("tells a client pairing how to become an owner", () => {
    const result = deriveDirectAccessAvailability({ ...directOwner, role: "client" }, "Studio");
    expect(result.kind === "unavailable" && result.reason).toBe("not-owner");
    expect(result.kind === "unavailable" && result.detail).toContain("--role owner");
  });

  it("asks to connect, switch on or pair again before listing anything", () => {
    expect(
      deriveDirectAccessAvailability({ ...directOwner, connected: false }, "Studio"),
    ).toMatchObject({ reason: "not-connected" });
    expect(deriveDirectAccessAvailability({ ...directOwner, role: null }, "Studio")).toMatchObject({
      reason: "not-connected",
    });
    expect(
      deriveDirectAccessAvailability({ ...directOwner, switchedOff: true }, "Studio"),
    ).toMatchObject({ reason: "switched-off" });
    expect(
      deriveDirectAccessAvailability({ ...directOwner, requiresAuth: true }, "Studio"),
    ).toMatchObject({ reason: "needs-pairing" });
  });
});

describe("deriveHubRevokeAvailability", () => {
  const node = { revokedAt: null };

  it("offers revocation only to a signed-in Hub owner", () => {
    expect(deriveHubRevokeAvailability({ node, signedIn: true, accountRole: "owner" }).kind).toBe(
      "available",
    );
    expect(deriveHubRevokeAvailability({ node, signedIn: true, accountRole: "operator" })).toEqual({
      kind: "unavailable",
      detail: "Only an owner of this Hub can revoke a node.",
    });
    expect(deriveHubRevokeAvailability({ node, signedIn: false, accountRole: "owner" }).kind).toBe(
      "unavailable",
    );
  });

  it("never offers a second revocation, including at epoch zero", () => {
    const result = deriveHubRevokeAvailability({
      node: { revokedAt: 0 },
      signedIn: true,
      accountRole: "owner",
    });
    expect(result.kind).toBe("unavailable");
  });
});

describe("machineAccessHeader", () => {
  it("names the machine and every way this phone reaches it", () => {
    expect(
      machineAccessHeader({
        directLabel: "Studio",
        directRole: "owner",
        hubNode: { label: "Studio (Hub)", effectiveRole: "operator" },
      }),
    ).toEqual({
      title: "Studio",
      subtitle: "Paired directly as owner · On your Hub as operator",
      known: true,
    });
  });

  it("falls back to the Hub label, and says when nothing is known", () => {
    expect(
      machineAccessHeader({
        directLabel: null,
        directRole: null,
        hubNode: { label: "Travel", effectiveRole: "owner" },
      }).title,
    ).toBe("Travel");
    expect(
      machineAccessHeader({ directLabel: null, directRole: null, hubNode: null }),
    ).toMatchObject({ known: false, title: "Machine" });
  });
});

function link(overrides: Partial<ServerPairingLinkRecord>): ServerPairingLinkRecord {
  return {
    id: "link-1",
    credential: "ABCDEFGHJKLM",
    role: "client",
    subject: "pairing",
    createdAt: "2036-04-07T09:58:00.000Z",
    expiresAt: "2036-04-07T10:04:30.000Z",
    ...overrides,
  };
}

describe("pairingLinkRows", () => {
  it("lists live links with their role and expiry, and drops expired ones", () => {
    const rows = pairingLinkRows(
      [link({}), link({ id: "old", expiresAt: "2036-04-07T09:59:00.000Z" })],
      NOW,
    );
    expect(rows).toEqual([
      {
        id: "link-1",
        title: "Client link",
        detail: "Client · Expires in 5m",
        credential: "ABCDEFGHJKLM",
        note: null,
      },
    ]);
  });

  it("never carries an owner link's credential", () => {
    const [row] = pairingLinkRows([link({ role: "owner", label: "Setup" })], NOW);
    expect(row?.credential).toBeNull();
    expect(row?.title).toBe("Setup");
    expect(row?.note).toContain("full access");
  });
});

function session(overrides: Partial<ServerClientSessionRecord>): ServerClientSessionRecord {
  return {
    sessionId: AuthSessionId.make("session-1"),
    subject: "subject-1",
    role: "client",
    method: "bearer-session-token",
    client: { deviceType: "mobile", os: "iOS", label: "Phone" },
    issuedAt: "2036-04-07T08:00:00.000Z",
    expiresAt: "2037-04-07T08:00:00.000Z",
    lastConnectedAt: null,
    connected: false,
    current: false,
    ...overrides,
  };
}

describe("clientSessionRows", () => {
  it("marks this phone and never offers to remove it", () => {
    const [row] = clientSessionRows([session({ current: true })], NOW);
    expect(row).toMatchObject({
      status: "This device",
      current: true,
      canRevoke: false,
      live: true,
    });
  });

  it("says when another client was last seen", () => {
    const rows = clientSessionRows(
      [
        session({ connected: true }),
        session({ lastConnectedAt: "2036-04-07T07:00:00.000Z" }),
        session({}),
      ],
      NOW,
    );
    expect(rows.map((row) => row.status)).toEqual([
      "Connected",
      "Last connected 3h ago",
      "Not connected yet",
    ]);
    expect(rows.every((row) => row.canRevoke)).toBe(true);
    expect(rows[0]?.detail).toBe("Client · Mobile · iOS");
  });

  it("has others to remove only when a client other than this phone is paired", () => {
    expect(hasOtherClientSessions([session({ current: true })])).toBe(false);
    expect(hasOtherClientSessions([session({ current: true }), session({})])).toBe(true);
    expect(revokedOthersNotice(1)).toBe("Removed 1 other client.");
    expect(revokedOthersNotice(3)).toBe("Removed 3 other clients.");
  });
});

describe("time labels", () => {
  it("rounds expiry up and elapsed time down", () => {
    expect(expiresInLabel("2036-04-07T10:00:30.000Z", NOW)).toBe("Expires in 1m");
    expect(expiresInLabel("2036-04-07T13:00:00.000Z", NOW)).toBe("Expires in 3h");
    expect(expiresInLabel("2036-04-09T10:00:00.000Z", NOW)).toBe("Expires in 2d");
    expect(expiresInLabel("2036-04-07T09:00:00.000Z", NOW)).toBe("Expired");
    expect(expiresInLabel("not a date", NOW)).toBe("Expired");
    expect(agoLabel("2036-04-07T09:59:30.000Z", NOW)).toBe("just now");
    expect(agoLabel("2036-04-07T09:15:00.000Z", NOW)).toBe("45m ago");
    expect(agoLabel("2036-04-05T10:00:00.000Z", NOW)).toBe("2d ago");
  });
});

describe("deriveNetworkExposure", () => {
  it("reports reach read-only, from the node's own policy and endpoints", () => {
    const view = deriveNetworkExposure({
      endpoints: [loopback, lan],
      authPolicy: "remote-reachable",
    });
    expect(view.summary).toContain("Network access is on");
    expect(view.endpoints.map((row) => [row.label, row.url, row.hint, row.status])).toEqual([
      ["This machine", "127.0.0.1:3773", "Clients on that machine", "Available"],
      ["Local network", "192.168.1.42:3773", "Devices on the same network", "Available"],
    ]);
    expect(view.tailscaleHttps).toBeNull();
    expect(view.footnote).toContain("read-only");
  });

  it("reads Tailscale HTTPS off its endpoint and says nothing it was not told", () => {
    const view = deriveNetworkExposure({
      endpoints: [
        endpoint({
          id: "tailscale-magicdns:https://studio.tail.ts.net",
          httpBaseUrl: "https://studio.tail.ts.net/",
          status: "unavailable",
        }),
      ],
      authPolicy: null,
    });
    expect(view.tailscaleHttps).toBe("off");
    expect(view.summary).toBeNull();
    expect(
      deriveNetworkExposure({ endpoints: [], authPolicy: "desktop-managed-local" }).summary,
    ).toContain("off");
  });
});

describe("derivePairingShare", () => {
  it("shares a direct pairing link through an endpoint another device can reach", () => {
    const view = derivePairingShare({
      endpoints: [loopback, lan, tailscale],
      selectedEndpointId: null,
      credential: "ABCDEFGHJKLM",
    });
    expect(view.url).toBe("http://192.168.1.42:3773/pair#token=ABCDEFGHJKLM");
    expect(view.qrUrl).toBe(view.url);
    expect(view.address).toBe("http://192.168.1.42:3773");
    expect(view.choices.map((choice) => choice.id)).toEqual([lan.id, tailscale.id]);
  });

  it("follows the picked endpoint, and never puts loopback in a QR code", () => {
    expect(
      derivePairingShare({
        endpoints: [lan, tailscale],
        selectedEndpointId: tailscale.id,
        credential: "CODE",
      }).url,
    ).toBe("http://100.84.12.7:3773/pair#token=CODE");
    const picked = derivePairingShare({
      endpoints: [loopback, lan],
      selectedEndpointId: loopback.id,
      credential: "CODE",
    });
    expect(picked.url).toBe("http://127.0.0.1:3773/pair#token=CODE");
    expect(picked.qrUrl).toBeNull();
  });

  it("has nothing to share with no reachable endpoint or no code yet", () => {
    expect(
      derivePairingShare({ endpoints: [loopback], selectedEndpointId: null, credential: "C" }).url,
    ).toBeNull();
    expect(
      derivePairingShare({ endpoints: [lan], selectedEndpointId: null, credential: null }).url,
    ).toBeNull();
    expect(pairingLinkShareUrl([lan], "CODE")).toBe("http://192.168.1.42:3773/pair#token=CODE");
  });
});

describe("add-device copy", () => {
  it("names the machine and the code's state", () => {
    expect(addDeviceTitle({ kind: "unreachable" }, "Studio")).toBe(
      "Only Studio can reach Ryco now",
    );
    expect(addDeviceTitle({ kind: "joined", deviceName: "The phone" }, "Studio")).toBe(
      "The phone is connected",
    );
    expect(addDeviceTitle({ kind: "code", countdown: "4:59" }, "Studio")).toBe("Add a device");
    expect(addDeviceDescription({ kind: "unreachable" }, "Studio")).toContain("Ryco Desktop");
    expect(deadCodeTitle({ kind: "used" })).toBe("This code was used");
    expect(deadCodeTitle({ kind: "expired" })).toBe("This code expired");
  });

  it("labels a node's platform", () => {
    expect(hubNodePlatformLabel({ platformOs: "darwin", platformArch: "arm64" })).toBe(
      "macOS · arm64",
    );
  });
});
