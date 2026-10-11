import { Schema } from "effect";

import { rejectExcessProperties } from "./baseSchemas.ts";

export const LOCAL_INTRODUCTION_PROTOCOL_VERSION = 1 as const;
export const LOCAL_INTRODUCTION_DESCRIPTOR_PATH =
  "/api/desktop/e2ee/local-introduction/descriptor" as const;
export const LOCAL_INTRODUCTION_COMPLETE_PATH =
  "/api/desktop/e2ee/local-introduction/complete" as const;
export const LOCAL_INTRODUCTION_CONTROL_HEADER = "x-ryco-desktop-control" as const;
export const LOCAL_INTRODUCTION_MAX_BODY_BYTES = 8 * 1_024;

const Base64Url256 = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(43),
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/),
);
const Base64UrlSignature64 = Schema.String.check(
  Schema.isMinLength(86),
  Schema.isMaxLength(86),
  Schema.isPattern(/^[A-Za-z0-9_-]{85}[AQgw]$/),
);
const Base64UrlTranscript = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(5_462),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
const EnvironmentId = Schema.String.check(
  Schema.isPattern(/^env_[A-Za-z0-9_-]{22}$/),
  Schema.isMaxLength(26),
);
const NodeId = Schema.String.check(
  Schema.isPattern(/^node_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(48),
);
const ContinuityId = Schema.String.check(
  Schema.isPattern(/^nct_[A-Za-z0-9_-]{22}$/),
  Schema.isMaxLength(26),
);

export const LocalIntroductionDescriptorResponse = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(LOCAL_INTRODUCTION_PROTOCOL_VERSION),
    hubOrigin: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
    environmentId: EnvironmentId,
    nodeId: NodeId,
    nodeIdentityPublicKey: Base64Url256,
    nodeIdentityFingerprint: Base64Url256,
    nodeContinuityId: ContinuityId,
    nodePolicyGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);
export type LocalIntroductionDescriptorResponse = typeof LocalIntroductionDescriptorResponse.Type;

export const LocalIntroductionCompleteRequest = rejectExcessProperties(
  Schema.Struct({
    requestTbs: Base64UrlTranscript,
    requestSignature: Base64UrlSignature64,
  }),
);
export type LocalIntroductionCompleteRequest = typeof LocalIntroductionCompleteRequest.Type;

export const LocalIntroductionCompleteResponse = rejectExcessProperties(
  Schema.Struct({
    protocolVersion: Schema.Literal(LOCAL_INTRODUCTION_PROTOCOL_VERSION),
    disposition: Schema.Literals(["created", "promoted", "reconciled"]),
    approvalTbs: Base64UrlTranscript,
    approvalSignature: Base64UrlSignature64,
  }),
);
export type LocalIntroductionCompleteResponse = typeof LocalIntroductionCompleteResponse.Type;

export const LocalIntroductionErrorResponse = rejectExcessProperties(
  Schema.Struct({
    error: Schema.Literals([
      "local_introduction_unavailable",
      "local_introduction_rejected",
      "local_introduction_conflict",
      "local_introduction_expired",
    ]),
  }),
);
export type LocalIntroductionErrorResponse = typeof LocalIntroductionErrorResponse.Type;
