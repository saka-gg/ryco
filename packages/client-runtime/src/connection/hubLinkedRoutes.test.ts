import { ed25519 } from "@noble/curves/ed25519.js";
import type { EnvironmentId } from "@ryco/contracts";
import { encodeDirectRouteIdentityTranscript } from "@ryco/shared/directRouteIdentity";
import { describe, expect, it, vi } from "vite-plus/test";

import { decodeBase64Url, encodeBase64Url } from "../relay/base64url.ts";
import type { SavedEnvironmentRecord } from "./catalog.ts";
import { createHubLinkedRoutes, type HubLinkedRoutesPorts } from "./hubLinkedRoutes.ts";

const HUB = "env_hub" as EnvironmentId;
const DIRECT = "env-direct" as EnvironmentId;
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const nodeSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
const NODE_KEY = encodeBase64Url(ed25519.getPublicKey(nodeSecret));

const record = (httpBaseUrl: string): SavedEnvironmentRecord => ({
  environmentId: DIRECT,
  label: "Studio",
  httpBaseUrl,
  wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws"),
  createdAt: "2026-10-20T00:00:00.000Z",
  lastConnectedAt: null,
  hubLink: {
    hubEnvironmentId: HUB,
    linkedAt: new Date(NOW - 60_000).toISOString(),
    nodeIdentityPublicKey: NODE_KEY,
  },
});

class Refused extends Error {}

function ports(overrides: Partial<HubLinkedRoutesPorts> = {}): HubLinkedRoutesPorts {
  return {
    listLinkedRecords: () => [record("https://studio.tail1.ts.net")],
    readBearerToken: async () => "linked-bearer",
    fetchDescriptorId: async () => DIRECT,
    requestProof: async ({ challenge }) => ({
      kind: "signed",
      signature: encodeBase64Url(
        ed25519.sign(
          encodeDirectRouteIdentityTranscript({
            environmentId: DIRECT,
            challenge: decodeBase64Url(challenge),
          }),
          nodeSecret,
        ),
      ),
    }),
    socketUrl: async ({ route, bearerToken }) =>
      `${route.wsBaseUrl}/some/path?wsToken=${bearerToken}-token`,
    isBearerRefused: (error) => error instanceof Refused,
    nowMs: () => NOW,
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

describe("a Hub machine's linked routes", () => {
  it("takes the proven route, its socket on the node's /ws path", async () => {
    const routes = createHubLinkedRoutes(ports());
    await expect(routes.resolve(HUB, signal())).resolves.toEqual({
      routeKey: "https://studio.tail1.ts.net",
      url: "wss://studio.tail1.ts.net/ws?wsToken=linked-bearer-token",
    });
  });

  it("adds the linked role when the ports read one, and takes no route without one", async () => {
    let role: "owner" | null = "owner";
    const routes = createHubLinkedRoutes(ports({ readRole: async () => role }));
    await expect(routes.resolve(HUB, signal())).resolves.toMatchObject({ role: "owner" });
    role = null;
    await expect(routes.resolve(HUB, signal())).resolves.toBeNull();
  });

  it("holds an address that refused the bearer until the machine's link changes", async () => {
    const onRefused = vi.fn();
    const socketUrl = vi.fn(async () => {
      throw new Refused();
    });
    const routes = createHubLinkedRoutes(ports({ socketUrl }));
    await expect(routes.resolve(HUB, signal(), onRefused)).resolves.toBeNull();
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(routes.routesFor(HUB)).toEqual([]);
    await routes.resolve(HUB, signal(), onRefused);
    expect(socketUrl).toHaveBeenCalledTimes(1);

    routes.clearRefusals(HUB);
    expect(routes.routesFor(HUB)).toHaveLength(1);
  });

  it("never spends the bearer at an address that fails the proof", async () => {
    const readBearerToken = vi.fn(async () => "linked-bearer");
    const onRefused = vi.fn();
    const routes = createHubLinkedRoutes(
      ports({
        readBearerToken,
        requestProof: async () => ({
          kind: "signed",
          signature: encodeBase64Url(new Uint8Array(64)),
        }),
      }),
    );
    await expect(routes.resolve(HUB, signal(), onRefused)).resolves.toBeNull();
    expect(readBearerToken).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledTimes(1);
  });
});
