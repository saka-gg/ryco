import { generateKeyPairSync, sign } from "node:crypto";

import type {
  RelayE2eeEnrollmentRevokedFrame,
  RelayE2eeVerifierKeysFrame,
} from "@ryco/contracts/relay";
import {
  decodeHubDeviceGrant,
  encodeHubDeviceGrantClaims,
  encodeHubDeviceGrantEnvelope,
  encodeHubDeviceGrantSigningEnvelope,
  type HubDeviceGrantClaimsInput,
} from "@ryco/shared/relayE2eeHubDeviceGrant";
import type { E2eeAccountGrantNodeVerificationInput } from "@ryco/shared/relayE2eeHandshake";
import { e2eeKeyFingerprint, e2eeSha256 } from "@ryco/shared/relayE2eeKeys";
import { describe, expect, it } from "vite-plus/test";

import type { NodeE2eeAdvertisement } from "../hubIdentity/NodeE2eeCapabilityStatement.ts";
import {
  effectiveNodeE2eePolicy,
  nodeE2eeAdmissionPolicyForMode,
} from "../hubIdentity/NodeE2eePolicyStore.ts";
import { HubConnectorE2eeStateMachine } from "./HubConnectorState.ts";
import { makeNodeAccountGrantVerifier } from "./NodeAccountGrantVerifier.ts";

const NOW = 2_000_000_000_000;
const HUB_ORIGIN = "https://hub.example.test";
const ACCOUNT_ID = `acct_${"a".repeat(22)}`;
const ENROLLMENT_ID = `enr_${"e".repeat(22)}`;
const TICKET_ID = `rtk_${"t".repeat(22)}`;
const NODE_ID = `node_${"n".repeat(22)}`;
const KEY_ID = `hgk_${"k".repeat(22)}`;

const rawPublicKey = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]): Uint8Array => {
  const bytes = key.export({ format: "der", type: "spki" });
  return Uint8Array.from(bytes.subarray(bytes.byteLength - 32));
};

function fixture() {
  const hub = generateKeyPairSync("ed25519");
  const node = generateKeyPairSync("ed25519");
  const device = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const nodeAgreement = generateKeyPairSync("x25519");
  const deviceAgreement = generateKeyPairSync("x25519");
  const hubPublic = rawPublicKey(hub.publicKey);
  const nodePublic = rawPublicKey(node.publicKey);
  const nodeAgreementPublic = rawPublicKey(nodeAgreement.publicKey);
  const deviceAgreementPublic = rawPublicKey(deviceAgreement.publicKey);
  const deviceDer = device.publicKey.export({ format: "der", type: "spki" });
  const devicePublic = Uint8Array.from(deviceDer.subarray(deviceDer.byteLength - 65));
  const certificateDigest = new Uint8Array(32).fill(7);
  const statement = new Uint8Array([1, 2, 3]);
  const statementDigest = e2eeSha256(statement);
  const advertisement = {
    hubOrigin: HUB_ORIGIN,
    statement,
    statementDigest,
    expiresAt: NOW + 120_000,
    nodeAgreementPrekeyExpiresAt: NOW + 120_000,
    nodeIdentityPublicKey: nodePublic,
    material: {
      nodeId: NODE_ID,
      nodeIdentityFingerprint: e2eeKeyFingerprint("node-identity", nodePublic),
      prekeyId: `epk_${"p".repeat(22)}`,
      agreementPublicKey: nodeAgreementPublic,
      continuityChainTranscripts: [],
      continuityId: `nct_${"c".repeat(22)}`,
      policyGeneration: 6,
      capabilityStatementDigest: statementDigest,
    },
  } as unknown as NodeE2eeAdvertisement;
  const claims = {
    issuerHubOrigin: HUB_ORIGIN,
    keyId: KEY_ID,
    grantId: `hgr_${"g".repeat(22)}`,
    accountId: ACCOUNT_ID,
    accountAuthEpoch: 3,
    enrollmentId: ENROLLMENT_ID,
    enrollmentRevision: 4,
    deviceAuthEpoch: 5,
    deviceIdentityPublicKey: devicePublic,
    deviceAgreementPublicKey: deviceAgreementPublic,
    clientPrekeyCertificateDigest: certificateDigest,
    nodeId: NODE_ID,
    nodeIdentityPublicKey: nodePublic,
    nodeAgreementPublicKey: nodeAgreementPublic,
    nodeContinuityId: advertisement.material.continuityId,
    nodePolicyGeneration: 6,
    nodeCapabilityStatementDigest: statementDigest,
    relayTicketId: TICKET_ID,
    maximumRole: "operator",
    capabilities: ["ryco.rpc"],
    issuedAt: NOW,
    notBefore: NOW - 1_000,
    expiresAt: NOW + 60_000,
    nonce: new Uint8Array(32).fill(9),
  } as unknown as HubDeviceGrantClaimsInput;
  const claimsBytes = encodeHubDeviceGrantClaims(claims);
  const envelope = encodeHubDeviceGrantEnvelope(
    claimsBytes,
    Uint8Array.from(sign(null, encodeHubDeviceGrantSigningEnvelope(claimsBytes), hub.privateKey)),
  );
  const grant = decodeHubDeviceGrant(envelope);
  if (grant.kind !== "ok") throw new Error(grant.reason);
  const input: E2eeAccountGrantNodeVerificationInput = {
    grant,
    certificate: {
      hubOrigin: HUB_ORIGIN,
      accountId: ACCOUNT_ID,
      identityPublicKey: devicePublic,
      identityFingerprint: e2eeKeyFingerprint("client-identity", devicePublic),
      agreementPublicKey: deviceAgreementPublic,
      agreementFingerprint: e2eeKeyFingerprint("agreement", deviceAgreementPublic),
      createdAt: NOW - 1_000,
      expiresAt: NOW + 120_000,
    },
    certificateDigest,
    channel: {
      hubOrigin: HUB_ORIGIN,
      channelId: `chn_${"h".repeat(22)}`,
      relayProtocolMajor: 1,
      relayProtocolMinor: 3,
      channelOpenCapability: "ryco.rpc",
      channelOpenEffectiveRole: "operator",
      accountGrantContext: {
        relayTicketId: TICKET_ID,
        deviceGrantDigest: grant.grantDigest,
        nodeCapabilityStatementDigest: statementDigest,
      },
    },
    advertised: advertisement.material,
    intendedCapability: "ryco.rpc",
    intendedRole: "operator",
    now: NOW,
  };
  const state = new HubConnectorE2eeStateMachine(() => NOW);
  state.begin(8, HUB_ORIGIN, { protocolMajor: 1, protocolMinor: 3 });
  expect(state.publish(8, advertisement)).toBe("accepted");
  expect(state.acknowledge(8, statementDigest)).toBe("accepted");
  expect(
    state.replaceVerifierKeys(8, {
      type: "e2ee.verifier-keys",
      protocolMajor: 1,
      protocolMinor: 3,
      generation: 1,
      keys: [
        { keyId: KEY_ID, publicKey: hubPublic, notBefore: NOW - 60_000, notAfter: NOW + 120_000 },
      ],
    } as unknown as RelayE2eeVerifierKeysFrame),
  ).toBe("accepted");
  return { advertisement, input, state };
}

const policy = (mode: Parameters<typeof nodeE2eeAdmissionPolicyForMode>[0]) =>
  effectiveNodeE2eePolicy(nodeE2eeAdmissionPolicyForMode(mode));

describe("NodeAccountGrantVerifier", () => {
  it("accepts a fully bound, acknowledged account grant without creating local state", () => {
    const context = fixture();
    let lookups = 0;
    const result = makeNodeAccountGrantVerifier({
      state: context.state,
      connectorGeneration: () => 8,
      policy: () => policy("compatibility"),
      authorization: {
        lookupClientAuthorization: () => {
          lookups += 1;
          return undefined;
        },
      },
    }).verify(context.input);
    expect(result).toEqual({ accepted: true, localAuthority: undefined });
    expect(lookups).toBe(1);
  });

  it("lets an existing approved local record narrow, but never promote, the grant", () => {
    const context = fixture();
    const authorization = {
      lookupClientAuthorization: () => ({
        status: "approved" as const,
        maxRole: "owner",
        capabilitySet: ["ryco.rpc"],
      }),
    };
    const accepted = makeNodeAccountGrantVerifier({
      state: context.state,
      connectorGeneration: () => 8,
      policy: () => policy("require-native-e2ee"),
      authorization,
    }).verify(context.input);
    expect(accepted.accepted).toBe(true);
    if (accepted.accepted) {
      expect(accepted.localAuthority).toMatchObject({
        hubOrigin: HUB_ORIGIN,
        accountId: ACCOUNT_ID,
        status: "approved",
        // The retained local lease is the intersection, never authority above
        // the Hub grant's operator ceiling.
        maxRole: "operator",
      });
    }

    for (const local of [
      { status: "revoked" as const, maxRole: "owner", capabilitySet: ["ryco.rpc"] },
      { status: "approved" as const, maxRole: "viewer", capabilitySet: ["ryco.rpc"] },
      { status: "approved" as const, maxRole: "owner", capabilitySet: [] },
    ]) {
      expect(
        makeNodeAccountGrantVerifier({
          state: context.state,
          connectorGeneration: () => 8,
          policy: () => policy("compatibility"),
          authorization: { lookupClientAuthorization: () => local },
        }).verify(context.input),
      ).toEqual({ accepted: false, reason: "grant_policy" });
    }
  });

  it("admits an enrolled device whose only local record is an unanswered pending request", () => {
    const context = fixture();
    for (const pending of [
      { status: "pending" as const, maxRole: "owner", capabilitySet: ["ryco.rpc"] },
      // Pending metadata is display-only: a narrow ceiling there is not a restriction.
      { status: "pending" as const, maxRole: "viewer", capabilitySet: [] },
    ]) {
      expect(
        makeNodeAccountGrantVerifier({
          state: context.state,
          connectorGeneration: () => 8,
          policy: () => policy("require-e2ee"),
          authorization: { lookupClientAuthorization: () => pending },
        }).verify(context.input),
      ).toEqual({ accepted: true, localAuthority: undefined });
    }
  });

  it("fails closed on strongest policy, stale generations, wrong ticket context, and reconnect", () => {
    const context = fixture();
    const make = (generation = 8) =>
      makeNodeAccountGrantVerifier({
        state: context.state,
        connectorGeneration: () => generation,
        policy: () => policy("compatibility"),
        authorization: { lookupClientAuthorization: () => undefined },
      });
    expect(
      makeNodeAccountGrantVerifier({
        state: context.state,
        connectorGeneration: () => 8,
        policy: () => policy("require-locally-approved-native-e2ee"),
        authorization: { lookupClientAuthorization: () => undefined },
      }).verify(context.input),
    ).toEqual({ accepted: false, reason: "grant_policy" });
    expect(make(7).verify(context.input).accepted).toBe(false);
    expect(
      make().verify({
        ...context.input,
        channel: {
          ...context.input.channel,
          accountGrantContext: {
            ...context.input.channel.accountGrantContext!,
            relayTicketId: `rtk_${"x".repeat(22)}`,
          },
        },
      }),
    ).toEqual({ accepted: false, reason: "grant_binding" });
    context.state.begin(9, HUB_ORIGIN, { protocolMajor: 1, protocolMinor: 3 });
    expect(make(9).verify(context.input).accepted).toBe(false);
  });

  it("rejects an authenticated revocation immediately", () => {
    const context = fixture();
    expect(
      context.state.acceptRevocation(8, {
        type: "e2ee.enrollment-revoked",
        protocolMajor: 1,
        protocolMinor: 3,
        enrollmentId: ENROLLMENT_ID,
        enrollmentRevision: 4,
        accountAuthEpoch: 3,
        deviceAuthEpoch: 5,
      } as RelayE2eeEnrollmentRevokedFrame),
    ).toBe("accepted");
    expect(
      makeNodeAccountGrantVerifier({
        state: context.state,
        connectorGeneration: () => 8,
        policy: () => policy("compatibility"),
        authorization: { lookupClientAuthorization: () => undefined },
      }).verify(context.input),
    ).toEqual({ accepted: false, reason: "grant_revoked" });
  });
});
