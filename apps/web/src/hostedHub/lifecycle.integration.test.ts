import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedHubNode, HostedHubSessionResponse } from "./types";

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
  readonly orchestration: {
    readonly dispatchCommand: ReturnType<typeof vi.fn>;
    readonly subscribeShell: ReturnType<typeof vi.fn>;
  };
  readonly server: {
    readonly discoverSourceControl: ReturnType<typeof vi.fn>;
    readonly subscribeConfig: ReturnType<typeof vi.fn>;
    readonly subscribeLifecycle: ReturnType<typeof vi.fn>;
  };
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

const environmentId = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
const selectedNode: HostedHubNode = {
  id: "node_aaaaaaaaaaaaaaaaaaaaaa",
  environmentId,
  label: "Test node",
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
  csrfToken: "test-csrf",
};

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
      discoverSourceControl: vi.fn(async () => ({
        versionControlSystems: [],
        sourceControlProviders: [],
      })),
    },
    orchestration: {
      dispatchCommand: vi.fn(async () => ({ sequence: 0 })),
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

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
  vi.stubGlobal("window", {
    location: { href: "https://hub.example.test/", origin: "https://hub.example.test" },
  });
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
  const { resetEnvironmentServiceForTests } = await import("../environments/runtime/service");
  const { resetPrimaryEnvironmentDescriptorForTests } = await import("../environments/primary");
  const { deactivateHostedNode } = await import("./environment");
  const { hostedHubController } = await import("./state");
  await deactivateHostedNode(environmentId);
  await resetEnvironmentServiceForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  hostedHubController.resetForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hosted browser lifecycle integration", () => {
  it("keeps generic local API access on the lifecycle-owned current client", async () => {
    const { hostedHubApi } = await import("./api");
    const { activateHostedNode } = await import("./environment");
    const { writePrimaryEnvironmentDescriptor } = await import("../environments/primary");
    const { listEnvironmentConnections } = await import("../environments/runtime/service");
    const { readLocalApi } = await import("../localApi");
    const { hostedHubController, useHostedHubStore } = await import("./state");

    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selectedNode]);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selectedNode],
      selectedNode,
      selectionStatus: "online",
      effectiveRole: "operator",
      transportStatus: "online",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      browserStatus: "current",
      generation: 4,
    });

    writePrimaryEnvironmentDescriptor({
      environmentId,
      label: selectedNode.label,
      platform: { os: selectedNode.platformOs, arch: selectedNode.platformArch },
      serverVersion: selectedNode.clientVersion,
      capabilities: {
        repositoryIdentity: false,
        threadSettlement: false,
        threadPriorityRanking: false,
      },
    });
    const localApi = readLocalApi();

    expect(localApi).toBeDefined();
    expect(listEnvironmentConnections()).toHaveLength(0);
    await expect(localApi!.server.discoverSourceControl()).rejects.toThrow(
      "Local backend API is unavailable before a backend is paired.",
    );

    await activateHostedNode(selectedNode, null);
    expect(capturedClients).toHaveLength(1);
    expect(listEnvironmentConnections()).toHaveLength(1);
    await localApi!.server.discoverSourceControl();
    expect(capturedClients[0]!.server.discoverSourceControl).toHaveBeenCalledOnce();

    hostedHubController.suspendBrowser("offline");
    await vi.waitFor(() => expect(capturedClients[0]!.dispose).toHaveBeenCalledOnce());
    await hostedHubController.resumeBrowser();
    expect(capturedClients).toHaveLength(2);
    expect(listEnvironmentConnections()).toHaveLength(1);

    await localApi!.server.discoverSourceControl();
    expect(capturedClients[0]!.server.discoverSourceControl).toHaveBeenCalledOnce();
    expect(capturedClients[1]!.server.discoverSourceControl).toHaveBeenCalledOnce();
  });

  it("disposes the stale transport before same-node recovery and accepts only a fresh snapshot", async () => {
    const { hostedHubApi } = await import("./api");
    const { activateHostedNode } = await import("./environment");
    const { listEnvironmentConnections } = await import("../environments/runtime/service");
    const { hostedHubController, useHostedHubStore } = await import("./state");
    const issueRelayTicket = vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selectedNode]);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selectedNode],
      selectedNode,
      selectionStatus: "online",
      effectiveRole: "operator",
      transportStatus: "online",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      browserStatus: "current",
      generation: 4,
    });

    await activateHostedNode(selectedNode, null);
    expect(capturedClients).toHaveLength(1);
    expect(capturedTransports).toHaveLength(1);
    expect(listEnvironmentConnections()).toHaveLength(1);
    await capturedTransports[0]!.resolveUrl();
    capturedTransports[0]!.options.onOpen?.();
    hostedHubController.transportStatus(4, "online");
    capturedClients[0]!.emitShellSnapshot(shellSnapshot(1));
    expect(useHostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    expect(
      capturedTransports[0]!.options.authorizeRequest?.({
        tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        stream: false,
      }),
    ).toBe("allowed");

    hostedHubController.suspendBrowser("offline");
    expect(
      capturedTransports[0]!.options.authorizeRequest?.({
        tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        stream: false,
      }),
    ).not.toBe("allowed");
    await vi.waitFor(() => expect(capturedClients[0]!.dispose).toHaveBeenCalledOnce());

    await hostedHubController.resumeBrowser();
    expect(capturedClients).toHaveLength(2);
    expect(capturedTransports).toHaveLength(2);
    expect(listEnvironmentConnections()).toHaveLength(1);
    await capturedTransports[1]!.resolveUrl();
    capturedTransports[1]!.options.onOpen?.();
    hostedHubController.transportStatus(6, "online");
    expect(useHostedHubStore.getState()).toMatchObject({
      browserStatus: "synchronizing",
      sessionEstablished: false,
    });
    expect(
      capturedTransports[1]!.options.authorizeRequest?.({
        tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        stream: false,
      }),
    ).not.toBe("allowed");

    capturedClients[0]!.emitShellSnapshot(shellSnapshot(2));
    expect(useHostedHubStore.getState().sessionEstablished).toBe(false);

    capturedClients[1]!.emitShellSnapshot(shellSnapshot(2));
    expect(useHostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    expect(
      capturedTransports[1]!.options.authorizeRequest?.({
        tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
        stream: false,
      }),
    ).toBe("allowed");
    expect(issueRelayTicket).toHaveBeenCalledTimes(2);
  });

  it("replays a command whose client a suspend disposed, on the resumed session only", async () => {
    const { hostedHubApi } = await import("./api");
    const { activateHostedNode } = await import("./environment");
    const { listEnvironmentConnections } = await import("../environments/runtime/service");
    const { hostedHubController, useHostedHubStore } = await import("./state");
    vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
      ticket: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      expiresAt: Date.now() + 60_000,
      protocolMajor: 1,
      protocolMinor: 2,
    });
    // Restoring re-mints the Hub session id on every resume.
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue({
      ...sessionResponse,
      session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
    });
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selectedNode]);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selectedNode],
      selectedNode,
      selectionStatus: "online",
      effectiveRole: "operator",
      transportStatus: "online",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      browserStatus: "current",
      generation: 4,
    });
    await activateHostedNode(selectedNode, null);
    capturedClients[0]!.emitShellSnapshot(shellSnapshot(1));
    expect(useHostedHubStore.getState().sessionStatus).toBe("ready");

    const command = {
      type: "thread.meta.update",
      commandId: "cmd-lost-to-suspend",
      threadId: "thread-1",
      title: "Renamed",
    } as const;
    // In flight until its client is disposed, which interrupts it — the
    // rejection a real disposal produces, with no socket error in it.
    let interrupt!: () => void;
    capturedClients[0]!.orchestration.dispatchCommand.mockImplementation(
      () =>
        new Promise((_, reject) => {
          interrupt = () => reject(new Error("All fibers interrupted without error"));
        }),
    );
    capturedClients[0]!.dispose.mockImplementation(async () => interrupt());
    const connection = listEnvironmentConnections()[0]!;
    let outcome: unknown = "pending";
    const sent = connection.client.orchestration
      .dispatchCommand(command as never)
      .then((value) => (outcome = value));

    hostedHubController.suspendBrowser("offline");
    await vi.waitFor(() => expect(capturedClients[0]!.dispose).toHaveBeenCalledOnce());
    await hostedHubController.resumeBrowser();
    expect(capturedClients).toHaveLength(2);
    capturedClients[1]!.orchestration.dispatchCommand.mockResolvedValue({ sequence: 9 });

    // Ticket and handshake alone are not enough: the replacement must accept
    // a current snapshot first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toBe("pending");
    expect(capturedClients[1]!.orchestration.dispatchCommand).not.toHaveBeenCalled();

    capturedClients[1]!.emitShellSnapshot(shellSnapshot(2));
    await sent;
    expect(outcome).toEqual({ sequence: 9 });
    expect(capturedClients[0]!.orchestration.dispatchCommand).toHaveBeenCalledOnce();
    expect(capturedClients[1]!.orchestration.dispatchCommand).toHaveBeenCalledExactlyOnceWith(
      command,
    );
    // Replayed and confirmed, so nothing is left uncertain.
    expect(useHostedHubStore.getState().sessionStatus).toBe("ready");
  });
});
