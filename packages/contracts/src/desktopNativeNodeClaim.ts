import { Schema } from "effect";

import {
  NativeNodeClaimEnvironmentId,
  NativeNodeClaimFinishResponse,
  NativeNodeClaimPublicKey,
  NativeNodeClaimStartResponse,
} from "./hostedIdentity.ts";
import { HubNodePublicKeyFingerprint } from "./hubConnector.ts";

export const DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION = 1 as const;
export const DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH =
  "/api/desktop/hub/native-node-claim/descriptor" as const;
export const DESKTOP_NATIVE_NODE_CLAIM_SIGN_PATH =
  "/api/desktop/hub/native-node-claim/sign" as const;
export const DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH =
  "/api/desktop/hub/native-node-claim/commit" as const;
export const DESKTOP_NATIVE_NODE_CLAIM_MAX_BODY_BYTES = 16 * 1_024;
/**
 * Desktop main asks its own backend, over the same per-child local control
 * channel, whether other devices can reach this node through the Hub, to keep
 * the machine awake only while they can.
 */
export const DESKTOP_HUB_REACHABILITY_PATH = "/api/desktop/hub/reachability" as const;

const strict = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S;

export const DesktopNativeNodeClaimDescriptorResponse = strict(
  Schema.Struct({
    protocolVersion: Schema.Literal(DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION),
    state: Schema.Literals(["prepared", "active"]),
    hubOrigin: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
    environmentId: NativeNodeClaimEnvironmentId,
    label: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
    platformOs: Schema.Literals(["darwin", "linux", "windows", "unknown"]),
    platformArch: Schema.Literals(["arm64", "x64", "other"]),
    clientVersion: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    algorithm: Schema.Literal("ed25519"),
    publicKey: NativeNodeClaimPublicKey,
    fingerprint: HubNodePublicKeyFingerprint,
  }),
);
export type DesktopNativeNodeClaimDescriptorResponse =
  typeof DesktopNativeNodeClaimDescriptorResponse.Type;

export const DesktopNativeNodeClaimSignRequest = strict(
  Schema.Struct({ claim: NativeNodeClaimStartResponse }),
);
export type DesktopNativeNodeClaimSignRequest = typeof DesktopNativeNodeClaimSignRequest.Type;

export const DesktopNativeNodeClaimSignResponse = strict(
  Schema.Struct({
    protocolVersion: Schema.Literal(DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION),
    signature: Schema.String.check(
      Schema.isMinLength(86),
      Schema.isMaxLength(86),
      Schema.isPattern(/^[A-Za-z0-9_-]{85}[AQgw]$/),
    ),
  }),
);
export type DesktopNativeNodeClaimSignResponse = typeof DesktopNativeNodeClaimSignResponse.Type;

export const DesktopNativeNodeClaimCommitRequest = strict(
  Schema.Struct({
    claim: NativeNodeClaimStartResponse,
    result: NativeNodeClaimFinishResponse,
  }),
);
export type DesktopNativeNodeClaimCommitRequest = typeof DesktopNativeNodeClaimCommitRequest.Type;

export const DesktopNativeNodeClaimCommitResponse = strict(
  Schema.Struct({
    protocolVersion: Schema.Literal(DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION),
    status: Schema.Literal("active"),
    result: NativeNodeClaimFinishResponse,
  }),
);
export type DesktopNativeNodeClaimCommitResponse = typeof DesktopNativeNodeClaimCommitResponse.Type;

export const DesktopHubReachabilityResponse = strict(
  Schema.Struct({
    protocolVersion: Schema.Literal(DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION),
    reachable: Schema.Boolean,
  }),
);
export type DesktopHubReachabilityResponse = typeof DesktopHubReachabilityResponse.Type;

export const DesktopNativeNodeClaimErrorResponse = strict(
  Schema.Struct({
    error: Schema.Literals([
      "native_node_claim_unavailable",
      "native_node_claim_rejected",
      "native_node_claim_conflict",
      "native_node_claim_expired",
    ]),
  }),
);
export type DesktopNativeNodeClaimErrorResponse = typeof DesktopNativeNodeClaimErrorResponse.Type;
