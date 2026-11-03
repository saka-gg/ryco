import type {
  AdvertisedEndpoint,
  AuthLinkedDirectAccess,
  ExecutionEnvironmentDescriptor,
} from "@ryco/contracts";
import { EnvironmentId } from "@ryco/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { SavedEnvironmentRecord } from "./catalog.ts";
import {
  HUB_LINKED_DIRECT_ACCESS_RENEW_AFTER_MS,
  hubLinkedDirectAccessDue,
  isManuallyPairedEnvironment,
} from "./hubLinkedDirectAccess.ts";
import { resolveHubLinkedDirectTarget } from "./hubLinkedDirectTarget.ts";

const DIRECT = EnvironmentId.make("env-direct");
const NOW = Date.parse("2026-10-14T12:00:00.000Z");

const record = (input: Partial<SavedEnvironmentRecord>): SavedEnvironmentRecord => ({
  environmentId: DIRECT,
  label: "M4",
  httpBaseUrl: "http://100.64.0.2:3773",
  wsBaseUrl: "ws://100.64.0.2:3773",
  createdAt: "2026-10-01T00:00:00.000Z",
  lastConnectedAt: null,
  ...input,
});

const endpoint = (httpBaseUrl: string) =>
  ({ httpBaseUrl, wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws") }) as AdvertisedEndpoint;

const NODE_KEY = "bm9kZS1pZGVudGl0eS1rZXk";

const access = (endpoints: ReadonlyArray<AdvertisedEndpoint>, nodeIdentityPublicKey = NODE_KEY) =>
  ({
    kind: "issued",
    environmentId: DIRECT,
    label: "MacBook Pro M4",
    endpoints,
    credential: "ABCDEFGHJKLM",
    expiresAt: DateTime.makeUnsafe(NOW + 120_000),
    ...(nodeIdentityPublicKey === "" ? {} : { nodeIdentityPublicKey }),
  }) as Extract<AuthLinkedDirectAccess, { kind: "issued" }>;

const proven = async () => "proven" as const;

describe("hubLinkedDirectAccessDue", () => {
  it("links a Hub machine with no linked record, and again once its link has aged", () => {
    expect(hubLinkedDirectAccessDue({ hubEnvironmentId: "env_hub", records: [], nowMs: NOW })).toBe(
      true,
    );
    const linked = (ageMs: number) =>
      record({
        hubLink: {
          hubEnvironmentId: "env_hub",
          linkedAt: new Date(NOW - ageMs).toISOString(),
          nodeIdentityPublicKey: NODE_KEY,
        },
      });
    expect(
      hubLinkedDirectAccessDue({
        hubEnvironmentId: "env_hub",
        records: [linked(60_000)],
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      hubLinkedDirectAccessDue({
        hubEnvironmentId: "env_hub",
        records: [linked(HUB_LINKED_DIRECT_ACCESS_RENEW_AFTER_MS)],
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("renews a link saved before the identity proof at once: it names no key to prove", () => {
    expect(
      hubLinkedDirectAccessDue({
        hubEnvironmentId: "env_hub",
        records: [
          record({
            hubLink: {
              hubEnvironmentId: "env_hub",
              linkedAt: new Date(NOW - 60_000).toISOString(),
            },
          }),
        ],
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("tells a hand-paired environment apart from a linked one", () => {
    expect(isManuallyPairedEnvironment([record({})], DIRECT)).toBe(true);
    expect(
      isManuallyPairedEnvironment(
        [record({ hubLink: { hubEnvironmentId: "env_hub", linkedAt: "2026-10-14T00:00:00Z" } })],
        DIRECT,
      ),
    ).toBe(false);
  });
});

describe("resolveHubLinkedDirectTarget", () => {
  const descriptor = (environmentId: string) =>
    ({ environmentId: EnvironmentId.make(environmentId) }) as ExecutionEnvironmentDescriptor;

  it("takes the first endpoint that answers as the same node, in the node's order", async () => {
    const probed: string[] = [];
    const proved: string[] = [];
    const target = await resolveHubLinkedDirectTarget({
      access: access([
        endpoint("https://gone.tailnet.ts.net"),
        endpoint("http://100.64.0.50:3773"),
        endpoint("http://100.64.0.2:3773"),
      ]),
      fetchDescriptor: async (httpBaseUrl) => {
        probed.push(httpBaseUrl);
        if (httpBaseUrl.includes("gone")) throw new Error("unreachable");
        // Another node answers at .50 — the same port on a different machine.
        return descriptor(httpBaseUrl.includes(".50") ? "env-other" : "env-direct");
      },
      proveIdentity: async (input) => {
        proved.push(input.httpBaseUrl);
        expect(input).toMatchObject({ environmentId: DIRECT, nodeIdentityPublicKey: NODE_KEY });
        return "proven";
      },
    });
    expect(probed).toHaveLength(3);
    expect(proved).toEqual(["http://100.64.0.2:3773"]);
    expect(target).toEqual({
      environmentId: DIRECT,
      label: "MacBook Pro M4",
      httpBaseUrl: "http://100.64.0.2:3773",
      wsBaseUrl: "ws://100.64.0.2:3773",
      credential: "ABCDEFGHJKLM",
      nodeIdentityPublicKey: NODE_KEY,
    });
  });

  it("never sends the code to an endpoint that answers with the descriptor but not the key", async () => {
    // A copy of the public descriptor is free to serve; the key is not.
    const target = await resolveHubLinkedDirectTarget({
      access: access([endpoint("https://m4.tailnet.ts.net"), endpoint("http://100.64.0.2:3773")]),
      fetchDescriptor: async () => descriptor("env-direct"),
      proveIdentity: async (input) =>
        input.httpBaseUrl.startsWith("https:") ? "refused" : "unreachable",
    });
    expect(target).toBeNull();
  });

  it("never probes a plain LAN or public address, which no route would use", async () => {
    const probed: string[] = [];
    const target = await resolveHubLinkedDirectTarget({
      access: access([endpoint("http://192.168.1.20:3773"), endpoint("http://203.0.113.9:3773")]),
      fetchDescriptor: async (httpBaseUrl) => {
        probed.push(httpBaseUrl);
        return descriptor("env-direct");
      },
      proveIdentity: proven,
    });
    expect(target).toBeNull();
    expect(probed).toEqual([]);
  });

  it("uses no endpoint of a node too old to name its identity key", async () => {
    const probed: string[] = [];
    const target = await resolveHubLinkedDirectTarget({
      access: access([endpoint("http://100.64.0.2:3773")], ""),
      fetchDescriptor: async (httpBaseUrl) => {
        probed.push(httpBaseUrl);
        return descriptor("env-direct");
      },
      proveIdentity: proven,
    });
    expect(target).toBeNull();
    expect(probed).toEqual([]);
  });

  it("gives up on an endpoint that does not answer in time", async () => {
    const target = await resolveHubLinkedDirectTarget({
      access: access([endpoint("http://100.64.0.2:3773")]),
      fetchDescriptor: () => new Promise(() => undefined),
      proveIdentity: proven,
      timeoutMs: 5,
    });
    expect(target).toBeNull();
    const silent = await resolveHubLinkedDirectTarget({
      access: access([endpoint("http://100.64.0.2:3773")]),
      fetchDescriptor: async () => descriptor("env-direct"),
      proveIdentity: () => new Promise(() => undefined),
      timeoutMs: 5,
    });
    expect(silent).toBeNull();
  });
});
