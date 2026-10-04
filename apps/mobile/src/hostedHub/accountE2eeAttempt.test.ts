import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({
  issueRelayTicket: vi.fn(async () => ({ ticket: "legacy-ticket", expiresAt: 2_000 })),
  resolveTrust: vi.fn(),
  classify: vi.fn(async () => ({
    class: "unexpected",
    clause: "i",
    record: "unpinned",
    scope: { kind: "fresh" },
  })),
  record: null as unknown,
  localProvider: vi.fn(),
  localPrepare: vi.fn(async () => undefined),
  begin: vi.fn(),
  dispose: vi.fn(),
  invalidateEnrollment: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 13,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => undefined },
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { version: "1.0.0", extra: {} }, platform: { ios: {} } },
}));
vi.mock("@ryco/client-runtime/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/client-runtime/authorization")>();
  return {
    ...actual,
    getHostedHubApi: () => ({ issueRelayTicket: hoisted.issueRelayTicket }),
    createNativeE2eeTrustResolver: () => hoisted.resolveTrust,
  };
});
vi.mock("../platform/nativeE2ee", () => ({
  mobileNativeE2eePlatform: {
    withAgreementSecret: async (use: (secret: Uint8Array) => unknown) =>
      use(new Uint8Array(32).fill(8)),
  },
}));
vi.mock("../platform/e2eeTrustStore", () => ({
  mobileE2eeTrustStore: {
    resolve: () => hoisted.record,
    classify: hoisted.classify,
    marker: () => ({ kind: "unset" }),
  },
}));
vi.mock("./e2eeAttempt", () => ({
  prepareMobileRelayE2eeAttempt: hoisted.localPrepare,
  resolveMobileRelayE2eeProvider: () => hoisted.localProvider,
}));
vi.mock("./e2eeSession", () => ({
  beginMobileE2eeChannel: hoisted.begin,
  beginMobileE2eeChannelAttempt: vi.fn(),
  lockMobileE2eeChannelMode: vi.fn(),
  observeMobileAccountE2eeStatement: vi.fn(),
  recordMobileE2eeInitiatorDiagnostic: vi.fn(),
}));
vi.mock("../platform/e2eeRelayProvider", () => ({
  makeMobileRelayE2eeProvider: () => vi.fn(),
}));
vi.mock("./runtimeConfig", () => ({
  getMobileHostedConfig: () => ({ hubOrigin: "https://hub.example.test" }),
}));

import { hostedHubStore } from "@ryco/client-runtime/authorization";
import {
  disposeMobileRelaySocketContext,
  issueMobileRelayAttempt,
  prepareMobileRelaySocketContext,
  providerForMobileRelaySocketContext,
  resetMobileAccountE2eeAttemptForTests,
} from "./accountE2eeAttempt";
import { setMobileNativeE2eeEnrollmentCoordinator } from "./e2eeEnrollment";

const READY = {
  namespace: { hubOrigin: "https://hub.example.test", accountId: `acct_${"a".repeat(22)}` },
  enrollment: {
    enrollmentId: `enr_${"e".repeat(22)}`,
    enrollmentRevision: 3,
    accountAuthEpoch: 1,
    deviceAuthEpoch: 1,
    status: "active",
  },
  identity: {
    publicKey: new Uint8Array(65),
    fingerprint: new Uint8Array(32),
    backing: "secure-enclave",
  },
  prekey: {
    agreementPublicKey: new Uint8Array(32),
    agreementFingerprint: new Uint8Array(32),
    transcript: new Uint8Array([1]),
    signature: new Uint8Array(64),
    certificate: new Uint8Array([2]),
    certificateDigest: new Uint8Array(32),
    expiresAt: 5_000,
  },
} as const;

const authorizedResolution = () => ({
  kind: "authorized" as const,
  trustSource: "account-enrolled" as const,
  suiteId: 2 as const,
  ticket: "account-ticket",
  expiresAt: 2_000,
  grant: { claims: { nodePolicyGeneration: 9 } },
  effectiveRole: "operator" as const,
  capability: "ryco.rpc" as const,
  nodeCapabilityStatement: new Uint8Array([3]),
  dispose: hoisted.dispose,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetMobileAccountE2eeAttemptForTests();
  hoisted.record = null;
  hostedHubStore.setState({
    accountStatus: "authenticated",
    account: { id: READY.namespace.accountId },
    selectedNode: {
      id: `node_${"n".repeat(22)}`,
      label: "Studio",
      environmentId: "env-1",
    },
    generation: 7,
  } as never);
  setMobileNativeE2eeEnrollmentCoordinator({
    getState: () => ({ status: "ready", generation: 4, ready: READY, errorCode: null }),
    subscribe: () => () => undefined,
    invalidate: hoisted.invalidateEnrollment,
  } as never);
  hoisted.resolveTrust.mockResolvedValue(authorizedResolution());
});

describe("mobile account E2EE relay attempt", () => {
  it("uses an atomic suite-0x02 ticket and grant for a fresh authenticated install", async () => {
    const prepared = await prepareMobileRelaySocketContext();
    expect(prepared.kind).toBe("account");
    const issued = await issueMobileRelayAttempt({
      nodeId: `node_${"n".repeat(22)}`,
      preparedSocketContext: prepared,
    });

    expect(issued).toMatchObject({ ticket: "account-ticket", expiresAt: 2_000 });
    expect(hoisted.issueRelayTicket).not.toHaveBeenCalled();
    expect(hoisted.resolveTrust).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "ryco.rpc",
        localTrustedIntroduction: false,
        verifiedPin: null,
      }),
    );
    expect(hoisted.begin).toHaveBeenCalledWith(
      expect.objectContaining({ trustSource: "account-enrolled", legacyPermitted: false }),
    );
    expect(providerForMobileRelaySocketContext(issued.preparedSocketContext)).toBeTypeOf(
      "function",
    );
    disposeMobileRelaySocketContext(issued.preparedSocketContext);
    disposeMobileRelaySocketContext(issued.preparedSocketContext);
    expect(hoisted.dispose).toHaveBeenCalledOnce();
  });

  it("keeps a locally verified pin on suite 0x01 ahead of account enrollment", async () => {
    hoisted.record = {
      state: "verified",
      index: { localNodeHandle: "local-1" },
    };
    const prepared = await prepareMobileRelaySocketContext();
    const issued = await issueMobileRelayAttempt({
      nodeId: `node_${"n".repeat(22)}`,
      preparedSocketContext: prepared,
    });

    expect(prepared.kind).toBe("local");
    expect(hoisted.localPrepare).toHaveBeenCalledOnce();
    expect(issued.ticket).toBe("legacy-ticket");
    expect(hoisted.resolveTrust).not.toHaveBeenCalled();
  });

  it("sends Request approval's pairing hello over suite 0x01, never the account grant", async () => {
    // `beginPairing` leaves exactly this record; the local attempt it resolves
    // to is pairing-only (§13.2 step 2), so the node sees one authenticated
    // 0x01 hello it can list for approval, and no application payload.
    hoisted.record = {
      state: "unverified",
      index: { localNodeHandle: "local-pairing" },
    };
    const prepared = await prepareMobileRelaySocketContext();
    const issued = await issueMobileRelayAttempt({
      nodeId: `node_${"n".repeat(22)}`,
      preparedSocketContext: prepared,
    });

    expect(prepared.kind).toBe("local");
    expect(hoisted.localPrepare).toHaveBeenCalledOnce();
    expect(hoisted.issueRelayTicket).toHaveBeenCalledOnce();
    expect(issued.ticket).toBe("legacy-ticket");
    expect(providerForMobileRelaySocketContext(issued.preparedSocketContext)).toBe(
      hoisted.localProvider,
    );
    expect(hoisted.resolveTrust).not.toHaveBeenCalled();
    expect(hoisted.begin).not.toHaveBeenCalled();
  });

  it("opens no data attempt before enrollment is ready", async () => {
    setMobileNativeE2eeEnrollmentCoordinator({
      getState: () => ({ status: "securing", generation: 5, ready: null, errorCode: null }),
      subscribe: () => () => undefined,
    } as never);
    await expect(prepareMobileRelaySocketContext()).rejects.toThrow(
      "Native E2EE enrollment is not ready.",
    );
    expect(hoisted.issueRelayTicket).not.toHaveBeenCalled();
    expect(hoisted.resolveTrust).not.toHaveBeenCalled();
  });

  it("surfaces an unsupported node as incompatible without native plaintext fallback", async () => {
    hoisted.resolveTrust.mockResolvedValueOnce({
      kind: "blocked",
      reason: "node-update-required",
    });
    const prepared = await prepareMobileRelaySocketContext();

    await expect(
      issueMobileRelayAttempt({
        nodeId: `node_${"n".repeat(22)}`,
        preparedSocketContext: prepared,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "incompatible", retryable: false },
    });
    expect(hoisted.issueRelayTicket).not.toHaveBeenCalled();
    expect(hoisted.begin).not.toHaveBeenCalled();
  });

  it("carries Hub retry guidance into the relay reconnect policy", async () => {
    hoisted.resolveTrust.mockResolvedValueOnce({
      kind: "recovery-required",
      reason: "account-authorization-unavailable",
      retryAfterMs: 42_000,
    });
    const prepared = await prepareMobileRelaySocketContext();

    await expect(
      issueMobileRelayAttempt({
        nodeId: `node_${"n".repeat(22)}`,
        preparedSocketContext: prepared,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "network", retryable: true, retryAfterMs: 42_000 },
    });
    expect(hoisted.issueRelayTicket).not.toHaveBeenCalled();
  });

  it("erases and rejects an account grant that resolves after an account switch", async () => {
    let resolveGrant!: (value: ReturnType<typeof authorizedResolution>) => void;
    hoisted.resolveTrust.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGrant = resolve;
        }),
    );
    const prepared = await prepareMobileRelaySocketContext();
    const issuing = issueMobileRelayAttempt({
      nodeId: `node_${"n".repeat(22)}`,
      preparedSocketContext: prepared,
    });

    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: { id: `acct_${"b".repeat(22)}` },
      selectedNode: {
        id: `node_${"n".repeat(22)}`,
        label: "Studio",
        environmentId: "env-1",
      },
      generation: 8,
    } as never);
    resolveGrant(authorizedResolution());

    await expect(issuing).rejects.toMatchObject({
      failure: { kind: "protocol", retryable: false },
    });
    expect(hoisted.dispose).toHaveBeenCalledOnce();
    expect(hoisted.begin).not.toHaveBeenCalled();
  });

  it("invalidates native enrollment immediately when the Hub reports revocation", async () => {
    hoisted.resolveTrust.mockResolvedValueOnce({
      kind: "blocked",
      reason: "enrollment-revoked",
    });
    const prepared = await prepareMobileRelaySocketContext();

    await expect(
      issueMobileRelayAttempt({
        nodeId: `node_${"n".repeat(22)}`,
        preparedSocketContext: prepared,
      }),
    ).rejects.toMatchObject({ failure: { kind: "revoked", retryable: false } });
    expect(hoisted.invalidateEnrollment).toHaveBeenCalledWith("revoked");
    expect(hoisted.begin).not.toHaveBeenCalled();
  });
});
