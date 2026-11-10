import { ed25519 } from "@noble/curves/ed25519.js";
import type { EnvironmentId } from "@ryco/contracts";
import { encodeDirectRouteIdentityTranscript } from "@ryco/shared/directRouteIdentity";
import { describe, expect, it, vi } from "vite-plus/test";

import { decodeBase64Url, encodeBase64Url } from "../relay/base64url.ts";
import type { SavedEnvironmentRecord } from "./catalog.ts";
import {
  createHubLinkedRoutes,
  LINKED_ROUTE_UNANSWERED_SKIP_MS,
  type HubLinkedRoutesPorts,
} from "./hubLinkedRoutes.ts";

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
    requestProof: async ({ challenge, origin }) => ({
      kind: "signed",
      signature: encodeBase64Url(
        ed25519.sign(
          encodeDirectRouteIdentityTranscript({
            environmentId: DIRECT,
            origin,
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

  it("moves on from an address that answers its descriptor and then stalls", async () => {
    const routes = createHubLinkedRoutes(
      ports({ socketUrl: () => new Promise(() => undefined), attemptDeadlineMs: 20 }),
    );
    await expect(routes.resolve(HUB, signal())).resolves.toBeNull();
  });

  it("lets the upgrader count a route only once it proved the key, holding one that refused", async () => {
    const onRefused = vi.fn();
    const proven = createHubLinkedRoutes(ports());
    const route = proven.routesFor(HUB);
    await expect(proven.checkRoutes(route, signal())).resolves.toEqual(
      new Map([["https://studio.tail1.ts.net", { kind: "answered", descriptorId: DIRECT }]]),
    );

    const impostor = createHubLinkedRoutes(
      ports({
        requestProof: async () => ({
          kind: "signed",
          signature: encodeBase64Url(new Uint8Array(64)),
        }),
      }),
    );
    const results = await impostor.checkRoutes(impostor.routesFor(HUB), signal(), onRefused);
    expect(results.get("https://studio.tail1.ts.net")).toEqual({ kind: "unreachable" });
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(impostor.routesFor(HUB)).toEqual([]);

    // Paced or silent: not counted this time, and not held either.
    const paced = createHubLinkedRoutes(
      ports({ requestProof: async () => ({ kind: "unreachable" }) }),
    );
    const pacedResults = await paced.checkRoutes(paced.routesFor(HUB), signal());
    expect(pacedResults.get("https://studio.tail1.ts.net")).toEqual({ kind: "unreachable" });
    expect(paced.routesFor(HUB)).toHaveLength(1);
  });

  it("gives a silent address a short time on an attempt, then leaves it out until it answers", async () => {
    let now = NOW;
    // "silent" never answers (a tailnet address away from the tailnet), "down" refuses at once.
    let address: "silent" | "down" | "up" = "silent";
    const fetchDescriptorId = vi.fn((_: string, abort: AbortSignal) => {
      if (address === "up") return Promise.resolve(DIRECT);
      if (address === "down") return Promise.reject(new Error("refused"));
      return new Promise<EnvironmentId>((_resolve, reject) => {
        abort.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const routes = createHubLinkedRoutes(
      ports({ fetchDescriptorId, attemptCheckTimeoutMs: 20, nowMs: () => now }),
    );
    // Away from the tailnet: the attempt waits only the short check, then takes the relay.
    await expect(routes.resolve(HUB, signal())).resolves.toBeNull();
    expect(fetchDescriptorId).toHaveBeenCalledTimes(1);
    // The next attempts do not ask the address at all.
    await expect(routes.resolve(HUB, signal())).resolves.toBeNull();
    expect(fetchDescriptorId).toHaveBeenCalledTimes(1);
    // The upgrader still checks it, and its proof brings the address back for attempts.
    address = "up";
    expect(routes.routesFor(HUB)).toHaveLength(1);
    await routes.checkRoutes(routes.routesFor(HUB), signal());
    await expect(routes.resolve(HUB, signal())).resolves.toMatchObject({
      routeKey: "https://studio.tail1.ts.net",
    });

    // Without an upgrader check, the address is asked again once the wait has passed.
    address = "down";
    await routes.checkRoutes(routes.routesFor(HUB), signal());
    fetchDescriptorId.mockClear();
    await expect(routes.resolve(HUB, signal())).resolves.toBeNull();
    expect(fetchDescriptorId).not.toHaveBeenCalled();
    address = "up";
    now += LINKED_ROUTE_UNANSWERED_SKIP_MS;
    await expect(routes.resolve(HUB, signal())).resolves.not.toBeNull();
  });

  it("allows an address the upgrader just proved the full check time on the next attempt", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      // The address answers when the test opens the gate, however long that takes.
      let open: (() => void) | null = null;
      const fetchDescriptorId = vi.fn(
        (_: string, abort: AbortSignal) =>
          new Promise<EnvironmentId>((resolve, reject) => {
            open = () => resolve(DIRECT);
            abort.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );
      const routes = createHubLinkedRoutes(
        ports({ fetchDescriptorId, attemptCheckTimeoutMs: 20, nowMs: () => Date.now() }),
      );
      // Too slow for an attempt's short check.
      const first = routes.resolve(HUB, signal());
      await vi.advanceTimersByTimeAsync(20);
      await expect(first).resolves.toBeNull();
      expect(fetchDescriptorId).toHaveBeenCalledTimes(1);

      // The upgrader's check waits longer, and sees it answer and prove the key.
      const check = routes.checkRoutes(routes.routesFor(HUB), signal());
      await vi.advanceTimersByTimeAsync(100);
      open!();
      await check;

      // The attempt that follows waits as long as the check did.
      let settled = false;
      const second = routes.resolve(HUB, signal()).then((attempt) => {
        settled = true;
        return attempt;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      open!();
      await expect(second).resolves.toMatchObject({ routeKey: "https://studio.tail1.ts.net" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold a called-off attempt against its address", async () => {
    const abort = new AbortController();
    const fetchDescriptorId = vi.fn(
      (_: string, signal: AbortSignal) =>
        new Promise<EnvironmentId>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const routes = createHubLinkedRoutes(ports({ fetchDescriptorId }));
    const attempt = routes.resolve(HUB, abort.signal);
    abort.abort();
    await expect(attempt).resolves.toBeNull();
    fetchDescriptorId.mockImplementation(async () => DIRECT);
    await expect(routes.resolve(HUB, signal())).resolves.not.toBeNull();
  });
});
