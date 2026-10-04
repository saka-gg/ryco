import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedHubNode, HostedHubSessionResponse } from "./types";
import { createFakeHistoryWindow, type FakeHistoryWindow } from "../../test/fakeHistoryWindow";

interface CapturedTransport {
  readonly resolveUrl: () => Promise<string>;
  readonly options: {
    readonly authorizeRequest?: (request: {
      readonly tag: string;
      readonly stream: boolean;
    }) => string;
    readonly onOpen?: () => void;
  };
}

interface CapturedClient {
  readonly reconnect: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  emitShellSnapshot(snapshot: OrchestrationShellSnapshot): void;
}

const { capturedTransports, capturedClients, createWsRpcClient } = vi.hoisted(() => ({
  capturedTransports: [] as CapturedTransport[],
  capturedClients: [] as CapturedClient[],
  createWsRpcClient: vi.fn(),
}));

function MockWsTransport(resolveUrl: () => Promise<string>, options: CapturedTransport["options"]) {
  capturedTransports.push({ resolveUrl, options });
}

function MockDeviceWsTransport() {}

vi.mock("../rpc/wsTransport", () => ({
  DeviceWsTransport: MockDeviceWsTransport,
  HostedWsTransport: MockWsTransport,
  WsTransport: MockWsTransport,
}));

vi.mock("../rpc/wsRpcClient", () => ({ createWsRpcClient }));

// The unrelated saved environment's HTTP session probe must not hit the
// network; everything else in the remote API keeps its real implementation.
vi.mock("../environments/remote/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../environments/remote/api")>()),
  fetchRemoteSessionState: vi.fn(async () => ({ authenticated: true, role: "client" })),
}));

const environmentId = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
const routedNode: HostedHubNode = {
  id: "node_aaaaaaaaaaaaaaaaaaaaaa",
  environmentId,
  label: "Routed node",
  platformOs: "linux",
  platformArch: "x64",
  clientVersion: "0.9.0",
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
  grant: { id: "grant_aaaaaaaaaaaaaaaaaaaaaa", role: "operator" },
  effectiveRole: "operator",
  presence: { online: true, lastHeartbeatAt: 1 },
};
const sessionResponse: HostedHubSessionResponse = {
  account: {
    id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    displayName: "Test account",
    role: "owner",
    createdAt: 1,
    disabledAt: null,
  },
  session: {
    id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
    accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    createdAt: 1,
    expiresAt: 2,
    lastSeenAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
  },
  csrfToken: "csrf-sensitive-restore-canary",
};
const RELAY_TICKET = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

function shellSnapshot(sequence: number): OrchestrationShellSnapshot {
  return {
    snapshotSequence: sequence,
    projects: [],
    threads: [],
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function makeClient(): CapturedClient & Record<string, unknown> {
  let shellListener:
    | ((item: { kind: "snapshot"; snapshot: OrchestrationShellSnapshot }) => void)
    | null = null;
  const client: CapturedClient & Record<string, unknown> = {
    reconnect: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    isHeartbeatFresh: vi.fn(() => false),
    server: {
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeConfig: vi.fn(() => () => undefined),
      getConfig: vi.fn(async () => ({
        environment: {
          environmentId: EnvironmentId.make("env_bbbbbbbbbbbbbbbbbbbbbb"),
          label: "Unrelated saved environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.9.0",
          capabilities: {
            repositoryIdentity: false,
            threadSettlement: false,
            threadPriorityRanking: false,
          },
        },
      })),
    },
    orchestration: {
      subscribeShell: vi.fn((listener: typeof shellListener) => {
        shellListener = listener;
        return () => {
          shellListener = null;
        };
      }),
    },
    terminal: { onEvent: vi.fn(() => () => undefined) },
    emitShellSnapshot(snapshot) {
      shellListener?.({ kind: "snapshot", snapshot });
    },
  };
  return client;
}

let fakeWindow: FakeHistoryWindow | null = null;
let stopOrchestrator: (() => void) | null = null;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
  capturedTransports.length = 0;
  capturedClients.length = 0;
  createWsRpcClient.mockReset();
  createWsRpcClient.mockImplementation(() => {
    const client = makeClient();
    capturedClients.push(client);
    return client;
  });
});

afterEach(async () => {
  stopOrchestrator?.();
  stopOrchestrator = null;
  const { resetHostedNodeRouteOrchestratorForTests } = await import("./nodeRouteOrchestrator");
  const { resetHostedNodeRoutesForTests } = await import("./nodeRoutes");
  const { resetEnvironmentServiceForTests } = await import("../environments/runtime/service");
  const { resetPrimaryEnvironmentDescriptorForTests } = await import("../environments/primary");
  const { deactivateHostedNode } = await import("./environment");
  const { hostedHubController } = await import("./state");
  await deactivateHostedNode(environmentId);
  await resetEnvironmentServiceForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  hostedHubController.resetForTests();
  resetHostedNodeRouteOrchestratorForTests();
  resetHostedNodeRoutesForTests();
  fakeWindow = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup(initialUrl: string) {
  fakeWindow = createFakeHistoryWindow(initialUrl);
  vi.stubGlobal("window", fakeWindow);
  const { installHostedNodeHistory } = await import("./nodeRoutes");
  const history = installHostedNodeHistory(fakeWindow as unknown as Window & typeof globalThis);
  const { startHostedNodeRouteOrchestrator } = await import("./nodeRouteOrchestrator");
  stopOrchestrator = startHostedNodeRouteOrchestrator();
  return { win: fakeWindow, history };
}

describe("hosted node route restore integration", () => {
  it("re-enters a deep-linked node through the full ordered pipeline before enabling mutations", async () => {
    const { win, history } = await setup(
      `/node/${routedNode.id}/${environmentId}/t_1?workspaceTab=diff`,
    );
    const { hostedHubApi } = await import("./api");
    const { hostedHubController, useHostedHubStore } = await import("./state");
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockResolvedValue(sessionResponse);
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([routedNode]);
    const issueRelayTicket = vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: RELAY_TICKET,
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });

    await hostedHubController.bootstrap();
    // The bootstrap path lazily imports large module graphs; under a loaded
    // full-repo test run (turbo runs the package suites concurrently) the
    // default one-second poll window starves before the transport appears.
    await vi.waitFor(() => expect(capturedTransports).toHaveLength(1), { timeout: 10_000 });

    // The activation path is the existing one: a fresh one-use ticket is
    // requested only when the relay attempt resolves its URL.
    expect(issueRelayTicket).not.toHaveBeenCalled();
    await capturedTransports[0]!.resolveUrl();
    expect(issueRelayTicket).toHaveBeenCalledWith(routedNode.id);
    expect(restoreSession.mock.invocationCallOrder[0]!).toBeLessThan(
      listNodes.mock.invocationCallOrder[0]!,
    );
    expect(listNodes.mock.invocationCallOrder[0]!).toBeLessThan(
      issueRelayTicket.mock.invocationCallOrder[0]!,
    );

    // Mutations stay blocked until the canonical snapshot is accepted.
    capturedTransports[0]!.options.onOpen?.();
    hostedHubController.transportStatus(useHostedHubStore.getState().generation, "online");
    expect(
      capturedTransports[0]!.options.authorizeRequest?.({
        tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        stream: false,
      }),
    ).not.toBe("allowed");
    capturedClients[0]!.emitShellSnapshot(shellSnapshot(1));
    expect(useHostedHubStore.getState()).toMatchObject({
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    expect(
      capturedTransports[0]!.options.authorizeRequest?.({
        tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        stream: false,
      }),
    ).toBe("allowed");

    // The nested thread and panel URL survives the restore.
    history.flush();
    expect(win.location.pathname).toBe(`/node/${routedNode.id}/${environmentId}/t_1`);
    expect(win.location.search).toBe("?workspaceTab=diff");

    // No sensitive material reached the URL or history entries.
    const serialized = JSON.stringify(win.entries());
    for (const sensitive of [
      RELAY_TICKET,
      sessionResponse.csrfToken,
      sessionResponse.session.id,
      sessionResponse.account.id,
    ]) {
      expect(serialized).not.toContain(sensitive);
      expect(win.location.href).not.toContain(sensitive);
    }
  });

  it("closes only the browser relay session on Back and re-enters through a fresh ticket on Forward", async () => {
    const { win, history } = await setup("/");
    const { hostedHubApi } = await import("./api");
    const { hostedHubController, useHostedHubStore } = await import("./state");
    const { listEnvironmentConnections, reconnectSavedEnvironment } =
      await import("../environments/runtime/service");
    const { useSavedEnvironmentRegistryStore, writeSavedEnvironmentBearerToken } =
      await import("../environments/runtime/catalog");
    const { selectHostedNodeRoute } = await import("./nodeRouteOrchestrator");
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([routedNode]);
    const issueRelayTicket = vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: RELAY_TICKET,
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });

    // An unrelated saved-environment connection exists alongside the hosted
    // relay session and must survive hosted teardown untouched.
    const secondEnvironmentId = EnvironmentId.make("env_bbbbbbbbbbbbbbbbbbbbbb");
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId: secondEnvironmentId,
      label: "Unrelated saved environment",
      wsBaseUrl: "ws://second.example.test/",
      httpBaseUrl: "http://second.example.test/",
      createdAt: "2026-07-20T00:00:00.000Z",
      lastConnectedAt: "2026-07-20T00:00:00.000Z",
    });
    await writeSavedEnvironmentBearerToken(secondEnvironmentId, "saved-bearer-token");
    await reconnectSavedEnvironment(secondEnvironmentId);
    expect(listEnvironmentConnections()).toHaveLength(1);
    const savedClientCount = capturedClients.length;

    await hostedHubController.bootstrap();
    expect(selectHostedNodeRoute(routedNode.id)).toBe(true);
    await vi.waitFor(() => expect(capturedTransports).toHaveLength(savedClientCount + 1));
    const hostedTransport = capturedTransports[savedClientCount]!;
    const hostedClient = capturedClients[savedClientCount]!;
    await hostedTransport.resolveUrl();
    hostedTransport.options.onOpen?.();
    hostedHubController.transportStatus(useHostedHubStore.getState().generation, "online");
    hostedClient.emitShellSnapshot(shellSnapshot(1));
    expect(useHostedHubStore.getState().sessionEstablished).toBe(true);
    expect(listEnvironmentConnections()).toHaveLength(2);
    history.flush();
    expect(win.location.pathname).toBe(`/node/${routedNode.id}`);

    // Back returns to the directory and tears down exactly the browser relay
    // session (hosted client disposed, hosted connection removed) while the
    // unrelated saved connection stays online.
    win.history.back();
    await vi.waitFor(() => expect(hostedClient.dispose).toHaveBeenCalled());
    await vi.waitFor(() => expect(listEnvironmentConnections()).toHaveLength(1));
    expect(
      listEnvironmentConnections().some(
        (connection) => connection.knownEnvironment.environmentId === secondEnvironmentId,
      ),
    ).toBe(true);
    for (let index = 0; index < savedClientCount; index += 1) {
      expect(capturedClients[index]!.dispose).not.toHaveBeenCalled();
    }
    expect(useHostedHubStore.getState().selectedNode).toBeNull();
    expect(win.location.pathname).toBe("/");

    // Forward re-enters through the restore pipeline with a fresh ticket.
    win.history.forward();
    await vi.waitFor(() => expect(capturedTransports).toHaveLength(savedClientCount + 2));
    const secondHostedTransport = capturedTransports[savedClientCount + 1]!;
    await secondHostedTransport.resolveUrl();
    expect(issueRelayTicket).toHaveBeenCalledTimes(2);
    secondHostedTransport.options.onOpen?.();
    hostedHubController.transportStatus(useHostedHubStore.getState().generation, "online");
    expect(useHostedHubStore.getState().sessionEstablished).toBe(false);
    capturedClients[savedClientCount + 1]!.emitShellSnapshot(shellSnapshot(2));
    expect(useHostedHubStore.getState()).toMatchObject({
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    expect(win.location.pathname).toBe(`/node/${routedNode.id}`);
    expect(listEnvironmentConnections()).toHaveLength(2);
  });
});
