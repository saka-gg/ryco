import type { AdvertisedEndpoint, ExecutionEnvironmentDescriptor } from "@ryco/contracts";
import { EnvironmentId } from "@ryco/contracts";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { issueLinkedDirectAccess, linkedDirectAccessEndpoints } from "./linkedDirectAccess.ts";

const endpoint = (
  id: string,
  httpBaseUrl: string,
  reachability: AdvertisedEndpoint["reachability"],
  status: AdvertisedEndpoint["status"] = "available",
): AdvertisedEndpoint =>
  ({
    id,
    label: id,
    provider: { id: "core", label: "Core", kind: "core", isAddon: false },
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws"),
    reachability,
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "server",
    status,
  }) as AdvertisedEndpoint;

const ENDPOINTS = [
  endpoint("loopback", "http://127.0.0.1:3773", "loopback"),
  endpoint("lan", "http://192.168.1.20:3773", "lan"),
  endpoint("tailnet", "http://100.64.0.2:3773", "private-network"),
  endpoint("serve", "https://m4.tailnet.ts.net", "private-network"),
  endpoint("down", "http://10.0.0.9:3773", "lan", "unavailable"),
];

const environment = {
  environmentId: EnvironmentId.make("env-direct"),
  label: "MacBook Pro M4",
} as unknown as ExecutionEnvironmentDescriptor;

describe("linkedDirectAccessEndpoints", () => {
  it("offers only endpoints another device can reach, Tailscale HTTPS first", () => {
    expect(linkedDirectAccessEndpoints(ENDPOINTS).map((entry) => entry.id)).toEqual([
      "serve",
      "tailnet",
      "lan",
    ]);
  });
});

describe("issueLinkedDirectAccess", () => {
  const issued: Array<Record<string, unknown>> = [];
  const bootstrapCredentials = {
    issueOneTimeToken: (input?: Record<string, unknown>) => {
      issued.push(input ?? {});
      return Effect.succeed({
        id: "grant-1",
        credential: "ABCDEFGHJKLM",
        expiresAt: DateTime.makeUnsafe(1_000),
      });
    },
  } as never;

  it("binds an account-enrolled code to the enrollment, key and role of its channel", async () => {
    const result = await Effect.runPromise(
      issueLinkedDirectAccess({
        authority: {
          trustSource: "account-enrolled",
          enrollmentId: "enr_laptop",
          clientIdentityFingerprint: Uint8Array.from([1, 2, 3]),
          role: "owner",
        },
        deviceLabel: "Studio Mac",
        environment,
        endpoints: ENDPOINTS,
        bootstrapCredentials,
      }),
    );
    expect(result).toMatchObject({
      kind: "issued",
      environmentId: "env-direct",
      label: "MacBook Pro M4",
      credential: "ABCDEFGHJKLM",
    });
    expect(issued.at(-1)).toMatchObject({
      role: "client",
      subject: "hub-linked",
      label: "Linked through Hub · Studio Mac",
      link: {
        trustSource: "account-enrolled",
        enrollmentId: "enr_laptop",
        clientFingerprint: "AQID",
        role: "owner",
      },
    });
  });

  it("binds a locally verified code to the device key alone", async () => {
    await Effect.runPromise(
      issueLinkedDirectAccess({
        authority: {
          trustSource: "locally-verified",
          clientIdentityFingerprint: Uint8Array.from([9]),
          role: "viewer",
        },
        deviceLabel: "Phone",
        environment,
        endpoints: ENDPOINTS,
        bootstrapCredentials,
      }),
    );
    expect(issued.at(-1)?.link).toEqual({
      trustSource: "locally-verified",
      enrollmentId: null,
      clientFingerprint: "CQ",
      role: "viewer",
    });
  });

  it("issues nothing for a channel without a native device or a node without a direct endpoint", async () => {
    const before = issued.length;
    expect(
      await Effect.runPromise(
        issueLinkedDirectAccess({
          authority: { trustSource: "none" },
          deviceLabel: "Browser",
          environment,
          endpoints: ENDPOINTS,
          bootstrapCredentials,
        }),
      ),
    ).toBeNull();
    expect(
      await Effect.runPromise(
        issueLinkedDirectAccess({
          authority: {
            trustSource: "locally-verified",
            clientIdentityFingerprint: Uint8Array.from([9]),
            role: "owner",
          },
          deviceLabel: "Phone",
          environment,
          endpoints: [ENDPOINTS[0]!],
          bootstrapCredentials,
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "no-direct-endpoint" });
    expect(issued.length).toBe(before);
  });
});
