import "../../index.css";

import {
  type AuthAccessStreamEvent,
  type AuthAccessSnapshot,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  EnvironmentId,
  type DesktopBridge,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
  type LocalApi,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type SourceControlDiscoveryResult,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "~/rpc/queryClient";

import { __resetLocalApiForTests } from "../../localApi";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useUiStateStore } from "../../uiStateStore";
import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { useTierOverrideStore } from "../../tierOverrideStore";
import { SettingsTargetProvider } from "../../settingsTarget";
import { DEFAULT_CLIENT_SETTINGS } from "@ryco/contracts/settings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";
import { ProvidersSettingsPanel } from "./ProvidersSettingsPanel";
import { SourceControlPreferences } from "./SourceControlPreferences";
import { GeneralSettingsPanel } from "./SettingsPanels";
import { SourceControlSettingsPanel } from "./SourceControlSettings";

const authAccessHarness = vi.hoisted(() => {
  type Snapshot = AuthAccessSnapshot;
  let snapshot: Snapshot = {
    pairingLinks: [],
    clientSessions: [],
  };
  let revision = 1;
  const listeners = new Set<(event: AuthAccessStreamEvent) => void>();

  const emitEvent = (event: AuthAccessStreamEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return {
    reset() {
      snapshot = {
        pairingLinks: [],
        clientSessions: [],
      };
      revision = 1;
      listeners.clear();
    },
    setSnapshot(next: Snapshot) {
      snapshot = next;
    },
    emitSnapshot() {
      emitEvent({
        version: 1 as const,
        revision,
        type: "snapshot" as const,
        payload: snapshot,
      });
      revision += 1;
    },
    emitEvent,
    emitPairingLinkUpserted(pairingLink: Snapshot["pairingLinks"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: pairingLink,
      });
      revision += 1;
    },
    emitPairingLinkRemoved(id: string) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id },
      });
      revision += 1;
    },
    emitClientUpserted(clientSession: Snapshot["clientSessions"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "clientUpserted",
        payload: clientSession,
      });
      revision += 1;
    },
    emitClientRemoved(sessionId: string) {
      emitEvent({
        version: 1,
        revision,
        type: "clientRemoved",
        payload: {
          sessionId: AuthSessionId.make(sessionId),
        },
      });
      revision += 1;
    },
    subscribe(listener: (event: AuthAccessStreamEvent) => void) {
      listeners.add(listener);
      listener({
        version: 1,
        revision: 1,
        type: "snapshot",
        payload: snapshot,
      });
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

const mockConnectDesktopSshEnvironment = vi.hoisted(() => vi.fn());
const mockUpdateEnvironmentServerSettings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const originalNavigatorPlatform = navigator.platform;

vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: {
        subscribeAuthAccess: (listener: Parameters<typeof authAccessHarness.subscribe>[0]) =>
          authAccessHarness.subscribe(listener),
        getAdvertisedEndpoints: async () => [],
      },
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    resetSavedEnvironmentRegistryStoreForTests: () => undefined,
    resetSavedEnvironmentRuntimeStoreForTests: () => undefined,
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    addSavedEnvironment: vi.fn(),
    connectPrimaryEnvironment: () => primaryConnection,
    connectDesktopWorkspaceEnvironment: vi.fn(),
    connectDesktopSshEnvironment: mockConnectDesktopSshEnvironment,
    disconnectPrimaryEnvironment: vi.fn(),
    disconnectSavedEnvironment: vi.fn(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: () => undefined,
    startEnvironmentConnectionService: () => undefined,
    subscribeEnvironmentConnections: () => () => {},
    updateEnvironmentServerSettings: mockUpdateEnvironmentServerSettings,
    useSavedEnvironmentRegistryStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "ryco_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.ryco-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.ryco/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function createOutdatedProvider(driver: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-05-04T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      message: "Update available.",
      checkedAt: "2026-05-04T10:00:00.000Z",
      updateCommand: "npm install -g openai/codex@latest",
      canUpdate: true,
    },
  };
}

function makeUtc(value: string) {
  return DateTime.makeUnsafe(Date.parse(value));
}

function makePairingLink(input: {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}): AuthAccessSnapshot["pairingLinks"][number] {
  return {
    ...input,
    createdAt: makeUtc(input.createdAt),
    expiresAt: makeUtc(input.expiresAt),
  };
}

function makeClientSession(input: {
  readonly sessionId: string;
  readonly subject: string;
  readonly role: "owner" | "client";
  readonly method: "browser-session-cookie";
  readonly client?: {
    readonly label?: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
    readonly deviceType?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
    readonly os?: string;
    readonly browser?: string;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt?: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}): AuthAccessSnapshot["clientSessions"][number] {
  return {
    ...input,
    client: {
      deviceType: "unknown",
      ...input.client,
    },
    sessionId: AuthSessionId.make(input.sessionId),
    issuedAt: makeUtc(input.issuedAt),
    expiresAt: makeUtc(input.expiresAt),
    lastConnectedAt:
      input.lastConnectedAt === undefined || input.lastConnectedAt === null
        ? null
        : makeUtc(input.lastConnectedAt),
  };
}

function installSettingsNativeApi(input?: {
  readonly updateSettings?: LocalApi["server"]["updateSettings"];
  readonly setClientSettings?: LocalApi["persistence"]["setClientSettings"];
  readonly clientSettings?: Awaited<ReturnType<LocalApi["persistence"]["getClientSettings"]>>;
  readonly confirm?: LocalApi["dialogs"]["confirm"];
}) {
  const updateSettings =
    input?.updateSettings ??
    vi.fn<LocalApi["server"]["updateSettings"]>().mockResolvedValue(DEFAULT_SERVER_SETTINGS);
  const setClientSettings =
    input?.setClientSettings ??
    vi.fn<LocalApi["persistence"]["setClientSettings"]>().mockResolvedValue(undefined);
  window.nativeApi = {
    persistence: {
      getClientSettings: vi.fn().mockResolvedValue(input?.clientSettings ?? null),
      setClientSettings,
      getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
      setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
      getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
      setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
      removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
    },
    server: {
      getConfig: vi.fn().mockResolvedValue(createBaseServerConfig()),
      refreshProviders: vi.fn().mockResolvedValue({
        providers: [],
      }),
      upsertKeybinding: vi.fn().mockResolvedValue({
        keybindings: [],
      }),
      getSettings: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
      updateSettings,
      discoverSourceControl: vi.fn().mockResolvedValue({
        versionControlSystems: [],
        sourceControlProviders: [],
      } satisfies SourceControlDiscoveryResult),
    },
    shell: {
      openInEditor: vi.fn().mockResolvedValue(undefined),
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    dialogs: {
      pickFolder: vi.fn().mockResolvedValue(null),
      confirm: input?.confirm ?? vi.fn().mockResolvedValue(false),
    },
    contextMenu: {
      show: vi.fn().mockResolvedValue(null),
    },
  } as unknown as LocalApi;
  return window.nativeApi;
}

const createDesktopBridgeStub = (overrides?: {
  readonly discoverSshHosts?: DesktopBridge["discoverSshHosts"];
  readonly serverExposureState?: Awaited<ReturnType<DesktopBridge["getServerExposureState"]>>;
  readonly advertisedEndpoints?: Awaited<ReturnType<DesktopBridge["getAdvertisedEndpoints"]>>;
  readonly setServerExposureMode?: DesktopBridge["setServerExposureMode"];
  readonly setUpdateChannel?: DesktopBridge["setUpdateChannel"];
  readonly getHubLaunchConfig?: DesktopBridge["getHubLaunchConfig"];
  readonly setHubLaunchConfig?: DesktopBridge["setHubLaunchConfig"];
  readonly restartApp?: NonNullable<DesktopBridge["restartApp"]>;
  readonly getHostedIdentityState?: NonNullable<DesktopBridge["getHostedIdentityState"]>;
  readonly connectHostedIdentity?: NonNullable<DesktopBridge["connectHostedIdentity"]>;
  readonly disconnectHostedIdentity?: NonNullable<DesktopBridge["disconnectHostedIdentity"]>;
  readonly connectHostedGitHub?: NonNullable<DesktopBridge["connectHostedGitHub"]>;
  readonly disconnectHostedGitHub?: NonNullable<DesktopBridge["disconnectHostedGitHub"]>;
  readonly cancelHostedGitHubConnection?: NonNullable<
    DesktopBridge["cancelHostedGitHubConnection"]
  >;
  readonly confirm?: DesktopBridge["confirm"];
  readonly openExternal?: DesktopBridge["openExternal"];
}): DesktopBridge => {
  const idleUpdateState: DesktopUpdateState = {
    enabled: false,
    status: "idle",
    channel: "latest",
    currentVersion: "0.0.0-test",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };

  return {
    getHubLaunchConfig:
      overrides?.getHubLaunchConfig ??
      (async () => ({
        enabled: false,
        origin: null,
        nodeName: null,
        allowFileSecretStore: false,
        fileSecretStoreFallbackSupported: true,
      })),
    setHubLaunchConfig: overrides?.setHubLaunchConfig ?? vi.fn().mockResolvedValue(undefined),
    ...(overrides?.restartApp === undefined ? {} : { restartApp: overrides.restartApp }),
    ...(overrides?.getHostedIdentityState === undefined
      ? {}
      : { getHostedIdentityState: overrides.getHostedIdentityState }),
    ...(overrides?.connectHostedIdentity === undefined
      ? {}
      : { connectHostedIdentity: overrides.connectHostedIdentity }),
    ...(overrides?.disconnectHostedIdentity === undefined
      ? {}
      : { disconnectHostedIdentity: overrides.disconnectHostedIdentity }),
    ...(overrides?.connectHostedGitHub === undefined
      ? {}
      : { connectHostedGitHub: overrides.connectHostedGitHub }),
    ...(overrides?.disconnectHostedGitHub === undefined
      ? {}
      : { disconnectHostedGitHub: overrides.disconnectHostedGitHub }),
    ...(overrides?.cancelHostedGitHubConnection === undefined
      ? {}
      : {
          cancelHostedGitHubConnection: overrides.cancelHostedGitHubConnection,
        }),
    validateHubOrigin: async () => ({
      ok: false as const,
      reason: "empty" as const,
    }),
    getAppBranding: vi.fn().mockReturnValue(null),
    getLocalEnvironmentBootstrap: () => ({
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "desktop-bootstrap-token",
    }),
    getClientSettings: vi.fn().mockResolvedValue(null),
    setClientSettings: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
    setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
    setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
    removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
    discoverSshHosts: overrides?.discoverSshHosts ?? vi.fn().mockResolvedValue([]),
    ensureSshEnvironment: vi.fn().mockImplementation(async (target) => ({
      target,
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      pairingToken: "ssh-pairing-token",
    })),
    disconnectSshEnvironment: vi.fn().mockResolvedValue(undefined),
    fetchSshEnvironmentDescriptor: vi.fn().mockResolvedValue({
      environmentId: "environment-ssh",
      label: "SSH environment",
      platform: {
        os: "linux",
        arch: "x64",
      },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
      },
    }),
    bootstrapSshBearerSession: vi.fn().mockResolvedValue({
      authenticated: true,
      role: "owner",
      sessionMethod: "bearer-session-token",
      expiresAt: "2026-05-01T12:00:00.000Z",
      sessionToken: "ssh-bearer-token",
    }),
    fetchSshSessionState: vi.fn().mockResolvedValue({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-session-token"],
        sessionCookieName: "ryco_session",
      },
      role: "owner",
      sessionMethod: "bearer-session-token",
      expiresAt: "2026-05-01T12:00:00.000Z",
    }),
    issueSshWebSocketToken: vi.fn().mockResolvedValue({
      token: "ssh-ws-token",
      expiresAt: "2026-05-01T12:05:00.000Z",
    }),
    onSshPasswordPrompt: vi.fn(() => () => {}),
    resolveSshPasswordPrompt: vi.fn().mockResolvedValue(undefined),
    getServerExposureState: vi.fn().mockResolvedValue(
      overrides?.serverExposureState ?? {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    ),
    setServerExposureMode:
      overrides?.setServerExposureMode ??
      vi.fn().mockImplementation(async (mode) => ({
        mode,
        endpointUrl: mode === "network-accessible" ? "http://192.168.1.44:3773" : null,
        advertisedHost: mode === "network-accessible" ? "192.168.1.44" : null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      })),
    setTailscaleServeEnabled: vi.fn().mockImplementation(async (input) => ({
      mode: overrides?.serverExposureState?.mode ?? "network-accessible",
      endpointUrl: overrides?.serverExposureState?.endpointUrl ?? "http://192.168.1.44:3773",
      advertisedHost: overrides?.serverExposureState?.advertisedHost ?? "192.168.1.44",
      tailscaleServeEnabled: input.enabled,
      tailscaleServePort: input.port ?? 443,
    })),
    getAdvertisedEndpoints: vi.fn().mockResolvedValue(overrides?.advertisedEndpoints ?? []),
    pickFolder: vi.fn().mockResolvedValue(null),
    confirm: overrides?.confirm ?? vi.fn().mockResolvedValue(false),
    setTheme: vi.fn().mockResolvedValue(undefined),
    showContextMenu: vi.fn().mockResolvedValue(null),
    openExternal: overrides?.openExternal ?? vi.fn().mockResolvedValue(true),
    onMenuAction: () => () => {},
    getUpdateState: vi.fn().mockResolvedValue(idleUpdateState),
    setUpdateChannel:
      overrides?.setUpdateChannel ??
      vi.fn().mockImplementation(async (channel: DesktopUpdateChannel) => ({
        ...idleUpdateState,
        channel,
      })),
    checkForUpdate: vi.fn().mockResolvedValue({ checked: false, state: idleUpdateState }),
    downloadUpdate: vi.fn().mockResolvedValue({
      accepted: false,
      completed: false,
      state: idleUpdateState,
    }),
    installUpdate: vi.fn().mockResolvedValue({
      accepted: false,
      completed: false,
      state: idleUpdateState,
    }),
    onUpdateState: () => () => {},
    notifyTurnComplete: vi.fn().mockResolvedValue(undefined),
    onTurnCompleteNotificationActivated: () => () => {},
  };
};

describe("GeneralSettingsPanel observability", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    localStorage.clear();
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: null });
    authAccessHarness.reset();
    useTierOverrideStore.setState({ override: null });
    mockConnectDesktopSshEnvironment.mockReset();
    mockUpdateEnvironmentServerSettings.mockClear();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "platform", {
      value: originalNavigatorPlatform,
      configurable: true,
    });
    Reflect.deleteProperty(window, "desktopBridge");
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    resetServerStateForTests();
    await __resetLocalApiForTests();
    authAccessHarness.reset();
    useTierOverrideStore.setState({ override: null });
  });

  it("hides owner pairing tools in browser-served loopback builds without remote exposure", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [
        makeClientSession({
          sessionId: "session-owner",
          subject: "browser-owner",
          role: "owner",
          method: "browser-session-cookie",
          client: {
            label: "Chrome on Mac",
            deviceType: "desktop",
            os: "macOS",
            browser: "Chrome",
            ipAddress: "127.0.0.1",
          },
          issuedAt: "2036-04-07T00:00:00.000Z",
          expiresAt: "2036-05-07T00:00:00.000Z",
          connected: true,
          current: true,
        }),
      ],
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            auth: createBaseServerConfig().auth,
            role: "owner",
            sessionMethod: "browser-session-cookie",
            expiresAt: "2036-05-07T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch GET ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Manage local backend")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Enable network access")).toBeDisabled();
    await expect
      .element(
        page.getByText(
          "This backend is only reachable on this machine. Restart it with a non-loopback host to enable remote pairing.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByText("Authorized clients")).not.toBeInTheDocument();
    await expect.element(page.getByText("Chrome on Mac")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Remote environments", exact: true }))
      .toBeInTheDocument();
  });

  it("hides advertised endpoint rows when desktop network access is disabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [
        {
          id: "loopback",
          label: "This machine",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          reachability: "loopback",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
          isDefault: true,
        },
        {
          id: "tailscale-ip",
          label: "Tailscale IP",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "http://100.105.39.17:3773/",
          wsBaseUrl: "ws://100.105.39.17:3773/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "available",
        },
      ],
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Limited to this machine.")).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "This machine", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Tailscale IP", exact: true }))
      .not.toBeInTheDocument();
  });

  it("collapses advertised endpoints behind the network access summary", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.86.39:3773",
        advertisedHost: "192.168.86.39",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [
        {
          id: "desktop-loopback:3773",
          label: "This machine",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          reachability: "loopback",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
        },
        {
          id: "desktop-lan:http://192.168.86.39:3773",
          label: "Local network",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://192.168.86.39:3773/",
          wsBaseUrl: "ws://192.168.86.39:3773/",
          reachability: "lan",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
          isDefault: true,
        },
        {
          id: "tailscale-ip:http://100.105.39.17:3773",
          label: "Tailscale IP",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "http://100.105.39.17:3773/",
          wsBaseUrl: "ws://100.105.39.17:3773/",
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-addon",
          status: "available",
        },
      ],
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("http://192.168.86.39:3773/")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "+2" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: "+2" }).click();

    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Default", { exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Set as default" }).first().click();
    await expect.element(page.getByText("http://127.0.0.1:3773/").first()).toBeInTheDocument();
  });

  it("shows mixed-content warnings for HTTP advertised endpoints", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.86.39:3773",
        advertisedHost: "192.168.86.39",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [
        {
          id: "desktop-lan:http://192.168.86.39:3773",
          label: "Local network",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "core",
            isAddon: false,
          },
          httpBaseUrl: "http://192.168.86.39:3773/",
          wsBaseUrl: "ws://192.168.86.39:3773/",
          reachability: "lan",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "desktop-core",
          status: "available",
          isDefault: true,
        },
      ],
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Hosted app blocked")).toBeInTheDocument();
  });

  it("shows diagnostics inside About with a single logs-folder action", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("About")).toBeInTheDocument();
    await expect.element(page.getByText("Diagnostics")).toBeInTheDocument();
    await expect.element(page.getByText("Open logs folder")).toBeInTheDocument();
    await expect
      .element(page.getByText("/repo/project/.ryco/logs", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. OTLP exporting traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("labels browser and node settings independently inside General", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    expect(
      page
        .getByText("Time format", { exact: true })
        .element()
        .closest("[data-setting-scope]")
        ?.getAttribute("data-setting-scope"),
    ).toBe("This browser");
    expect(
      page
        .getByText("Provider update checks", { exact: true })
        .element()
        .closest("[data-setting-scope]")
        ?.getAttribute("data-setting-scope"),
    ).toBe("Node: Connecting…");
  });

  it("labels and writes node settings against the explicitly selected remote node", async () => {
    const environmentId = EnvironmentId.make("environment-qa");
    const remoteConfig = {
      ...createBaseServerConfig(),
      environment: {
        ...createBaseServerConfig().environment,
        environmentId,
        label: "Ryco Multi-node QA",
      },
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        enableProviderUpdateChecks: false,
      },
    };

    mounted = await render(
      <AppAtomRegistryProvider>
        <SettingsTargetProvider
          value={{
            environmentId,
            nodeLabel: "Ryco Multi-node QA",
            serverConfig: remoteConfig,
            primary: false,
            connected: true,
          }}
        >
          <GeneralSettingsPanel />
        </SettingsTargetProvider>
      </AppAtomRegistryProvider>,
    );

    expect(
      page
        .getByText("Provider update checks", { exact: true })
        .element()
        .closest("[data-setting-scope]")
        ?.getAttribute("data-setting-scope"),
    ).toBe("Node: Ryco Multi-node QA");

    const providerUpdateSwitch = page.getByLabelText("Check providers for updates");
    await expect.element(providerUpdateSwitch).not.toBeChecked();
    await providerUpdateSwitch.click();
    await vi.waitFor(() => {
      expect(mockUpdateEnvironmentServerSettings).toHaveBeenCalledWith(environmentId, {
        enableProviderUpdateChecks: true,
      });
    });
  });

  it("reveals and focuses legacy token streaming when settings search targets it", async () => {
    useTierOverrideStore.setState({ override: "desktop" });
    syncDocumentPresentationTier();
    installSettingsNativeApi();
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel searchTargetId="legacy-token-streaming" />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Legacy features", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("Stream token by token (legacy)", { exact: true }))
      .toBeInTheDocument();
    const tokenStreamingSwitch = page.getByLabelText("Stream token by token (legacy)");
    await expect.element(tokenStreamingSwitch).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(tokenStreamingSwitch.element());
    });
  });

  it("confirms legacy token streaming before enabling and disables it immediately", async () => {
    useTierOverrideStore.setState({ override: "desktop" });
    syncDocumentPresentationTier();
    const confirm = vi
      .fn<LocalApi["dialogs"]["confirm"]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const updateSettings = vi
      .fn<LocalApi["server"]["updateSettings"]>()
      .mockImplementation(async (patch) => ({
        ...DEFAULT_SERVER_SETTINGS,
        enableLegacyTokenStreaming:
          patch.enableLegacyTokenStreaming ?? DEFAULT_SERVER_SETTINGS.enableLegacyTokenStreaming,
      }));
    installSettingsNativeApi({ confirm, updateSettings });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel searchTargetId="legacy-token-streaming" />
      </AppAtomRegistryProvider>,
    );

    const tokenStreamingSwitch = page.getByLabelText("Stream token by token (legacy)");
    await expect.element(tokenStreamingSwitch).not.toBeChecked();

    await tokenStreamingSwitch.click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(updateSettings).not.toHaveBeenCalled();
    await expect.element(tokenStreamingSwitch).not.toBeChecked();

    await tokenStreamingSwitch.click();
    await vi.waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(updateSettings).toHaveBeenLastCalledWith({
        enableLegacyTokenStreaming: true,
      });
    });
    await expect.element(tokenStreamingSwitch).toBeChecked();

    await tokenStreamingSwitch.click();
    await vi.waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({
        enableLegacyTokenStreaming: false,
      }),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("disables the keybindings file opener when no editor is available", async () => {
    installSettingsNativeApi();
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      availableEditors: [],
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <KeybindingsSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("No available editors found.")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Open file" })).toBeDisabled();
  });

  it("labels the default editor file-manager option as Finder on macOS", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    const setClientSettings = vi
      .fn<LocalApi["persistence"]["setClientSettings"]>()
      .mockResolvedValue(undefined);
    installSettingsNativeApi({ setClientSettings });
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      availableEditors: ["cursor", "vscode", "file-manager"],
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByLabelText("Default editor").click();
    await expect.element(page.getByRole("option", { name: /Cursor/ })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: /VS Code/ })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: /Finder/ })).toBeInTheDocument();
    await expect
      .element(page.getByRole("option", { name: /File Manager/ }))
      .not.toBeInTheDocument();

    await page.getByRole("option", { name: /VS Code/ }).click();
    await vi.waitFor(() => {
      expect(setClientSettings).toHaveBeenCalledWith({
        ...DEFAULT_CLIENT_SETTINGS,
        preferredEditor: "vscode",
      });
    });
  });

  it("labels the default editor file-manager option as Explorer on Windows", async () => {
    Object.defineProperty(navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
    installSettingsNativeApi();
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      availableEditors: ["cursor", "vscode", "file-manager"],
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByLabelText("Default editor").click();
    await expect.element(page.getByRole("option", { name: /Explorer/ })).toBeInTheDocument();
    await expect
      .element(page.getByRole("option", { name: /File Manager/ }))
      .not.toBeInTheDocument();
  });

  it("persists the diff behavior toggles", async () => {
    const setClientSettings = vi
      .fn<LocalApi["persistence"]["setClientSettings"]>()
      .mockResolvedValue(undefined);
    installSettingsNativeApi({
      setClientSettings,
      clientSettings: {
        ...DEFAULT_CLIENT_SETTINGS,
        diffWordWrap: false,
        diffIgnoreWhitespace: true,
      },
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlPreferences />
      </AppAtomRegistryProvider>,
    );

    const wordWrapSwitch = page.getByLabelText("Wrap diff lines by default");
    await expect.element(wordWrapSwitch).not.toBeChecked();
    await wordWrapSwitch.click();
    await expect.element(wordWrapSwitch).toBeChecked();
    await vi.waitFor(() => {
      expect(setClientSettings).toHaveBeenLastCalledWith({
        ...DEFAULT_CLIENT_SETTINGS,
        diffWordWrap: true,
        diffIgnoreWhitespace: true,
      });
    });

    const ignoreWhitespaceSwitch = page.getByLabelText("Hide whitespace changes by default");
    await expect.element(ignoreWhitespaceSwitch).toBeChecked();
    await ignoreWhitespaceSwitch.click();
    await expect.element(ignoreWhitespaceSwitch).not.toBeChecked();
    await vi.waitFor(() => {
      expect(setClientSettings).toHaveBeenLastCalledWith({
        ...DEFAULT_CLIENT_SETTINGS,
        diffWordWrap: true,
        diffIgnoreWhitespace: false,
      });
    });
  });

  it("shows separate remote Git and PR workflow refresh controls", async () => {
    const setClientSettings = vi
      .fn<LocalApi["persistence"]["setClientSettings"]>()
      .mockResolvedValue(undefined);
    installSettingsNativeApi({ setClientSettings });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlPreferences />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Remote Git status", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("PR & workflow updates", { exact: true }))
      .toBeInTheDocument();

    const refreshMode = page.getByLabelText("PR and workflow update mode");
    await expect.element(refreshMode).toHaveTextContent("Automatic");
    await refreshMode.click();
    await page.getByRole("option", { name: "Reduced", exact: true }).click();

    await vi.waitFor(() => {
      expect(setClientSettings).toHaveBeenLastCalledWith({
        ...DEFAULT_CLIENT_SETTINGS,
        sourceControlRefreshMode: "reduced",
      });
    });
    await expect.element(refreshMode).toHaveTextContent("Reduced");
  });

  it("creates and shows a pairing link when network access is enabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    });
    let pairingLinks: Array<AuthAccessSnapshot["pairingLinks"][number]> = [];
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
        issuedAt: "2036-04-07T00:00:00.000Z",
        expiresAt: "2036-05-07T00:00:00.000Z",
        connected: true,
        current: true,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks,
      clientSessions,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/auth/pairing-token") && method === "POST") {
          pairingLinks = [
            makePairingLink({
              id: "pairing-link-1",
              credential: "pairing-token",
              role: "client",
              subject: "one-time-token",
              label: "Julius iPhone",
              createdAt: "2036-04-07T00:00:00.000Z",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
          ];
          clientSessions = [
            ...clientSessions,
            makeClientSession({
              sessionId: "session-client",
              subject: "one-time-token",
              role: "client",
              method: "browser-session-cookie",
              client: {
                label: "Julius iPhone",
                deviceType: "mobile",
                os: "iOS",
                browser: "Safari",
                ipAddress: "192.168.1.88",
              },
              issuedAt: "2036-04-07T00:01:00.000Z",
              expiresAt: "2036-05-07T00:01:00.000Z",
              connected: false,
              current: false,
            }),
          ];
          authAccessHarness.setSnapshot({
            pairingLinks,
            clientSessions,
          });
          return new Response(
            JSON.stringify({
              id: "pairing-link-1",
              credential: "pairing-token",
              label: "Julius iPhone",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`Unhandled fetch ${method} ${url}`);
      }),
    );

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Authorized clients")).toBeInTheDocument();
    await expect.element(page.getByText("Revoke others")).toBeInTheDocument();
    await expect.element(page.getByText("This Mac", { exact: true })).toBeInTheDocument();
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    await expect.element(page.getByText("Create pairing link")).toBeInTheDocument();
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    authAccessHarness.emitPairingLinkUpserted(pairingLinks[0]!);
    authAccessHarness.emitClientUpserted(clientSessions[1]!);
    await expect
      .element(page.getByText("Client · Mobile · iOS · Safari · 192.168.1.88"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^Copy pairing URL for:/ }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Revoke others")).toBeInTheDocument();
  });

  it("revokes all other paired clients from settings", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
    });
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
        issuedAt: "2036-04-05T00:00:00.000Z",
        expiresAt: "2036-05-05T00:00:00.000Z",
        connected: true,
        current: true,
      }),
      makeClientSession({
        sessionId: "session-client",
        subject: "one-time-token",
        role: "client",
        method: "browser-session-cookie",
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
        issuedAt: "2036-04-05T00:01:00.000Z",
        expiresAt: "2036-05-05T00:01:00.000Z",
        connected: false,
        current: false,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions,
    });

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/auth/clients/revoke-others") && method === "POST") {
        clientSessions = clientSessions.filter((session) => session.current);
        authAccessHarness.setSnapshot({
          pairingLinks: [],
          clientSessions,
        });
        authAccessHarness.emitClientRemoved("session-client");
        return new Response(JSON.stringify({ revokedCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unhandled fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Julius iPhone")).toBeInTheDocument();
    await page.getByRole("button", { name: "Revoke others", exact: true }).click();
    await expect.element(page.getByText("This Mac", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Julius iPhone")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("shows a disabled network access toggle with guidance in desktop builds", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    const networkAccessToggle = page.getByLabelText("Enable network access");
    await expect.element(networkAccessToggle).not.toBeDisabled();
    await networkAccessToggle.click();
    await expect.element(page.getByText("Enable network access?")).toBeInTheDocument();
    await expect
      .element(page.getByText("Ryco will restart to expose this environment over the network."))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Restart and enable", exact: true }).click();
    await vi.waitFor(() => {
      expect(desktopBridge.setServerExposureMode).toHaveBeenCalledWith("network-accessible");
    });
    await expect.element(page.getByText("http://192.168.1.44:3773")).toBeInTheDocument();
  });

  it("adds desktop ssh environments from the add-environment dialog", async () => {
    const discoverSshHosts = vi.fn().mockResolvedValue([
      {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
        source: "ssh-config" as const,
      },
    ]);
    window.desktopBridge = createDesktopBridgeStub({
      discoverSshHosts,
    });
    mockConnectDesktopSshEnvironment.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-devbox"),
      label: "Build box",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      httpBaseUrl: "http://127.0.0.1:3774/",
      createdAt: "2036-04-07T00:00:00.000Z",
      lastConnectedAt: "2036-04-07T00:00:00.000Z",
      desktopSsh: {
        alias: "devbox.example.com",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      },
    });

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Add environment", exact: true }).click();
    const addEnvironmentDialog = page.getByRole("dialog", {
      name: "Add Environment",
    });
    await expect
      .element(
        addEnvironmentDialog.getByRole("heading", {
          name: "Add Environment",
          exact: true,
        }),
      )
      .toBeInTheDocument();
    await addEnvironmentDialog.getByRole("button", { name: /^SSH\b/ }).click();
    await vi.waitFor(() => {
      expect(discoverSshHosts).toHaveBeenCalledTimes(1);
    });
    await expect
      .element(page.getByRole("heading", { name: "devbox", exact: true }))
      .toBeInTheDocument();

    await addEnvironmentDialog.getByLabelText("SSH host or alias").fill("devbox.example.com");
    await addEnvironmentDialog.getByLabelText("Username").fill("julius");
    await addEnvironmentDialog.getByLabelText("Port").fill("2222");
    await addEnvironmentDialog
      .getByRole("button", { name: "Add environment", exact: true })
      .first()
      .click();

    await vi.waitFor(() => {
      expect(mockConnectDesktopSshEnvironment).toHaveBeenCalledWith(
        {
          alias: "devbox.example.com",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
        { label: "" },
      );
    });
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<LocalApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      shell: {
        openInEditor,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const openLogsButton = page.getByText("Open logs folder");
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.ryco/logs", "cursor");
  });

  it("shows an OpenCode server URL field in provider settings", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProvidersSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Edit OpenCode default provider instance" }).click();

    // The unified provider-instance card renders field labels without a
    // driver-name prefix (the driver name is already shown in the card
    // header), so the labels read "Server URL" / "Server password"
    // rather than the old "OpenCode server URL" / "OpenCode server password".
    await expect.element(page.getByText("Server URL")).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("http://127.0.0.1:4096")).toBeInTheDocument();
    await expect.element(page.getByText("Server password")).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("Optional")).toBeInTheDocument();
  });

  it("opens the existing instance wizard from the master list", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProvidersSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Add provider instance" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Add provider instance" }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Step 1", { exact: true })).toBeInTheDocument();
  });

  it("keeps multiple instances scannable and supports arrow-key editor selection", async () => {
    const workInstanceId = ProviderInstanceId.make("codex_work");
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [workInstanceId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            displayName: "Work Codex",
          },
        },
      },
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProvidersSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect
      .element(page.getByRole("navigation", { name: "Provider instances" }))
      .toBeInTheDocument();
    const workRow = page.getByRole("button", {
      name: "Edit Work Codex custom provider instance",
    });
    await expect.element(workRow).toBeInTheDocument();
    workRow.element().focus();
    await userEvent.keyboard("{ArrowDown}");

    const claudeRow = page.getByRole("button", {
      name: "Edit Claude default provider instance",
    });
    await expect.element(claudeRow).toHaveAttribute("aria-current", "true");
    await expect.element(page.getByRole("region", { name: "Edit Claude" })).toBeInTheDocument();
  });

  it("requires confirmation before deleting a custom instance", async () => {
    const customInstanceId = ProviderInstanceId.make("codex_work");
    const updateSettings = vi
      .fn<LocalApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    installSettingsNativeApi({ updateSettings });
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [customInstanceId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            displayName: "Work Codex",
          },
        },
      },
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProvidersSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Edit Work Codex custom provider instance" }).click();
    await page
      .getByRole("button", { name: `Delete provider instance ${customInstanceId}` })
      .click();

    await expect
      .element(page.getByRole("heading", { name: "Delete Work Codex?" }))
      .toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Delete instance" }).click();
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({ providerInstances: {} });
  });

  it("requires confirmation before resetting a customized default instance", async () => {
    const driver = ProviderDriverKind.make("codex");
    const instanceId = defaultInstanceIdForDriver(driver);
    const updateSettings = vi
      .fn<LocalApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    installSettingsNativeApi({ updateSettings });
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: {
            driver,
            enabled: true,
            displayName: "Primary Codex",
          },
        },
      },
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProvidersSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page
      .getByRole("button", { name: "Reset Primary Codex provider settings to default" })
      .click();
    await expect
      .element(page.getByRole("heading", { name: "Reset Primary Codex?" }))
      .toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Reset settings" }).click();
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({ providerInstances: {} });
  });

  it("runs one-click provider updates from the provider card", async () => {
    const updateProvider = vi.fn<LocalApi["server"]["updateProvider"]>().mockResolvedValue({
      providers: [createOutdatedProvider("codex")],
    });
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateProvider,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createOutdatedProvider("codex")],
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProvidersSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Update available — view details" }).click();
    await expect.element(page.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Update now" }).click();

    expect(updateProvider).toHaveBeenCalledWith({
      provider: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
    });
  });
});

describe("SourceControlSettingsPanel discovery states", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetAppAtomRegistryForTests();
    await __resetLocalApiForTests();
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    await __resetLocalApiForTests();
    resetAppAtomRegistryForTests();
  });

  function setSourceControlDiscoveryStub(
    discoverSourceControl: () => Promise<SourceControlDiscoveryResult>,
  ) {
    window.nativeApi = {
      server: {
        discoverSourceControl,
      },
    } as LocalApi;
  }

  function renderSourceControlSettingsPanel(queryClient = new QueryClient()) {
    return render(
      <QueryClientProvider client={queryClient}>
        <AppAtomRegistryProvider>
          <SourceControlSettingsPanel />
        </AppAtomRegistryProvider>
      </QueryClientProvider>,
    );
  }

  it("shows skeleton sections while the first source control scan is pending", async () => {
    setSourceControlDiscoveryStub(() => new Promise(() => {}));

    mounted = await renderSourceControlSettingsPanel();

    await expect.element(page.getByText("Version Control")).toBeInTheDocument();
    await expect.element(page.getByText("Source Control Providers")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Rescan server environment" }))
      .toBeDisabled();
    await expect.element(page.getByText("Nothing detected yet")).not.toBeInTheDocument();
  });

  it("uses the shared empty state when discovery completes without tools", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [],
      sourceControlProviders: [],
    }));

    mounted = await renderSourceControlSettingsPanel();

    await expect.element(page.getByText("Nothing detected yet")).toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Scan" })).toBeInTheDocument();
  });

  it("keeps discovered rows instead of showing the empty state", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          implemented: true,
          status: "available",
          version: Option.some("git version 2.50.0"),
          installHint: "Install Git.",
          detail: Option.none(),
        },
      ],
      sourceControlProviders: [],
    }));

    mounted = await renderSourceControlSettingsPanel();

    await expect
      .element(page.getByRole("heading", { name: "Git", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Nothing detected yet")).not.toBeInTheDocument();
  });

  it("does not rescan on remount while the discovery atom is fresh", async () => {
    let calls = 0;
    setSourceControlDiscoveryStub(async () => {
      calls += 1;
      return {
        versionControlSystems: [
          {
            kind: "git",
            label: "Git",
            executable: "git",
            implemented: true,
            status: "available",
            version: Option.some("git version 2.50.0"),
            installHint: "Install Git.",
            detail: Option.none(),
          },
        ],
        sourceControlProviders: [],
      };
    });

    const queryClient = new QueryClient();
    mounted = await renderSourceControlSettingsPanel(queryClient);

    await expect
      .element(page.getByRole("heading", { name: "Git", exact: true }))
      .toBeInTheDocument();
    expect(calls).toBe(1);

    const teardown = mounted.cleanup ?? mounted.unmount;
    await teardown?.call(mounted).catch(() => {});
    mounted = null;
    document.body.innerHTML = "";

    mounted = await renderSourceControlSettingsPanel(queryClient);

    await expect
      .element(page.getByRole("heading", { name: "Git", exact: true }))
      .toBeInTheDocument();
    expect(calls).toBe(1);
  });
});

describe("ConnectionsSettings Hub section", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | undefined;

  beforeEach(() => {
    resetAppAtomRegistryForTests();
    resetServerStateForTests();
    __resetLocalApiForTests();
    authAccessHarness.reset();
    localStorage.clear();
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: null });
  });

  afterEach(async () => {
    await mounted?.cleanup?.();
    await mounted?.unmount?.();
    mounted = undefined;
    vi.unstubAllGlobals();
    delete window.desktopBridge;
    delete window.nativeApi;
  });

  /**
   * Serve the hub control plane from a fetch stub.
   *
   * The panel reads these three routes on every poll, so a test that omits one
   * would exercise the error path rather than the state it means to.
   */
  const stubHubFetch = (hub: {
    readonly status: unknown;
    readonly identity: unknown;
    readonly enrollment?: unknown;
  }) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return json({
          authenticated: true,
          auth: createBaseServerConfig().auth,
          role: "owner",
          sessionMethod: "browser-session-cookie",
          expiresAt: "2036-05-07T00:00:00.000Z",
        });
      }
      if (url.endsWith("/api/hub/status")) return json(hub.status);
      if (url.endsWith("/api/hub/identity")) return json(hub.identity);
      if (url.endsWith("/api/hub/enrollment")) {
        return hub.enrollment === undefined
          ? json({ message: "No Hub enrollment is pending." }, 404)
          : json(hub.enrollment);
      }
      throw new Error(`Unhandled fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  const renderHub = async (
    hubConfig?: Partial<Awaited<ReturnType<DesktopBridge["getHubLaunchConfig"]>>>,
    bridgeOverrides?: Parameters<typeof createDesktopBridgeStub>[0],
  ) => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "local-only",
        endpointUrl: "http://127.0.0.1:3773",
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      getHubLaunchConfig: async () => ({
        enabled: false,
        origin: null,
        nodeName: null,
        allowFileSecretStore: false,
        fileSecretStoreFallbackSupported: true,
        ...hubConfig,
      }),
      ...bridgeOverrides,
    });
    setServerConfigSnapshot(createBaseServerConfig());
    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );
  };

  const baseStatus = {
    transitionedAt: "2036-04-07T00:00:00.000Z",
    activeChannels: 0,
    queuedBytes: 0,
  };

  it("offers enabling when nothing is enrolled", async () => {
    stubHubFetch({
      status: { ...baseStatus, state: "disabled" },
      identity: { enrolled: "none" },
    });
    await renderHub();

    await expect
      .element(page.getByRole("heading", { name: "Hub", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Connection", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Not connected")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    // Nothing enrolled, so the address is editable.
    await expect.element(page.getByPlaceholder("https://…")).toBeEnabled();
  });

  it("uses account setup instead of a second manual enrollment on Desktop", async () => {
    stubHubFetch({
      status: { ...baseStatus, state: "enrolling" },
      identity: { enrolled: "none" },
    });
    await renderHub(
      { enabled: true, origin: "https://hub.example.com" },
      {
        getHostedIdentityState: vi.fn().mockResolvedValue({ status: "signed-out" }),
        connectHostedIdentity: vi.fn().mockResolvedValue({ status: "ready" }),
      },
    );

    await expect.element(page.getByText("Ready for account setup")).toBeVisible();
    await expect
      .element(page.getByText(/register this Mac with this Hub automatically/))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Start enrollment" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Connect account" })).toBeVisible();
  });

  it("offers Finish setup when account login completed before the local node claim", async () => {
    const connectHostedIdentity = vi.fn().mockResolvedValue({ status: "ready" as const });
    stubHubFetch({
      status: { ...baseStatus, state: "disabled" },
      identity: { enrolled: "none" },
    });
    await renderHub(
      { enabled: false, origin: "https://hub.example.com" },
      {
        getHostedIdentityState: vi.fn().mockResolvedValue({ status: "ready" }),
        connectHostedIdentity,
      },
    );

    await expect.element(page.getByText("Signed in · Node setup needed")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Finish setup" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Enable" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Finish setup" }).click();
    expect(connectHostedIdentity).toHaveBeenCalledOnce();
  });

  it("restarts Desktop when the startup credential store was unavailable", async () => {
    const restartApp = vi.fn().mockResolvedValue(undefined);
    stubHubFetch({
      status: {
        ...baseStatus,
        state: "degraded",
        degradedMode: "operator_action_required",
        failure: "identity_store_unavailable",
      },
      identity: { enrolled: "active" },
    });
    await renderHub({ enabled: true, origin: "https://hub.example.com" }, { restartApp });

    await page.getByRole("button", { name: "Restart Ryco" }).click();

    expect(restartApp).toHaveBeenCalledOnce();
  });

  it("runs automatic native account setup without exposing Hub identifiers", async () => {
    const connectHostedIdentity = vi.fn().mockResolvedValue({ status: "ready" as const });
    stubHubFetch({
      status: { ...baseStatus, state: "online" },
      identity: { enrolled: "active" },
    });
    await renderHub(
      { enabled: true, origin: "https://hub.example.com" },
      {
        getHostedIdentityState: vi.fn().mockResolvedValue({ status: "signed-out" }),
        connectHostedIdentity,
      },
    );

    await expect.element(page.getByText("Not signed in")).toBeInTheDocument();
    await page.getByRole("button", { name: "Connect account" }).click();
    await expect.element(page.getByText("Secure setup complete")).toBeInTheDocument();
    expect(connectHostedIdentity).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("account-");
    expect(document.body.textContent).not.toContain("node-");
  });

  it("connects and disconnects GitHub through bounded Desktop outcomes", async () => {
    const disconnected = {
      status: "ready" as const,
      github: { linkAvailable: true, identity: null },
    };
    const connected = {
      status: "ready" as const,
      github: {
        linkAvailable: true,
        identity: {
          provider: "github" as const,
          login: "octocat",
          displayName: "The Octocat",
          connectedAt: 1_700_000_000_000,
          lastUsedAt: null,
        },
      },
    };
    const connectHostedGitHub = vi.fn().mockResolvedValue({
      outcome: "committed" as const,
      state: connected,
    });
    const disconnectHostedGitHub = vi.fn().mockResolvedValue({
      outcome: "committed" as const,
      state: disconnected,
    });
    stubHubFetch({
      status: { ...baseStatus, state: "online" },
      identity: { enrolled: "active" },
    });
    await renderHub(
      { enabled: true, origin: "https://hub.example.com" },
      {
        getHostedIdentityState: vi.fn().mockResolvedValue(disconnected),
        connectHostedGitHub,
        disconnectHostedGitHub,
      },
    );

    await page.getByRole("button", { name: "Connect GitHub" }).click();
    await expect.element(page.getByText("GitHub · @octocat")).toBeVisible();
    expect(connectHostedGitHub).toHaveBeenCalledWith(undefined);
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    expect(disconnectHostedGitHub).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Disconnect GitHub", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
    expect(disconnectHostedGitHub).toHaveBeenCalledWith(undefined);
    expect(document.body.textContent).not.toContain("providerSubject");
    expect(document.body.textContent).not.toContain("accessToken");
  });

  it("discards the Desktop staged GitHub link when step-up is cancelled", async () => {
    const state = {
      status: "ready" as const,
      github: { linkAvailable: true, identity: null },
    };
    const cancelHostedGitHubConnection = vi.fn().mockResolvedValue(undefined);
    stubHubFetch({
      status: { ...baseStatus, state: "online" },
      identity: { enrolled: "active" },
    });
    await renderHub(
      { enabled: true, origin: "https://hub.example.com" },
      {
        getHostedIdentityState: vi.fn().mockResolvedValue(state),
        connectHostedGitHub: vi.fn().mockResolvedValue({
          outcome: "step-up-required",
          state,
        }),
        cancelHostedGitHubConnection,
      },
    );

    await page.getByRole("button", { name: "Connect GitHub" }).click();
    await expect.element(page.getByLabelText("Authenticator code")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await vi.waitFor(() => expect(cancelHostedGitHubConnection).toHaveBeenCalledOnce());
  });

  it("saves a trimmed pre-enrollment node name", async () => {
    const setHubLaunchConfig = vi.fn().mockResolvedValue(undefined);
    stubHubFetch({
      status: { ...baseStatus, state: "disabled" },
      identity: { enrolled: "none" },
    });
    await renderHub({ nodeName: "Build node" }, { setHubLaunchConfig });

    const input = page.getByRole("textbox", { name: "Hub node name" });
    await expect.element(input).toHaveValue("Build node");
    await input.fill("  Release node  ");
    await page.getByRole("button", { name: "Save and restart" }).click();
    expect(setHubLaunchConfig).toHaveBeenCalledWith({
      nodeName: "Release node",
    });
  });

  it("resets a configured node name to automatic", async () => {
    const setHubLaunchConfig = vi.fn().mockResolvedValue(undefined);
    stubHubFetch({
      status: { ...baseStatus, state: "disabled" },
      identity: { enrolled: "none" },
    });
    await renderHub({ nodeName: "Build node" }, { setHubLaunchConfig });

    const input = page.getByRole("textbox", { name: "Hub node name" });
    await input.fill("");
    await page.getByRole("button", { name: "Save and restart" }).click();
    expect(setHubLaunchConfig).toHaveBeenCalledWith({ nodeName: null });
  });

  it("rejects an overlong node name before it reaches the desktop bridge", async () => {
    const setHubLaunchConfig = vi.fn().mockResolvedValue(undefined);
    stubHubFetch({
      status: { ...baseStatus, state: "disabled" },
      identity: { enrolled: "none" },
    });
    await renderHub(undefined, { setHubLaunchConfig });

    await page.getByRole("textbox", { name: "Hub node name" }).fill("N".repeat(101));

    await expect.element(page.getByText("Use 100 characters or fewer.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Save and restart" }))
      .not.toBeInTheDocument();
    expect(setHubLaunchConfig).not.toHaveBeenCalled();
  });

  it("locks the address once an identity exists, and offers leaving", async () => {
    stubHubFetch({
      status: { ...baseStatus, state: "disabled" },
      identity: { enrolled: "active" },
    });
    await renderHub({ enabled: false, origin: "https://hub.example.com" });

    // Status is identical to the previous test; only the identity summary differs.
    await expect.element(page.getByText("Turned off")).toBeInTheDocument();
    await expect.element(page.getByPlaceholder("https://…")).toBeDisabled();
    await expect.element(page.getByRole("textbox", { name: "Hub node name" })).toBeDisabled();
    await expect
      .element(
        page.getByText("Locked while this machine is enrolled. Leave this Hub to change it."),
      )
      .toBeInTheDocument();
    await expect.element(page.getByText(/Managed on the Hub after enrollment/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Leave this Hub" })).toBeInTheDocument();
  });

  it("renders the enrollment comparison with every field the approval screen shows", async () => {
    stubHubFetch({
      status: { ...baseStatus, state: "awaiting_approval" },
      identity: { enrolled: "pending" },
      enrollment: {
        deviceCode: "K7P2-N4QX",
        fingerprint: `SHA256:${"A".repeat(43)}`,
        label: "Laurin's MacBook Pro",
        platformOs: "darwin",
        platformArch: "arm64",
        clientVersion: "0.0.17",
        algorithm: "ed25519",
        expiresAt: "2036-04-07T00:10:00.000Z",
        pollIntervalMs: 5_000,
      },
    });
    await renderHub({ enabled: true, origin: "https://hub.example.com" });

    await expect.element(page.getByText("Waiting for approval on the Hub")).toBeInTheDocument();
    for (const field of [
      "Label",
      "Platform",
      "Version",
      "Algorithm",
      "Fingerprint",
      "Expires",
      "Device code",
    ]) {
      await expect.element(page.getByText(field, { exact: true })).toBeInTheDocument();
    }
    await expect.element(page.getByText(`SHA256:${"A".repeat(43)}`)).toBeInTheDocument();
    await expect.element(page.getByText("K7P2-N4QX")).toBeInTheDocument();
    // The compare instruction has to be present, or the fields are decoration.
    await expect
      .element(
        page.getByText(
          "If the fingerprint on the Hub differs by even one character, deny it there and cancel here.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("reports a retrying connector without asking the operator to act", async () => {
    stubHubFetch({
      status: {
        ...baseStatus,
        state: "degraded",
        degradedMode: "backing_off",
        failure: "network_unavailable",
        reconnectAttempt: 3,
        nextRetryAt: "2099-01-01T00:00:00.000Z",
      },
      identity: { enrolled: "active" },
    });
    await renderHub({ enabled: true, origin: "https://hub.example.com" });

    await expect.element(page.getByText("Reconnecting")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Retry now" })).not.toBeInTheDocument();
  });

  it("offers a retry for a duplicate process, which schedules none of its own", async () => {
    stubHubFetch({
      status: {
        ...baseStatus,
        state: "degraded",
        degradedMode: "operator_action_required",
        failure: "connection_replaced",
      },
      identity: { enrolled: "active" },
    });
    await renderHub({ enabled: true, origin: "https://hub.example.com" });

    await expect
      .element(page.getByText("Another process connected as this machine"))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Retry now" })).toBeInTheDocument();
  });

  it("says a revoked node will not retry, rather than looking stuck", async () => {
    stubHubFetch({
      status: {
        ...baseStatus,
        state: "revoked",
        failure: "authentication_failed",
      },
      identity: { enrolled: "active" },
    });
    await renderHub({ enabled: true, origin: "https://hub.example.com" });

    await expect.element(page.getByText("Revoked at the Hub")).toBeInTheDocument();
    await expect.element(page.getByText(/will not retry/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Leave this Hub" })).toBeInTheDocument();
  });

  it("warns before erasing the key, and names what leaving does not do", async () => {
    stubHubFetch({
      status: {
        ...baseStatus,
        state: "revoked",
        failure: "authentication_failed",
      },
      identity: { enrolled: "active" },
    });
    await renderHub({ enabled: true, origin: "https://hub.example.com" });

    await page.getByRole("button", { name: "Leave this Hub" }).click();

    await expect.element(page.getByText("Leave this Hub?")).toBeInTheDocument();
    await expect.element(page.getByText(/join as a new machine/)).toBeInTheDocument();
    // The orphan record is the thing an operator will otherwise be surprised by.
    await expect.element(page.getByText(/until an owner removes it/)).toBeInTheDocument();
  });

  it("shows the session count and the role explainer while online", async () => {
    stubHubFetch({
      status: {
        ...baseStatus,
        state: "online",
        protocolMajor: 1,
        protocolMinor: 2,
        activeChannels: 2,
      },
      identity: { enrolled: "active" },
    });
    await renderHub({ enabled: true, origin: "https://hub.example.com" });

    await expect.element(page.getByText("Connected")).toBeInTheDocument();
    await expect.element(page.getByText("2 active sessions")).toBeInTheDocument();
    await expect.element(page.getByText(/Managed on the Hub, not here/)).toBeInTheDocument();
  });

  it("keeps advanced launch settings collapsed until they are requested", async () => {
    stubHubFetch({
      status: { ...baseStatus, state: "disabled" },
      identity: { enrolled: "none" },
    });
    await renderHub();

    await expect.element(page.getByRole("button", { name: /Show advanced options/ })).toBeVisible();
    await expect.element(page.getByText("Protected key fallback")).not.toBeInTheDocument();

    await page.getByRole("button", { name: /Show advanced options/ }).click();

    await expect.element(page.getByText("Protected key fallback")).toBeVisible();
    await expect
      .element(
        page.getByRole("switch", {
          name: "Allow permissioned-file Hub key storage",
        }),
      )
      .toBeEnabled();
    await expect.element(page.getByText(/--hub-connector-enabled/, { exact: false })).toBeVisible();
  });

  it("confirms and restarts before enabling permissioned-file key storage", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const setHubLaunchConfig = vi.fn().mockResolvedValue(undefined);
    stubHubFetch({
      status: { ...baseStatus, state: "disabled" },
      identity: { enrolled: "none" },
    });
    await renderHub(undefined, { confirm, setHubLaunchConfig });

    await page.getByRole("button", { name: /Show advanced options/ }).click();
    await page.getByRole("switch", { name: "Allow permissioned-file Hub key storage" }).click();

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Ryco will restart. Existing keys are not moved."),
    );
    expect(setHubLaunchConfig).toHaveBeenCalledWith({
      allowFileSecretStore: true,
    });
  });

  it("locks key custody after enrollment and explains why", async () => {
    stubHubFetch({
      status: { ...baseStatus, state: "disabled" },
      identity: { enrolled: "active" },
    });
    await renderHub({ allowFileSecretStore: false });

    await page.getByRole("button", { name: /Show advanced options/ }).click();

    await expect
      .element(
        page.getByRole("switch", {
          name: "Allow permissioned-file Hub key storage",
        }),
      )
      .toBeDisabled();
    await expect.element(page.getByText(/Locked while this machine holds/)).toBeVisible();
  });

  it("shows bounded relay diagnostics and opens the standalone guide", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    stubHubFetch({
      status: {
        ...baseStatus,
        state: "online",
        protocolMajor: 1,
        protocolMinor: 2,
        activeChannels: 3,
        queuedBytes: 1536,
      },
      identity: { enrolled: "active" },
    });
    await renderHub({ enabled: true, origin: "https://hub.example.com" }, { openExternal });

    await page.getByRole("button", { name: /Show advanced options/ }).click();

    await expect.element(page.getByText("1.2", { exact: true })).toBeVisible();
    await expect.element(page.getByText("1.5 KiB", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open relay guide" }).click();
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("relay-architecture"));
  });
});
