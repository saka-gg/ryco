import { EnvironmentId } from "@ryco/contracts";
import { encodeDirectRouteIdentityTranscript } from "@ryco/shared/directRouteIdentity";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const HUB = EnvironmentId.make("env_hub_m4");
const DIRECT = EnvironmentId.make("env-direct-m4");

let records: Array<Record<string, unknown>> = [];
const issueLinkedDirectAccess = vi.fn();
const addSavedEnvironment = vi.fn(async (_input: unknown) => undefined);
const fetchRemoteEnvironmentDescriptor = vi.fn(async (_input: unknown) => ({
  environmentId: DIRECT,
}));
/** The key the machine's direct address signs challenges with. */
let addressSigner: CryptoKey | null = null;
const requestDirectRouteIdentityProof = vi.fn(
  async ({ challenge }: { readonly httpBaseUrl: string; readonly challenge: string }) => {
    if (addressSigner === null) return { kind: "refused" as const };
    const transcript = encodeDirectRouteIdentityTranscript({
      environmentId: DIRECT,
      challenge: Uint8Array.from(Buffer.from(challenge, "base64url")),
    });
    const signature = await crypto.subtle.sign(
      "Ed25519",
      addressSigner,
      Uint8Array.from(transcript),
    );
    return { kind: "signed" as const, signature: Buffer.from(signature).toString("base64url") };
  },
);

vi.mock("../environments/runtime", () => ({
  addSavedEnvironment: (input: unknown) => addSavedEnvironment(input),
  connectDesktopWorkspaceEnvironment: async () => ({
    client: { server: { issueLinkedDirectAccess } },
  }),
  // The catalog keeps linked records apart from the environments.
  listSavedEnvironmentRecords: () => records.filter((record) => record.hubLink === undefined),
}));
vi.mock("../environments/runtime/catalog", () => ({
  listLinkedDirectRecords: () => records.filter((record) => record.hubLink !== undefined),
}));
vi.mock("../environments/remote/api", () => ({
  fetchRemoteEnvironmentDescriptor: (input: unknown) => fetchRemoteEnvironmentDescriptor(input),
}));
vi.mock("./directRouteIdentityRequest", () => ({
  requestWebDirectRouteIdentityProof: (input: { httpBaseUrl: string; challenge: string }) =>
    requestDirectRouteIdentityProof(input),
}));

const { linkDesktopMachineDirectAccess, renewDesktopMachineDirectAccess } =
  await import("./desktopHubLinkedDirectAccess");

const machine = { environmentId: HUB, label: "MacBook Pro M4" };
let nodeKey: CryptoKeyPair;
let issued: Record<string, unknown>;

beforeAll(async () => {
  nodeKey = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  issued = {
    kind: "issued",
    environmentId: DIRECT,
    label: "MacBook Pro M4",
    endpoints: [{ httpBaseUrl: "http://100.64.0.20:3773", wsBaseUrl: "ws://100.64.0.20:3773" }],
    credential: "ABCDEFGHJKLM",
    expiresAt: new Date(),
    nodeIdentityPublicKey: Buffer.from(
      await crypto.subtle.exportKey("raw", nodeKey.publicKey),
    ).toString("base64url"),
  };
});

describe("Desktop Hub-linked direct access", () => {
  beforeEach(() => {
    records = [];
    issueLinkedDirectAccess.mockReset();
    addSavedEnvironment.mockClear();
    requestDirectRouteIdentityProof.mockClear();
    addressSigner = nodeKey.privateKey;
  });

  it("asks the machine over the Hub and saves the direct connection with its Hub link", async () => {
    issueLinkedDirectAccess.mockResolvedValue(issued);
    await expect(linkDesktopMachineDirectAccess(machine)).resolves.toBe("linked");
    expect(issueLinkedDirectAccess).toHaveBeenCalledWith({ deviceLabel: "Ryco Desktop" });
    expect(addSavedEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "MacBook Pro M4",
        host: "http://100.64.0.20:3773",
        pairingCode: "ABCDEFGHJKLM",
        hubLink: expect.objectContaining({
          hubEnvironmentId: HUB,
          nodeIdentityPublicKey: issued.nodeIdentityPublicKey,
        }),
      }),
    );
    expect(requestDirectRouteIdentityProof).toHaveBeenCalledTimes(1);
  });

  it("never redeems the code at an address that cannot prove the machine's key", async () => {
    issueLinkedDirectAccess.mockResolvedValue(issued);
    addressSigner = (
      (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair
    ).privateKey;
    await expect(linkDesktopMachineDirectAccess(machine)).resolves.toBe("unreachable");
    expect(addSavedEnvironment).not.toHaveBeenCalled();
  });

  it("asks a machine that names no identity key to update first, sending its code nowhere", async () => {
    const { nodeIdentityPublicKey: _omitted, ...older } = issued;
    issueLinkedDirectAccess.mockResolvedValue(older);
    await expect(linkDesktopMachineDirectAccess(machine)).resolves.toBe("node-update-required");
    expect(requestDirectRouteIdentityProof).not.toHaveBeenCalled();
    expect(addSavedEnvironment).not.toHaveBeenCalled();
  });

  it("leaves a machine the user paired by hand alone, and reports one it cannot reach", async () => {
    issueLinkedDirectAccess.mockResolvedValue(issued);
    records = [{ environmentId: DIRECT }];
    await expect(linkDesktopMachineDirectAccess(machine)).resolves.toBe("already-paired");

    records = [];
    issueLinkedDirectAccess.mockResolvedValue({
      kind: "unavailable",
      reason: "no-direct-endpoint",
    });
    await expect(linkDesktopMachineDirectAccess(machine)).resolves.toBe("no-direct-endpoint");
    expect(addSavedEnvironment).not.toHaveBeenCalled();
  });

  it("renews only a link the owner made, and only once it has aged", async () => {
    issueLinkedDirectAccess.mockResolvedValue(issued);
    renewDesktopMachineDirectAccess(machine);
    expect(issueLinkedDirectAccess).not.toHaveBeenCalled();

    records = [
      {
        environmentId: DIRECT,
        hubLink: {
          hubEnvironmentId: HUB,
          linkedAt: new Date().toISOString(),
          nodeIdentityPublicKey: issued.nodeIdentityPublicKey,
        },
      },
    ];
    renewDesktopMachineDirectAccess(machine);
    expect(issueLinkedDirectAccess).not.toHaveBeenCalled();

    records = [
      {
        environmentId: DIRECT,
        hubLink: {
          hubEnvironmentId: HUB,
          linkedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    ];
    renewDesktopMachineDirectAccess(machine);
    await vi.waitFor(() => expect(addSavedEnvironment).toHaveBeenCalledTimes(1));
  });
});
