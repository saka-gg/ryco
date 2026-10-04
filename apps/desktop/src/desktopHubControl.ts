import {
  DESKTOP_HUB_REACHABILITY_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_SIGN_PATH,
  DesktopHubReachabilityResponse,
  DesktopNativeNodeClaimCommitResponse,
  DesktopNativeNodeClaimDescriptorResponse,
  DesktopNativeNodeClaimErrorResponse,
  DesktopNativeNodeClaimSignResponse,
  type DesktopNativeNodeClaimCommitRequest,
  type DesktopNativeNodeClaimSignRequest,
} from "@ryco/contracts/desktop-native-node-claim";
import {
  LOCAL_INTRODUCTION_COMPLETE_PATH,
  LOCAL_INTRODUCTION_CONTROL_HEADER,
  LOCAL_INTRODUCTION_DESCRIPTOR_PATH,
  LocalIntroductionCompleteResponse,
  LocalIntroductionDescriptorResponse,
  LocalIntroductionErrorResponse,
  type LocalIntroductionCompleteRequest,
} from "@ryco/contracts/local-introduction";
import { Schema } from "effect";

const RESPONSE_MAX_BYTES = 32 * 1024;

export type DesktopHubControlErrorCode =
  | "local_control_unavailable"
  | "native_node_claim_rejected"
  | "native_node_claim_conflict"
  | "native_node_claim_expired"
  | "local_introduction_rejected"
  | "local_introduction_conflict"
  | "local_introduction_expired";

export class DesktopHubControlError extends Error {
  readonly code: DesktopHubControlErrorCode;

  constructor(code: DesktopHubControlErrorCode) {
    super("Desktop Hub control operation failed.");
    this.name = "DesktopHubControlError";
    this.code = code;
  }
}

function fail(code: DesktopHubControlErrorCode): never {
  throw new DesktopHubControlError(code);
}

function decode<S extends Schema.Top>(schema: S, value: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema as unknown as Schema.Decoder<unknown>)(value, {
      onExcessProperty: "error",
    }) as S["Type"];
  } catch {
    return fail("local_control_unavailable");
  }
}

function decodeError(value: unknown): DesktopHubControlErrorCode {
  try {
    const native = Schema.decodeUnknownSync(DesktopNativeNodeClaimErrorResponse)(value, {
      onExcessProperty: "error",
    });
    if (native.error === "native_node_claim_unavailable") return "local_control_unavailable";
    return native.error;
  } catch {
    // Try the disjoint LTI error shape.
  }
  try {
    const introduction = Schema.decodeUnknownSync(LocalIntroductionErrorResponse)(value, {
      onExcessProperty: "error",
    });
    if (introduction.error === "local_introduction_unavailable") {
      return "local_control_unavailable";
    }
    return introduction.error;
  } catch {
    return "local_control_unavailable";
  }
}

export interface DesktopHubControlClient {
  readonly nodeClaimDescriptor: () => Promise<typeof DesktopNativeNodeClaimDescriptorResponse.Type>;
  readonly signNodeClaim: (
    request: DesktopNativeNodeClaimSignRequest,
  ) => Promise<typeof DesktopNativeNodeClaimSignResponse.Type>;
  readonly commitNodeClaim: (
    request: DesktopNativeNodeClaimCommitRequest,
  ) => Promise<typeof DesktopNativeNodeClaimCommitResponse.Type>;
  readonly localIntroductionDescriptor: () => Promise<
    typeof LocalIntroductionDescriptorResponse.Type
  >;
  readonly completeLocalIntroduction: (
    request: LocalIntroductionCompleteRequest,
  ) => Promise<typeof LocalIntroductionCompleteResponse.Type>;
  /** Whether other devices can reach this node through the Hub right now. */
  readonly hubReachability: () => Promise<typeof DesktopHubReachabilityResponse.Type>;
}

export function createDesktopHubControlClient(input: {
  readonly baseUrl: () => string;
  readonly controlToken: () => string;
  readonly fetch?: typeof globalThis.fetch;
}): DesktopHubControlClient {
  const fetch = input.fetch ?? globalThis.fetch;
  const post = async <S extends Schema.Top>(
    pathname: string,
    schema: S,
    body?: unknown,
  ): Promise<S["Type"]> => {
    const token = input.controlToken();
    const baseUrl = input.baseUrl();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || baseUrl.length === 0) {
      return fail("local_control_unavailable");
    }
    let response: Response;
    try {
      response = await fetch(new URL(pathname, baseUrl), {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          [LOCAL_INTRODUCTION_CONTROL_HEADER]: token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return fail("local_control_unavailable");
    }
    const text = await response.text().catch(() => fail("local_control_unavailable"));
    if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) {
      return fail("local_control_unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return fail("local_control_unavailable");
    }
    if (!response.ok) return fail(decodeError(parsed));
    return decode(schema, parsed);
  };

  return {
    nodeClaimDescriptor: () =>
      post(DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH, DesktopNativeNodeClaimDescriptorResponse),
    signNodeClaim: (request) =>
      post(DESKTOP_NATIVE_NODE_CLAIM_SIGN_PATH, DesktopNativeNodeClaimSignResponse, request),
    commitNodeClaim: (request) =>
      post(DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH, DesktopNativeNodeClaimCommitResponse, request),
    localIntroductionDescriptor: () =>
      post(LOCAL_INTRODUCTION_DESCRIPTOR_PATH, LocalIntroductionDescriptorResponse),
    completeLocalIntroduction: (request) =>
      post(LOCAL_INTRODUCTION_COMPLETE_PATH, LocalIntroductionCompleteResponse, request),
    hubReachability: () => post(DESKTOP_HUB_REACHABILITY_PATH, DesktopHubReachabilityResponse),
  };
}
