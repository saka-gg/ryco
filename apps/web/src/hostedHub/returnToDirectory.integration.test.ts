import { EnvironmentId, type OrchestrationShellSnapshot } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedHubNode, HostedHubSessionResponse } from "./types";
import { createFakeHistoryWindow, type FakeHistoryWindow } from "../../test/fakeHistoryWindow";

interface CapturedTransport {
  readonly resolveUrl: () => Promise<string>;
  readonly options: {
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
  csrfToken: "csrf-sensitive-return-canary",
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

function serverConfig() {
  return {
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
      // Like a real server, the config stream opens with a full snapshot.
      subscribeConfig: vi.fn((listener: (event: unknown) => void) => {
        queueMicrotask(() => listener({ version: 1, type: "snapshot", config: serverConfig() }));
        return () => undefined;
      }),
      getConfig: vi.fn(async () => serverConfig()),
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
let stopCoordinator: (() => void) | null = null;

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
  stopCoordinator?.();
  stopCoordinator = null;
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
  // The workspace coordinator connects what the routes demand, as it does
  // alongside the orchestrator in the app.
  const { startHostedWorkspaceCoordinator } = await import("./hostedConnectionCoordinator");
  stopCoordinator = startHostedWorkspaceCoordinator({
    hubOrigin: "https://hub.example.test",
    cache: {
      load: async () => null,
      list: async () => [],
      replace: async () => undefined,
      purgeEnvironment: async () => undefined,
      purgeAccount: async () => undefined,
    },
  });
  return { win: fakeWindow, history };
}

describe("user-facing return to the node directory (All nodes)", () => {
  it("opens the directory with the cursor and its session kept; the saved connection and node connector survive", async () => {
    const { win, history } = await setup("/");
    const { hostedHubApi } = await import("./api");
    const { getHostedEnvironmentSessions, hostedHubController, useHostedHubStore } =
      await import("./state");
    const { listEnvironmentConnections, reconnectSavedEnvironment } =
      await import("../environments/runtime/service");
    const { useSavedEnvironmentRegistryStore, writeSavedEnvironmentBearerToken } =
      await import("../environments/runtime/catalog");
    const { selectHostedNodeRoute, leaveHostedNodeRouteToDirectory } =
      await import("./nodeRouteOrchestrator");
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([routedNode]);
    const issueRelayTicket = vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: RELAY_TICKET,
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const signOut = vi.spyOn(hostedHubApi, "signOut");

    // An unrelated saved-environment connection exists alongside the hosted
    // relay session and must survive the return-to-directory teardown.
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
    expect(issueRelayTicket).toHaveBeenCalledTimes(1);
    hostedTransport.options.onOpen?.();
    const sessions = getHostedEnvironmentSessions();
    sessions.transportStatus(environmentId, sessions.read(environmentId)!.generation, "online");
    hostedClient.emitShellSnapshot(shellSnapshot(1));
    expect(useHostedHubStore.getState().sessionEstablished).toBe(true);
    expect(listEnvironmentConnections()).toHaveLength(2);
    history.flush();
    // Choosing a node opens home, which names no node.
    expect(win.location.pathname).toBe("/");
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(routedNode.id);

    // The user-facing "All nodes" action opens the directory, a page no node
    // owns: the cursor stays, and the node's session stays warm until the
    // workspace needs its slot (or the tab stays hidden), so going back to it
    // is immediate.
    expect(leaveHostedNodeRouteToDirectory()).toBe(true);
    await vi.waitFor(() => expect(win.location.pathname).toBe("/nodes"));
    expect(hostedClient.dispose).not.toHaveBeenCalled();
    expect(listEnvironmentConnections()).toHaveLength(2);
    expect(
      listEnvironmentConnections().some(
        (connection) => connection.knownEnvironment.environmentId === secondEnvironmentId,
      ),
    ).toBe(true);
    for (let index = 0; index < savedClientCount; index += 1) {
      expect(capturedClients[index]!.dispose).not.toHaveBeenCalled();
    }

    const state = useHostedHubStore.getState();
    // Distinct from sign-out: the Hub session survives.
    expect(signOut).not.toHaveBeenCalled();
    expect(state.accountStatus).toBe("authenticated");
    // Distinct from revocation: the node's directory entry is untouched and
    // stays selected (the remote node connector was never addressed).
    expect(state.selectedNode?.id).toBe(routedNode.id);
    expect(state.sessionEstablished).toBe(true);
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]).toMatchObject({ id: routedNode.id, revokedAt: null });
    expect(state.nodes[0]!.presence.online).toBe(true);
    expect(win.location.pathname).toBe("/nodes");

    // A second tap mid- or post-teardown is a handled no-op: no duplicate
    // "/" history entry is pushed.
    history.flush();
    const entryCountAfterLeave = win.entries().length;
    expect(leaveHostedNodeRouteToDirectory()).toBe(true);
    history.flush();
    expect(win.entries().length).toBe(entryCountAfterLeave);
    expect(win.location.pathname).toBe("/nodes");

    // No sensitive material reached the URL or history entries.
    const serialized = JSON.stringify(win.entries());
    for (const sensitive of [RELAY_TICKET, sessionResponse.csrfToken, sessionResponse.session.id]) {
      expect(serialized).not.toContain(sensitive);
      expect(win.location.href).not.toContain(sensitive);
    }
  });

  it("reports when no hosted history is installed so callers fall back to the controller", async () => {
    const { resetHostedNodeRoutesForTests } = await import("./nodeRoutes");
    resetHostedNodeRoutesForTests();
    const { leaveHostedNodeRouteToDirectory } = await import("./nodeRouteOrchestrator");
    expect(leaveHostedNodeRouteToDirectory()).toBe(false);
  });
});
