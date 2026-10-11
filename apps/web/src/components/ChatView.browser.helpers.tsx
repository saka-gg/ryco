import { getAppKeybindings, replaceAppKeybindings, resetAppKeybindings } from "../appKeybindings";
import { serializeShortcut } from "../lib/shortcutCapture";
import { serializeWhenAst } from "../lib/keybindingWhenPresets";
import { useChatPanesStore } from "../chatPanesStore";

import { resetPreviewFileSessionsForTests } from "./previewFileSessions";
import { useInboxFilterStore } from "./inboxSidebar/inboxFilterStore";
import { useSidebarFoldStore } from "./sidebar/sidebarFold";

// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  EnvironmentId,
  type CheckpointRef,
  type ComposerSourceControlContext,
  type EnvironmentApi,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
  type TurnId,
  WS_METHODS,
  OrchestrationSessionStatus,
  DEFAULT_SERVER_SETTINGS,
} from "@ryco/contracts";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { type PromptStashEntry } from "@ryco/client-runtime/state/composer";
import { createModelCapabilities } from "@ryco/shared/model";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Option } from "effect";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page, userEvent } from "vite-plus/test/browser";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vite-plus/test";
import { useMessageQueueStore } from "../messageQueueStore";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  useComposerDraftStore,
  DraftId,
  type ComposerImageAttachment,
} from "../composerDraftStore";
import { usePromptStashStore } from "../promptStashStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
} from "../environments/runtime";

import { type TerminalContextDraft } from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";
import { syncDocumentPresentationTier } from "../lib/presentationTier";

import { __resetLocalApiForTests } from "../localApi";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { resetGitAtomsForTests } from "../rpc/gitAtoms";
import { resetProjectAtomsForTests } from "../rpc/projectAtoms";
import { resetProjectPreviewAtomsForTests } from "../rpc/projectPreviewAtoms";
import { resetCheckpointDiffStateForTests } from "../rpc/providerAtoms";
import { getServerConfig } from "../rpc/serverState";
import { getRouter } from "../router";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { clearRightPanelSessionSearch } from "../rightPanelSessionState";
import { selectBootstrapCompleteForActiveEnvironment, useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { createAuthenticatedSessionHandlers } from "../../test/authHttpHandlers";
import {
  resetPointerEmulation,
  parkPointer,
  setCoarsePointerEmulation,
} from "../../test/browserPointer";

import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import { DEFAULT_CLIENT_SETTINGS } from "@ryco/contracts/settings";

const THREAD_ID = "thread-browser-test" as ThreadId;
const THREAD_TITLE = "Browser test thread";
const ARCHIVED_SECONDARY_THREAD_ID = "thread-secondary-project-archived" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const SECOND_PROJECT_ID = "project-2" as ProjectId;
const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const THREAD_REF = scopeThreadRef(LOCAL_ENVIRONMENT_ID, THREAD_ID);
const THREAD_KEY = scopedThreadKey(THREAD_REF);
const UUID_ROUTE_RE = /^\/draft\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_DRAFT_KEY = `${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`;
const PROJECT_LOGICAL_KEY = deriveLogicalProjectKeyFromSettings(
  {
    environmentId: LOCAL_ENVIRONMENT_ID,
    id: PROJECT_ID,
    cwd: "/repo/project",
    repositoryIdentity: null,
  },
  {
    sidebarProjectGroupingMode: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingOverrides,
  },
);
const SECOND_PROJECT_LOGICAL_KEY = deriveLogicalProjectKeyFromSettings(
  {
    environmentId: LOCAL_ENVIRONMENT_ID,
    id: SECOND_PROJECT_ID,
    cwd: "/repo/clients/docs-portal",
    repositoryIdentity: null,
  },
  {
    sidebarProjectGroupingMode: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingOverrides,
  },
);
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'></svg>";
const ADD_PROJECT_SUBMENU_PLACEHOLDER = "Enter path (e.g. ~/projects/my-app)";
const CHAT_NEW_KEYBINDING: ServerConfig["keybindings"][number] = {
  command: "chat.new",
  shortcut: {
    key: "o",
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    modKey: true,
  },
  whenAst: {
    type: "not" as const,
    node: { type: "identifier" as const, name: "terminalFocus" },
  },
};
const CHAT_NEW_LOCAL_KEYBINDING: ServerConfig["keybindings"][number] = {
  command: "chat.newLocal",
  shortcut: {
    key: "n",
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    modKey: true,
  },
  whenAst: {
    type: "not" as const,
    node: { type: "identifier" as const, name: "terminalFocus" },
  },
};
const COMPOSER_STASH_KEYBINDING: ServerConfig["keybindings"][number] = {
  command: "composer.stash",
  shortcut: {
    key: "s",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
  },
  whenAst: {
    type: "not" as const,
    node: { type: "identifier" as const, name: "terminalFocus" },
  },
};
const THREAD_PIN_TOGGLE_KEYBINDING: ServerConfig["keybindings"][number] = {
  command: "thread.pinToggle",
  shortcut: {
    key: "p",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: true,
    modKey: true,
  },
  whenAst: {
    type: "not" as const,
    node: { type: "identifier" as const, name: "terminalFocus" },
  },
};

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: ServerLifecycleWelcomePayload;
  /** Threads whose window reports older messages than it holds. */
  threadsWithOlderMessages?: ReadonlySet<ThreadId>;
}

let fixture: TestFixture;
const rpcHarness = new BrowserWsRpcHarness();
const wsRequests = rpcHarness.requests;
let customWsRpcResolver: ((body: NormalizedWsRpcRequestBody) => unknown | undefined) | null = null;
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  textTolerancePx: number;
  attachmentTolerancePx: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const WIDE_FOOTER_VIEWPORT: ViewportSpec = {
  name: "wide-footer",
  width: 1_680,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const COMPACT_FOOTER_VIEWPORT: ViewportSpec = {
  name: "compact-footer",
  width: 430,
  height: 932,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};
const NARROW_PHONE_VIEWPORT: ViewportSpec = {
  name: "narrow-phone",
  width: 320,
  height: 568,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};
const PHONE_VIEWPORT: ViewportSpec = {
  name: "phone",
  width: 390,
  height: 844,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};
const PHONE_LANDSCAPE_VIEWPORT: ViewportSpec = {
  name: "phone-landscape",
  width: 844,
  height: 390,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};
const NARROW_TABLET_VIEWPORT: ViewportSpec = {
  name: "narrow-tablet",
  width: 700,
  height: 900,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};
const TABLET_VIEWPORT: ViewportSpec = {
  name: "tablet",
  width: 768,
  height: 1_024,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};
// Desktop-tier side of a mid-size (600-800px) rotation: same device class as
// NARROW_TABLET_VIEWPORT but landscape, crossing the 768px tier boundary.
const ROTATED_MID_VIEWPORT: ViewportSpec = {
  name: "rotated-mid",
  width: 780,
  height: 700,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};

interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  setContainerSize: (viewport: Pick<ViewportSpec, "width" | "height">) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Studio Mac",
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
      ...DEFAULT_CLIENT_SETTINGS,
    },
  };
}

function createMockEnvironmentApi(input: {
  getConfig: () => Promise<ServerConfig>;
  browse: EnvironmentApi["filesystem"]["browse"];
  dispatchCommand: EnvironmentApi["orchestration"]["dispatchCommand"];
}): EnvironmentApi {
  return {
    server: { getConfig: input.getConfig } as NonNullable<EnvironmentApi["server"]>,
    terminal: {} as EnvironmentApi["terminal"],
    projects: {} as EnvironmentApi["projects"],
    filesystem: {
      browse: input.browse,
    },
    sourceControl: {} as EnvironmentApi["sourceControl"],
    vcs: {} as EnvironmentApi["vcs"],
    git: {} as EnvironmentApi["git"],
    orchestration: {
      dispatchCommand: input.dispatchCommand,
      getTurnDiff: (() => {
        throw new Error("Not implemented in browser test.");
      }) as EnvironmentApi["orchestration"]["getTurnDiff"],
      getFullThreadDiff: (() => {
        throw new Error("Not implemented in browser test.");
      }) as EnvironmentApi["orchestration"]["getFullThreadDiff"],
      searchThreadMessages: async () => [],
      subscribeShell: (() => () => undefined) as EnvironmentApi["orchestration"]["subscribeShell"],
      subscribeThread: (() => () =>
        undefined) as EnvironmentApi["orchestration"]["subscribeThread"],
    },
    contextHandoff: {} as EnvironmentApi["contextHandoff"],
  };
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

function createSourceControlContext(id: string): ComposerSourceControlContext {
  return {
    id,
    kind: "issue",
    provider: "github",
    reference: "owner/repo#1",
    detail: {
      provider: "github",
      number: 1 as never,
      title: "Stash context issue" as never,
      url: "https://github.com/owner/repo/issues/1" as never,
      state: "open",
      updatedAt: Option.none(),
      body: "Issue body",
      comments: [],
      truncated: false,
    },
    fetchedAt: NOW_ISO as never,
    staleAfter: NOW_ISO as never,
  };
}

function createBrowserComposerImage(input: {
  id: string;
  name?: string;
  bytes?: Uint8Array;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  previewUrl?: string;
}): ComposerImageAttachment {
  const bytes = input.bytes ?? new Uint8Array([1, 2, 3]);
  const name = input.name ?? `${input.id}.png`;
  const fileBytes = new Uint8Array(bytes.byteLength);
  fileBytes.set(bytes);
  const file = new File([fileBytes.buffer], name, { type: "image/png" });
  if (input.arrayBuffer) {
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: input.arrayBuffer,
    });
  }
  return {
    type: "image",
    id: input.id,
    name,
    mimeType: "image/png",
    sizeBytes: file.size,
    previewUrl: input.previewUrl ?? `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`,
    file,
  };
}

function createPromptStashEntry(input: {
  id: string;
  prompt: string;
  attachments?: PromptStashEntry["attachments"];
}): PromptStashEntry {
  return {
    id: input.id,
    createdAt: NOW_ISO,
    prompt: input.prompt,
    attachments: input.attachments ?? [],
    droppedImageNames: [],
    unreadableImageNames: [],
    pendingImageCount: 0,
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
            previewUrl: `/attachments/attachment-${attachmentIndex + 1}`,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

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
        title: THREAD_TITLE,
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
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
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

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    welcome: {
      environment: {
        environmentId: EnvironmentId.make("environment-local"),
        label: "Studio Mac",
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

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
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
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function toShellThread(thread: OrchestrationReadModel["threads"][number]) {
  return {
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
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    session: thread.session,
    latestUserMessageAt:
      thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function toShellSnapshot(snapshot: OrchestrationReadModel) {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      title: project.title,
      ...(project.kind ? { kind: project.kind } : {}),
      workspaceRoot: project.workspaceRoot,
      repositoryIdentity: project.repositoryIdentity ?? null,
      defaultModelSelection: project.defaultModelSelection,
      scripts: project.scripts,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    threads: snapshot.threads.map(toShellThread),
    updatedAt: snapshot.updatedAt,
  };
}

function toThreadWindowSnapshot(
  snapshotSequence: number,
  thread: OrchestrationReadModel["threads"][number],
  options: { readonly hasOlderMessages?: boolean } = {},
) {
  const emptyPage = {
    oldestCursor: null,
    newestCursor: null,
    hasMoreBefore: false,
  };
  return {
    snapshotSequence,
    thread,
    history: {
      messages: options.hasOlderMessages ? { ...emptyPage, hasMoreBefore: true } : emptyPage,
      proposedPlans: emptyPage,
      activities: emptyPage,
      checkpoints: emptyPage,
    },
  };
}

function updateThreadSessionInSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  session: OrchestrationReadModel["threads"][number]["session"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            session,
            updatedAt: NOW_ISO,
          }
        : thread,
    ),
  };
}

function sendShellThreadUpsert(
  threadId: ThreadId,
  options?: {
    readonly session?: OrchestrationReadModel["threads"][number]["session"];
  },
): void {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Expected thread ${threadId} in snapshot.`);
  }

  const shellThread =
    options?.session !== undefined
      ? toShellThread({ ...thread, session: options.session })
      : toShellThread(thread);
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
    kind: "thread-upserted",
    sequence: fixture.snapshot.snapshotSequence,
    thread: shellThread,
  });
}

async function waitForWsClient(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.subscribeShell),
      ).toBe(true);
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerLifecycle),
      ).toBe(true);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig)).toBe(
        true,
      );
    },
    { timeout: 20_000, interval: 16 },
  );
}

function threadRefFor(threadId: ThreadId) {
  return scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
}

function threadKeyFor(threadId: ThreadId): string {
  return scopedThreadKey(threadRefFor(threadId));
}

function composerDraftFor(target: string) {
  const { draftsByThreadKey } = useComposerDraftStore.getState();
  return draftsByThreadKey[target] ?? draftsByThreadKey[threadKeyFor(target as ThreadId)];
}

function draftIdFromPath(pathname: string) {
  const segments = pathname.split("/");
  const draftId = segments[segments.length - 1];
  if (!draftId) {
    throw new Error(`Expected thread path, received "${pathname}".`);
  }
  return DraftId.make(draftId);
}

function draftThreadIdFor(draftId: ReturnType<typeof draftIdFromPath>): ThreadId {
  const draftSession = useComposerDraftStore.getState().getDraftSession(draftId);
  if (!draftSession) {
    throw new Error(`Expected draft session for "${draftId}".`);
  }
  return draftSession.threadId;
}

function serverThreadPath(threadId: ThreadId): string {
  return `/${LOCAL_ENVIRONMENT_ID}/${threadId}`;
}

async function waitForAppBootstrap(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(getServerConfig()).not.toBeNull();
      expect(selectBootstrapCompleteForActiveEnvironment(useStore.getState())).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function materializePromotedDraftThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  await waitForWsClient();
  fixture.snapshot = addThreadToSnapshot(fixture.snapshot, threadId);
  fixture.snapshot = updateThreadSessionInSnapshot(fixture.snapshot, threadId, null);
  sendShellThreadUpsert(threadId, { session: null });
}

async function startPromotedServerThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  const snapshotWithSession = updateThreadSessionInSnapshot(fixture.snapshot, threadId, {
    threadId,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: `turn-${threadId}` as TurnId,
    lastError: null,
    updatedAt: NOW_ISO,
  });
  fixture.snapshot = {
    ...snapshotWithSession,
    threads: snapshotWithSession.threads.map((thread) => {
      if (thread.id !== threadId) {
        return thread;
      }
      return Object.assign({}, thread, {
        latestTurn: {
          turnId: `turn-${threadId}` as TurnId,
          state: "running",
          requestedAt: NOW_ISO,
          startedAt: NOW_ISO,
          completedAt: null,
          assistantMessageId: null,
        },
      });
    }),
  };
  sendShellThreadUpsert(threadId);
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function createProjectlessSnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-projectless-target" as MessageId,
    targetText: "projectless",
  });
  return {
    ...snapshot,
    projects: [],
    threads: [],
  };
}

function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

function setDraftThreadWithoutWorktree(): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {
      [THREAD_KEY]: {
        threadId: THREAD_ID,
        environmentId: LOCAL_ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        logicalProjectKey: PROJECT_DRAFT_KEY,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
      },
    },
    logicalProjectDraftThreadKeyByLogicalProjectKey: {
      [PROJECT_DRAFT_KEY]: THREAD_KEY,
    },
  });
}

function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createSnapshotWithSecondaryProject(options?: {
  includeSecondaryThread?: boolean;
  includeArchivedSecondaryThread?: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-secondary-project-target" as MessageId,
    targetText: "secondary project",
  });
  const includeSecondaryThread = options?.includeSecondaryThread ?? true;
  const includeArchivedSecondaryThread = options?.includeArchivedSecondaryThread ?? true;
  const secondaryThreads: OrchestrationReadModel["threads"] = includeSecondaryThread
    ? [
        {
          id: "thread-secondary-project" as ThreadId,
          projectId: SECOND_PROJECT_ID,
          title: "Release checklist",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "release/docs-portal",
          worktreePath: null,
          latestTurn: null,
          createdAt: isoAt(30),
          updatedAt: isoAt(31),
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: {
            threadId: "thread-secondary-project" as ThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: isoAt(31),
          },
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
        },
      ]
    : [];
  const archivedSecondaryThreads: OrchestrationReadModel["threads"] = includeArchivedSecondaryThread
    ? [
        {
          id: ARCHIVED_SECONDARY_THREAD_ID,
          projectId: SECOND_PROJECT_ID,
          title: "Archived Docs Notes",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "release/docs-archive",
          worktreePath: null,
          latestTurn: null,
          createdAt: isoAt(24),
          updatedAt: isoAt(25),
          deletedAt: null,
          settledOverride: null,
          settledAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: {
            threadId: ARCHIVED_SECONDARY_THREAD_ID,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: isoAt(25),
          },
          archivedAt: isoAt(26),
        },
      ]
    : [];

  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: SECOND_PROJECT_ID,
        title: "Docs Portal",
        workspaceRoot: "/repo/clients/docs-portal",
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
    threads: [...snapshot.threads, ...secondaryThreads, ...archivedSecondaryThreads],
  };
}

function createSnapshotWithPendingUserInput(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-pending-input-target" as MessageId,
    targetText: "question thread",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            interactionMode: "plan",
            activities: [
              {
                id: EventId.make("activity-user-input-requested"),
                tone: "info",
                kind: "user-input.requested",
                summary: "User input requested",
                payload: {
                  requestId: "req-browser-user-input",
                  questions: [
                    {
                      id: "scope",
                      header: "Scope",
                      question: "What should this change cover?",
                      options: [
                        {
                          label: "Tight",
                          description: "Touch only the footer layout logic.",
                        },
                        {
                          label: "Broad",
                          description: "Also adjust the related composer controls.",
                        },
                      ],
                    },
                    {
                      id: "risk",
                      header: "Risk",
                      question: "How aggressive should the imaginary plan be?",
                      options: [
                        {
                          label: "Conservative",
                          description: "Favor reliability and low-risk changes.",
                        },
                        {
                          label: "Balanced",
                          description: "Mix quick wins with one structural improvement.",
                        },
                      ],
                    },
                  ],
                },
                turnId: null,
                sequence: 1,
                createdAt: isoAt(1_000),
              },
            ],
            updatedAt: isoAt(1_000),
          })
        : thread,
    ),
  };
}

const APPROVAL_DETAIL_HEAD = "Run command: bun run scripts/deploy.ts --target production";
const APPROVAL_DETAIL_TAIL = "end-of-approval-detail-sentinel";
const LONG_APPROVAL_DETAIL = [
  APPROVAL_DETAIL_HEAD,
  ...Array.from(
    { length: 24 },
    (_, index) =>
      `argument --flag-${index}=value-${index} keeps the request detail long enough to require its own scroll container on phones`,
  ),
  APPROVAL_DETAIL_TAIL,
].join("\n");

function createSnapshotWithPendingApproval(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-pending-approval-target" as MessageId,
    targetText: "approval thread",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            activities: [
              {
                id: EventId.make("activity-approval-requested"),
                tone: "approval",
                kind: "approval.requested",
                summary: "Command approval requested",
                payload: {
                  requestId: "req-browser-approval",
                  requestKind: "command",
                  detail: LONG_APPROVAL_DETAIL,
                },
                turnId: null,
                sequence: 1,
                createdAt: isoAt(1_000),
              },
            ],
            updatedAt: isoAt(1_000),
          })
        : thread,
    ),
  };
}

// `.chat-markdown` allows breaks anywhere, so a table only overflows once the
// per-cell minimum (padding + one character) exceeds the viewport; use enough
// columns that the table cannot fit a 320-430px phone viewport.
const WIDE_TABLE_COLUMN_COUNT = 24;

// A transcript short enough that the timeline never overflows its viewport.
function createShortTranscriptSnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-short-transcript" as MessageId,
    targetText: "short transcript target",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, { messages: thread.messages.slice(0, 2) })
        : thread,
    ),
  };
}

function createSnapshotWithWideMarkdownTable(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-wide-table-target" as MessageId,
    targetText: "wide table thread",
  });
  const headerCells = Array.from(
    { length: WIDE_TABLE_COLUMN_COUNT },
    (_, index) => `metric_column_header_${index}`,
  );
  const valueCells = Array.from(
    { length: WIDE_TABLE_COLUMN_COUNT },
    (_, index) => `value_${index}_0123456789`,
  );
  const tableMarkdown = [
    `| ${headerCells.join(" | ")} |`,
    `| ${headerCells.map(() => "---").join(" | ")} |`,
    `| ${valueCells.join(" | ")} |`,
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            messages: [
              ...thread.messages,
              createAssistantMessage({
                id: "msg-assistant-wide-table" as MessageId,
                text: `Here is a wide table:\n\n${tableMarkdown}`,
                offsetSeconds: 500,
              }),
            ],
          })
        : thread,
    ),
  };
}

// Emulates a touch primary pointer so `pointer-coarse:` styles apply; the
// emulation is always reverted so later tests keep the fine-pointer default.
async function withCoarsePointer(run: () => Promise<void>): Promise<void> {
  await setCoarsePointerEmulation(true);
  try {
    await vi.waitFor(() => {
      expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
    });
    await run();
  } finally {
    try {
      await setCoarsePointerEmulation(false);
      await vi.waitFor(() => {
        expect(window.matchMedia("(pointer: coarse)").matches).toBe(false);
      });
    } catch (revertError) {
      // Surface revert failures without masking an assertion error from run().
      console.error("Failed to revert coarse pointer emulation", revertError);
    }
  }
}

const APPROVAL_ACTION_LABELS = [
  "Cancel turn",
  "Decline",
  "Always allow this session",
  "Approve once",
] as const;

function createSnapshotWithPlanFollowUpPrompt(options?: {
  modelSelection?: { instanceId: ProviderInstanceId; model: string };
  planMarkdown?: string;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-follow-up-target" as MessageId,
    targetText: "plan follow-up thread",
  });
  const modelSelection = options?.modelSelection ?? {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  };
  const planMarkdown =
    options?.planMarkdown ?? "# Follow-up plan\n\n- Keep the composer footer stable on resize.";

  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, defaultModelSelection: modelSelection } : project,
    ),
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            modelSelection,
            interactionMode: "plan",
            latestTurn: {
              turnId: "turn-plan-follow-up" as TurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_010),
              assistantMessageId: null,
            },
            proposedPlans: [
              {
                id: "plan-follow-up-browser-test",
                turnId: "turn-plan-follow-up" as TurnId,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_002),
                updatedAt: isoAt(1_003),
              },
            ],
            session: {
              ...thread.session,
              status: "ready",
              updatedAt: isoAt(1_010),
            },
            updatedAt: isoAt(1_010),
          })
        : thread,
    ),
  };
}

function resolveWsRpc(body: NormalizedWsRpcRequestBody): unknown {
  const customResult = customWsRpcResolver?.(body);
  if (customResult !== undefined) {
    return customResult;
  }
  const tag = body._tag;
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.serverDiscoverSourceControl) {
    return {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          executable: "gh",
          status: "available",
          version: Option.some("gh version 2.0.0"),
          installHint: "Install GitHub CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("openai"),
            host: Option.some("github.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "gitlab",
          label: "GitLab",
          executable: "glab",
          status: "available",
          version: Option.some("glab version 1.0.0"),
          installHint: "Install GitLab CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("openai"),
            host: Option.some("gitlab.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "bitbucket",
          label: "Bitbucket",
          executable: "Bitbucket REST API",
          status: "available",
          version: Option.none(),
          installHint: "Set Bitbucket API token environment variables.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("openai"),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          },
        },
        {
          kind: "azure-devops",
          label: "Azure DevOps",
          executable: "az",
          status: "available",
          version: Option.some("azure-cli 2.0.0"),
          installHint: "Install Azure CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("openai"),
            host: Option.some("dev.azure.com"),
            detail: Option.none(),
          },
        },
      ],
    };
  }
  if (tag === WS_METHODS.vcsListRefs) {
    return {
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 1,
      refs: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.sourceControlListChangeRequests) {
    return [];
  }
  if (tag === WS_METHODS.shellOpenInEditor) {
    return null;
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      worktreePath:
        typeof body.worktreePath === "string"
          ? body.worktreePath
          : body.worktreePath === null
            ? null
            : null,
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
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
  http.get("*/attachments/:attachmentId", () =>
    HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    }),
  ),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function waitForWsRequestsToSettle(): Promise<void> {
  let previousCount = -1;
  let stableChecks = 0;
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    if (wsRequests.length === previousCount) {
      stableChecks += 1;
      if (stableChecks >= 3) return;
    } else {
      previousCount = wsRequests.length;
      stableChecks = 0;
    }
  }
  throw new Error("WebSocket requests did not settle before the sidebar mode assertion.");
}

function findScrollToBottomButton(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Scroll to bottom"),
    ) ?? null
  );
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node) {
    // Note: `overflow-x-hidden` alone makes overflow-y compute to auto, so a
    // computed-style check must be paired with actually scrollable content.
    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function clickEnabledButton(button: HTMLButtonElement, errorMessage: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(button.isConnected, errorMessage).toBe(true);
      expect(button.disabled, errorMessage).toBe(false);
    },
    { timeout: 8_000, interval: 16 },
  );
  button.click();
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function pressComposerKey(key: string): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const keydownEvent = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  composerEditor.dispatchEvent(keydownEvent);
  if (keydownEvent.defaultPrevented) {
    await waitForLayout();
    return;
  }

  const beforeInputEvent = new InputEvent("beforeinput", {
    data: key,
    inputType: "insertText",
    bubbles: true,
    cancelable: true,
  });
  composerEditor.dispatchEvent(beforeInputEvent);
  if (beforeInputEvent.defaultPrevented) {
    await waitForLayout();
    return;
  }

  if (
    typeof document.execCommand === "function" &&
    document.execCommand("insertText", false, key)
  ) {
    await waitForLayout();
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    throw new Error("Unable to resolve composer selection for text input.");
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(key);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  composerEditor.dispatchEvent(
    new InputEvent("input", {
      data: key,
      inputType: "insertText",
      bubbles: true,
    }),
  );
  await waitForLayout();
}

async function pressComposerUndo(): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  const useMetaForMod = isMacPlatform(navigator.platform);
  composerEditor.focus();
  composerEditor.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitForLayout();
}

async function waitForComposerText(expectedText: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
        expectedText,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function setComposerSelectionByTextOffsets(options: {
  start: number;
  end: number;
  direction?: "forward" | "backward";
}): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const resolvePoint = (targetOffset: number) => {
    const traversedRef = { value: 0 };

    const visitNode = (node: Node): { node: Node; offset: number } | null => {
      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = node.textContent?.length ?? 0;
        if (targetOffset <= traversedRef.value + textLength) {
          return {
            node,
            offset: Math.max(0, Math.min(targetOffset - traversedRef.value, textLength)),
          };
        }
        traversedRef.value += textLength;
        return null;
      }

      if (node instanceof HTMLBRElement) {
        const parent = node.parentNode;
        if (!parent) {
          return null;
        }
        const siblingIndex = Array.prototype.indexOf.call(parent.childNodes, node);
        if (targetOffset <= traversedRef.value) {
          return { node: parent, offset: siblingIndex };
        }
        if (targetOffset <= traversedRef.value + 1) {
          return { node: parent, offset: siblingIndex + 1 };
        }
        traversedRef.value += 1;
        return null;
      }

      if (node instanceof Element || node instanceof DocumentFragment) {
        for (const child of node.childNodes) {
          const point = visitNode(child);
          if (point) {
            return point;
          }
        }
      }

      return null;
    };

    return (
      visitNode(composerEditor) ?? {
        node: composerEditor,
        offset: composerEditor.childNodes.length,
      }
    );
  };

  const startPoint = resolvePoint(options.start);
  const endPoint = resolvePoint(options.end);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Unable to resolve window selection.");
  }
  selection.removeAllRanges();

  if (options.direction === "backward" && "setBaseAndExtent" in selection) {
    selection.setBaseAndExtent(endPoint.node, endPoint.offset, startPoint.node, startPoint.offset);
    await waitForLayout();
    return;
  }

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.addRange(range);
  await waitForLayout();
}

async function selectAllComposerContent(): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Unable to resolve window selection.");
  }
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(composerEditor);
  selection.addRange(range);
  await waitForLayout();
}

async function waitForComposerMenuItem(itemId: string): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>(`[data-composer-item-id="${itemId}"]`),
    `Unable to find composer menu item "${itemId}".`,
  );
}
async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function composerEditorHasFocus(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement
    ? active.closest('[data-testid="composer-editor"]') !== null
    : false;
}

async function expandPhoneComposerIfCollapsed(): Promise<void> {
  // Exactly one activation. The collapsed composer is the real editor, so a
  // single tap must both expand it and leave it holding focus; a retry loop
  // here would tolerate an N-tap regression by construction.
  await waitForElement(
    () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
    "Unable to find the composer editor.",
  );
  if (!composerEditorHasFocus()) {
    await page.getByTestId("composer-editor").click();
  }
  await vi.waitFor(() => {
    expect(composerEditorHasFocus()).toBe(true);
    expect(document.querySelector('[data-chat-composer-mobile-collapsed="true"]')).toBeNull();
  });
  await waitForLayout();
}

function findComposerProviderModelPicker(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]');
}

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  ) ?? null) as HTMLButtonElement | null;
}

async function waitForButtonByText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(() => findButtonByText(text), `Unable to find "${text}" button.`);
}

function findButtonContainingText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

async function waitForButtonContainingText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () => findButtonContainingText(text),
    `Unable to find button containing "${text}".`,
  );
}

async function waitForSelectItemContainingText(text: string): Promise<HTMLElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')).find((item) =>
        item.textContent?.includes(text),
      ) ?? null,
    `Unable to find select item containing "${text}".`,
  );
}

async function expectComposerActionsContained(): Promise<void> {
  const footer = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
    "Unable to find composer footer.",
  );
  const actions = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-actions="right"]'),
    "Unable to find composer actions container.",
  );

  await vi.waitFor(
    () => {
      const footerRect = footer.getBoundingClientRect();
      const actionButtons = Array.from(actions.querySelectorAll<HTMLButtonElement>("button"));
      expect(actionButtons.length).toBeGreaterThanOrEqual(1);

      const buttonRects = actionButtons.map((button) => button.getBoundingClientRect());
      const firstTop = buttonRects[0]?.top ?? 0;

      for (const rect of buttonRects) {
        expect(rect.right).toBeLessThanOrEqual(footerRect.right + 0.5);
        expect(rect.bottom).toBeLessThanOrEqual(footerRect.bottom + 0.5);
        expect(Math.abs(rect.top - firstTop)).toBeLessThanOrEqual(1.5);
      }
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForInteractionModeButton(
  expectedLabel: "Build" | "Plan",
): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === expectedLabel,
      ) as HTMLButtonElement | null,
    `Unable to find ${expectedLabel} interaction mode button.`,
  );
}

async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig)).toBe(
        true,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

async function waitForComposerStashBinding(key: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getAppKeybindings().some(
          (binding) => binding.command === "composer.stash" && binding.shortcut.key === key,
        ),
      ).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForElement(
    () => document.querySelector('[data-chat-composer-form="true"]'),
    "Unable to find the active composer for the stash shortcut.",
  );
  await waitForLayout();
}

function dispatchChatNewShortcut(): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "o",
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchChatNewLocalShortcut(): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "n",
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchComposerStashShortcut(
  overrides: Partial<KeyboardEventInit> = {},
  target: EventTarget = document.activeElement ?? window,
): KeyboardEvent {
  const useMetaForMod = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "s",
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchThreadPinToggleShortcut(): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "p",
      altKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function releaseModShortcut(key?: string): void {
  window.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: key ?? (isMacPlatform(navigator.platform) ? "Meta" : "Control"),
      metaKey: false,
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchChatNewShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

async function triggerChatNewLocalShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchChatNewLocalShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

function enableChatNewShortcut(nextFixture: TestFixture): void {
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    keybindings: [CHAT_NEW_KEYBINDING],
  };
}

function enableChatNewLocalShortcut(nextFixture: TestFixture): void {
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    keybindings: [CHAT_NEW_LOCAL_KEYBINDING],
  };
}

function enableComposerStashShortcut(nextFixture: TestFixture): void {
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    keybindings: [COMPOSER_STASH_KEYBINDING],
  };
}

function configureContextHandoffProviders(nextFixture: TestFixture): void {
  const codex = nextFixture.serverConfig.providers[0];
  if (!codex) throw new Error("Expected the default Codex provider fixture.");
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    providers: [
      {
        ...codex,
        continuation: { groupKey: "codex:default" },
        supportsAskMode: true,
        models: [
          {
            slug: "gpt-5",
            name: "GPT-5",
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
          {
            slug: "gpt-5.1",
            name: "GPT-5.1",
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
        ],
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        instanceId: ProviderInstanceId.make("claudeAgent"),
        displayName: "Claude",
        continuation: { groupKey: "claude:default" },
        supportsAskMode: false,
        enabled: true,
        installed: true,
        version: "2.1.117",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: NOW_ISO,
        models: [
          {
            slug: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            shortName: "Sonnet 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
  };
}

async function openCommandPaletteFromTrigger(): Promise<void> {
  const trigger = page.getByTestId("command-palette-trigger");
  await expect.element(trigger).toBeInTheDocument();
  await trigger.click();
  await waitForElement(
    () => document.querySelector('[data-testid="command-palette"]'),
    "Command palette should have opened from the sidebar trigger.",
  );
}

async function openNewWorkspaceDialog(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  // The action only takes pointer events while its project header is hovered,
  // so reach it the way a pointer user does.
  const projectHeader = newThreadButton.element().closest<HTMLElement>(".group\\/project-header");
  await page.elementLocator(projectHeader!).hover();
  await newThreadButton.click();
  await expect.element(page.getByText("New worktree", { exact: true })).toBeInTheDocument();
}

async function expectVisibleComboboxPopupToBeOpaqueAndClipped(): Promise<void> {
  const popup = await waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-popup"]')).find(
        (element) => element.getBoundingClientRect().width > 0,
      ) ?? null,
    "Unable to find the visible combobox popup.",
  );
  const popupShell = popup.parentElement as HTMLElement | null;

  expect(popupShell).toBeTruthy();
  if (!popupShell) {
    throw new Error("Unable to find the combobox popup shell.");
  }

  const popupShellStyles = window.getComputedStyle(popupShell);
  const popupStyles = window.getComputedStyle(popup);

  // Opacity is the shell's job alone. `combobox.tsx` deliberately leaves the
  // inner popup transparent so the two do not both paint a glass layer (see
  // "kill glass-on-glass"), so asserting a background on the popup would pin
  // the exact bug that change removed. What the user can observe — that the
  // list is not see-through — is the shell's background plus its clipping.
  expect(popupShellStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(popupShellStyles.overflow).toBe("hidden");
  expect(popupStyles.backgroundColor).toBe("rgba(0, 0, 0, 0)");

  const popupShellRect = popupShell.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();

  expect(popupRect.left).toBeGreaterThanOrEqual(popupShellRect.left - 1);
  expect(popupRect.right).toBeLessThanOrEqual(popupShellRect.right + 1);
}

async function createDraftFromChatNewLocalShortcut(
  mounted: Pick<MountedChatView, "router">,
): Promise<string> {
  await waitForServerConfigToApply();
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  await waitForLayout();
  return triggerChatNewLocalShortcutUntilPath(
    mounted.router,
    (path) => UUID_ROUTE_RE.test(path),
    "Route should have changed to a new draft thread UUID.",
  );
}

async function createDraftFromChatNewShortcut(
  mounted: Pick<MountedChatView, "router">,
): Promise<string> {
  await waitForServerConfigToApply();
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  await waitForLayout();
  return triggerChatNewShortcutUntilPath(
    mounted.router,
    (path) => UUID_ROUTE_RE.test(path),
    "Route should have changed to a new draft thread UUID from the shortcut.",
  );
}

async function waitForCommandPaletteShortcutLabel(): Promise<void> {
  await waitForElement(
    () => document.querySelector('[data-testid="command-palette-trigger"] kbd'),
    "Command palette shortcut label did not render.",
  );
}

async function waitForCommandPaletteInput(placeholder: string): Promise<HTMLInputElement> {
  return waitForElement(
    () => document.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null,
    `Command palette input with placeholder "${placeholder}" did not render.`,
  );
}

function getCommandPaletteLegendEntries(): string[] {
  const footer = document.querySelector('[data-slot="command-footer"]');
  if (!footer) {
    return [];
  }

  return Array.from(footer.querySelectorAll('[data-slot="kbd-group"]'))
    .map((group) =>
      Array.from(group.children)
        .map((child) => child.textContent?.trim() ?? "")
        .filter((value) => value.length > 0)
        .join(" "),
    )
    .filter((value) => value.length > 0);
}

async function dispatchInputKey(
  input: HTMLInputElement,
  init: Pick<KeyboardEventInit, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): Promise<void> {
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  await waitForLayout();
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  resolveRpc?: (body: NormalizedWsRpcRequestBody) => unknown | undefined;
  initialPath?: string;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  // Fixture shortcuts seed local app preferences explicitly; server data has no GUI authority.
  if (fixture.serverConfig.keybindings.length > 0) {
    await replaceAppKeybindings(
      fixture.serverConfig.keybindings.map((rule) => ({
        key: serializeShortcut(rule.shortcut),
        command: rule.command,
        when: serializeWhenAst(rule.whenAst),
      })),
    );
  } else {
    await resetAppKeybindings();
  }
  customWsRpcResolver = options.resolveRpc ?? null;
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [options.initialPath ?? `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`],
    }),
  );

  const screen = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
    {
      container: host,
    },
  );

  await waitForWsClient();
  await waitForAppBootstrap();
  await waitForLayout();

  const cleanup = async () => {
    customWsRpcResolver = null;
    await screen.unmount();
    host.remove();
    await waitForLayout();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    // Resizes the mount host only. Media queries still report the real
    // viewport, so a layout that reflows via `sm:`/`not-phone:` variants will
    // NOT respond to this — it just gets squeezed and overflows. Use it to
    // test container-driven layout; reach for `setViewport` whenever the
    // assertion is about what a window resize does.
    setContainerSize: async (viewport) => {
      host.style.width = `${viewport.width}px`;
      host.style.height = `${viewport.height}px`;
      await waitForLayout();
    },
    router,
  };
}

// --- Phone work-surface fixtures (delivery step 8) ---

const WORK_SURFACE_TURN_ID = "turn-work-surface-1" as TurnId;
// A single 600+ character line: with wrap disabled this must scroll inside
// the diff surface, never at document level.
const WIDE_DIFF_LINE = `export const wide = "${"wide-segment-".repeat(50)}";`;
const WORK_SURFACE_DIFF = [
  "diff --git a/src/wide.ts b/src/wide.ts",
  "index 1111111..2222222 100644",
  "--- a/src/wide.ts",
  "+++ b/src/wide.ts",
  "@@ -1,2 +1,2 @@",
  " export const kept = true;",
  '-export const wide = "old";',
  `+${WIDE_DIFF_LINE}`,
  "",
].join("\n");

function createSnapshotWithWorkSurfaceCheckpoint(options: {
  targetMessageId: MessageId;
  targetText: string;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser(options);
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            checkpoints: [
              {
                turnId: WORK_SURFACE_TURN_ID,
                checkpointTurnCount: 1,
                checkpointRef: "checkpoint-work-surface-1" as CheckpointRef,
                status: "ready" as const,
                files: [
                  {
                    path: "src/wide.ts",
                    kind: "M",
                    additions: 1,
                    deletions: 1,
                  },
                ],
                assistantMessageId: null,
                completedAt: NOW_ISO,
              },
            ],
          })
        : thread,
    ),
  };
}

function resolveWorkSurfaceRpc(body: NormalizedWsRpcRequestBody): unknown | undefined {
  if (
    body._tag === ORCHESTRATION_WS_METHODS.getFullThreadDiff ||
    body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff
  ) {
    return {
      threadId: THREAD_ID,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: WORK_SURFACE_DIFF,
    };
  }
  if (body._tag === WS_METHODS.projectsListEntries) {
    return {
      entries: [
        { path: "README.md", kind: "file" },
        { path: "src", kind: "directory" },
        { path: "src/wide.ts", kind: "file", parentPath: "src" },
      ],
      truncated: false,
    };
  }
  if (body._tag === WS_METHODS.projectsReadFile) {
    return {
      relativePath: typeof body.relativePath === "string" ? body.relativePath : "README.md",
      contents: "# Work surface readme\n",
      version: `sha256:${"0".repeat(64)}`,
      encoding: "utf8",
      lineEnding: "lf",
    };
  }
  return undefined;
}

function queryPhoneSurfacePopup(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot="sheet-popup"][aria-label="${label}"]`);
}

function isElementVisible(element: HTMLElement): boolean {
  return element.checkVisibility?.() ?? element.getBoundingClientRect().width > 0;
}

/** Text lookup across light DOM and any nested shadow roots (@pierre/diffs). */
function surfaceContainsText(root: HTMLElement, text: string): boolean {
  if (root.textContent?.includes(text)) {
    return true;
  }
  return [root, ...root.querySelectorAll<HTMLElement>("*")].some((host) =>
    host.shadowRoot ? (host.shadowRoot.textContent?.includes(text) ?? false) : false,
  );
}

/**
 * Whether a rendered diff file scrolls horizontally inside its own surface.
 * @pierre/diffs renders line content into `diffs-container` shadow roots, so
 * the contained scroller lives inside the shadow DOM rather than on the
 * virtualizer viewport.
 */
function hasContainedHorizontalDiffOverflow(fileElement: HTMLElement): boolean {
  const hostElements = [fileElement, ...fileElement.querySelectorAll<HTMLElement>("*")];
  const candidates: HTMLElement[] = [];
  for (const host of hostElements) {
    candidates.push(host);
    if (host.shadowRoot) {
      candidates.push(...host.shadowRoot.querySelectorAll<HTMLElement>("*"));
    }
  }
  return candidates.some((node) => {
    if (node.scrollWidth <= node.clientWidth + 1) {
      return false;
    }
    const overflowX = getComputedStyle(node).overflowX;
    return overflowX === "auto" || overflowX === "scroll";
  });
}

async function selectTranscriptQuote() {
  const node = await waitForElement<HTMLElement>(
    () => document.querySelector('[data-selection-message-id="msg-assistant-21"]'),
    "Assistant selection target",
  );
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
  await expect.element(page.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
}

function selectionSnapshot() {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "selection-user" as MessageId,
    targetText: "Selection source",
  });
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      messages: thread.messages.slice(-2),
    })),
  };
}

async function expectThreadDockInBottomThird(viewport: ViewportSpec): Promise<void> {
  const dock = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-slot="phone-thread-dock"]'),
    "Unable to find the phone thread dock.",
  );
  await waitForLayout();

  // The column is viewport-wide, so the horizontal assertions below are not
  // vacuous. A content-sized column would make them meaningless.
  const column = dock.closest('[data-slot="sidebar-inset"]') as HTMLElement | null;
  expect(column, "the dock is not inside the route's SidebarInset column").not.toBeNull();
  expect(column!.getBoundingClientRect().width).toBeGreaterThanOrEqual(viewport.width - 0.5);

  const controls = [
    ...dock.querySelectorAll<HTMLElement>(
      'button[aria-label], [data-slot="mobile-context-strip-pill"]',
    ),
  ];
  for (const label of ["Toggle workspace panel", "Thread actions"]) {
    expect(
      controls.some((control) => control.getAttribute("aria-label") === label),
      `the dock no longer renders "${label}"`,
    ).toBe(true);
  }
  expect(controls.length).toBeGreaterThanOrEqual(3);

  const twoThirds = (viewport.height * 2) / 3;
  for (const control of controls) {
    control.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = control.getBoundingClientRect();
    const name = control.getAttribute("aria-label") ?? control.textContent?.trim();
    const where = `"${name}" at ${viewport.width}x${viewport.height}`;
    expect(rect.top + rect.height / 2, `${where}: centre above the bottom third`).toBeGreaterThan(
      twoThirds,
    );
    expect(rect.width, `${where}: width`).toBeGreaterThanOrEqual(44);
    expect(rect.height, `${where}: height`).toBeGreaterThanOrEqual(44);
    expect(rect.left, `${where}: off-screen left`).toBeGreaterThanOrEqual(-0.5);
    expect(rect.right, `${where}: off-screen right`).toBeLessThanOrEqual(viewport.width + 0.5);
  }

  // The app bar's top-right corner holds none of them, hit-tested over the
  // region rather than derived from the centres above.
  for (let column2 = 0; column2 <= 10; column2 += 1) {
    for (let row = 0; row <= 10; row += 1) {
      const x = viewport.width / 2 + ((viewport.width / 2 - 1) * column2) / 10;
      const y = (((viewport.height / 3) * row) / 10) | 0;
      const hit = document.elementFromPoint(x, y);
      const owner = controls.find((control) => hit !== null && control.contains(hit));
      expect(
        owner === undefined,
        `a dock control answers the top-right corner at (${Math.round(x)}, ${y})`,
      ).toBe(true);
    }
  }

  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
}

/** Register a fresh app/transport lifecycle for each independently sharded suite. */
export function setupChatViewBrowserSuite() {
  beforeAll(async () => {
    // This suite exercises the route after it has rendered, not the loading
    // boundary itself. Warm the lazy route module once so a cold Vite
    // transform cannot consume an interaction test's timeout while the route
    // Suspense fallback is intentionally empty.
    await import("./routeViews/ChatThreadRouteView");
    // Mirrors main.tsx: stamps data-tier on the root element so tier-gated
    // (`phone:`) styles and the tier hook stay live across viewport changes.
    syncDocumentPresentationTier();
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await rpcHarness.disconnect();
    await worker.stop();
  });

  beforeEach(async () => {
    resetPreviewFileSessionsForTests();
    await rpcHarness.reset({
      resolveUnary: resolveWsRpc,
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
          request._tag === ORCHESTRATION_WS_METHODS.subscribeThread ||
          request._tag === ORCHESTRATION_WS_METHODS.subscribeThreadWindow
        ) {
          const thread = fixture.snapshot.threads.find((entry) => entry.id === request.threadId);
          if (!thread) return [];
          return [
            {
              kind: "snapshot",
              snapshot:
                request._tag === ORCHESTRATION_WS_METHODS.subscribeThreadWindow
                  ? toThreadWindowSnapshot(fixture.snapshot.snapshotSequence, thread, {
                      hasOlderMessages: fixture.threadsWithOlderMessages?.has(thread.id) === true,
                    })
                  : {
                      snapshotSequence: fixture.snapshot.snapshotSequence,
                      thread,
                    },
            },
          ];
        }
        return [];
      },
    });
    await __resetLocalApiForTests();
    // Defensive: no earlier test or file may leak touch emulation or a parked
    // hovering pointer into pointer-sensitive assertions.
    await resetPointerEmulation();
    await parkPointer(4, 4);
    await setViewport(DEFAULT_VIEWPORT);
    localStorage.clear();
    useChatPanesStore.setState({ root: null, activeRef: null });
    usePromptStashStore.setState({ entries: [] });
    document.body.innerHTML = "";
    wsRequests.length = 0;
    customWsRpcResolver = null;
    __resetEnvironmentApiOverridesForTests();
    resetGitAtomsForTests();
    resetProjectAtomsForTests();
    // The checkpoint-diff and project-preview caches are module-level; stale
    // entries from a previous mount would otherwise dedupe the fresh fetches
    // the work-surface tests depend on.
    resetCheckpointDiffStateForTests();
    resetProjectPreviewAtomsForTests();
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    clearRightPanelSessionSearch();
    Reflect.deleteProperty(window, "desktopBridge");
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useCommandPaletteStore.setState({
      open: false,
      openIntent: null,
    });
    useInboxFilterStore.setState({ draft: "", environmentId: null, status: "all" });
    useSidebarFoldStore.getState().reset();
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
    useUiStateStore.setState({
      // Existing browser fixtures predate sidebar modes; preserve their
      // Projects-tree baseline and opt into Inbox in the mode-specific cases.
      sidebarMode: "projects",
      alwaysUseBuildMode: true,
      projectExpandedById: {},
      projectOrder: [],
      pinnedThreadKeys: {},
      threadLastVisitedAtById: {},
    });
    useTerminalStateStore.persist.clearStorage();
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
      terminalLaunchContextByThreadKey: {},
      terminalEventEntriesByKey: {},
      nextTerminalEventId: 1,
    });
  });

  afterEach(() => {
    customWsRpcResolver = null;
    document.body.innerHTML = "";
    // Queues, holds and baselines are module-level; the epoch bump also drops
    // completions of any queued send still in flight from this test.
    useMessageQueueStore.getState().reset();
  });
}

export {
  createBaseServerConfig,
  createUserMessage,
  waitForAppBootstrap,
  THREAD_ID,
  THREAD_TITLE,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  REMOTE_ENVIRONMENT_ID,
  THREAD_REF,
  THREAD_KEY,
  UUID_ROUTE_RE,
  PROJECT_DRAFT_KEY,
  PROJECT_LOGICAL_KEY,
  SECOND_PROJECT_LOGICAL_KEY,
  NOW_ISO,
  ADD_PROJECT_SUBMENU_PLACEHOLDER,
  CHAT_NEW_KEYBINDING,
  COMPOSER_STASH_KEYBINDING,
  THREAD_PIN_TOGGLE_KEYBINDING,
  fixture,
  rpcHarness,
  wsRequests,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  COMPACT_FOOTER_VIEWPORT,
  NARROW_PHONE_VIEWPORT,
  PHONE_VIEWPORT,
  PHONE_LANDSCAPE_VIEWPORT,
  NARROW_TABLET_VIEWPORT,
  TABLET_VIEWPORT,
  ROTATED_MID_VIEWPORT,
  isoAt,
  createMockEnvironmentApi,
  createTerminalContext,
  createSourceControlContext,
  createBrowserComposerImage,
  createPromptStashEntry,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  toThreadWindowSnapshot,
  threadRefFor,
  threadKeyFor,
  composerDraftFor,
  draftIdFromPath,
  draftThreadIdFor,
  serverThreadPath,
  materializePromotedDraftThreadViaDomainEvent,
  startPromotedServerThreadViaDomainEvent,
  createDraftOnlySnapshot,
  createProjectlessSnapshot,
  withProjectScripts,
  setDraftThreadWithoutWorktree,
  createSnapshotWithLongProposedPlan,
  createSnapshotWithSecondaryProject,
  createSnapshotWithPendingUserInput,
  APPROVAL_DETAIL_HEAD,
  APPROVAL_DETAIL_TAIL,
  createSnapshotWithPendingApproval,
  createShortTranscriptSnapshot,
  createSnapshotWithWideMarkdownTable,
  withCoarsePointer,
  APPROVAL_ACTION_LABELS,
  createSnapshotWithPlanFollowUpPrompt,
  nextFrame,
  waitForLayout,
  waitForWsRequestsToSettle,
  findScrollToBottomButton,
  findScrollableAncestor,
  setViewport,
  waitForElement,
  clickEnabledButton,
  waitForURL,
  waitForComposerEditor,
  pressComposerKey,
  pressComposerUndo,
  waitForComposerText,
  setComposerSelectionByTextOffsets,
  selectAllComposerContent,
  waitForComposerMenuItem,
  waitForSendButton,
  composerEditorHasFocus,
  expandPhoneComposerIfCollapsed,
  findComposerProviderModelPicker,
  findButtonByText,
  waitForButtonByText,
  waitForButtonContainingText,
  waitForSelectItemContainingText,
  expectComposerActionsContained,
  waitForInteractionModeButton,
  waitForServerConfigToApply,
  waitForComposerStashBinding,
  dispatchChatNewShortcut,
  dispatchComposerStashShortcut,
  dispatchThreadPinToggleShortcut,
  releaseModShortcut,
  triggerChatNewShortcutUntilPath,
  triggerChatNewLocalShortcutUntilPath,
  enableChatNewShortcut,
  enableChatNewLocalShortcut,
  enableComposerStashShortcut,
  configureContextHandoffProviders,
  openCommandPaletteFromTrigger,
  openNewWorkspaceDialog,
  expectVisibleComboboxPopupToBeOpaqueAndClipped,
  createDraftFromChatNewLocalShortcut,
  createDraftFromChatNewShortcut,
  waitForCommandPaletteShortcutLabel,
  waitForCommandPaletteInput,
  getCommandPaletteLegendEntries,
  dispatchInputKey,
  mountChatView,
  createSnapshotWithWorkSurfaceCheckpoint,
  resolveWorkSurfaceRpc,
  queryPhoneSurfacePopup,
  isElementVisible,
  surfaceContainsText,
  hasContainedHorizontalDiffOverflow,
  selectTranscriptQuote,
  selectionSnapshot,
  expectThreadDockInBottomThird,
};
