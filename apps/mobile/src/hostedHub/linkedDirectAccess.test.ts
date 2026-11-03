import { createSavedEnvironmentCatalog } from "@ryco/client-runtime/connection";
import type { AuthLinkedDirectAccess, EnvironmentId } from "@ryco/contracts";
import { encodeDirectRouteIdentityTranscript } from "@ryco/shared/directRouteIdentity";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { capLinkedRole, createMobileLinkedDirectAccess } from "./linkedDirectAccess";

const HUB = "env_hub_studio" as EnvironmentId;
const DIRECT = "env-direct-studio" as EnvironmentId;
const ADDRESS = "https://studio.tail1.ts.net";
const machine = { environmentId: HUB, label: "Studio" };

let nodeKey: CryptoKeyPair;
let nodeKeyB64 = "";
beforeAll(async () => {
  nodeKey = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  nodeKeyB64 = Buffer.from(await crypto.subtle.exportKey("raw", nodeKey.publicKey)).toString(
    "base64url",
  );
});

function memoryCatalog() {
  let registry: ReadonlyArray<unknown> = [];
  const secrets = new Map<string, string>();
  return createSavedEnvironmentCatalog({
    kv: {
      getRegistry: async () => registry as never,
      setRegistry: async (records) => {
        registry = records;
      },
    },
    secretKV: {
      get: async (key: string) => secrets.get(key) ?? null,
      set: async (key: string, value: string) => {
        secrets.set(key, value);
        return true;
      },
      remove: async (key: string) => {
        secrets.delete(key);
      },
    } as never,
  });
}

interface Node {
  /** The key the address signs with; null: it cannot prove anything. */
  signer: CryptoKey | null;
  linkedRole: "viewer" | "operator" | "owner" | undefined;
  authenticated: boolean;
}

function setup(options: { readonly access?: Partial<AuthLinkedDirectAccess> } = {}) {
  const node: Node = { signer: nodeKey.privateKey, linkedRole: "operator", authenticated: true };
  const catalog = memoryCatalog();
  const issueLinkedDirectAccess = vi.fn(
    async (): Promise<AuthLinkedDirectAccess> =>
      ({
        kind: "issued",
        environmentId: DIRECT,
        label: "Studio",
        endpoints: [
          { httpBaseUrl: "http://192.168.1.20:3773", wsBaseUrl: "ws://192.168.1.20:3773" },
          { httpBaseUrl: ADDRESS, wsBaseUrl: "wss://studio.tail1.ts.net" },
        ],
        credential: "ONE-TIME-CODE",
        expiresAt: new Date(),
        nodeIdentityPublicKey: nodeKeyB64,
        ...options.access,
      }) as AuthLinkedDirectAccess,
  );
  const bootstrap = vi.fn(async () => ({ sessionToken: "linked-bearer" }));
  let nowMs = Date.parse("2026-10-30T12:00:00.000Z");
  const linked = createMobileLinkedDirectAccess({
    catalog,
    remoteApi: {
      fetchRemoteEnvironmentDescriptor: async () => ({ environmentId: DIRECT }) as never,
      bootstrapRemoteBearerSession: bootstrap as never,
      resolveRemoteWebSocketConnectionUrl: async ({ wsBaseUrl, bearerToken }) =>
        `${wsBaseUrl}/anything?wsToken=${bearerToken}-token`,
      fetchRemoteSessionState: async () =>
        ({
          authenticated: node.authenticated,
          ...(node.linkedRole ? { linkedRole: node.linkedRole } : {}),
        }) as never,
    },
    requestProof: async ({ challenge, origin }) => {
      if (node.signer === null) return { kind: "refused" };
      const transcript = encodeDirectRouteIdentityTranscript({
        environmentId: DIRECT,
        origin,
        challenge: Uint8Array.from(Buffer.from(challenge, "base64url")),
      });
      const signature = await crypto.subtle.sign(
        "Ed25519",
        node.signer,
        Uint8Array.from(transcript),
      );
      return { kind: "signed", signature: Buffer.from(signature).toString("base64url") };
    },
    isBearerRefused: () => false,
    issueLinkedDirectAccess,
    nowMs: () => nowMs,
  });
  return {
    node,
    catalog,
    linked,
    issueLinkedDirectAccess,
    bootstrap,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const signal = () => new AbortController().signal;

describe("the phone's linked direct access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("links over the relay at the address that proves the machine's key, kept apart from environments", async () => {
    const { catalog, linked, bootstrap } = setup();
    await expect(linked.link(machine)).resolves.toBe("linked");
    // The plain LAN address is never tried; the code goes to the proven one.
    expect(bootstrap).toHaveBeenCalledWith({ httpBaseUrl: ADDRESS, credential: "ONE-TIME-CODE" });
    expect(catalog.list()).toEqual([]);
    expect(catalog.getLinked(DIRECT)).toMatchObject({
      httpBaseUrl: ADDRESS,
      hubLink: { hubEnvironmentId: HUB, nodeIdentityPublicKey: nodeKeyB64 },
    });
    await expect(catalog.readBearerToken(DIRECT)).resolves.toBe("linked-bearer");
  });

  it("sends the code nowhere when no address proves the key, or the machine names none", async () => {
    const impostor = setup();
    impostor.node.signer = (
      (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair
    ).privateKey;
    await expect(impostor.linked.link(machine)).resolves.toBe("unreachable");
    expect(impostor.bootstrap).not.toHaveBeenCalled();

    const older = setup({ access: { nodeIdentityPublicKey: undefined } as never });
    await expect(older.linked.link(machine)).resolves.toBe("node-update-required");
    expect(older.bootstrap).not.toHaveBeenCalled();
  });

  it("gives each attempt the proven route with the linked session's role", async () => {
    const { linked } = setup();
    await linked.link(machine);
    await expect(linked.resolveRoute(machine, signal())).resolves.toEqual({
      routeKey: ADDRESS,
      url: "wss://studio.tail1.ts.net/ws?wsToken=linked-bearer-token",
      role: "operator",
    });
  });

  it("takes the relay when the node names no linked role", async () => {
    const { linked, node } = setup();
    await linked.link(machine);
    node.linkedRole = undefined;
    await expect(linked.resolveRoute(machine, signal())).resolves.toBeNull();
    // A role the node should not send is no role either.
    node.linkedRole = "admin" as never;
    await expect(linked.resolveRoute(machine, signal())).resolves.toBeNull();
  });

  it("holds an address whose bearer the node refused and renews the link over the relay", async () => {
    const { linked, node, issueLinkedDirectAccess } = setup();
    await linked.link(machine);
    issueLinkedDirectAccess.mockClear();
    node.authenticated = false;
    await expect(linked.resolveRoute(machine, signal())).resolves.toBeNull();
    await vi.waitFor(() => expect(issueLinkedDirectAccess).toHaveBeenCalledTimes(1));
  });

  it("leaves a direct route that was removed, and checks better routes while on the relay", async () => {
    const { linked } = setup();
    await linked.link(machine);
    let active: string | null = ADDRESS;
    let fire: ((reason: "interval" | "network-changed" | "resume") => void) | undefined;
    const reconnect = vi.fn();
    const stop = linked.keepUpgraded({
      machine,
      readActiveRouteKey: () => active,
      mayUpgrade: () => true,
      relayReady: () => true,
      isCurrent: () => true,
      reconnect,
      subscribeTriggers: (trigger) => {
        fire = trigger;
        return () => undefined;
      },
    });
    await linked.forget(HUB);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(linked.linkFor(HUB)).toBeNull();

    active = "relay";
    fire?.("interval");
    expect(reconnect).toHaveBeenCalledTimes(1);
    stop();
  });

  it("renews an aged link while on the relay, and stops once its connection is replaced", async () => {
    const { linked, issueLinkedDirectAccess, advance } = setup();
    await linked.link(machine);
    issueLinkedDirectAccess.mockClear();
    let current = true;
    let fire: ((reason: "interval" | "network-changed" | "resume") => void) | undefined;
    linked.keepUpgraded({
      machine,
      readActiveRouteKey: () => "relay",
      mayUpgrade: () => false,
      relayReady: () => true,
      isCurrent: () => current,
      reconnect: () => undefined,
      subscribeTriggers: (trigger) => {
        fire = trigger;
        return () => undefined;
      },
    });
    fire?.("interval");
    expect(issueLinkedDirectAccess).not.toHaveBeenCalled();
    advance(3 * 24 * 60 * 60 * 1000);
    fire?.("interval");
    await vi.waitFor(() => expect(issueLinkedDirectAccess).toHaveBeenCalledTimes(1));

    current = false;
    advance(3 * 24 * 60 * 60 * 1000);
    fire?.("interval");
    fire?.("interval");
    expect(issueLinkedDirectAccess).toHaveBeenCalledTimes(1);
  });

  it("keeps no link or bearer from a link still being made when the links are forgotten", async () => {
    const { linked, catalog, bootstrap } = setup();
    let releaseBootstrap: (() => void) | undefined;
    bootstrap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBootstrap = () => resolve({ sessionToken: "linked-bearer" });
        }),
    );
    const linking = linked.link(machine);
    await vi.waitFor(() => expect(releaseBootstrap).toBeDefined());
    // Sign-out (or Remove direct access) while the code is being redeemed.
    const forgetting = linked.forget();
    releaseBootstrap?.();
    await expect(linking).rejects.toThrow("removed");
    await forgetting;
    expect(catalog.listLinked()).toEqual([]);
    await expect(catalog.readBearerToken(DIRECT)).resolves.toBeNull();
  });

  it("holds direct routes per machine after a relay refusal, until a relay socket opens", () => {
    const { linked } = setup();
    const hold = linked.directRouteHold(HUB);
    expect(hold.held()).toBe(false);
    hold.set(true);
    // Another generation of the same machine's connection reads the same hold.
    expect(linked.directRouteHold(HUB).held()).toBe(true);
    expect(linked.directRouteHold("env_hub_other" as EnvironmentId).held()).toBe(false);
    hold.set(false);
    expect(linked.directRouteHold(HUB).held()).toBe(false);
  });

  it("forgets every link and bearer on sign-out", async () => {
    const { linked, catalog } = setup();
    await linked.link(machine);
    await linked.forget();
    expect(catalog.listLinked()).toEqual([]);
    await expect(catalog.readBearerToken(DIRECT)).resolves.toBeNull();
  });
});

describe("the role a direct attempt publishes", () => {
  it("never rises above the machine's current role in the Hub directory", () => {
    expect(capLinkedRole("owner", "owner")).toBe("owner");
    expect(capLinkedRole("owner", "viewer")).toBe("viewer");
    expect(capLinkedRole("operator", "owner")).toBe("operator");
    expect(capLinkedRole("viewer", "operator")).toBe("viewer");
    // A machine the directory no longer lists takes the relay.
    expect(capLinkedRole("owner", null)).toBeNull();
  });
});
