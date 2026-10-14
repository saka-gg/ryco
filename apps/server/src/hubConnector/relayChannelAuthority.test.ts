import { describe, expect, it } from "vite-plus/test";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { relayRpcPrincipal } from "../ws/RpcPrincipal.ts";
import { relayChannelAuthority } from "./relayChannelAuthority.ts";
import { Effect, Exit } from "effect";

const FINGERPRINT = Uint8Array.from([7, 7, 7]);

const grant = (maximumRole: string) => ({
  trustSource: "account-enrolled" as const,
  hubOrigin: "https://hub.example",
  accountId: "acct",
  enrollmentId: "enr_1",
  enrollmentRevision: 1,
  accountAuthEpoch: 1,
  deviceAuthEpoch: 1,
  clientIdentityFingerprint: FINGERPRINT,
  maximumRole,
  capabilitySet: ["ryco.rpc"],
});

const local = (maxRole: string, status: "approved" | "pending" = "approved") => ({
  hubOrigin: "https://hub.example",
  accountId: "acct",
  clientIdentityFingerprint: FINGERPRINT,
  status,
  maxRole,
  capabilitySet: ["ryco.rpc"],
});

describe("relayChannelAuthority", () => {
  it("identifies an account-enrolled device at the lower of channel and grant role", () => {
    expect(
      relayChannelAuthority("owner", {
        trustSource: "account-enrolled",
        admittedAuthority: undefined,
        accountGrantAuthority: grant("operator"),
      }),
    ).toEqual({
      trustSource: "account-enrolled",
      enrollmentId: "enr_1",
      clientIdentityFingerprint: FINGERPRINT,
      role: "operator",
    });
  });

  it("identifies a locally verified device only through an approved record", () => {
    expect(
      relayChannelAuthority("operator", {
        trustSource: "locally-verified",
        admittedAuthority: local("owner"),
        accountGrantAuthority: undefined,
      }),
    ).toEqual({
      trustSource: "locally-verified",
      clientIdentityFingerprint: FINGERPRINT,
      role: "operator",
    });
    expect(
      relayChannelAuthority("owner", {
        trustSource: "locally-verified",
        admittedAuthority: local("owner", "pending"),
        accountGrantAuthority: undefined,
      }),
    ).toEqual({ trustSource: "none" });
  });

  it("identifies no device for web NX or an unknown role", () => {
    expect(
      relayChannelAuthority("owner", {
        trustSource: "web-unsigned",
        admittedAuthority: undefined,
        accountGrantAuthority: undefined,
      }),
    ).toEqual({ trustSource: "none" });
    expect(
      relayChannelAuthority("owner", {
        trustSource: "account-enrolled",
        admittedAuthority: undefined,
        accountGrantAuthority: grant("superuser"),
      }),
    ).toEqual({ trustSource: "none" });
  });
});

describe("relay_native access", () => {
  const allowed = (principal: Parameters<typeof authorizeRpcPrincipal>[0]) =>
    Exit.isSuccess(
      Effect.runSyncExit(authorizeRpcPrincipal(principal, "relay_native", "auth.test")),
    );

  it("admits only a relay channel that authenticated a native device", () => {
    expect(
      allowed(
        relayRpcPrincipal("viewer", "chn_1", () => ({
          trustSource: "locally-verified",
          clientIdentityFingerprint: FINGERPRINT,
          role: "viewer",
        })),
      ),
    ).toBe(true);
    expect(allowed(relayRpcPrincipal("owner", "chn_2"))).toBe(false);
    expect(
      allowed({
        transport: "direct",
        role: "owner",
        scopeId: "session",
        canManageLocalAccess: true,
        relayAuthority: () => ({
          trustSource: "locally-verified",
          clientIdentityFingerprint: FINGERPRINT,
          role: "owner",
        }),
      }),
    ).toBe(false);
  });
});
