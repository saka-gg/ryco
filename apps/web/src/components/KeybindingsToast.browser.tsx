import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
  WS_METHODS,
} from "@ryco/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { ws, http, HttpResponse } from "msw";
import { setupWorker } from "msw/browser";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { __resetLocalApiForTests } from "../localApi";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { getServerConfig, getServerConfigUpdatedNotification } from "../rpc/serverState";
import { getWsConnectionStatus } from "../rpc/wsConnectionState";
import { getRouter } from "../router";
import { useStore } from "../store";
import { createAuthenticatedSessionHandlers } from "../../test/authHttpHandlers";
import { resetPointerEmulation, parkPointer } from "../../test/browserPointer";
import { BrowserWsRpcHarness } from "../../test/wsRpcHarness";

vi.mock("../lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

const THREAD_ID = "thread-kb-toast-test" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const NOW_ISO = "2026-03-04T12:00:00.000Z";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: ServerLifecycleWelcomePayload;
}

let fixture: TestFixture;
const rpcHarness = new BrowserWsRpcHarness();

const wsLink = ws.link(/ws(s)?:\/\/.*/);

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: LOCAL_ENVIRONMENT_ID,
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
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
        enabled: true,
        installed: true,
        version: "0.116.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: NOW_ISO,
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.ryco/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      enableLegacyTokenStreaming: false,
      defaultThreadEnvMode: "local" as const,
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4-mini",
      },
      providers: {
        codex: {
          enabled: true,
          binaryPath: "",
          homePath: "",
          shadowHomePath: "",
          customModels: [],
        },
        claudeAgent: {
          enabled: true,
          binaryPath: "",
          homePath: "",
          customModels: [],
          launchArgs: "",
        },
        copilot: {
          enabled: true,
          binaryPath: "",
          customModels: [],
        },
        cursor: { enabled: true, binaryPath: "", apiEndpoint: "", customModels: [] },
        grok: { enabled: true, binaryPath: "", customModels: [] },
        opencode: {
          enabled: true,
          binaryPath: "",
          serverUrl: "",
          serverPassword: "",
          customModels: [],
        },
      },
    },
  };
}

function createMinimalSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        projectMetadataDir: ".ryco",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Test thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [
          {
            id: "msg-1" as MessageId,
            role: "user",
            text: "hello",
            turnId: null,
            streaming: false,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          },
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function toShellSnapshot(snapshot: OrchestrationReadModel) {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryIdentity: project.repositoryIdentity ?? null,
      defaultModelSelection: project.defaultModelSelection,
      scripts: project.scripts,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    threads: snapshot.threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      latestTurn: thread.latestTurn,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      archivedAt: thread.archivedAt,
      session: thread.session,
      latestUserMessageAt:
        thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    })),
    updatedAt: snapshot.updatedAt,
  };
}

function buildFixture(): TestFixture {
  return {
    snapshot: createMinimalSnapshot(),
    serverConfig: createBaseServerConfig(),
    welcome: {
      environment: {
        environmentId: LOCAL_ENVIRONMENT_ID,
        label: "Local environment",
        platform: { os: "darwin" as const, arch: "arm64" as const },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
          threadSettlement: false,
          threadPriorityRanking: false,
        },
      },
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function resolveWsRpc(tag: string): unknown {
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.serverDiscoverSourceControl) {
    return { versionControlSystems: [], sourceControlProviders: [] };
  }
  if (tag === WS_METHODS.vcsListRefs) {
    return {
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 1,
      refs: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return { entries: [], truncated: false };
  }
  if (tag === WS_METHODS.sourceControlListChangeRequests) {
    return [];
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    void rpcHarness.connect(client);
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      void rpcHarness.onMessage(rawData, client);
    });
  }),
  ...createAuthenticatedSessionHandlers(() => fixture.serverConfig.auth),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

function sendServerConfigUpdatedPush(issues: ServerConfig["issues"]) {
  rpcHarness.emitStreamValue(WS_METHODS.subscribeServerConfig, {
    version: 1,
    type: "keybindingsUpdated",
    payload: { keybindings: fixture.serverConfig.keybindings, issues },
  });
}

function queryToastTitles(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="toast-title"]')).map(
    (el) => el.textContent ?? "",
  );
}

const FULL_APP_BOOTSTRAP_TIMEOUT_MS = 20_000;

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
  timeout = 8_000,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    { timeout, interval: 16 },
  );
  return element!;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
    "App should render composer editor",
    FULL_APP_BOOTSTRAP_TIMEOUT_MS,
  );
}

async function waitForToastViewport(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[data-slot="toast-viewport"]'),
    "App should render the toast viewport before server config updates are pushed",
  );
}

async function waitForWsConnection(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(getWsConnectionStatus().phase).toBe("connected");
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForNoToasts(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(queryToastTitles()).toHaveLength(0);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForInitialWsSubscriptions(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        rpcHarness.requests.some((request) => request._tag === WS_METHODS.subscribeServerLifecycle),
      ).toBe(true);
      expect(
        rpcHarness.requests.some((request) => request._tag === WS_METHODS.subscribeServerConfig),
      ).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForServerConfigSnapshot(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(getServerConfig()).not.toBeNull();
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForServerConfigStreamReady(): Promise<void> {
  const previousNotificationId = getServerConfigUpdatedNotification()?.id ?? 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    rpcHarness.emitStreamValue(WS_METHODS.subscribeServerConfig, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings: fixture.serverConfig.settings },
    });

    try {
      await vi.waitFor(
        () => {
          const notification = getServerConfigUpdatedNotification();
          expect(notification?.id).toBeGreaterThan(previousNotificationId);
          expect(notification?.source).toBe("settingsUpdated");
        },
        { timeout: 200, interval: 16 },
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error("Timed out waiting for the server config stream to deliver updates.");
}

async function mountApp(): Promise<{ cleanup: () => Promise<void> }> {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`] }),
  );

  const screen = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
    { container: host },
  );
  await waitForComposerEditor();
  // Earlier test files leave the shared pointer wherever their last click
  // landed. If a toast later mounts under that parked pointer, Base UI pauses
  // its dismiss timers (pause-on-hover) and the auto-dismiss assertions hang.
  // Park the pointer in the top-left corner, outside the toast region at
  // every viewport width.
  await parkPointer(4, 4);
  await waitForToastViewport();
  await waitForInitialWsSubscriptions();
  await waitForWsConnection();
  await waitForServerConfigSnapshot();
  await waitForServerConfigStreamReady();
  await waitForNoToasts();

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("Keybindings update toast", () => {
  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  });

  afterAll(async () => {
    await rpcHarness.disconnect();
    await worker.stop();
  });

  beforeEach(async () => {
    await rpcHarness.reset({
      resolveUnary: (request) => resolveWsRpc(request._tag),
      getInitialStreamValues: (request) => {
        if (request._tag === WS_METHODS.subscribeServerLifecycle) {
          return [
            {
              version: 1,
              sequence: 1,
              type: "welcome",
              payload: fixture.welcome,
            },
          ];
        }
        if (request._tag === WS_METHODS.subscribeServerConfig) {
          return [
            {
              version: 1,
              type: "snapshot",
              config: fixture.serverConfig,
            },
          ];
        }
        if (request._tag === ORCHESTRATION_WS_METHODS.subscribeShell) {
          return [
            {
              kind: "snapshot",
              snapshot: toShellSnapshot(fixture.snapshot),
            },
          ];
        }
        if (
          request._tag === ORCHESTRATION_WS_METHODS.subscribeThread &&
          request.threadId === THREAD_ID
        ) {
          return [
            {
              kind: "snapshot",
              snapshot: {
                snapshotSequence: fixture.snapshot.snapshotSequence,
                thread: fixture.snapshot.threads[0],
              },
            },
          ];
        }
        return [];
      },
    });
    await __resetLocalApiForTests();
    // Defensive: no earlier test or file may leak touch emulation into these
    // pointer-sensitive toast-dismissal tests.
    await resetPointerEmulation();
    localStorage.clear();
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("never announces remote legacy config changes as local app binding updates", async () => {
    const mounted = await mountApp();
    try {
      for (const issues of [
        [],
        [{ kind: "keybindings.malformed-config" as const, message: "bad json" }],
      ]) {
        const previousId = getServerConfigUpdatedNotification()?.id ?? 0;
        sendServerConfigUpdatedPush(issues);
        await vi.waitFor(() =>
          expect(getServerConfigUpdatedNotification()?.id).toBeGreaterThan(previousId),
        );
        expect(queryToastTitles()).not.toContain("Keybindings updated");
        expect(queryToastTitles()).not.toContain("Invalid keybindings configuration");
      }
    } finally {
      await mounted.cleanup();
    }
  });
});
