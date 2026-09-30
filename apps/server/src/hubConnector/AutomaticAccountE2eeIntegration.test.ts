import { generateKeyPairSync, sign } from "node:crypto";

import {
  createNativeE2eeTrustResolver,
  type HostedHubApi,
  type NativeE2eeReadyEnrollment,
  type NativeE2eeTrustResolution,
} from "@ryco/client-runtime/authorization";
import {
  encodeBase64Url,
  makeRelayE2eeInitiator,
  type RelayE2eeHost,
  type RelayE2eeInitiator,
  type RelayE2eeInitiatorAttempt,
} from "@ryco/client-runtime/relay";
import type { NativeE2eeAccountTrustedNode } from "@ryco/client-runtime/platform";
import type {
  NativeAccountGrantRelayTicketResponse,
  NativeAccountGrantRelayTicketRequest,
} from "@ryco/contracts/native-e2ee";
import type { RelayAccountGrantContext, RelayE2eeVerifierKeysFrame } from "@ryco/contracts/relay";
import { E2EE_PREKEY_LIFETIME } from "@ryco/shared/relayE2eeConstants";
import { verifyNodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeCapabilityVerify";
import {
  encodeHubDeviceGrantClaims,
  encodeHubDeviceGrantEnvelope,
  encodeHubDeviceGrantSigningEnvelope,
  type HubDeviceGrantClaimsInput,
} from "@ryco/shared/relayE2eeHubDeviceGrant";
import { e2eeKeyFingerprint, e2eeSha256 } from "@ryco/shared/relayE2eeKeys";
import {
  encodeClientE2eePrekeyCertificateCarrier,
  encodeClientE2eePrekeyTranscript,
} from "@ryco/shared/relayE2eeTranscripts";
import { E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256 } from "@ryco/shared/relayE2eeWire";
import { describe, expect, it, vi } from "vite-plus/test";

import type { NodeE2eeAdvertisement } from "../hubIdentity/NodeE2eeCapabilityStatement.ts";
import {
  effectiveNodeE2eePolicy,
  nodeE2eeAdmissionPolicyForMode,
} from "../hubIdentity/NodeE2eePolicyStore.ts";
import { HubConnectorE2eeStateMachine } from "./HubConnectorState.ts";
import {
  makeNodeAccountGrantVerifier,
  type NodeAccountGrantVerifier,
} from "./NodeAccountGrantVerifier.ts";
import {
  CAPABILITY,
  CHANNEL_ID,
  CLIENT_AGREEMENT_PUBLIC,
  CLIENT_AGREEMENT_SECRET,
  CLIENT_IDENTITY_PUBLIC,
  HUB_ORIGIN,
  NOW,
  ROLE,
  authorizationFor,
  harness as nodeHarness,
  limits,
  settle,
  signClientPrekey,
  stripPrelude,
  utf8,
  type Harness as NodeHarness,
} from "./testUtils/nodeE2eeChannelHarness.ts";

const ACCOUNT_ID = `acct_${"a".repeat(22)}`;
const ENROLLMENT_ID = `enr_${"e".repeat(22)}`;
const HUB_KEY_ID = `hgk_${"k".repeat(22)}`;
const CONNECTOR_GENERATION = 11;

const rawEd25519PublicKey = (
  key: ReturnType<typeof generateKeyPairSync>["publicKey"],
): Uint8Array => {
  const bytes = key.export({ format: "der", type: "spki" });
  return Uint8Array.from(bytes.subarray(bytes.byteLength - 32));
};

function readyEnrollment(): NativeE2eeReadyEnrollment {
  const createdAt = NOW - 1_000;
  const expiresAt = createdAt + E2EE_PREKEY_LIFETIME;
  const transcript = encodeClientE2eePrekeyTranscript({
    hubOrigin: HUB_ORIGIN,
    accountId: ACCOUNT_ID,
    identityPublicKey: CLIENT_IDENTITY_PUBLIC,
    agreementPublicKey: CLIENT_AGREEMENT_PUBLIC,
    createdAt,
    expiresAt,
  });
  const signature = signClientPrekey(transcript);
  const certificate = encodeClientE2eePrekeyCertificateCarrier(transcript, signature);
  const identityFingerprint = e2eeKeyFingerprint("client-identity", CLIENT_IDENTITY_PUBLIC);
  const agreementFingerprint = e2eeKeyFingerprint("agreement", CLIENT_AGREEMENT_PUBLIC);
  const certificateDigest = e2eeSha256(certificate);
  return {
    namespace: { hubOrigin: HUB_ORIGIN, accountId: ACCOUNT_ID },
    enrollment: {
      enrollmentId: ENROLLMENT_ID,
      enrollmentRevision: 1,
      accountAuthEpoch: 1,
      deviceAuthEpoch: 1,
      platform: "darwin",
      appVersion: "1.0.0",
      reportedKeyBacking: "hardware-backed",
      deviceLabel: "Automatic native client",
      identityFingerprint: encodeBase64Url(identityFingerprint),
      agreementFingerprint: encodeBase64Url(agreementFingerprint),
      clientPrekeyCertificateDigest: encodeBase64Url(certificateDigest),
      certificateExpiresAt: expiresAt,
      status: "active",
      createdAt,
      updatedAt: NOW,
      lastUsedAt: null,
      revokedAt: null,
    },
    identity: {
      publicKey: CLIENT_IDENTITY_PUBLIC,
      fingerprint: identityFingerprint,
      backing: "hardware-backed",
    },
    prekey: {
      agreementPublicKey: CLIENT_AGREEMENT_PUBLIC,
      agreementFingerprint,
      transcript,
      signature,
      certificate,
      certificateDigest,
      expiresAt,
    },
  } as unknown as NativeE2eeReadyEnrollment;
}

interface ConnectedAttempt {
  readonly node: NodeHarness;
  readonly machine: RelayE2eeInitiator;
  readonly resolution: Extract<
    NativeE2eeTrustResolution,
    { readonly kind: "authorized"; readonly trustSource: "account-enrolled" }
  >;
  readonly awaitOutbound: () => Promise<void>;
  readonly lockedModes: readonly string[];
  readonly closeFailures: readonly unknown[];
}

describe("automatic account-enrolled E2EE", () => {
  it("turns login enrollment into protected RPC without pairing and caches the Hub keyset", async () => {
    const hub = generateKeyPairSync("ed25519");
    const hubPublicKey = rawEd25519PublicKey(hub.publicKey);
    const enrollment = readyEnrollment();
    const trustedNodes = new Map<string, NativeE2eeAccountTrustedNode>();
    let currentAdvertisement: NodeE2eeAdvertisement | undefined;
    let ticketSequence = 0;

    const issueAccountGrantRelayTicket = vi.fn(
      async (
        request: NativeAccountGrantRelayTicketRequest,
      ): Promise<NativeAccountGrantRelayTicketResponse> => {
        const advertisement = currentAdvertisement;
        if (advertisement === undefined) throw new Error("node statement was not published");
        ticketSequence += 1;
        const ticketId = `rtk_${String(ticketSequence).padStart(22, "t")}`;
        const claimsBytes = encodeHubDeviceGrantClaims({
          issuerHubOrigin: HUB_ORIGIN,
          keyId: HUB_KEY_ID,
          grantId: `hgr_${String(ticketSequence).padStart(22, "g")}`,
          accountId: ACCOUNT_ID,
          accountAuthEpoch: enrollment.enrollment.accountAuthEpoch,
          enrollmentId: enrollment.enrollment.enrollmentId,
          enrollmentRevision: enrollment.enrollment.enrollmentRevision,
          deviceAuthEpoch: enrollment.enrollment.deviceAuthEpoch,
          deviceIdentityPublicKey: enrollment.identity.publicKey,
          deviceAgreementPublicKey: enrollment.prekey.agreementPublicKey,
          clientPrekeyCertificateDigest: enrollment.prekey.certificateDigest,
          nodeId: advertisement.material.nodeId,
          nodeIdentityPublicKey: advertisement.nodeIdentityPublicKey,
          nodeAgreementPublicKey: advertisement.material.agreementPublicKey,
          nodeContinuityId: advertisement.material.continuityId,
          nodePolicyGeneration: advertisement.policyGeneration,
          nodeCapabilityStatementDigest: advertisement.statementDigest,
          relayTicketId: ticketId,
          maximumRole: ROLE,
          capabilities: [CAPABILITY],
          issuedAt: NOW,
          notBefore: NOW - 1_000,
          expiresAt: NOW + 60_000,
          nonce: new Uint8Array(32).fill(ticketSequence),
        } as unknown as HubDeviceGrantClaimsInput);
        const envelope = encodeHubDeviceGrantEnvelope(
          claimsBytes,
          Uint8Array.from(
            sign(null, encodeHubDeviceGrantSigningEnvelope(claimsBytes), hub.privateKey),
          ),
        );
        return {
          protocolVersion: 1,
          ticket: encodeBase64Url(new Uint8Array(32).fill(ticketSequence)),
          ticketId,
          expiresAt: NOW + 60_000,
          protocolMajor: 1,
          protocolMinor: 3,
          suiteId: E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
          deviceGrant: encodeBase64Url(envelope),
          deviceGrantDigest: encodeBase64Url(e2eeSha256(envelope)),
          nodeCapabilityStatement: encodeBase64Url(advertisement.statement),
          nodeCapabilityStatementDigest: encodeBase64Url(advertisement.statementDigest),
          keysetGeneration: 1,
          capability: request.capability,
          effectiveRole: ROLE,
        } as NativeAccountGrantRelayTicketResponse;
      },
    );
    const getE2eeGrantVerificationKeys = vi.fn(async () => ({
      protocolVersion: 1 as const,
      generation: 1,
      keys: [
        {
          keyId: HUB_KEY_ID,
          publicKey: encodeBase64Url(hubPublicKey),
          notBefore: NOW - 60_000,
          notAfter: NOW + 180_000,
        },
      ],
    }));
    const resolveTrust = createNativeE2eeTrustResolver({
      api: {
        issueAccountGrantRelayTicket,
        getE2eeGrantVerificationKeys,
      } as unknown as Pick<
        HostedHubApi,
        "issueAccountGrantRelayTicket" | "getE2eeGrantVerificationKeys"
      >,
      platform: {
        readAccountTrustedNode: async ({ nodeId }) => trustedNodes.get(nodeId) ?? null,
        writeAccountTrustedNode: async (record) => {
          trustedNodes.set(record.nodeId, record);
        },
      },
      now: () => NOW,
    });

    const connect = async (): Promise<ConnectedAttempt> => {
      const policy = effectiveNodeE2eePolicy(nodeE2eeAdmissionPolicyForMode("compatibility"));
      const connectorState = new HubConnectorE2eeStateMachine(() => NOW);
      connectorState.begin(CONNECTOR_GENERATION, HUB_ORIGIN, {
        protocolMajor: 1,
        protocolMinor: 3,
      });
      let verifier: NodeAccountGrantVerifier | undefined;
      let resolution:
        | Extract<
            NativeE2eeTrustResolution,
            { readonly kind: "authorized"; readonly trustSource: "account-enrolled" }
          >
        | undefined;
      let pairingEvaluations = 0;
      let localRegistrations = 0;
      let registeredTrustSource: string | undefined;
      const baseAuthorization = authorizationFor(undefined);
      const node = await nodeHarness({
        protocolMinor: 3,
        policy: () => policy,
        authorization: {
          ...baseAuthorization,
          registerInFlightHandshake: (input) => {
            localRegistrations += 1;
            return baseAuthorization.registerInFlightHandshake(input);
          },
          evaluatePairingAdmission: (input) => {
            pairingEvaluations += 1;
            return baseAuthorization.evaluatePairingAdmission(input);
          },
        },
        verifyAccountGrant: (input) => {
          if (verifier === undefined) throw new Error("account grant verifier is not ready");
          return verifier.verify(input);
        },
        registerSession: (session) => {
          registeredTrustSource = session.accountGrantAuthority?.trustSource;
          return () => undefined;
        },
        accountGrantContext: async (advertisement) => {
          currentAdvertisement = advertisement;
          const statementVerification = verifyNodeE2eeCapabilityStatement({
            statement: advertisement.statement,
            connectedHubOrigin: HUB_ORIGIN,
            tier: "native",
            trustSource: "account-enrolled",
            localSuitePreference: [E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256],
            now: NOW,
            accountId: ACCOUNT_ID,
          });
          if (statementVerification.kind !== "verified") {
            throw new Error(
              `node statement was not account-eligible: ${JSON.stringify(statementVerification)}`,
            );
          }
          expect(connectorState.publish(CONNECTOR_GENERATION, advertisement)).toBe("accepted");
          expect(
            connectorState.acknowledge(CONNECTOR_GENERATION, advertisement.statementDigest),
          ).toBe("accepted");
          expect(
            connectorState.replaceVerifierKeys(CONNECTOR_GENERATION, {
              type: "e2ee.verifier-keys",
              protocolMajor: 1,
              protocolMinor: 3,
              generation: 1,
              keys: [
                {
                  keyId: HUB_KEY_ID,
                  publicKey: hubPublicKey,
                  notBefore: NOW - 60_000,
                  notAfter: NOW + 180_000,
                },
              ],
            } as unknown as RelayE2eeVerifierKeysFrame),
          ).toBe("accepted");
          verifier = makeNodeAccountGrantVerifier({
            state: connectorState,
            connectorGeneration: () => CONNECTOR_GENERATION,
            policy: () => policy,
            authorization: baseAuthorization,
          });
          const resolved = await resolveTrust({
            hubOrigin: HUB_ORIGIN,
            accountId: ACCOUNT_ID,
            capability: CAPABILITY,
            node: { nodeId: advertisement.material.nodeId, accountGrantAllowed: true },
            enrollment,
            localTrustedIntroduction: false,
            verifiedPin: null,
          });
          if (resolved.kind !== "authorized" || resolved.trustSource !== "account-enrolled") {
            throw new Error(`automatic trust was not authorized: ${JSON.stringify(resolved)}`);
          }
          resolution = resolved;
          return [
            E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
            resolved.grant.claims.relayTicketId,
            resolved.grant.grantDigest,
            advertisement.statementDigest,
          ] as unknown as RelayAccountGrantContext;
        },
      });
      const advertisement = await node.open();
      if (resolution === undefined) throw new Error("automatic trust resolution did not run");
      const authorized = resolution;
      let outbound = Promise.resolve();
      const lockedModes: string[] = [];
      const closeFailures: unknown[] = [];
      const diagnostics: string[] = [];
      const host: RelayE2eeHost = {
        limits,
        channel: {
          channelId: CHANNEL_ID,
          capability: CAPABILITY,
          effectiveRole: ROLE,
          relayProtocolMajor: 1,
          relayProtocolMinor: 3,
          accountGrantContext: {
            relayTicketId: authorized.grant.claims.relayTicketId,
            deviceGrantDigest: authorized.grant.grantDigest,
            nodeCapabilityStatementDigest: advertisement.statementDigest,
          },
        },
        admit: () => ({
          send: (message) => {
            outbound = outbound.then(() => node.deliver(message));
            return true;
          },
          release: () => undefined,
        }),
        lockMode: (mode) => lockedModes.push(mode),
        close: (failure) => closeFailures.push(failure),
        now: () => NOW,
        setTimeout: () => Symbol("e2ee-deadline"),
        clearTimeout: () => undefined,
      };
      const attempt: RelayE2eeInitiatorAttempt = {
        hubOrigin: HUB_ORIGIN,
        selectionClass: "latched",
        legacyPermitted: false,
        pairingOnly: false,
        localSuitePreference: [E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256],
        credentials: {
          tier: "native",
          trustSource: "account-enrolled",
          accountId: ACCOUNT_ID,
          identityPublicKey: enrollment.identity.publicKey,
          agreementPublicKey: enrollment.prekey.agreementPublicKey,
          prekeyTranscript: enrollment.prekey.transcript,
          prekeySignature: enrollment.prekey.signature,
          deviceGrant: authorized.grant,
        },
        withNativeAgreementSecretKey: async (use) => use(Uint8Array.from(CLIENT_AGREEMENT_SECRET)),
        accountId: ACCOUNT_ID,
        acceptedPolicyGeneration: authorized.grant.claims.nodePolicyGeneration,
        onDiagnostic: ({ row }) => diagnostics.push(row),
      };
      const machine = makeRelayE2eeInitiator({ host, attempt });
      expect(node.dataPayloads()).toHaveLength(1);
      const carrier = await machine.intercept(stripPrelude(node.dataPayloads()[0]!));
      if (carrier.kind !== "claimed") {
        throw new Error(
          `client rejected account carrier: ${JSON.stringify({ diagnostics, closeFailures })}`,
        );
      }
      await outbound;
      expect(node.dataPayloads()).toHaveLength(2);
      expect(await machine.intercept(stripPrelude(node.dataPayloads()[1]!))).toEqual({
        kind: "claimed",
      });
      expect(machine.mode()).toBe("e2ee");
      expect(node.session().mode()).toBe("e2ee");
      expect(pairingEvaluations).toBe(0);
      expect(localRegistrations).toBe(0);
      expect(registeredTrustSource).toBe("account-enrolled");
      return {
        node,
        machine,
        resolution: authorized,
        awaitOutbound: async () => {
          await settle();
          await outbound;
        },
        lockedModes,
        closeFailures,
      };
    };

    const first = await connect();
    expect(first.machine.submit(utf8('{"_tag":"Ping"}'))).toBe(true);
    await first.awaitOutbound();
    expect(first.node.deliveredToParser).toHaveLength(1);
    expect(new TextDecoder().decode(first.node.deliveredToParser[0]!)).toBe('{"_tag":"Ping"}');

    const beforePong = first.node.dataPayloads().length;
    expect(await first.node.session().emit(utf8('{"_tag":"Pong"}'))).toBe("sent");
    first.node.flush();
    const pong = await first.machine.intercept(
      stripPrelude(first.node.dataPayloads()[beforePong]!),
    );
    expect(pong.kind).toBe("rpc");
    if (pong.kind === "rpc") {
      expect(new TextDecoder().decode(pong.message)).toBe('{"_tag":"Pong"}');
    }

    const beforeRevocation = first.node.dataPayloads().length;
    await first.node.session().revokeAccountGrant();
    await settle();
    first.node.flush();
    expect(
      await first.machine.intercept(stripPrelude(first.node.dataPayloads()[beforeRevocation]!)),
    ).toEqual({ kind: "rejected" });
    expect(first.closeFailures).toHaveLength(1);
    first.machine.dispose();
    expect(first.machine.mode()).toBe("closed");
    first.resolution.dispose();

    const second = await connect();
    expect(second.lockedModes).toEqual(["e2ee"]);
    expect(issueAccountGrantRelayTicket).toHaveBeenCalledTimes(2);
    expect(getE2eeGrantVerificationKeys).toHaveBeenCalledTimes(1);
    expect(trustedNodes.size).toBe(1);
    second.resolution.dispose();
  });
});
