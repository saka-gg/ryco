import { describe, expect, it } from "vite-plus/test";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { relayRpcPrincipal } from "../ws/RpcPrincipal.ts";
import type { NodeE2eeChannelMode } from "./NodeE2eeChannelSession.ts";
import { relayChannelAuthority, relayChannelPrincipal } from "./relayChannelAuthority.ts";
import { Effect, Exit } from "effect";

const FINGERPRINT = Uint8Array.from([7, 7, 7]);
const NODE_KEY = Uint8Array.from([5, 5, 5]);

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
        nodeIdentityPublicKey: NODE_KEY,
      }),
    ).toEqual({
      trustSource: "account-enrolled",
      enrollmentId: "enr_1",
      accountId: "acct",
      clientIdentityFingerprint: FINGERPRINT,
      role: "operator",
      nodeIdentityPublicKey: NODE_KEY,
    });
  });

  it("identifies a locally verified device only through an approved record", () => {
    expect(
      relayChannelAuthority("operator", {
        trustSource: "locally-verified",
        admittedAuthority: local("owner"),
        accountGrantAuthority: undefined,
        nodeIdentityPublicKey: NODE_KEY,
      }),
    ).toEqual({
      trustSource: "locally-verified",
      clientIdentityFingerprint: FINGERPRINT,
      role: "operator",
      nodeIdentityPublicKey: NODE_KEY,
    });
    expect(
      relayChannelAuthority("owner", {
        trustSource: "locally-verified",
        admittedAuthority: local("owner", "pending"),
        accountGrantAuthority: undefined,
        nodeIdentityPublicKey: NODE_KEY,
      }),
    ).toEqual({ trustSource: "none" });
  });

  it("identifies no device for web NX or an unknown role", () => {
    expect(
      relayChannelAuthority("owner", {
        trustSource: "web-unsigned",
        admittedAuthority: undefined,
        accountGrantAuthority: undefined,
        nodeIdentityPublicKey: NODE_KEY,
      }),
    ).toEqual({ trustSource: "none" });
    expect(
      relayChannelAuthority("owner", {
        trustSource: "account-enrolled",
        admittedAuthority: undefined,
        accountGrantAuthority: grant("superuser"),
        nodeIdentityPublicKey: NODE_KEY,
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

describe("relayChannelPrincipal", () => {
  it("reads the device and the encryption from the channel's E2EE mode per request", () => {
    let mode: NodeE2eeChannelMode = "negotiating";
    const principal = relayChannelPrincipal("owner", "chn_1", { mode: () => mode }, () => ({
      trustSource: "locally-verified",
      clientIdentityFingerprint: FINGERPRINT,
      role: "owner",
    }));
    const encrypted = () =>
      principal.connection?.kind === "relay" && principal.connection.endToEndEncrypted();
    for (const plain of ["negotiating", "legacy", "closed"] as const) {
      mode = plain;
      expect(encrypted(), plain).toBe(false);
      expect(principal.relayAuthority?.().trustSource, plain).toBe("none");
    }
    mode = "e2ee";
    expect(encrypted()).toBe(true);
    expect(principal.relayAuthority?.().trustSource).toBe("locally-verified");
  });

  it("counts a web NX channel, which identifies no device, as encrypted", () => {
    const principal = relayChannelPrincipal("owner", "chn_web", { mode: () => "e2ee" }, () => ({
      trustSource: "none",
    }));
    expect(principal.connection?.kind === "relay" && principal.connection.endToEndEncrypted()).toBe(
      true,
    );
    expect(principal.relayAuthority?.()).toEqual({ trustSource: "none" });
  });
});
