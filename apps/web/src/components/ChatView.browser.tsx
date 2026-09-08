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
import {
  PROMPT_STASH_STORAGE_KEY,
  stripInlineTerminalContextPlaceholders,
  type PromptStashEntry,
} from "@ryco/client-runtime/state/composer";
import { createModelCapabilities, createModelSelection } from "@ryco/shared/model";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Option } from "effect";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page, userEvent } from "vite-plus/test/browser";
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
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import {
  readPrimaryEnvironmentDescriptor,
  writePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";
import { syncDocumentPresentationTier } from "../lib/presentationTier";
import {
  KEYBOARD_INSET_CSS_VAR,
  VISIBLE_VIEWPORT_HEIGHT_CSS_VAR,
  syncDocumentVisualViewportInsets,
} from "../lib/visualViewportInsets";
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
  cdpSession,
  resetPointerEmulation,
  parkPointer,
  setCoarsePointerEmulation,
} from "../../test/browserPointer";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { installVisualViewportStub } from "../../test/browserVisualViewport";
import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import { toastManager } from "./ui/toast";

import { DEFAULT_CLIENT_SETTINGS } from "@ryco/contracts/settings";

vi.mock("../lib/gitStatusState", () => ({
  useGitStatus: () => ({
    data: null,
    error: null,
    cause: null,
    isPending: false,
  }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

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
      ...DEFAULT_CLIENT_SETTINGS,
    },
  };
}

function createMockEnvironmentApi(input: {
  browse: EnvironmentApi["filesystem"]["browse"];
  dispatchCommand: EnvironmentApi["orchestration"]["dispatchCommand"];
}): EnvironmentApi {
  return {
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
      messages: emptyPage,
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
        getServerConfig()?.keybindings.some(
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

describe("ChatView timeline estimator parity (full app)", () => {
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
                  ? toThreadWindowSnapshot(fixture.snapshot.snapshotSequence, thread)
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
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
    useUiStateStore.setState({
      // Existing browser fixtures predate sidebar modes; preserve their
      // Projects-tree baseline and opt into Inbox in the mode-specific cases.
      sidebarMode: "projects",
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
  });

  it("keeps a cached hosted thread visible while its node reconnects", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-cached-cross-node" as MessageId,
        targetText: "cached cross-node switch target",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();

      // Hosted A -> B disposal keeps thread detail in memory but marks the
      // old environment non-live until its next relay bootstrap.
      useStore.getState().demoteEnvironmentStateToCachedSnapshot(LOCAL_ENVIRONMENT_ID, Date.now());
      await waitForLayout();

      expect(useStore.getState().environmentStateById[LOCAL_ENVIRONMENT_ID]).toMatchObject({
        bootstrapComplete: false,
      });
      expect(composerEditor.isConnected).toBe(true);
      expect(await waitForComposerEditor()).toBe(composerEditor);
    } finally {
      await mounted.cleanup();
    }
  });

  it("stashes globally, preserves contexts/model state, merges on keyboard restore, and deletes from the picker", async () => {
    const terminalContext = createTerminalContext({
      id: "stash-terminal",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "git status",
    });
    const sourceControlContext = createSourceControlContext("stash-source");
    const draftStore = useComposerDraftStore.getState();
    draftStore.setPrompt(THREAD_REF, "Stashed text");
    draftStore.addTerminalContext(THREAD_REF, terminalContext);
    draftStore.addSourceControlContext(THREAD_REF, sourceControlContext);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stash-global" as MessageId,
        targetText: "stash global target",
      }),
      configureFixture: enableComposerStashShortcut,
    });

    try {
      await waitForComposerStashBinding("s");
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      const saveEvent = dispatchComposerStashShortcut({}, composerEditor);
      expect(saveEvent.defaultPrevented).toBe(true);

      let stashedId = "";
      await vi.waitFor(() => {
        const stash = usePromptStashStore.getState().entries;
        expect(stash).toHaveLength(1);
        expect(stash[0]?.prompt).toBe("Stashed text");
        stashedId = stash[0]?.id ?? "";
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(stripInlineTerminalContextPlaceholders(draft?.prompt ?? "")).toBe("");
        expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["stash-terminal"]);
        expect(draft?.sourceControlContexts.map((context) => context.id)).toEqual(["stash-source"]);
      });
      expect(localStorage.getItem(PROMPT_STASH_STORAGE_KEY)).toContain("Stashed text");

      usePromptStashStore.getState().stashEntry(
        createPromptStashEntry({
          id: "newer-picker-entry",
          prompt: "Other stash",
        }),
      );
      const emptyShortcut = dispatchComposerStashShortcut();
      expect(emptyShortcut.defaultPrevented).toBe(true);
      await waitForElement(
        () => document.querySelector('[data-prompt-stash-picker="true"]'),
        "Empty stash shortcut should open the picker.",
      );
      const escapeEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(escapeEvent);
      expect(escapeEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.querySelector('[data-prompt-stash-picker="true"]')).toBeNull();
      });
      dispatchComposerStashShortcut();
      await waitForElement(
        () => document.querySelector('[data-prompt-stash-picker="true"]'),
        "Empty stash shortcut should reopen the picker.",
      );
      const outsidePickerButton = document.createElement("button");
      document.body.append(outsidePickerButton);
      outsidePickerButton.focus();
      const outsidePickerArrow = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      outsidePickerButton.dispatchEvent(outsidePickerArrow);
      expect(outsidePickerArrow.defaultPrevented).toBe(false);
      outsidePickerButton.remove();

      const switchedSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "effort", value: "max" }],
      );
      useComposerDraftStore.getState().setModelSelection(THREAD_REF, switchedSelection);
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_REF, `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}Current text`);
      await waitForLayout();

      const stashPicker = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-prompt-stash-picker="true"]'),
        "Unable to focus the stash picker.",
      );
      stashPicker.focus();
      await userEvent.keyboard("{ArrowUp}{ArrowDown}{ArrowDown}{Enter}");

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(stripInlineTerminalContextPlaceholders(draft?.prompt ?? "")).toBe(
          "Current text\n\nStashed text",
        );
        expect(draft?.modelSelectionByProvider[ProviderInstanceId.make("claudeAgent")]).toEqual(
          switchedSelection,
        );
        expect(draft?.activeProvider).toBe("claudeAgent");
        expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).not.toContain(
          stashedId,
        );
      });

      const mergedPrompt =
        useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "";
      const stashBadge = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-prompt-stash-badge="true"]'),
        "Unable to find stash badge for deletion.",
      );
      stashBadge.click();
      const deleteButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-prompt-stash-delete="newer-picker-entry"]',
          ),
        "Unable to find stash delete button.",
      );
      deleteButton.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries).toEqual([]);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          mergedPrompt,
        );
      });
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[data-prompt-stash-picker="true"]')).toBeNull();
      });

      usePromptStashStore
        .getState()
        .stashEntry(createPromptStashEntry({ id: "keyboard-keep", prompt: "Keep" }));
      usePromptStashStore
        .getState()
        .stashEntry(createPromptStashEntry({ id: "keyboard-delete", prompt: "Delete" }));
      const keyboardDeleteBadge = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-prompt-stash-badge="true"]'),
        "Unable to find stash badge for keyboard deletion.",
      );
      keyboardDeleteBadge.click();
      const keyboardDeletePicker = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-prompt-stash-picker="true"]'),
        "Unable to focus stash picker for keyboard deletion.",
      );
      keyboardDeletePicker.focus();
      const deleteShortcut = new KeyboardEvent("keydown", {
        key: "Backspace",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(deleteShortcut);
      expect(deleteShortcut.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
          "keyboard-keep",
        ]);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          mergedPrompt,
        );
      });

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[data-prompt-stash-picker="true"]')).toBeNull();
      });

      const entriesBeforeIgnoredShortcuts = usePromptStashStore.getState().entries;
      const alreadyHandledShortcut = new KeyboardEvent("keydown", {
        key: "s",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
        bubbles: true,
        cancelable: true,
      });
      alreadyHandledShortcut.preventDefault();
      window.dispatchEvent(alreadyHandledShortcut);
      expect(usePromptStashStore.getState().entries).toBe(entriesBeforeIgnoredShortcuts);

      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      const dialogInput = document.createElement("input");
      dialog.append(dialogInput);
      document.body.append(dialog);
      dialogInput.focus();
      const ignoredInDialog = dispatchComposerStashShortcut({}, dialogInput);
      expect(ignoredInDialog.defaultPrevented).toBe(false);
      expect(usePromptStashStore.getState().entries).toBe(entriesBeforeIgnoredShortcuts);
      dialog.remove();

      const terminalInput = document.createElement("textarea");
      terminalInput.className = "xterm-helper-textarea";
      document.body.append(terminalInput);
      terminalInput.focus();
      const unresolvedInTerminal = dispatchComposerStashShortcut();
      expect(unresolvedInTerminal.defaultPrevented).toBe(false);
      terminalInput.remove();
    } finally {
      await mounted.cleanup();
    }
  });

  it("separates restored text from retained terminal placeholders", async () => {
    const draftStore = useComposerDraftStore.getState();
    draftStore.setPrompt(THREAD_REF, "Separated stash text");
    draftStore.addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "stash-separator-terminal",
        terminalLabel: "Terminal 1",
        lineStart: 3,
        lineEnd: 4,
        text: "git status",
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stash-separator" as MessageId,
        targetText: "stash separator target",
      }),
      configureFixture: enableComposerStashShortcut,
    });

    try {
      await waitForComposerStashBinding("s");
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      dispatchComposerStashShortcut();
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries).toHaveLength(1);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
        );
      });

      dispatchComposerStashShortcut();
      const row = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-prompt-stash-row]"),
        "Unable to find the terminal-separator stash row.",
      );
      row.click();
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}\n\nSeparated stash text`,
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("honors a custom composer stash binding without suppressing the unbound Save shortcut", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "Custom binding prompt");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stash-custom-binding" as MessageId,
        targetText: "stash custom binding target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "composer.stash",
              shortcut: {
                key: "x",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: true,
                modKey: false,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForComposerStashBinding("x");
      expect(dispatchComposerStashShortcut().defaultPrevented).toBe(false);
      expect(usePromptStashStore.getState().entries).toEqual([]);

      const customEvent = new KeyboardEvent("keydown", {
        key: "x",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(customEvent);
      expect(customEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries[0]?.prompt).toBe("Custom binding prompt");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps newer typing during image finalization and enforces restore dedupe and attachment caps", async () => {
    let resolveImageBytes!: (value: ArrayBuffer) => void;
    const delayedImageBytes = new Promise<ArrayBuffer>((resolve) => {
      resolveImageBytes = resolve;
    });
    const delayedImage = createBrowserComposerImage({
      id: "delayed-image",
      name: "delayed.png",
      arrayBuffer: () => delayedImageBytes,
      previewUrl: "blob:delayed-image",
    });
    const draftStore = useComposerDraftStore.getState();
    draftStore.setPrompt(THREAD_REF, "Image prompt");
    draftStore.addImage(THREAD_REF, delayedImage);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stash-images" as MessageId,
        targetText: "stash images target",
      }),
      configureFixture: enableComposerStashShortcut,
    });
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeObjectUrl = vi.fn();
    URL.revokeObjectURL = revokeObjectUrl;

    try {
      await waitForComposerStashBinding("s");
      dispatchComposerStashShortcut();
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries[0]?.pendingImageCount).toBe(1);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.images ?? []).toEqual(
          [],
        );
      });

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Typed while saving");
      resolveImageBytes(new Uint8Array([1, 2, 3]).buffer);
      await vi.waitFor(() => {
        expect(usePromptStashStore.getState().entries[0]?.pendingImageCount).toBe(0);
        expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
          "Typed while saving",
        );
        expect(revokeObjectUrl).toHaveBeenCalledWith("blob:delayed-image");
      });

      const finalizedImageBadge = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-prompt-stash-badge="true"]'),
        "Unable to find finalized image stash badge.",
      );
      finalizedImageBadge.click();
      const delayedRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-prompt-stash-row]"),
        "Unable to find finalized image stash row.",
      );
      delayedRow.click();
      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(draft?.prompt).toBe("Typed while saving\n\nImage prompt");
        expect(draft?.images.map((image) => image.name)).toEqual(["delayed.png"]);
      });

      useComposerDraftStore.getState().clearPromptAndImages(THREAD_REF);
      const currentImages = [
        createBrowserComposerImage({
          id: "current-duplicate",
          name: "duplicate.png",
        }),
        ...Array.from({ length: 6 }, (_, index) =>
          createBrowserComposerImage({
            id: `current-${index}`,
            name: `current-${index}.png`,
            bytes: new Uint8Array([index + 10]),
          }),
        ),
      ];
      useComposerDraftStore.getState().addImages(THREAD_REF, currentImages);
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Current cap text");
      usePromptStashStore.getState().stashEntry(
        createPromptStashEntry({
          id: "cap-entry",
          prompt: "Saved cap text",
          attachments: [
            {
              id: "saved-duplicate",
              name: "duplicate.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,AQID",
            },
            {
              id: "saved-accepted",
              name: "accepted.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,AQID",
            },
            {
              id: "saved-overflow",
              name: "overflow.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,AQID",
            },
          ],
        }),
      );

      const capBadge = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-prompt-stash-badge="true"]'),
        "Unable to find attachment cap stash badge.",
      );
      capBadge.click();
      const capRow = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-prompt-stash-row="cap-entry"]'),
        "Unable to find attachment cap stash row.",
      );
      capRow.click();
      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
        expect(draft?.prompt).toBe("Current cap text\n\nSaved cap text");
        expect(draft?.images).toHaveLength(8);
        expect(draft?.images.map((image) => image.name)).toContain("accepted.png");
        expect(draft?.images.map((image) => image.name)).not.toContain("overflow.png");
        expect(draft?.images.filter((image) => image.name === "duplicate.png")).toHaveLength(1);
      });
    } finally {
      await mounted.cleanup();
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("keeps the mobile run-context control non-interactive when the environment is locked", async () => {
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-locked-workspace" as MessageId,
        targetText: "locked mobile workspace",
      }),
    });

    try {
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
      expect(document.querySelector('button[aria-label="Run on"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shrinks the desktop composer at rest and while reading, then expands without losing the draft", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-compact-composer" as MessageId,
        targetText: "compact composer",
      }),
    });

    try {
      const editor = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );
      const surface = editor.closest<HTMLElement>("[data-chat-composer-compact]")!;
      (document.activeElement as HTMLElement | null)?.blur();
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeCloseTo(26, 0));

      surface.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
      );
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeGreaterThan(60));
      surface.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          pointerType: "mouse",
          relatedTarget: document.body,
        }),
      );
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeCloseTo(26, 0));

      editor.focus();
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeGreaterThan(60));
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep this draft");
      await vi.waitFor(() => expect(editor.textContent).toContain("Keep this draft"));
      const timelineRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-message-id]"),
        "Unable to find a timeline message.",
      );
      const scrollContainer = findScrollableAncestor(timelineRow)!;
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeCloseTo(26, 0));
      expect(document.activeElement).toBe(editor);
      expect(editor.textContent).toContain("Keep this draft");

      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await vi.waitFor(() => expect(editor.getBoundingClientRect().height).toBeGreaterThan(60));
      expect(document.querySelector('[data-testid="composer-editor"]')).toBe(editor);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the active-thread composer on its stable outer width while phones remain full width", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-composer-width" as MessageId,
        targetText: "composer width",
      }),
    });

    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find the composer form.",
      );
      const composerContainer = composerForm.parentElement;
      expect(composerContainer).toBeTruthy();
      await waitForLayout();

      const desktopFormRect = composerForm.getBoundingClientRect();
      const desktopContainerRect = composerContainer!.getBoundingClientRect();
      expect(desktopFormRect.width).toBeCloseTo(52 * 16, 1);
      expect(desktopFormRect.left - desktopContainerRect.left).toBeCloseTo(
        (desktopContainerRect.width - desktopFormRect.width) / 2,
        1,
      );

      await mounted.setViewport(PHONE_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      await waitForLayout();

      const phoneFormRect = composerForm.getBoundingClientRect();
      const phoneContainerRect = composerContainer!.getBoundingClientRect();
      expect(phoneFormRect.width / phoneContainerRect.width).toBeCloseTo(1, 2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new-thread composer on the same stable content width", async () => {
    const draftId = DraftId.make("draft-composer-timeline-width");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
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
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const newThreadMounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-hero"]'),
        "Unable to find the new-thread hero.",
      );
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find the new-thread composer form.",
      );
      const composerContainer = composerForm.parentElement;
      expect(composerContainer).toBeTruthy();
      await waitForLayout();

      const formRect = composerForm.getBoundingClientRect();
      const containerRect = composerContainer!.getBoundingClientRect();
      expect(formRect.width).toBeCloseTo(52 * 16, 1);
      expect(formRect.left - containerRect.left).toBeCloseTo(
        (containerRect.width - formRect.width) / 2,
        1,
      );
    } finally {
      await newThreadMounted.cleanup();
    }
  });

  it("contains the active chat and composer at 320 CSS pixels", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-narrow-mobile" as MessageId,
        targetText: "narrow mobile workspace",
      }),
    });

    try {
      const composer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the mobile composer.",
      );
      await waitForLayout();
      const rect = composer.getBoundingClientRect();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
      expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps dismiss-only composer banners aligned on mobile", async () => {
    const mounted = await mountChatView({
      viewport: COMPACT_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-mobile-version-banner" as MessageId,
        targetText: "mobile version banner",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          environment: {
            ...nextFixture.serverConfig.environment,
            serverVersion: "9.9.9",
          },
        };
      },
    });

    try {
      const banner = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="alert"]')).find(
            (element) => element.textContent?.includes("Client and server versions differ"),
          ) ?? null,
        "Unable to find version mismatch banner.",
      );
      const title = banner.querySelector<HTMLElement>('[data-slot="alert-title"]');
      const description = banner.querySelector<HTMLElement>('[data-slot="alert-description"]');
      const dismissButton = banner.querySelector<HTMLButtonElement>(
        'button[aria-label="Dismiss version mismatch warning"]',
      );

      expect(title).toBeTruthy();
      expect(description).toBeTruthy();
      expect(dismissButton).toBeTruthy();
      expect(dismissButton!.getBoundingClientRect().top).toBeLessThan(
        description!.getBoundingClientRect().top,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("re-expands the bootstrap project using its logical key", async () => {
    useUiStateStore.setState({
      projectExpandedById: {
        [PROJECT_LOGICAL_KEY]: false,
      },
      projectOrder: [PROJECT_LOGICAL_KEY],
      threadLastVisitedAtById: {},
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap-project-expand" as MessageId,
        targetText: "bootstrap project expand",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(useUiStateStore.getState().projectExpandedById[PROJECT_LOGICAL_KEY]).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the sidebar project available when the snapshot has no server threads", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      await expect.element(page.getByText("Project", { exact: true })).toBeInTheDocument();
      expect(document.querySelector('[data-testid="thread-row-thread-browser-test"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves Inbox filters across sidebar mode changes without workspace churn", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-modes" as MessageId,
        targetText: "sidebar modes",
      }),
    });

    try {
      const projectTrigger = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-add-project-trigger"]',
      );
      expect(projectTrigger?.checkVisibility()).toBe(true);
      expect(
        document.querySelector<HTMLElement>('[data-testid="inbox-sidebar"]')?.checkVisibility(),
      ).toBe(false);
      await waitForWsRequestsToSettle();
      const stableRequestTags = [
        ORCHESTRATION_WS_METHODS.subscribeShell,
        WS_METHODS.subscribeServerConfig,
        WS_METHODS.subscribeServerLifecycle,
        WS_METHODS.serverGetConfig,
        WS_METHODS.serverGetSettings,
      ];
      const countStableRequests = () =>
        stableRequestTags.map((tag) => wsRequests.filter((request) => request._tag === tag).length);
      const stableRequestCountsBeforeSwitch = countStableRequests();

      const showInboxButton = page.getByRole("button", { name: "Show Inbox sidebar" });
      await expect.element(showInboxButton).toHaveAttribute("aria-pressed", "false");
      await showInboxButton.click();

      await expect.element(page.getByTestId("inbox-sidebar")).toBeInTheDocument();
      expect(projectTrigger?.checkVisibility()).toBe(false);
      await page.getByRole("searchbox", { name: "Search inbox" }).fill("preserved search");
      expect(useUiStateStore.getState().sidebarMode).toBe("inbox");

      const showProjectsButton = page.getByRole("button", { name: "Show Projects sidebar" });
      await expect.element(showProjectsButton).toHaveAttribute("aria-pressed", "true");
      await showProjectsButton.click();
      expect(useUiStateStore.getState().sidebarMode).toBe("projects");
      expect(
        document.querySelector<HTMLElement>('[data-testid="inbox-sidebar"]')?.checkVisibility(),
      ).toBe(false);
      expect(
        document
          .querySelector<HTMLElement>('[data-testid="sidebar-add-project-trigger"]')
          ?.checkVisibility(),
      ).toBe(true);
      await waitForWsRequestsToSettle();
      await showInboxButton.click();
      await expect
        .element(page.getByRole("searchbox", { name: "Search inbox" }))
        .toHaveValue("preserved search");
      expect(countStableRequests()).toEqual(stableRequestCountsBeforeSwitch);
    } finally {
      await mounted.cleanup();
    }
  });

  it("pins and renames a thread from the Inbox action menu", async () => {
    useUiStateStore.setState({ sidebarMode: "inbox" });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-inbox-actions" as MessageId,
        targetText: "inbox actions",
      }),
    });
    try {
      const row = page.getByTestId("inbox-thread-row").first();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Pin thread", exact: true }).click();
      await vi.waitFor(() =>
        expect(
          useUiStateStore.getState().pinnedThreadKeys[
            scopedThreadKey(scopeThreadRef(LOCAL_ENVIRONMENT_ID, THREAD_ID))
          ],
        ).toBe(true),
      );
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="context-menu-popup"]')).toBeNull(),
      );
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename thread", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Thread title", exact: true })
        .fill("Renamed inbox thread");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await vi.waitFor(() =>
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              JSON.stringify(request).includes("Renamed inbox thread"),
          ),
        ).toBe(true),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens an Inbox row through its exact scoped route", async () => {
    useUiStateStore.setState({ sidebarMode: "inbox" });
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-inbox-navigation" as MessageId,
      targetText: "inbox navigation",
    });
    const sourceThread = snapshot.threads[0]!;
    const inboxThreadId = "thread-inbox-target" as ThreadId;
    const inboxSiblingThreadId = "thread-inbox-sibling" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: [
          sourceThread,
          {
            ...sourceThread,
            id: inboxThreadId,
            title: "Inbox exact target",
            createdAt: "2026-08-23T09:00:00.000Z",
            updatedAt: "2026-08-23T11:00:00.000Z",
          },
          {
            ...sourceThread,
            id: inboxSiblingThreadId,
            title: "Inbox motion sibling",
            createdAt: "2026-08-23T08:00:00.000Z",
            updatedAt: "2026-08-23T10:00:00.000Z",
          },
        ],
      },
    });

    try {
      const rows = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="inbox-thread-row"]'),
      );
      const rowIndex = rows.findIndex((candidate) =>
        candidate.textContent?.includes("Inbox exact target"),
      );
      const row = rows[rowIndex];
      const rowLocator = page.getByTestId("inbox-thread-row").nth(rowIndex);
      const siblingRow = rows.find((candidate) =>
        candidate.textContent?.includes("Inbox motion sibling"),
      );
      expect(row).toBeDefined();
      expect(siblingRow).toBeDefined();
      expect(row?.textContent).toContain("This device");
      expect(row?.textContent).toContain("Project");
      expect(row?.textContent).toContain("main");
      expect(row?.textContent).toContain("Idle");
      expect(row?.className).toContain("hover:-translate-y-px");
      expect(row?.className).toContain("motion-reduce:translate-none");
      expect(row?.className).toContain("group/row");

      expect(row?.querySelector('[class*="group-hover/row:opacity-100"]')).toBeNull();
      expect(siblingRow?.querySelector('[class*="group-hover/row:opacity-100"]')).toBeNull();

      // Tailwind v4 guards hover utilities with `(hover: hover)`. Linux
      // headless Chromium can still report no hover device even though
      // Playwright can dispatch a mouse; exercise the motion only when the
      // same media query that guards the production CSS is active.
      if (
        window.matchMedia("(hover: hover)").matches &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        const restingTranslate = getComputedStyle(row!).translate;
        await rowLocator.hover();
        await vi.waitFor(() => {
          expect(getComputedStyle(row!).translate).not.toBe(restingTranslate);
        });
      }

      await rowLocator.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(
          `/${LOCAL_ENVIRONMENT_ID}/${inboxThreadId}`,
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd for draft threads without a worktree path", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not leak a server worktree path into drawer runtime env when launch context clears it", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-launch-context-target" as MessageId,
      targetText: "launch context worktree override",
    });
    const targetThread = snapshot.threads.find((thread) => thread.id === THREAD_ID);
    if (targetThread) {
      Object.assign(targetThread, {
        branch: "feature/branch",
        worktreePath: "/repo/worktrees/feature-branch",
      });
    }

    useTerminalStateStore.setState({
      terminalStateByThreadKey: {
        [THREAD_KEY]: {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
      },
      terminalLaunchContextByThreadKey: {
        [THREAD_KEY]: {
          cwd: "/repo/project",
          worktreePath: null,
        },
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          ) as
            | {
                _tag: string;
                cwd?: string;
                worktreePath?: string | null;
                env?: Record<string, string>;
              }
            | undefined;
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            cwd: "/repo/project",
            worktreePath: null,
            env: {
              RYCO_PROJECT_ROOT: "/repo/project",
            },
          });
          expect(openRequest?.env?.RYCO_WORKTREE_PATH).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with VS Code Insiders when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with Trae when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["trae"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "trae",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows Kiro in the open picker menu and opens the project cwd with it", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["kiro"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const menuButton = await waitForElement(
        () => document.querySelector('button[aria-label="Copy options"]'),
        "Unable to find Open picker button.",
      );
      (menuButton as HTMLButtonElement).click();

      const kiroItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Kiro"),
          ) ?? null,
        "Unable to find Kiro menu item.",
      );
      (kiroItem as HTMLElement).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "kiro",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters expanded app options and keeps Terminal from replacing the favorite editor", async () => {
    localStorage.setItem("ryco:last-editor", JSON.stringify("vscode"));
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode", "windsurf", "xcode", "android-studio", "terminal"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const menuButton = await waitForElement(
        () => document.querySelector('button[aria-label="Copy options"]'),
        "Unable to find Open picker button.",
      );
      (menuButton as HTMLButtonElement).click();

      const androidStudioItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Android Studio"),
          ) ?? null,
        "Unable to find Android Studio menu item.",
      );
      expect(androidStudioItem.querySelector("svg image")).not.toBeNull();

      const windsurfItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Windsurf"),
          ) ?? null,
        "Unable to find Windsurf menu item.",
      );
      expect(windsurfItem.querySelector("svg image")).not.toBeNull();

      const xcodeItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Xcode"),
          ) ?? null,
        "Unable to find Xcode menu item.",
      );
      expect(xcodeItem.querySelector("svg image")).not.toBeNull();
      expect(
        Array.from(document.querySelectorAll('[data-slot="menu-item"]')).some((item) =>
          item.textContent?.includes("Positron"),
        ),
      ).toBe(false);

      (androidStudioItem as HTMLElement).click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.shellOpenInEditor &&
                request.editor === "android-studio",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      (menuButton as HTMLButtonElement).click();
      const reopenedWindsurfItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Windsurf"),
          ) ?? null,
        "Unable to find Windsurf menu item after reopening the picker.",
      );
      (reopenedWindsurfItem as HTMLElement).click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.shellOpenInEditor && request.editor === "windsurf",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      (menuButton as HTMLButtonElement).click();

      const terminalItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Terminal"),
          ) ?? null,
        "Unable to find Terminal menu item.",
      );
      expect(terminalItem.querySelector("svg")).not.toBeNull();
      (terminalItem as HTMLElement).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.shellOpenInEditor && request.editor === "terminal",
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "terminal",
          });
          expect(localStorage.getItem("ryco:last-editor")).toBe(JSON.stringify("windsurf"));
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters the open picker menu and opens VSCodium from the menu", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders", "vscodium"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const menuButton = await waitForElement(
        () => document.querySelector('button[aria-label="Copy options"]'),
        "Unable to find Open picker button.",
      );
      (menuButton as HTMLButtonElement).click();

      await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VS Code Insiders"),
          ) ?? null,
        "Unable to find VS Code Insiders menu item.",
      );

      expect(
        Array.from(document.querySelectorAll('[data-slot="menu-item"]')).some((item) =>
          item.textContent?.includes("Zed"),
        ),
      ).toBe(false);

      const vscodiumItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VSCodium"),
          ) ?? null,
        "Unable to find VSCodium menu item.",
      );
      (vscodiumItem as HTMLElement).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscodium",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the first installed editor when the stored favorite is unavailable", async () => {
    localStorage.setItem("ryco:last-editor", JSON.stringify("vscodium"));
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from local draft threads at the project cwd", async () => {
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

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Lint",
          ) as HTMLButtonElement | null,
        "Unable to find Run Lint button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/project",
            env: {
              RYCO_PROJECT_ROOT: "/repo/project",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const writeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalWrite,
          );
          expect(writeRequest).toMatchObject({
            _tag: WS_METHODS.terminalWrite,
            threadId: THREAD_ID,
            data: "bun run lint\r",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from worktree draft threads at the worktree cwd", async () => {
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
          branch: "feature/draft",
          worktreePath: "/repo/worktrees/feature-draft",
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Test",
          ) as HTMLButtonElement | null,
        "Unable to find Run Test button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/worktrees/feature-draft",
            env: {
              RYCO_PROJECT_ROOT: "/repo/project",
              RYCO_WORKTREE_PATH: "/repo/worktrees/feature-draft",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets the server own setup after preparing a pull request worktree thread", async () => {
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

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitResolvePullRequest) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/sak0a/ryco/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
          };
        }
        if (body._tag === WS_METHODS.gitPreparePullRequestThread) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/sak0a/ryco/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
            branch: "archive-settings-overhaul",
            worktreePath: "/repo/worktrees/pr-1359",
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "main",
          ) as HTMLButtonElement | null,
        "Unable to find branch selector button.",
      );
      await clickEnabledButton(branchButton, "Branch selector did not become actionable.");

      const branchInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to find ref search input.",
      );
      branchInput.focus();
      await page.getByPlaceholder("Search refs...").fill("1359");

      const checkoutItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "Checkout pull request",
          ) as HTMLSpanElement | null,
        "Unable to find checkout pull request option.",
      );
      checkoutItem.click();

      const worktreeButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Worktree",
          ) as HTMLButtonElement | null,
        "Unable to find Worktree button.",
      );
      await clickEnabledButton(
        worktreeButton,
        "Worktree preparation did not become actionable after resolving the pull request.",
      );

      await vi.waitFor(
        () => {
          const prepareRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitPreparePullRequestThread,
          );
          expect(prepareRequest).toMatchObject({
            _tag: WS_METHODS.gitPreparePullRequestThread,
            cwd: "/repo/project",
            reference: "1359",
            mode: "worktree",
            threadId: THREAD_ID,
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(
        wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite && request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends bootstrap turn-starts and waits for server setup on first-send worktree drafts", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
    });
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
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  createThread?: { projectId?: string };
                  prepareWorktree?: {
                    projectCwd?: string;
                    baseBranch?: string;
                    branch?: string;
                  };
                  runSetupScript?: boolean;
                };
              }
            | undefined;
          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: expect.stringMatching(/^ryco\/[0-9a-f]{8}$/),
              },
              runSetupScript: true,
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(wsRequests.some((request) => request._tag === WS_METHODS.vcsCreateWorktree)).toBe(
        false,
      );
      expect(
        wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite &&
            request.threadId === THREAD_ID &&
            request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps custom provider instance ids when bootstrapping a local draft thread", async () => {
    setDraftThreadWithoutWorktree();
    const openRouterInstanceId = ProviderInstanceId.make("claude_openrouter");
    const openRouterSelection = createModelSelection(openRouterInstanceId, "openai/gpt-5.5");
    useComposerDraftStore.getState().setModelSelection(THREAD_REF, openRouterSelection);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            ...nextFixture.serverConfig.providers,
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: ProviderInstanceId.make("claudeAgent"),
              enabled: true,
              installed: true,
              version: "2.1.117",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [],
                  }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: openRouterInstanceId,
              displayName: "Claude OpenRouter",
              enabled: true,
              installed: true,
              version: "2.1.117",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [],
                  }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ],
          settings: {
            ...nextFixture.serverConfig.settings,
            providerInstances: {
              ...nextFixture.serverConfig.settings.providerInstances,
              [openRouterInstanceId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                displayName: "Claude OpenRouter",
                config: { customModels: ["openai/gpt-5.5"] },
              },
            },
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Hello there");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                modelSelection?: { instanceId?: string; model?: string };
                bootstrap?: {
                  createThread?: {
                    modelSelection?: { instanceId?: string; model?: string };
                  };
                };
              }
            | undefined;

          expect(turnStartRequest?.modelSelection).toMatchObject({
            instanceId: openRouterInstanceId,
            model: "openai/gpt-5.5",
          });
          expect(turnStartRequest?.bootstrap?.createThread?.modelSelection).toMatchObject({
            instanceId: openRouterInstanceId,
            model: "openai/gpt-5.5",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a worktree from the sidebar new workspace dialog", async () => {
    const createdThreadId = "thread-browser-test-created-worktree" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
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
        if (body._tag === WS_METHODS.gitCreateWorktreeForProject) {
          return {
            worktreeId: "worktree-browser-test-created",
            sessionId: createdThreadId,
          };
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByRole("button", { name: /Create worktree/ }).click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitCreateWorktreeForProject,
          ) as
            | {
                _tag: string;
                intent?: { kind?: string; branchName?: string };
                projectId?: string;
              }
            | undefined;

          expect(createWorktreeRequest).toMatchObject({
            _tag: WS_METHODS.gitCreateWorktreeForProject,
            projectId: PROJECT_ID,
            intent: {
              kind: "branch",
              branchName: "main",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(createdThreadId),
        "Route should switch to the created worktree session.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("updates the selected branch in the new workspace dialog before creation", async () => {
    const createdThreadId = "thread-browser-test-selected-worktree" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === WS_METHODS.gitCreateWorktreeForProject) {
          return {
            worktreeId: "worktree-browser-test-selected",
            sessionId: createdThreadId,
          };
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByText("release/next", { exact: true }).click();
      await page.getByRole("button", { name: /Create worktree/ }).click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitCreateWorktreeForProject,
          ) as
            | {
                _tag: string;
                intent?: { branchName?: string };
              }
            | undefined;

          expect(createWorktreeRequest?.intent?.branchName).toBe("release/next");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new workspace from-branch picker opaque when opened wide", async () => {
    const branches = [
      {
        name: "main",
        current: true,
        isDefault: true,
        worktreePath: null,
      },
      ...Array.from({ length: 80 }, (_, index) => ({
        name: `feature/very-long-worktree-branch-selector-regression-${String(index).padStart(2, "0")}`,
        current: false,
        isDefault: false,
        worktreePath: null,
      })),
    ];
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: branches.length,
            refs: branches,
          };
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByRole("tab", { name: "New branch" }).click();

      const fromBranchTrigger = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="combobox-trigger"]'))
            .filter((element) => element.getBoundingClientRect().width > 0)
            .find((element) => element.textContent?.includes("main")) ?? null,
        "Unable to find the new workspace from-branch selector trigger.",
      );

      await clickEnabledButton(
        fromBranchTrigger,
        "New workspace branch selector did not become actionable.",
      );
      await expectVisibleComboboxPopupToBeOpaqueAndClipped();
    } finally {
      await mounted.cleanup();
    }
  });

  it("ignores stale generated branch names after the base branch changes", async () => {
    let resolveGeneration!: (value: { branch: string }) => void;
    const generationPromise = new Promise<{ branch: string }>((resolve) => {
      resolveGeneration = resolve;
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === WS_METHODS.textGenerationGenerateBranchName) {
          return generationPromise;
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByRole("tab", { name: "New branch" }).click();
      await page.getByRole("button", { name: "Generate branch name" }).click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) => request._tag === WS_METHODS.textGenerationGenerateBranchName,
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      const fromBranchTrigger = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="combobox-trigger"]'))
            .filter((element) => element.getBoundingClientRect().width > 0)
            .find((element) => element.textContent?.includes("main")) ?? null,
        "Unable to find the new workspace from-branch selector trigger.",
      );
      await clickEnabledButton(
        fromBranchTrigger,
        "New workspace branch selector did not become actionable.",
      );
      await page.getByText("release/next", { exact: true }).click();

      await vi.waitFor(
        () => {
          const releaseTrigger = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[data-slot="combobox-trigger"]'),
          )
            .filter((element) => element.getBoundingClientRect().width > 0)
            .find((element) => element.textContent?.includes("release/next"));
          expect(releaseTrigger).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      resolveGeneration({ branch: "stale/generated" });
      await waitForLayout();
      const branchNameInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="task/short-name"]'),
        "Unable to find new branch name input.",
      );

      await vi.waitFor(
        () => {
          expect(branchNameInput.value).toBe("");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves the selected branch when reopening the new workspace dialog", async () => {
    const createdThreadId = "thread-browser-test-reopened-worktree" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === WS_METHODS.gitCreateWorktreeForProject) {
          return {
            worktreeId: "worktree-browser-test-reopened",
            sessionId: createdThreadId,
          };
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByText("release/next", { exact: true }).click();
      await page.getByText("Cancel", { exact: true }).click();

      await openNewWorkspaceDialog();
      await page.getByRole("button", { name: /Create worktree/ }).click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.findLast(
            (request) => request._tag === WS_METHODS.gitCreateWorktreeForProject,
          ) as
            | {
                _tag: string;
                intent?: { branchName?: string };
              }
            | undefined;

          expect(createWorktreeRequest?.intent?.branchName).toBe("release/next");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the send state once bootstrap dispatch is in flight", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
    });
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
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    let resolveDispatch!: (value: { sequence: number }) => void;
    const dispatchPromise = new Promise<{ sequence: number }>((resolve) => {
      resolveDispatch = resolve;
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return dispatchPromise;
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
          ).toBe(true);
          expect(document.querySelector('button[aria-label="Sending"]')).toBeTruthy();
          expect(document.querySelector('button[aria-label="Preparing worktree"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      resolveDispatch({ sequence: fixture.snapshot.snapshotSequence + 1 });
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      const initialModeButton = await waitForInteractionModeButton("Build");
      expect(initialModeButton.title).toContain("Make changes and run commands.");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect((await waitForInteractionModeButton("Build")).title).toContain(
        "Make changes and run commands.",
      );

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Plan")).title).toContain(
            "Chat toward a plan before making changes.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Build")).title).toContain(
            "Make changes and run commands.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the active draft route session when changing the base branch", async () => {
    const staleDraftId = draftIdFromPath("/draft/draft-stale-branch-session");
    const activeDraftId = draftIdFromPath("/draft/draft-active-branch-session");

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [staleDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: `${PROJECT_DRAFT_KEY}:stale`,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
        [activeDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [`${PROJECT_DRAFT_KEY}:stale`]: staleDraftId,
        [PROJECT_DRAFT_KEY]: activeDraftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${activeDraftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "From main",
          ) as HTMLButtonElement | null,
        'Unable to find branch selector button with "From main".',
      );
      await clickEnabledButton(branchButton, "Branch selector did not become actionable.");

      const branchOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "release/next",
          ) as HTMLSpanElement | null,
        'Unable to find the "release/next" branch option.',
      );
      branchOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftSession(activeDraftId)?.branch).toBe(
            "release/next",
          );
          expect(useComposerDraftStore.getState().getDraftSession(staleDraftId)?.branch).toBe(
            "main",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const updatedButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.trim().includes("From release/next"),
          );
          expect(updatedButton).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new worktree branch picker anchored at the top when opening with a preselected branch", async () => {
    const draftId = DraftId.make("draft-branch-picker-scroll-regression");
    const branches = [
      {
        name: "feature/current",
        current: true,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "main",
        current: false,
        isDefault: true,
        worktreePath: null,
      },
      ...Array.from({ length: 48 }, (_, index) => ({
        name: `feature/${String(index).padStart(2, "0")}`,
        current: false,
        isDefault: false,
        worktreePath: null,
      })),
      {
        name: "feature/selected",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/selected",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: branches.length,
            refs: branches,
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "From feature/selected",
          ) as HTMLButtonElement | null,
        'Unable to find branch selector button with "From feature/selected".',
      );
      await clickEnabledButton(branchButton, "Branch selector did not become actionable.");

      await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to find ref search input.",
      );

      const popup = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="combobox-popup"]'),
        "Unable to find the branch picker popup.",
      );

      await vi.waitFor(
        () => {
          const popupSpans = Array.from(popup.querySelectorAll("span"));
          expect(
            popupSpans.some((element) => element.textContent?.trim() === "feature/current"),
          ).toBe(true);
          expect(popupSpans.some((element) => element.textContent?.trim() === "main")).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("greets an empty draft thread with the new-thread hero", async () => {
    const draftId = DraftId.make("draft-new-thread-hero");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
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
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      const hero = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-hero"]'),
        "Unable to find the new-thread hero.",
      );

      expect(hero.textContent).toContain("What should we do in Project?");
    } finally {
      await mounted.cleanup();
    }
  });

  it("drops the new-thread hero once the thread has messages", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-hero-absent" as MessageId,
        targetText: "hero absent",
      }),
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-timeline-root="true"]'),
        "Unable to find the rendered timeline.",
      );

      expect(document.querySelector('[data-testid="new-thread-hero"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches an empty draft into new-worktree mode and clears the stale worktree path", async () => {
    const draftId = DraftId.make("draft-env-mode-chip");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/existing",
          // A draft attached to an existing worktree reads as "Local"; the chip
          // has to clear this path or the switch back to worktree mode is a
          // no-op once `resolveEffectiveEnvMode` runs again.
          worktreePath: "/repo/.ryco/worktrees/existing",
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      // The sentence names the directory even though no worktree summary
      // matches the path, rather than silently reading "the project root".
      const locationTrigger = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[aria-label^="Change where this thread runs"]',
          ),
        "Unable to find the work-location picker.",
      );
      expect(locationTrigger.textContent).toContain("existing");

      locationTrigger.click();

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="combobox-popup"]'),
        "Unable to find the work-location popup.",
      );
      await page.getByText("A new worktree", { exact: true }).click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
            envMode: "worktree",
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the overview panel on an empty thread and restores it on request", async () => {
    const draftId = DraftId.make("draft-empty-thread-overview");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
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
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-hero"]'),
        "Unable to find the new-thread hero.",
      );

      // The overview describes a thread's history, so it stays out of the way
      // until there is one — or until the user explicitly asks for it.
      // Visibility, not DOM presence: the sheet presentation keeps the panel
      // mounted and only toggles whether it is shown, and the inline one plays
      // an exit transition before unmounting.
      const overviewShowing = () => {
        const header = document.querySelector('[data-slot="overview-branch-header"]');
        return header !== null && header.checkVisibility();
      };
      await vi.waitFor(
        () => {
          expect(overviewShowing()).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );

      const overviewToggle = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Toggle overview panel"]'),
        "Unable to find the overview toggle.",
      );
      overviewToggle.click();

      await vi.waitFor(
        () => {
          expect(overviewShowing()).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the new-thread hero from the sidebar project row", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-new-thread" as MessageId,
        targetText: "sidebar new thread",
      }),
    });

    try {
      const newThreadButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('[data-testid="new-thread-composer-button"]'),
        "Unable to find the sidebar new-thread button.",
      );
      newThreadButton.click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname.startsWith("/draft/")).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-hero"]'),
        "Unable to find the new-thread hero after using the sidebar button.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds selected plain text and preserves the inner selection for repeated wrapping", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-basic" as MessageId,
        targetText: "surround basic",
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "selected".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("(selected)");

      await pressComposerKey("[");
      await waitForComposerText("([selected])");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves collapsed-caret typing unchanged for surround symbols", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-collapsed" as MessageId,
        targetText: "surround collapsed",
      }),
    });

    try {
      await waitForComposerText("selected");
      await setComposerSelectionByTextOffsets({
        start: "selected".length,
        end: "selected".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("selected(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports symmetric and backward-selection surrounds", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "backward");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-backward" as MessageId,
        targetText: "surround backward",
      }),
    });

    try {
      await waitForComposerText("backward");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "backward".length,
        direction: "backward",
      });
      await pressComposerKey("*");
      await waitForComposerText("*backward*");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports option-produced surround symbols like guillemets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-guillemet" as MessageId,
        targetText: "surround guillemet",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "quoted".length,
      });
      await pressComposerKey("«");
      await waitForComposerText("«quoted»");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports dead-key composition that resolves to another surround symbol without an extra undo step", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-dead-quote" as MessageId,
        targetText: "surround dead quote",
      }),
    });

    try {
      await waitForComposerText("quoted");
      await setComposerSelectionByTextOffsets({
        start: 0,
        end: "quoted".length,
      });
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          bubbles: true,
          cancelable: true,
        }),
      );
      composerEditor.dispatchEvent(
        new InputEvent("beforeinput", {
          data: "'",
          inputType: "insertCompositionText",
          bubbles: true,
          cancelable: true,
        }),
      );
      const resolvedInputEvent = new InputEvent("beforeinput", {
        data: "'",
        inputType: "insertText",
        bubbles: true,
        cancelable: true,
      });
      composerEditor.dispatchEvent(resolvedInputEvent);
      expect(resolvedInputEvent.defaultPrevented).toBe(true);
      await waitForComposerText("'quoted'");
      await pressComposerUndo();
      await waitForComposerText("quoted");
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds text after a mention using the correct expanded offsets", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-after-mention" as MessageId,
        targetText: "surround after mention",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForComposerText("hi @package.json there");
      await setComposerSelectionByTextOffsets({
        start: "hi package.json ".length,
        end: "hi package.json there".length,
      });
      await pressComposerKey("(");
      await waitForComposerText("hi @package.json (there)");
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to normal replacement when the selection includes a mention token", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there ");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-token" as MessageId,
        targetText: "surround token",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("package.json");
        },
        { timeout: 8_000, interval: 16 },
      );
      await selectAllComposerContent();
      await pressComposerKey("(");
      await waitForComposerText("(");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows runtime mode descriptions in the desktop composer access select", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      const runtimeModeSelect = await waitForButtonByText("Full access");
      runtimeModeSelect.click();

      expect((await waitForSelectItemContainingText("Supervised")).textContent).toContain(
        "Ask before commands and file changes",
      );

      const autoAcceptItem = await waitForSelectItemContainingText("Auto-accept edits");
      expect(autoAcceptItem.textContent).toContain("Auto-approve edits");
      expect(
        (await waitForSelectItemContainingText("Routine actions proceed without you")).textContent,
      ).toContain("Auto");
      expect((await waitForSelectItemContainingText("Full access")).textContent).toContain(
        "Allow commands and edits without prompts",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadKey[THREAD_KEY]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_REF, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_REF, "ctx-removed");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_REF,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_REF,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_REF, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a pointer cursor for the running stop button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the active thread title in the breadcrumb", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
        targetText: "thread tooltip target",
      }),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Breadcrumb"]')).find(
            (element) => element.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the active thread title in the breadcrumb.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not render a thread archive action in the chat header", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        confirmThreadArchive: true,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-confirm-test" as MessageId,
        targetText: "archive confirm target",
      }),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Breadcrumb"]')).find(
            (element) => element.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the active thread title in the breadcrumb.",
      );
      expect(document.querySelector(`[data-testid="thread-archive-${THREAD_ID}"]`)).toBeNull();
      expect(
        document.querySelector(`[data-testid="thread-archive-confirm-${THREAD_ID}"]`),
      ).toBeNull();
    } finally {
      localStorage.removeItem("ryco:client-settings:v1");
      await mounted.cleanup();
    }
  });

  it("keeps the scroll-to-bottom pill hidden when the transcript is too short to scroll", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createShortTranscriptSnapshot(),
    });

    try {
      const timelineRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-message-id]"),
        "Unable to find a timeline message row.",
      );
      expect(findScrollableAncestor(timelineRow)).toBeNull();

      // The pill is shown behind a 150ms debounce, so a stale "not at end"
      // signal would surface shortly after the timeline paints.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(findScrollToBottomButton()).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the scroll-to-bottom pill only while the transcript is scrolled away from the bottom", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-scroll-pill" as MessageId,
        targetText: "scroll pill target",
      }),
    });

    try {
      const timelineRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-message-id]"),
        "Unable to find a timeline message row.",
      );
      const scrollContainer = findScrollableAncestor(timelineRow);
      expect(scrollContainer).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(findScrollToBottomButton()).toBeNull();

      // The list keeps re-pinning to the end until its scroll handler observes
      // the user-initiated offset, so re-assert until the position sticks.
      await vi.waitFor(async () => {
        scrollContainer!.scrollTop = 0;
        await waitForLayout();
        expect(scrollContainer!.scrollTop).toBeLessThan(100);
      });
      await vi.waitFor(() => {
        expect(findScrollToBottomButton()).not.toBeNull();
      });

      findScrollToBottomButton()!.click();
      await vi.waitFor(() => {
        expect(findScrollToBottomButton()).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("canonicalizes promoted draft threads to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // `thread.created` should only mark the draft as promoting; it should
      // not navigate away until the server thread has actual runtime state.
      await materializePromotedDraftThreadViaDomainEvent(newThreadId);
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();

      // Once the server thread starts, the route should canonicalize.
      await startPromotedServerThreadViaDomainEvent(newThreadId);

      // The route should switch to the canonical server thread path.
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Promoted drafts should canonicalize to the server thread route.",
      );

      // The composer should remain usable after canonicalization, regardless of
      // whether the promoted thread is still visibly empty or has already
      // entered the running state.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("canonicalizes stale promoted draft routes to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-hydration-race-test" as MessageId,
        targetText: "draft hydration race test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      await materializePromotedDraftThreadViaDomainEvent(newThreadId);

      await mounted.router.navigate({
        to: "/draft/$draftId",
        params: { draftId: newDraftId },
      });

      await startPromotedServerThreadViaDomainEvent(newThreadId);

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Stale promoted draft routes should canonicalize to the server thread path.",
      );

      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh worktree draft from an existing worktree thread when the default mode is worktree", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }),
        threads: createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }).threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                branch: "feature/existing",
                worktreePath: "/repo/.ryco/worktrees/existing",
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        enableChatNewLocalShortcut(nextFixture);
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
        };
      },
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(useComposerDraftStore.getState().getDraftSession(newDraftId)).toMatchObject({
        envMode: "worktree",
        worktreePath: null,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new draft instead of reusing a promoting draft thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoting-draft-new-thread-test" as MessageId,
        targetText: "promoting draft new thread test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const firstDraftPath = await createDraftFromChatNewLocalShortcut(mounted);
      const firstDraftId = draftIdFromPath(firstDraftPath);
      const firstThreadId = draftThreadIdFor(firstDraftId);

      await materializePromotedDraftThreadViaDomainEvent(firstThreadId);
      expect(mounted.router.state.location.pathname).toBe(firstDraftPath);

      const secondDraftPath = await triggerChatNewLocalShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== firstDraftPath,
        "Route should change to a second draft thread instead of reusing the promoting draft.",
      );
      expect(draftIdFromPath(secondDraftPath)).not.toBe(firstDraftId);
    } finally {
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("codex")]: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.3-codex",
          [
            { id: "reasoningEffort", value: "medium" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
        targetText: "sticky codex traits test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);

      // `toMatchObject` matches objects loosely (extras ignored) but compares
      // arrays strictly, so wrap `options` in `arrayContaining` to keep the
      // assertion focused on sticky `fastMode` carrying over without asserting
      // on exactly which other options are preserved.
      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("claudeAgent")]: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("claudeAgent"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
        targetText: "sticky claude model test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-opus-4-6",
            [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ],
          ),
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(composerDraftFor(newDraftId)).toBe(undefined);
    } finally {
      await mounted.cleanup();
    }
  });

  it("prefers draft state over sticky composer settings and defaults", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("codex")]: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.3-codex",
          [
            { id: "reasoningEffort", value: "medium" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const threadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const draftId = draftIdFromPath(threadPath);

      // See the note on the sibling sticky-codex test: arrays match strictly
      // under `toMatchObject`, so use `arrayContaining` to keep the assertion
      // scoped to the sticky trait (`fastMode`) that must carry over.
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(
        draftId,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ]),
      );

      await triggerChatNewLocalShortcutUntilPath(
        mounted.router,
        (path) => path === threadPath,
        "New-thread should reuse the existing project draft thread.",
      );
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "low" },
            { id: "fastMode", value: true },
          ]),
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        enableChatNewShortcut(nextFixture);
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            CHAT_NEW_KEYBINDING,
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
            },
          ],
        };
      },
    });

    try {
      await createDraftFromChatNewShortcut(mounted);
    } finally {
      await mounted.cleanup();
    }
  });

  it("pins from the global shortcut and exposes the matching palette action", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-pin-shortcut-test" as MessageId,
        targetText: "thread pin shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [THREAD_PIN_TOGGLE_KEYBINDING],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      expect(useUiStateStore.getState().pinnedThreadKeys[THREAD_KEY]).not.toBe(true);

      dispatchThreadPinToggleShortcut();
      await vi.waitFor(() => {
        expect(useUiStateStore.getState().pinnedThreadKeys[THREAD_KEY]).toBe(true);
      });

      useCommandPaletteStore.getState().setOpen(true);
      const palette = page.getByTestId("command-palette");
      const unpinAction = palette.getByText("Unpin current thread", { exact: true });
      await expect.element(unpinAction).toBeInTheDocument();
      await unpinAction.click();
      await vi.waitFor(() => {
        expect(useUiStateStore.getState().pinnedThreadKeys[THREAD_KEY]).not.toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not consume chat.new when there is no project context", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createProjectlessSnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
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
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      dispatchChatNewShortcut();
      await waitForLayout();

      expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the configurable shortcut and runs a command from the sidebar trigger", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-shortcut-test" as MessageId,
        targetText: "command palette shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await expect
        .element(palette.getByText("New thread in Project", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("New thread in Project", { exact: true }).click();

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the command palette.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches sidebar modes from command-palette actions", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-sidebar-mode" as MessageId,
        targetText: "command palette sidebar mode",
      }),
    });

    try {
      await openCommandPaletteFromTrigger();
      const palette = page.getByTestId("command-palette");
      await waitForWsRequestsToSettle();
      const requestCountBeforeInboxSwitch = wsRequests.length;
      await palette.getByText("Show Inbox sidebar", { exact: true }).click();

      await vi.waitFor(() => expect(useUiStateStore.getState().sidebarMode).toBe("inbox"));
      await expect.element(page.getByTestId("inbox-sidebar")).toBeInTheDocument();
      expect(useCommandPaletteStore.getState().open).toBe(false);
      expect(wsRequests).toHaveLength(requestCountBeforeInboxSwitch);

      useCommandPaletteStore.getState().setOpen(true);
      await waitForElement(
        () => document.querySelector('[data-testid="command-palette"]'),
        "Command palette should have reopened from Inbox mode.",
      );
      await waitForWsRequestsToSettle();
      const requestCountBeforeProjectsSwitch = wsRequests.length;
      await palette.getByText("Show Projects sidebar", { exact: true }).click();
      await vi.waitFor(() => expect(useUiStateStore.getState().sidebarMode).toBe("projects"));
      expect(
        document
          .querySelector<HTMLElement>('[data-testid="sidebar-add-project-trigger"]')
          ?.checkVisibility(),
      ).toBe(true);
      expect(wsRequests).toHaveLength(requestCountBeforeProjectsSwitch);
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters command palette results as the user types", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-search-test" as MessageId,
        targetText: "command palette search test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("settings");
      await expect.element(palette.getByText("Open settings", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("New thread in Project", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds a project from browse mode with Enter when no directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-enter" as MessageId,
        targetText: "command palette add project enter",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            projectMetadataDir: ".ryco",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Enter.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows clone destination controls after resolving an add project repository", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-remote" as MessageId,
        targetText: "command palette add project remote",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === WS_METHODS.sourceControlLookupRepository) {
          return {
            provider: "github",
            nameWithOwner: "openai/codex",
            url: "https://github.com/openai/codex",
            sshUrl: "git@github.com:openai/codex.git",
          };
        }

        if (body._tag === WS_METHODS.sourceControlCloneRepository) {
          return {
            cwd: body.destinationPath,
            remoteUrl: body.remoteUrl,
            repository: null,
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await palette.getByText("GitHub repository", { exact: true }).click();

      const repositoryInput = await waitForCommandPaletteInput(
        "Enter GitHub repository (owner/repo)",
      );
      await page.getByPlaceholder("Enter GitHub repository (owner/repo)").fill("openai/codex");
      await dispatchInputKey(repositoryInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const clonePathInput = document.querySelector<HTMLInputElement>(
            'input[placeholder="Enter path (e.g. ~/projects/my-app)"]',
          );
          expect(clonePathInput?.value).toBe("~/");
          expect(document.body.textContent).toContain("Repository");
          expect(document.body.textContent).toContain("openai/codex");
          expect(document.body.textContent).toContain("https://github.com/openai/codex");
          expect(document.body.textContent).toContain("Select where to clone");
          expect(document.body.textContent).toContain("Development");
          expect(document.body.textContent).toContain("Clone");
        },
        { timeout: 8_000, interval: 16 },
      );

      await page
        .getByPlaceholder("Enter path (e.g. ~/projects/my-app)")
        .fill("~/Development/codex");
      const clonePathInput = await waitForCommandPaletteInput(
        "Enter path (e.g. ~/projects/my-app)",
      );
      await dispatchInputKey(clonePathInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const cloneRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.sourceControlCloneRepository,
          ) as { destinationPath?: string; remoteUrl?: string } | undefined;
          expect(cloneRequest).toMatchObject({
            remoteUrl: "git@github.com:openai/codex.git",
            destinationPath: "~/Development/codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens add project browse mode from the sidebar add button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-trigger" as MessageId,
        targetText: "sidebar add project trigger",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse && request.partialPath === "~/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts add project browse mode from the configured base directory", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-custom-base-dir" as MessageId,
        targetText: "sidebar add project custom base directory",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            addProjectBaseDirectory: "~/Development",
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [{ name: "codething", fullPath: "~/Development/codething" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/Development/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts restricted browsing at the access root and hides parent navigation there", async () => {
    const workspaceAccessRoot = "/allowed/workspace";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-restricted-root" as MessageId,
        targetText: "sidebar add project restricted root",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          workspaceAccessRoot,
          settings: {
            ...nextFixture.serverConfig.settings,
            addProjectBaseDirectory: "~/Development",
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: workspaceAccessRoot,
            workspaceAccessRoot,
            entries: [{ name: "project", fullPath: `${workspaceAccessRoot}/project` }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue(`${workspaceAccessRoot}/`);
      await expect.element(palette.getByText("..", { exact: true })).not.toBeInTheDocument();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === `${workspaceAccessRoot}/`,
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows create-folder affordances for missing project paths", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-create-missing-project" as MessageId,
        targetText: "command palette create missing project",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Desktop/") {
            return {
              parentPath: "~/Desktop/",
              entries: [{ name: "existing", fullPath: "~/Desktop/existing" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Desktop", fullPath: "~/Desktop" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Desktop/fresh-project");

      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .toBeInTheDocument();
      await expect.element(palette.getByText("Will create this folder")).not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
                createWorkspaceRootIfMissing?: boolean;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Desktop/fresh-project",
            projectMetadataDir: ".ryco",
            title: "fresh-project",
            createWorkspaceRootIfMissing: true,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not show create affordances for an existing directory with a trailing slash", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-existing-trailing-directory" as MessageId,
        targetText: "command palette existing trailing directory",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/codex/") {
            return {
              parentPath: "~/Development/codex/",
              entries: [
                {
                  name: "Codex.app",
                  fullPath: "~/Development/codex/Codex.app",
                },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/codex/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/codex/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();
      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development/codex",
            projectMetadataDir: ".ryco",
            title: "codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects an environment before browsing when multiple environments are available", async () => {
    const remoteBrowseMock = vi.fn(async ({ partialPath }: { partialPath: string }) => {
      if (partialPath === "~/workspaces/") {
        return {
          parentPath: "~/workspaces/",
          entries: [{ name: "codething", fullPath: "~/workspaces/codething" }],
        };
      }

      return {
        parentPath: "~/",
        entries: [{ name: "workspaces", fullPath: "~/workspaces" }],
      };
    });
    const remoteDispatchMock = vi.fn(async () => ({
      sequence: fixture.snapshot.snapshotSequence + 1,
    }));

    __setEnvironmentApiOverrideForTests(
      REMOTE_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: remoteBrowseMock,
        dispatchCommand: remoteDispatchMock,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-multi-env" as MessageId,
        targetText: "command palette add project multi env",
      }),
    });

    try {
      await waitForServerConfigToApply();
      useSavedEnvironmentRegistryStore.getState().upsert({
        environmentId: REMOTE_ENVIRONMENT_ID,
        label: "Staging",
        httpBaseUrl: "https://staging.example.test",
        wsBaseUrl: "wss://staging.example.test/ws",
        createdAt: NOW_ISO,
        lastConnectedAt: NOW_ISO,
      });
      useSavedEnvironmentRuntimeStore.getState().patch(REMOTE_ENVIRONMENT_ID, {
        connectionState: "connected",
        authState: "authenticated",
        descriptor: {
          ...fixture.serverConfig.environment,
          environmentId: REMOTE_ENVIRONMENT_ID,
          label: "Staging",
        },
        serverConfig: {
          ...fixture.serverConfig,
          environment: {
            ...fixture.serverConfig.environment,
            environmentId: REMOTE_ENVIRONMENT_ID,
            label: "Staging",
          },
          settings: {
            ...fixture.serverConfig.settings,
            addProjectBaseDirectory: "~/workspaces",
          },
        },
        connectedAt: NOW_ISO,
      });

      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await expect.element(palette.getByText("Environments", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("This device", { exact: true }).first())
        .toBeInTheDocument();
      await palette.getByText("Staging", { exact: true }).click();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/workspaces/");

      await vi.waitFor(
        () => {
          expect(remoteBrowseMock).toHaveBeenCalledWith({
            partialPath: "~/workspaces/",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/workspaces/");
      await vi.waitFor(
        () => {
          expect(remoteBrowseMock).toHaveBeenCalledWith({
            partialPath: "~/workspaces/",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(palette.getByText("codething", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          expect(remoteDispatchMock).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "project.create",
              workspaceRoot: "~/workspaces",
              projectMetadataDir: ".ryco",
              title: "workspaces",
            }),
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a remote project.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("picks a local project from the native file manager", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/Users/julius/Projects/finder-picked");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-file-manager" as MessageId,
        targetText: "command palette add project file manager",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Applications/") {
            return {
              parentPath: "~/Applications/",
              entries: [{ name: "Utilities", fullPath: "~/Applications/Utilities" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Applications", fullPath: "~/Applications" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      window.desktopBridge = {
        pickFolder,
        setTheme: vi.fn().mockResolvedValue(undefined),
      } as unknown as NonNullable<typeof window.desktopBridge>;

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();
      const browseInput = palette.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await browseInput.fill("~/Applications/access");

      const fileManagerLabel = isMacPlatform(navigator.platform)
        ? "Open in Finder"
        : navigator.platform.toLowerCase().startsWith("win")
          ? "Open in Explorer"
          : "Open in Files";
      await palette.getByRole("button", { name: fileManagerLabel }).click();

      await vi.waitFor(
        () => {
          expect(pickFolder).toHaveBeenCalledWith({
            initialPath: "~/Applications",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "/Users/julius/Projects/finder-picked",
            projectMetadataDir: ".ryco",
            title: "finder-picked",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project from the native file manager.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds a project from browse mode with Mod+Enter when a directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-mod-enter" as MessageId,
        targetText: "command palette add project mod enter",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "ArrowDown" });

      const addButtonLabel = isMacPlatform(navigator.platform)
        ? "Add (\u2318 Enter)"
        : "Add (Ctrl Enter)";
      await vi.waitFor(
        () => {
          const legendEntries = getCommandPaletteLegendEntries();
          expect(legendEntries).toContain("Enter Select");
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(palette.getByRole("button", { name: addButtonLabel }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, {
        key: "Enter",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
      });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            projectMetadataDir: ".ryco",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Mod+Enter.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps project-context thread matches available when searching by project name", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("Release checklist", { exact: true }))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches projects by path and opens the latest thread for that project", async () => {
    useUiStateStore.setState({
      projectExpandedById: {
        [SECOND_PROJECT_LOGICAL_KEY]: false,
      },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath("thread-secondary-project" as ThreadId),
        "Route should have changed to the latest thread for the selected project.",
      );
      expect(nextPath).toBe(serverThreadPath("thread-secondary-project" as ThreadId));
      expect(useUiStateStore.getState().projectExpandedById[SECOND_PROJECT_LOGICAL_KEY]).toBe(true);
      expect(
        useComposerDraftStore
          .getState()
          .getDraftThread(threadRefFor("thread-secondary-project" as ThreadId)),
      ).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from project search when no active project thread exists", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject({
        includeSecondaryThread: false,
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the project search result.",
      );
      const nextDraftId = draftIdFromPath(nextPath);
      const draftThread = useComposerDraftStore.getState().getDraftSession(nextDraftId);
      expect(draftThread?.projectId).toBe(SECOND_PROJECT_ID);
      expect(draftThread?.envMode).toBe("worktree");
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters archived threads out of command palette search results", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("docs-archive");
      await expect
        .element(palette.getByText("Archived Docs Notes", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        enableChatNewShortcut(nextFixture);
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [CHAT_NEW_KEYBINDING],
        };
      },
    });

    try {
      const promotedThreadPath = await createDraftFromChatNewShortcut(mounted);
      const promotedDraftId = draftIdFromPath(promotedThreadPath);
      const promotedThreadId = draftThreadIdFor(promotedDraftId);

      await materializePromotedDraftThreadViaDomainEvent(promotedThreadId);
      await startPromotedServerThreadViaDomainEvent(promotedThreadId);
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(promotedThreadId),
        "Promoted drafts should canonicalize to the server thread route before a fresh draft is created.",
      );
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(promotedDraftId)).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the active worktree path when saving a proposed plan to the workspace", async () => {
    const snapshot = createSnapshotWithLongProposedPlan();
    const threads = snapshot.threads.slice();
    const targetThreadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
    const targetThread = targetThreadIndex >= 0 ? threads[targetThreadIndex] : undefined;
    if (targetThread) {
      threads[targetThreadIndex] = {
        ...targetThread,
        worktreePath: "/repo/worktrees/plan-thread",
      };
    }

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads,
      },
    });

    try {
      const planActionsButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]'),
        "Unable to find proposed plan actions button.",
      );
      planActionsButton.click();

      const saveToWorkspaceItem = await waitForElement(
        () =>
          (Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Save to workspace",
          ) ?? null) as HTMLElement | null,
        'Unable to find "Save to workspace" menu item.',
      );
      saveToWorkspaceItem.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Enter a path relative to /repo/worktrees/plan-thread.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps pending-question footer actions inside the composer after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();

      await waitForButtonByText("Previous");
      await waitForButtonByText("Submit answers");

      await mounted.setViewport({
        ...COMPACT_FOOTER_VIEWPORT,
        width: 1_024,
      });
      await expectComposerActionsContained();
    } finally {
      await mounted.cleanup();
    }
  });

  it("submits pending user input after the final option selection resolves the draft answers", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();

      const finalOption = await waitForButtonContainingText("Conservative");
      finalOption.click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.user-input.respond",
          ) as
            | {
                _tag: string;
                type?: string;
                requestId?: string;
                answers?: Record<string, unknown>;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.user-input.respond",
            requestId: "req-browser-user-input",
            answers: {
              scope: "Tight",
              risk: "Conservative",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps plan follow-up footer actions fused and aligned after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
    });

    try {
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      const initialModelPicker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider model picker.",
      );
      const initialModelPickerOffset =
        initialModelPicker.getBoundingClientRect().left - footer.getBoundingClientRect().left;
      const initialImplementButton = await waitForButtonByText("Implement");
      const initialImplementWidth = initialImplementButton.getBoundingClientRect().width;

      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await mounted.setViewport({
        ...WIDE_FOOTER_VIEWPORT,
        width: 1_024,
      });
      await expectComposerActionsContained();

      const implementButton = await waitForButtonByText("Implement");
      const implementActionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await vi.waitFor(
        () => {
          const implementRect = implementButton.getBoundingClientRect();
          const implementActionsRect = implementActionsButton.getBoundingClientRect();
          const compactModelPicker = findComposerProviderModelPicker();
          expect(compactModelPicker).toBeTruthy();

          const compactModelPickerOffset =
            compactModelPicker!.getBoundingClientRect().left - footer.getBoundingClientRect().left;

          expect(Math.abs(implementRect.right - implementActionsRect.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.top - implementActionsRect.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.width - initialImplementWidth)).toBeLessThanOrEqual(1);
          expect(Math.abs(compactModelPickerOffset - initialModelPickerOffset)).toBeLessThanOrEqual(
            1,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the wide desktop follow-up layout expanded when the footer still fits", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex-spark",
        },
        planMarkdown:
          "# Imaginary Long-Range Plan: Ryco Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer?.dataset.chatComposerFooterCompact).toBe("false");
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("false");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("compacts the footer when a wide desktop follow-up layout starts overflowing", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex-spark",
        },
        planMarkdown:
          "# Imaginary Long-Range Plan: Ryco Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await mounted.setContainerSize({
        width: 804,
        height: WIDE_FOOTER_VIEWPORT.height,
      });

      await expectComposerActionsContained();

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer?.dataset.chatComposerFooterCompact).toBe("true");
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("true");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the slash-command menu visible above the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-menu-target" as MessageId,
        targetText: "command menu thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/");

      const menuItem = await waitForComposerMenuItem("slash:model");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );

      await vi.waitFor(
        () => {
          const menuRect = menuItem.getBoundingClientRect();
          const composerRect = composerForm.getBoundingClientRect();
          const hitTarget = document.elementFromPoint(
            menuRect.left + menuRect.width / 2,
            menuRect.top + menuRect.height / 2,
          );

          expect(menuRect.width).toBeGreaterThan(0);
          expect(menuRect.height).toBeGreaterThan(0);
          expect(menuRect.bottom).toBeLessThanOrEqual(composerRect.bottom);
          expect(hitTarget instanceof Element && menuItem.contains(hitTarget)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("stages an idle provider target locally and sends it without an unsafe model meta update", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-context-handoff-stage" as MessageId,
      targetText: "context handoff staging thread",
    });
    const thread = snapshot.threads.find((candidate) => candidate.id === THREAD_ID);
    if (!thread) throw new Error("Expected context handoff thread fixture.");
    Object.assign(thread, { interactionMode: "ask" as const });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: configureContextHandoffProviders,
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const picker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider/model picker for context handoff.",
      );
      await picker.click();
      await page.getByRole("button", { name: "Claude", exact: true }).click();
      await page.getByText("Sonnet 4.6", { exact: true }).click();
      await waitForLayout();

      const pendingHandoff = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-pending-context-handoff="true"]'),
        "Unable to find the staged context-handoff chip.",
      );
      expect(pendingHandoff.textContent).toContain("Next message hands off context");
      expect(pendingHandoff.textContent).toContain("GPT-5");
      expect(pendingHandoff.textContent).toContain("Sonnet 4.6");
      expect(pendingHandoff.textContent).not.toContain("claude-sonnet-4-6");
      expect(pendingHandoff.querySelector("button")).toBeNull();
      expect(pendingHandoff.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        document
          .querySelector<HTMLElement>('[data-chat-composer-mobile-collapsed="false"]')!
          .getBoundingClientRect().top,
      );

      expect(
        wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toBe(false);
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)).toMatchObject({
        activeProvider: ProviderInstanceId.make("claudeAgent"),
        modelSelectionByProvider: {
          claudeAgent: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        },
        interactionMode: "default",
      });
      expect(useComposerDraftStore.getState().stickyActiveProvider).not.toBe(
        ProviderInstanceId.make("claudeAgent"),
      );

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Continue on the staged target");
      const sendButton = await waitForSendButton();
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStart = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          );
          expect(turnStart).toMatchObject({
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.querySelector('[data-pending-context-handoff="true"]')).toBeNull();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.meta.update" &&
            "modelSelection" in request,
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("changes models inside the active provider without presenting a context handoff", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-same-provider-model-stage" as MessageId,
        targetText: "same provider model staging thread",
      }),
      configureFixture: configureContextHandoffProviders,
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        }
        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const picker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider/model picker for same-provider model change.",
      );
      await picker.click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();
      await page.getByText("GPT-5.1", { exact: true }).click();
      await waitForLayout();

      expect(document.querySelector('[data-pending-context-handoff="true"]')).toBeNull();
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)).toMatchObject({
        activeProvider: ProviderInstanceId.make("codex"),
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1",
          },
        },
      });

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Continue with the new Codex model");
      const sendButton = await waitForSendButton();
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStart = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          );
          expect(turnStart).toMatchObject({
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.1",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.querySelector('[data-pending-context-handoff="true"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the frozen web phone picker on the current provider", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-context-handoff-phone" as MessageId,
        targetText: "frozen phone provider thread",
      }),
      configureFixture: configureContextHandoffProviders,
    });

    try {
      await waitForServerConfigToApply();
      await expandPhoneComposerIfCollapsed();
      const picker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find frozen phone provider/model picker.",
      );
      await picker.click();
      await waitForElement(
        () => document.querySelector('[data-slot="mobile-select-sheet-list"]'),
        "Unable to find phone model sheet.",
      );

      expect(document.body.textContent).toContain("GPT-5");
      expect(document.body.textContent).not.toContain("Claude Sonnet 4.6");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the model picker when selecting /model", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-command-target" as MessageId,
        targetText: "model command thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/mod");

      const menuItem = await waitForComposerMenuItem("slash:model");
      await menuItem.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
        expect(findComposerProviderModelPicker()?.textContent).not.toContain("/model");
      });

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the model picker and shows jump keys immediately from the shortcut", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-model-picker-shortcut-target" as MessageId,
      targetText: "model picker shortcut thread",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.map((project) =>
          project.id === PROJECT_ID
            ? Object.assign({}, project, {
                defaultModelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
              })
            : project,
        ),
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: true,
                shiftKey: true,
                altKey: false,
                modKey: false,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
            },
          ],
          providers: [
            {
              ...nextFixture.serverConfig.providers[0]!,
              models: [
                {
                  slug: "gpt-5.1-codex-max",
                  name: "GPT-5.1 Codex Max",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      {
                        id: "fastMode",
                        label: "Fast Mode",
                        type: "boolean" as const,
                      },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.3-codex",
                  name: "GPT-5.3 Codex",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      {
                        id: "fastMode",
                        label: "Fast Mode",
                        type: "boolean" as const,
                      },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.4",
                  name: "GPT-5.4",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      {
                        id: "fastMode",
                        label: "Fast Mode",
                        type: "boolean" as const,
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();

      const initialPath = mounted.router.state.location.pathname;
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
      });

      const jumpLabel = isMacPlatform(navigator.platform) ? "⌃1" : "Ctrl+1";
      await vi.waitFor(() => {
        expect(
          Array.from(
            document.querySelectorAll<HTMLElement>('.model-picker-list [data-slot="kbd"]'),
          ).some((element) => element.textContent?.trim() === jumpLabel),
        ).toBe(true);
      });
      expect(mounted.router.state.location.pathname).toBe(initialPath);

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      releaseModShortcut("Control");
      await mounted.cleanup();
    }
  });

  it("shows a tooltip with the skill description when hovering a skill pill", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-skill-tooltip-target" as MessageId,
        targetText: "skill tooltip thread",
      }),
      configureFixture: (nextFixture) => {
        const provider = nextFixture.serverConfig.providers[0];
        if (!provider) {
          throw new Error("Expected default provider in test fixture.");
        }
        (
          provider as {
            skills: ServerConfig["providers"][number]["skills"];
          }
        ).skills = [
          {
            name: "agent-browser",
            displayName: "Agent Browser",
            description: "Open pages, click around, and inspect web apps.",
            path: "/Users/test/.agents/skills/agent-browser/SKILL.md",
            enabled: true,
          },
        ];
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "use the $agent-browser ");
      await waitForComposerText("use the $agent-browser ");

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-skill-chip="true"]'),
        "Unable to find rendered composer skill chip.",
      );
      await page.getByText("Agent Browser").hover();

      await vi.waitFor(
        () => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip).not.toBeNull();
          expect(tooltip?.textContent).toContain("Open pages, click around, and inspect web apps.");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("navigates the phone stack from the thread app bar to Home with 44px coarse-pointer targets", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-stack" as MessageId,
        targetText: "phone stack thread",
      }),
    });

    try {
      // The phone tier renders the compact thread app bar instead of the
      // persistent sidebar or a navigation drawer.
      const backButton = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the phone app bar back affordance.",
      );
      // The thread-actions overflow left the app bar's top-right corner for
      // the dock row above the composer.
      const threadActions = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Thread actions"]'),
        "Unable to find the thread-actions overflow.",
      );
      expect(document.querySelector('[data-slot="sidebar-container"]')).toBeNull();
      expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();
      expect(
        threadActions.closest('[data-slot="phone-thread-dock"]'),
        "the thread-actions overflow is still in the app bar",
      ).not.toBeNull();
      expect(threadActions.getBoundingClientRect().top).toBeGreaterThan(
        backButton.getBoundingClientRect().bottom,
      );

      await withCoarsePointer(async () => {
        // Back keeps the shared button's coarse-pointer hit-area expansion; the
        // dock's overflow meets the floor with its own border box instead, so
        // each is measured the way it actually resolves.
        const back = document.querySelector<HTMLElement>('button[aria-label="Back to threads"]')!;
        const backHitArea = getComputedStyle(back, "::after");
        expect(backHitArea.position).toBe("absolute");
        expect(parseFloat(backHitArea.width)).toBeGreaterThanOrEqual(44);
        expect(parseFloat(backHitArea.height)).toBeGreaterThanOrEqual(44);

        const overflowRect = document
          .querySelector<HTMLElement>('button[aria-label="Thread actions"]')!
          .getBoundingClientRect();
        expect(overflowRect.width).toBeGreaterThanOrEqual(44);
        expect(overflowRect.height).toBeGreaterThanOrEqual(44);
      });

      // Back navigates the URL-driven stack to Home (the thread list).
      backButton.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/");
      });
      const homeHeading = await waitForElement(
        () => document.querySelector<HTMLElement>("h1"),
        "Unable to find the Home heading.",
      );
      expect(homeHeading.textContent).toBe("Threads");

      // Home renders the same store-backed thread with a >=44px row and a
      // visible kebab (no hover-only affordances on the phone tier).
      const homeRow = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            `button[aria-label="Thread actions for ${THREAD_TITLE}"]`,
          ),
        "Unable to find the Home thread row kebab.",
      );
      const rowRect = homeRow.getBoundingClientRect();
      expect(rowRect.height).toBeGreaterThanOrEqual(44);
      expect(rowRect.width).toBeGreaterThanOrEqual(44);

      // The kebab opens the bottom-sheet action inventory.
      homeRow.click();
      await vi.waitFor(() => {
        const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
        expect(sheet).not.toBeNull();
        expect(sheet!.textContent).toContain("Rename thread");
        expect(sheet!.textContent).toContain("Mark unread");
      });

      // Deep links keep working: navigating forward re-enters the thread.
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
      });
      mounted.router.history.back();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(
          `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`,
        );
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the app bar after returning to the thread.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the full approval detail scrollable with all actions visible on a phone", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });

    try {
      const detail = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
        "Unable to find the pending approval detail block.",
      );
      expect(detail.textContent).toContain(APPROVAL_DETAIL_HEAD);
      expect(detail.textContent).toContain(APPROVAL_DETAIL_TAIL);
      const detailStyle = getComputedStyle(detail);
      expect(detailStyle.overflowY).toBe("auto");
      expect(detailStyle.whiteSpace).toBe("pre-wrap");
      expect(detail.scrollHeight).toBeGreaterThan(detail.clientHeight);
      expect(detail.getBoundingClientRect().height).toBeLessThanOrEqual(161);

      for (const label of APPROVAL_ACTION_LABELS) {
        const button = await waitForElement(
          () => findButtonByText(label),
          `Unable to find approval action "${label}".`,
        );
        const rect = button.getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(-0.5);
        expect(rect.right).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width + 0.5);
        expect(rect.top).toBeGreaterThanOrEqual(-0.5);
        expect(rect.bottom).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.height + 0.5);
      }

      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width);
    } finally {
      await mounted.cleanup();
    }
  });

  it("wraps the expanded approval action row so all actions stay visible at 390px", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });

    try {
      await waitForElement(
        () => findButtonByText("Approve once"),
        "Unable to find the expanded approval action row.",
      );

      // 656px total minus the 16rem desktop sidebar leaves the chat column
      // (and the approval action row) at roughly 400px — inside the 320-430px
      // range the acceptance criteria target. The shell sizes itself with
      // viewport units, so the container height must match the viewport.
      await mounted.setContainerSize({
        width: 656,
        height: DEFAULT_VIEWPORT.height,
      });

      const buttons: HTMLElement[] = [];
      for (const label of APPROVAL_ACTION_LABELS) {
        buttons.push(
          await waitForElement(
            () => findButtonByText(label),
            `Unable to find approval action "${label}".`,
          ),
        );
      }
      const actionRow = buttons[0]!.parentElement!;
      const rowRect = actionRow.getBoundingClientRect();
      expect(rowRect.width).toBeGreaterThanOrEqual(320);
      expect(rowRect.width).toBeLessThanOrEqual(430);
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(rowRect.left - 0.5);
        expect(rect.right).toBeLessThanOrEqual(rowRect.right + 0.5);
        expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 0.5);
      }
      // The row is too wide for one line at this width, so it must have
      // wrapped instead of pushing actions out of view.
      const rowTops = new Set(
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
      );
      expect(rowTops.size).toBeGreaterThan(1);
      expect(actionRow.scrollWidth).toBeLessThanOrEqual(actionRow.clientWidth + 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("contains wide markdown tables in their own scroll container on phones", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotWithWideMarkdownTable(),
    });

    try {
      for (const viewport of [NARROW_PHONE_VIEWPORT, PHONE_VIEWPORT]) {
        await mounted.setViewport(viewport);
        const wrapper = await waitForElement(
          () => document.querySelector<HTMLElement>(".chat-markdown-table-scroll"),
          "Unable to find the markdown table scroll container.",
        );
        await vi.waitFor(() => {
          expect(getComputedStyle(wrapper).overflowX).toBe("auto");
          expect(wrapper.scrollWidth).toBeGreaterThan(wrapper.clientWidth);
          expect(wrapper.getBoundingClientRect().width).toBeLessThanOrEqual(viewport.width);
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
        });
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps transient notices clear of the session tab strip at phone widths", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-toast" as MessageId,
        targetText: "phone toast thread",
      }),
    });

    let toastId: ReturnType<typeof toastManager.add> | null = null;
    const onClose = vi.fn();
    try {
      // The phone tier renders the compact app bar (the session tab strip
      // moved into the thread kebab sheet), so notices must clear the app bar.
      const appBar = await waitForElement(
        () =>
          document
            .querySelector<HTMLElement>('button[aria-label="Back to threads"]')
            ?.closest("header") ?? null,
        "Unable to find the phone thread app bar.",
      );

      toastId = toastManager.add({
        title: "Reconnecting",
        description: "Attempting to restore the connection.",
        type: "info",
        // Keep the toast mounted across the viewport sweep below.
        timeout: 0,
        data: { onClose },
      });

      const toastRoot = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="toast-viewport"] [data-position]'),
        "Unable to find the mounted toast.",
      );
      // The notice must clear the app bar across the whole sub-768px range.
      for (const viewport of [PHONE_VIEWPORT, NARROW_PHONE_VIEWPORT, NARROW_TABLET_VIEWPORT]) {
        await mounted.setViewport(viewport);
        await vi.waitFor(() => {
          const toastRect = toastRoot.getBoundingClientRect();
          const appBarRect = appBar.getBoundingClientRect();
          expect(toastRect.height).toBeGreaterThan(0);
          expect(toastRect.top).toBeGreaterThanOrEqual(appBarRect.bottom);
        });

        const composerForm = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
          "Unable to find the composer form.",
        );
        expect(toastRoot.getBoundingClientRect().bottom).toBeLessThan(
          composerForm.getBoundingClientRect().top,
        );
      }

      // A coarse landscape phone (844x390) is md-wide, so a width-keyed
      // offset would fall back to the 52px desktop value and overlap the app
      // bar; the tier keys the 76px phone offset there too.
      await withCoarsePointer(async () => {
        await mounted.setViewport(PHONE_LANDSCAPE_VIEWPORT);
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        await vi.waitFor(() => {
          const toastRect = toastRoot.getBoundingClientRect();
          const appBarRect = appBar.getBoundingClientRect();
          expect(toastRect.height).toBeGreaterThan(0);
          expect(toastRect.top).toBeGreaterThanOrEqual(appBarRect.bottom);
        });
      });

      // Desktop placement sits at the viewport's top edge, over the header
      // chrome (system-notification style).
      await mounted.setViewport(DEFAULT_VIEWPORT);
      await vi.waitFor(() => {
        const toastViewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]');
        expect(toastViewport).not.toBeNull();
        expect(getComputedStyle(toastViewport!).top).toBe("12px");
        expect(getComputedStyle(toastRoot).getPropertyValue("-webkit-app-region")).toBe("no-drag");
        const closeButton = toastRoot.querySelector<HTMLElement>('[data-slot="toast-close"]');
        expect(closeButton).not.toBeNull();
        expect(getComputedStyle(closeButton!).getPropertyValue("-webkit-app-region")).toBe(
          "no-drag",
        );
      });

      await page.getByRole("button", { name: "Dismiss notification" }).click();
      await vi.waitFor(() => {
        expect(onClose).toHaveBeenCalledOnce();
        expect(document.body.contains(toastRoot)).toBe(false);
      });
      toastId = null;
    } finally {
      if (toastId !== null) {
        toastManager.close(toastId);
      }
      await mounted.cleanup();
    }
  });

  it("keeps tablet-width sidebar density unchanged on coarse pointers", async () => {
    const mounted = await mountChatView({
      viewport: TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-tablet-density" as MessageId,
        targetText: "tablet density thread",
      }),
    });

    try {
      // The persistent desktop sidebar renders at md and up; expand the
      // worktree section so a thread row (and its actions) is in the DOM.
      await page.getByRole("button", { name: "Expand main", exact: true }).click();
      const threadRow = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="thread-row-thread-browser-test"]'),
        "Unable to find the sidebar thread row.",
      );
      const archiveAction = await waitForElement(
        () =>
          document.querySelector<HTMLElement>('[data-testid="thread-archive-thread-browser-test"]'),
        "Unable to find the sidebar thread archive action.",
      );
      const settingsTrigger = await waitForElement(
        () => document.querySelector<HTMLElement>('[aria-label^="Open project settings for"]'),
        "Unable to find the project settings action.",
      );
      const headerButton = await waitForElement(
        () =>
          settingsTrigger.parentElement?.querySelector<HTMLElement>(
            '[data-sidebar="menu-button"]',
          ) ?? null,
        "Unable to find the project header row button.",
      );

      // Rect-based values can carry sub-pixel scaling from the shared test
      // iframe, so they get range/tolerance assertions; computed styles are
      // unscaled CSS px and stay exact.
      const measureDensity = () => ({
        threadRowHeight: threadRow.getBoundingClientRect().height,
        archiveActionWidth: archiveAction.getBoundingClientRect().width,
        archiveHitAreaContent: getComputedStyle(archiveAction, "::after").content,
        headerPaddingRight: getComputedStyle(headerButton).paddingRight,
        settingsRight: getComputedStyle(settingsTrigger).right,
        settingsTop: getComputedStyle(settingsTrigger).top,
      });

      const baseline = measureDensity();
      // Desktop values: 28px rows (h-7) and 20px actions (size-5); the coarse
      // variants would be 44px rows and 32px actions.
      expect(baseline.threadRowHeight).toBeLessThanOrEqual(28.5);
      expect(baseline.archiveActionWidth).toBeGreaterThanOrEqual(18);
      expect(baseline.archiveActionWidth).toBeLessThanOrEqual(22);
      expect(baseline.archiveHitAreaContent).toBe("none");
      // pr-26 reserves the four fine-pointer header actions (new thread,
      // overview, new workspace, settings).
      expect(baseline.headerPaddingRight).toBe("104px");
      expect(baseline.settingsRight).toBe("6px");
      expect(baseline.settingsTop).toBe("4px");

      // A coarse pointer at tablet width must not change the desktop density
      // or positioning: 768x1024 stays on the desktop tier, and the
      // touch-target styles are gated on the phone tier.
      await withCoarsePointer(async () => {
        await waitForLayout();
        const coarse = measureDensity();
        expect(Math.abs(coarse.threadRowHeight - baseline.threadRowHeight)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(coarse.archiveActionWidth - baseline.archiveActionWidth),
        ).toBeLessThanOrEqual(1);
        expect(coarse.archiveHitAreaContent).toBe(baseline.archiveHitAreaContent);
        expect(coarse.headerPaddingRight).toBe(baseline.headerPaddingRight);
        expect(coarse.settingsRight).toBe(baseline.settingsRight);
        expect(coarse.settingsTop).toBe(baseline.settingsTop);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses the composer across the whole phone tier, including 640-767px viewports", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-tier-collapse" as MessageId,
        targetText: "tier collapse thread",
      }),
    });

    try {
      // 700px previously kept the expanded desktop composer (collapse applied
      // only below 640); the phone tier now collapses it consistently across
      // the whole sub-768px range.
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
      });

      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows exactly one set of pending-answer actions on a 700px phone-tier viewport", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      // Focus the always-mounted editor so the mobile pending-answer overlay
      // engages. (The collapsed pending row no longer carries a stand-in pill;
      // the collapsed editor is the tap target.)
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
        expect(
          document.querySelector('[data-chat-composer-mobile-pending-actions="true"]'),
        ).not.toBeNull();
      });

      // The footer's own primary actions must be hidden while the overlay
      // renders: at 640-767px the old width-based sm:flex re-showed them and
      // doubled the pending actions.
      const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
      expect(footer).not.toBeNull();
      expect(getComputedStyle(footer!).display).toBe("none");

      const visibleSubmitActions = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-chat-composer-form="true"] button[type="submit"]',
        ),
      ).filter((button) => button.getBoundingClientRect().width > 0);
      expect(visibleSubmitActions.length).toBe(1);
      expect(
        document
          .querySelector('[data-chat-composer-mobile-pending-actions="true"]')
          ?.contains(visibleSubmitActions[0] ?? null),
      ).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows exactly one set of pending-answer actions on a coarse landscape phone", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_LANDSCAPE_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      await withCoarsePointer(async () => {
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        (document.activeElement as HTMLElement | null)?.blur();
        await page.getByTestId("composer-editor").click();
        await vi.waitFor(() => {
          expect(
            document.querySelector('[data-chat-composer-mobile-pending-actions="true"]'),
          ).not.toBeNull();
        });

        const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
        expect(footer).not.toBeNull();
        expect(getComputedStyle(footer!).display).toBe("none");

        const visibleSubmitActions = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-chat-composer-form="true"] button[type="submit"]',
          ),
        ).filter((button) => button.getBoundingClientRect().width > 0);
        expect(visibleSubmitActions.length).toBe(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves route, draft, and panel search state across a mid-size rotation tier flip", async () => {
    const targetMessageId = "msg-user-rotation-flip" as MessageId;
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: "rotation flip thread",
      }),
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?messageId=${targetMessageId}`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const initialPathname = mounted.router.state.location.pathname;
      const initialSearch = mounted.router.state.location.searchStr;
      expect(initialSearch).toContain("messageId");

      useComposerDraftStore.getState().setPrompt(THREAD_REF, "rotation draft probe");

      // Scroll the timeline away from its bottom-anchored start to a
      // mid-list offset and note a message row visible at that position.
      const timelineRow = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-message-id]"),
        "Unable to find a timeline message row.",
      );
      const scrollContainer = findScrollableAncestor(timelineRow);
      expect(scrollContainer).not.toBeNull();
      // Scroll to the upper quarter of the list: clearly away from the
      // bottom-anchored start and outside the maintain-at-end band. The list
      // keeps re-pinning to the end until its scroll handler observes the
      // user-initiated position, so re-assert the offset until it sticks.
      const targetScrollTop = Math.max(
        300,
        (scrollContainer!.scrollHeight - scrollContainer!.clientHeight) / 4,
      );
      await vi.waitFor(async () => {
        scrollContainer!.scrollTop = targetScrollTop;
        // Match a real user scroll after the viewport is away from the end.
        // The live-follow latch intentionally ignores bare programmatic
        // scrollTop writes so layout corrections cannot turn off streaming
        // follow mode by accident.
        scrollContainer!.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true }),
        );
        await waitForLayout();
        expect(Math.abs(scrollContainer!.scrollTop - targetScrollTop)).toBeLessThan(50);
        expect(findScrollToBottomButton()).not.toBeNull();
      });
      // Confirm the position holds without further re-assertion.
      await waitForLayout();
      await waitForLayout();
      expect(Math.abs(scrollContainer!.scrollTop - targetScrollTop)).toBeLessThan(50);

      // The scroller must survive the flips in place. Losing state would
      // surface as a fresh scroller element, a reset to the top, or a
      // remount re-running the initial scroll-to-end; a preserved position
      // stays strictly interior. (The virtualizer legitimately shifts the
      // pixel offset while re-measuring row heights for the new column
      // width, so an exact-pixel assertion would overconstrain.)
      const expectScrollPositionPreserved = () => {
        expect(scrollContainer!.isConnected).toBe(true);
        const maxScrollTop = scrollContainer!.scrollHeight - scrollContainer!.clientHeight;
        expect(scrollContainer!.scrollTop).toBeGreaterThan(100);
        expect(scrollContainer!.scrollTop).toBeLessThan(maxScrollTop * 0.8);
      };

      // Rotate across the 768px tier boundary: the desktop shell replaces the
      // drawer without resetting route, draft, or panel search state.
      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(document.querySelector('[data-slot="sidebar-container"]')).not.toBeNull();
      });
      expect(mounted.router.state.location.pathname).toBe(initialPathname);
      expect(mounted.router.state.location.searchStr).toBe(initialSearch);
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
        "rotation draft probe",
      );
      // The desktop composer renders the preserved draft.
      await vi.waitFor(() => {
        const editor = document.querySelector('[data-testid="composer-editor"]');
        expect(editor?.textContent ?? "").toContain("rotation draft probe");
      });
      // The timeline keeps its anchored scroll position: the row visible
      // before the flip stays rendered inside the scroll viewport and the
      // offset is not reset.
      await vi.waitFor(expectScrollPositionPreserved);

      // Rotate back: same route, draft, and search state on the phone tier.
      await mounted.setViewport(NARROW_TABLET_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        expect(document.querySelector('[data-slot="sidebar-container"]')).toBeNull();
      });
      expect(mounted.router.state.location.pathname).toBe(initialPathname);
      expect(mounted.router.state.location.searchStr).toBe(initialSearch);
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt).toBe(
        "rotation draft probe",
      );
      // Scroll anchoring survives the round trip as well.
      await vi.waitFor(expectScrollPositionPreserved);
    } finally {
      await mounted.cleanup();
    }
  });

  it("serves the phone structural presentation to a wide coarse-pointer landscape viewport", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_LANDSCAPE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-coarse-landscape" as MessageId,
        targetText: "coarse landscape thread",
      }),
    });

    try {
      // A fine pointer at 844x390 stays on the desktop tier (width-based
      // clause does not match, pointer clause requires coarse).
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(document.querySelector('[data-slot="sidebar-container"]')).not.toBeNull();
      });

      await withCoarsePointer(async () => {
        // The pointer clause reclassifies the same viewport as a phone: the
        // persistent sidebar unmounts and the compact thread app bar renders
        // its back affordance (width-only styling kept the desktop header at
        // 844px before).
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
          expect(document.querySelector('[data-slot="sidebar-container"]')).toBeNull();
          expect(document.querySelector('button[aria-label="Back to threads"]')).not.toBeNull();
          expect(document.querySelector('button[aria-label="Thread actions"]')).not.toBeNull();
        });

        // The composer collapses like any other phone-tier viewport once the
        // editor loses focus (a focused editor is intentionally kept
        // expanded across the tier flip).
        (document.activeElement as HTMLElement | null)?.blur();
        await vi.waitFor(() => {
          expect(
            document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
          ).not.toBeNull();
        });
      });

      // Reverting the pointer restores the desktop presentation in place; the
      // phone app bar unmounts with the tier flip.
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(document.querySelector('button[aria-label="Back to threads"]')).toBeNull();
        expect(document.querySelector('[data-slot="sidebar-container"]')).not.toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("focuses the phone composer editor in the activating task on the first tap", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-first-tap" as MessageId,
        targetText: "first tap focus thread",
      }),
    });

    const order: string[] = [];
    const focusInTargets: EventTarget[] = [];
    const scheduleRacingFrame = () => {
      window.requestAnimationFrame(() => order.push("frame"));
    };
    const recordFocusIn = (event: Event) => {
      focusInTargets.push(event.target as EventTarget);
      order.push("focusin");
    };

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-composer-mobile-collapsed]"),
        "Unable to find the phone composer surface.",
      );
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      // Opening a thread on a phone leaves the composer collapsed: the first
      // tap is the user's, and it is the one that must raise the keyboard.
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
      });

      // Structural: the collapsed composer must present the real editor, not a
      // stand-in. A `display: none` editor cannot receive the activating tap at
      // all, so no amount of focus-timing work can raise the keyboard.
      const editor = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );
      expect(getComputedStyle(editor).display).not.toBe("none");
      expect(editor.offsetParent).not.toBeNull();
      expect(editor.getBoundingClientRect().height).toBeGreaterThan(0);

      // Ordering: a post-await read of document.activeElement cannot tell a
      // synchronous focus from a next-frame focus, because the harness yields
      // across the tap. The racing frame is scheduled from inside the
      // pointerdown of the very same gesture, so "focusin" can only be
      // recorded first when focus lands in the activation task itself.
      document.addEventListener("pointerdown", scheduleRacingFrame, {
        once: true,
        capture: true,
      });
      document.addEventListener("focusin", recordFocusIn, {
        once: true,
        capture: true,
      });

      await page.getByTestId("composer-editor").click();

      await vi.waitFor(() => {
        expect(order).toContain("focusin");
        expect(order).toContain("frame");
      });
      expect(order[0]).toBe("focusin");
      // The recorded focus must be the editor's own, not some other node that
      // happened to take focus first during the same gesture.
      expect(focusInTargets[0]).toBe(editor);
      expect(document.activeElement).toBe(editor);
    } finally {
      document.removeEventListener("pointerdown", scheduleRacingFrame, true);
      document.removeEventListener("focusin", recordFocusIn, true);
      await mounted.cleanup();
    }
  });

  it("sends from the collapsed phone send affordance on a single tap", async () => {
    // Seed the draft before mount so the composer renders collapsed with
    // sendable content and no post-mount controlled update can transiently
    // focus the editor.
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "Collapsed send probe");
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-collapsed-send" as MessageId,
        targetText: "collapsed send thread",
      }),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        }
        return undefined;
      },
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-composer-mobile-collapsed]"),
        "Unable to find the phone composer surface.",
      );
      // The desktop-to-phone viewport switch settles matchMedia a frame late,
      // which can transiently focus the composer before the tier resolves;
      // blur and wait for a stable collapsed state so the tap below is
      // genuinely the collapsed send affordance and not the expanded footer.
      (document.activeElement as HTMLElement | null)?.blur();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
        expect(document.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
      });
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);

      // A real pointer sequence, not element.click(): engines that focus a
      // button on pointerdown would otherwise expand the composer through the
      // surface's focus handler and unmount this button before `click` is
      // dispatched, silently dropping the send.
      await page.getByRole("button", { name: "Send message" }).click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                (request as { type?: string }).type === "thread.turn.start",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the collapsed phone composer expandable while the environment is unavailable", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-unavailable-expand" as MessageId,
        targetText: "unavailable expand thread",
      }),
    });

    const previousPrimaryDescriptor = readPrimaryEnvironmentDescriptor();

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-mobile-collapsed="true"]'),
        "Unable to find the collapsed phone composer.",
      );
      // Re-point the primary environment so the thread's own environment
      // resolves as a saved, non-primary one; with no live runtime it reports
      // as unavailable, which is what disables the composer editor.
      expect(previousPrimaryDescriptor).not.toBeNull();
      writePrimaryEnvironmentDescriptor({
        ...previousPrimaryDescriptor!,
        environmentId: REMOTE_ENVIRONMENT_ID,
      });
      useSavedEnvironmentRegistryStore.getState().upsert({
        environmentId: LOCAL_ENVIRONMENT_ID,
        label: "Workstation",
        httpBaseUrl: "https://workstation.example.test",
        wsBaseUrl: "wss://workstation.example.test/ws",
        createdAt: NOW_ISO,
        lastConnectedAt: NOW_ISO,
      });

      const editor = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );
      // A disabled editor is `contenteditable="false"` and cannot take focus,
      // so the collapsed surface has nothing focusable in it at all.
      await vi.waitFor(() => {
        expect(editor.getAttribute("contenteditable")).toBe("false");
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
        expect(document.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
      });

      await page.getByTestId("composer-editor").click();

      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
      // Reachable, not merely mounted: the model picker is the entry point to
      // the footer control set that the collapsed dead end hid.
      const modelPicker = await waitForElement(
        () => findComposerProviderModelPicker(),
        "Unable to find the composer model picker.",
      );
      expect(getComputedStyle(modelPicker).display).not.toBe("none");
      expect(modelPicker.getBoundingClientRect().width).toBeGreaterThan(0);
    } finally {
      writePrimaryEnvironmentDescriptor(previousPrimaryDescriptor);
      await mounted.cleanup();
    }
  });

  /**
   * The state whose layout the dock relocation changed: the dock now renders
   * inside `ChatComposer`, beneath the approval panel and above the prompt row.
   * The collapsed composer's activating tap must still reach the editor — the
   * dock must not overlay it, intercept the gesture, or remount it.
   *
   * An approval disables the editor (`contenteditable="false"`, pre-existing:
   * the approval must be answered before typing), so this state expands through
   * the surface's explicit onClick path rather than through native focus. The
   * unconditional first-tap focus guarantee is asserted separately by "focuses
   * the phone composer editor in the activating task on the first tap".
   */
  it("expands the collapsed phone composer on a single tap with an approval open", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
        "Unable to find the pending approval detail block.",
      );
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-mobile-collapsed="true"]'),
        "Unable to find the collapsed phone composer.",
      );
      const dock = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="phone-thread-dock"]'),
        "Unable to find the phone thread dock.",
      );
      const editor = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );
      await waitForLayout();

      // The editor is presented, not swapped out: a display:none or zero-size
      // editor could not receive the activating tap at all.
      expect(getComputedStyle(editor).display).not.toBe("none");
      expect(editor.offsetParent).not.toBeNull();
      const editorRect = editor.getBoundingClientRect();
      expect(editorRect.height).toBeGreaterThan(0);

      // The dock is laid out above the prompt row, not over it, and nothing it
      // renders answers a hit test anywhere across the editor's tap target.
      const dockRect = dock.getBoundingClientRect();
      expect(dockRect.bottom).toBeLessThanOrEqual(editorRect.top + 0.5);
      for (let step = 0; step <= 10; step += 1) {
        const x = editorRect.left + (editorRect.width * step) / 10;
        const y = editorRect.top + editorRect.height / 2;
        const hit = document.elementFromPoint(
          Math.min(Math.max(x, editorRect.left + 0.5), editorRect.right - 0.5),
          y,
        );
        expect(
          hit !== null && dock.contains(hit),
          `the thread dock answers the collapsed editor's tap target at (${Math.round(x)}, ${Math.round(y)})`,
        ).toBe(false);
      }

      await page.getByTestId("composer-editor").click();

      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
      // The same editor node, never remounted by the expansion — that identity
      // is what lets the activating tap's focus survive in the enabled case.
      expect(document.querySelector('[data-testid="composer-editor"]')).toBe(editor);
    } finally {
      await mounted.cleanup();
    }
  });

  /**
   * The dock is now a descendant of the composer surface, so the surface's
   * collapse check has to treat focus landing on it as *not* composer focus.
   * Otherwise tapping the workspace toggle blurs the editor — the software
   * keyboard leaves — while the composer keeps its full expanded height, and
   * nothing ever moves focus back out of the surface to correct it.
   */
  it("collapses the expanded phone composer when focus lands on a thread dock control", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-dock-focus-collapse" as MessageId,
        targetText: "dock focus collapse thread",
      }),
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-mobile-collapsed="true"]'),
        "Unable to find the collapsed phone composer.",
      );
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });

      const toggle = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-slot="phone-thread-dock"] button[aria-label="Toggle workspace panel"]',
          ),
        "Unable to find the dock's workspace toggle.",
      );
      // The toggle is a descendant of the composer surface, which is exactly
      // why the collapse check would otherwise keep the composer expanded.
      expect(toggle.closest("[data-chat-composer-mobile-collapsed]")).not.toBeNull();
      expect(toggle.getAttribute("aria-pressed")).toBe("false");

      // Focus is moved explicitly rather than by clicking: engines differ on
      // whether a click focuses a button (Chromium on Android does, Chromium on
      // macOS — where this suite runs — does not), and it is the focus landing,
      // not the click, that this asserts.
      toggle.focus();
      expect(document.activeElement).toBe(toggle);

      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
        ).not.toBeNull();
      });

      // The tap that moved focus there must still land: the dock renders
      // identically in both states, so the collapse relayout cannot unmount the
      // control out from under it.
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
      await page.getByRole("button", { name: "Toggle workspace panel" }).click();
      // The collapse relayout must not steal the tap it was triggered by: the
      // dock renders identically in both states, so the control stays mounted
      // and the toggle still lands.
      await vi.waitFor(() => {
        expect(toggle.getAttribute("aria-pressed")).toBe("true");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a 16px composer type size across the whole phone tier", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-type-size" as MessageId,
        targetText: "phone type size thread",
      }),
    });

    const editorFontSize = (): number => {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      return Number.parseFloat(getComputedStyle(editor!).fontSize);
    };

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-editor"]'),
        "Unable to find the composer editor.",
      );

      // 640-767px portrait is phone tier. A width-based `sm:` boundary dropped
      // the editor to 14px here, which makes iOS zoom the page on focus.
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        expect(editorFontSize()).toBeGreaterThanOrEqual(16);
      });

      // Coarse landscape is phone tier by pointer, not by width.
      await mounted.setViewport(PHONE_LANDSCAPE_VIEWPORT);
      await withCoarsePointer(async () => {
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
          expect(editorFontSize()).toBeGreaterThanOrEqual(16);
        });
      });

      // Desktop keeps its 14px density.
      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        expect(editorFontSize()).toBe(14);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps approval actions visible when an approval arrives while the phone composer is expanded", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-approval-expanded" as MessageId,
        targetText: "phone expanded approval thread",
      }),
    });

    try {
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });

      // Deliver the approval over the live thread subscription, mirroring an
      // approval arriving while the user has the composer open.
      const approvalSnapshot = createSnapshotWithPendingApproval();
      fixture.snapshot = approvalSnapshot;
      const approvalThread = approvalSnapshot.threads.find((thread) => thread.id === THREAD_ID);
      if (!approvalThread) {
        throw new Error("Expected the approval thread in the snapshot.");
      }
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThreadWindow, {
        kind: "snapshot",
        snapshot: toThreadWindowSnapshot(approvalSnapshot.snapshotSequence + 1, approvalThread),
      });

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
        "Unable to find the pending approval detail block.",
      );
      await waitForLayout();

      // Whether the composer stays expanded or collapses once the editor is
      // disabled, every approval action must remain fully visible at 390px.
      const buttons: HTMLElement[] = [];
      for (const label of APPROVAL_ACTION_LABELS) {
        buttons.push(
          await waitForElement(
            () => findButtonByText(label),
            `Unable to find approval action "${label}".`,
          ),
        );
      }
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(-0.5);
        expect(rect.right).toBeLessThanOrEqual(PHONE_VIEWPORT.width + 0.5);
        expect(rect.top).toBeGreaterThanOrEqual(-0.5);
        expect(rect.bottom).toBeLessThanOrEqual(PHONE_VIEWPORT.height + 0.5);
      }
      // The four actions cannot fit one 390px line, so the row must wrap.
      const rowTops = new Set(
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
      );
      expect(rowTops.size).toBeGreaterThan(1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the composer and send action above a stubbed software keyboard on phones", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-keyboard-composer" as MessageId,
        targetText: "keyboard composer thread",
      }),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      const rootStyle = document.documentElement.style;
      for (const { viewport, keyboardInset } of [
        { viewport: PHONE_VIEWPORT, keyboardInset: 300 },
        { viewport: NARROW_PHONE_VIEWPORT, keyboardInset: 250 },
      ]) {
        await mounted.setViewport(viewport);
        await expandPhoneComposerIfCollapsed();

        const composerForm = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
          "Unable to find the composer form.",
        );
        const sendButton = await waitForSendButton();
        const baselineFormBottom = composerForm.getBoundingClientRect().bottom;

        viewportStub.setKeyboardInset(keyboardInset);
        await waitForLayout();

        expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe(`${keyboardInset}px`);
        expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe(
          `${viewport.height - keyboardInset}px`,
        );

        const visibleBottom = viewport.height - keyboardInset;
        await vi.waitFor(() => {
          const formRect = composerForm.getBoundingClientRect();
          const sendRect = sendButton.getBoundingClientRect();
          expect(formRect.height).toBeGreaterThan(0);
          expect(formRect.top).toBeGreaterThanOrEqual(-0.5);
          expect(formRect.bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
          expect(sendRect.height).toBeGreaterThan(0);
          expect(sendRect.top).toBeGreaterThanOrEqual(-0.5);
          expect(sendRect.bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
        });

        // Hiding the keyboard removes the variables and restores the exact
        // keyboard-closed geometry.
        viewportStub.setKeyboardInset(0);
        await waitForLayout();
        expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("");
        expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe("");
        await vi.waitFor(() => {
          expect(composerForm.getBoundingClientRect().bottom).toBeCloseTo(baselineFormBottom, 0);
        });
      }
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("keeps approval detail and actions visible above a stubbed software keyboard", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      const detail = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
        "Unable to find the pending approval detail block.",
      );

      const keyboardInset = 300;
      viewportStub.setKeyboardInset(keyboardInset);
      await waitForLayout();

      const visibleBottom = PHONE_VIEWPORT.height - keyboardInset;
      await vi.waitFor(() => {
        const detailRect = detail.getBoundingClientRect();
        expect(detailRect.height).toBeGreaterThan(0);
        expect(detailRect.top).toBeGreaterThanOrEqual(-0.5);
        expect(detailRect.bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
      });
      for (const label of APPROVAL_ACTION_LABELS) {
        const button = await waitForElement(
          () => findButtonByText(label),
          `Unable to find approval action "${label}".`,
        );
        const rect = button.getBoundingClientRect();
        expect(rect.height).toBeGreaterThan(0);
        expect(rect.top).toBeGreaterThanOrEqual(-0.5);
        expect(rect.bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
      }
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("clamps the mention/command menu to the visible viewport height with the keyboard open", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-keyboard-command-menu" as MessageId,
        targetText: "keyboard command menu thread",
      }),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      for (const { viewport, keyboardInset, expectTopWithinViewport } of [
        {
          viewport: PHONE_VIEWPORT,
          keyboardInset: 300,
          expectTopWithinViewport: true,
        },
        {
          viewport: NARROW_PHONE_VIEWPORT,
          keyboardInset: 250,
          expectTopWithinViewport: true,
        },
        // Landscape with the keyboard open leaves less visible height than
        // the clamp allowance; the 4.5rem floor must keep the menu usable
        // instead of collapsing it to 0px, even if its top edge is cropped.
        {
          viewport: PHONE_LANDSCAPE_VIEWPORT,
          keyboardInset: 160,
          expectTopWithinViewport: false,
        },
      ]) {
        await mounted.setViewport(viewport);
        await expandPhoneComposerIfCollapsed();
        await waitForComposerEditor();
        await page.getByTestId("composer-editor").fill("/");
        await waitForComposerMenuItem("slash:model");

        const menuList = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-slot="command-list"]'),
          "Unable to find the composer command menu list.",
        );
        // Keyboard-closed baseline: the historical 18rem cap applies on every
        // viewport because the fallback never engages without the adapter.
        expect(getComputedStyle(menuList).maxHeight).toBe("288px");

        viewportStub.setKeyboardInset(keyboardInset);
        await waitForLayout();

        const visibleHeight = viewport.height - keyboardInset;
        // 18rem cap clamped by the visible height minus the composer allowance,
        // floored at 4.5rem (see ComposerCommandMenu). The phone tier's control
        // row carries 44px touch targets instead of 28px `xs` controls, so it
        // takes the 13.5rem allowance rather than 12.5rem.
        const composerAllowance =
          document.documentElement.getAttribute("data-tier") === "phone" ? 216 : 200;
        const expectedMaxHeight = Math.min(288, Math.max(72, visibleHeight - composerAllowance));
        await vi.waitFor(() => {
          expect(getComputedStyle(menuList).maxHeight).toBe(`${expectedMaxHeight}px`);
          const menuRect = menuList.getBoundingClientRect();
          expect(menuRect.height).toBeGreaterThan(40);
          if (expectTopWithinViewport) {
            expect(menuRect.top).toBeGreaterThanOrEqual(-0.5);
          }
          expect(menuRect.bottom).toBeLessThanOrEqual(visibleHeight + 0.5);
        });

        viewportStub.setKeyboardInset(0);
        await waitForLayout();
        expect(getComputedStyle(menuList).maxHeight).toBe("288px");
        await page.getByTestId("composer-editor").fill("");
      }
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("tracks keyboard insets across orientation changes and removes them when closed", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_LANDSCAPE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-keyboard-orientation" as MessageId,
        targetText: "keyboard orientation thread",
      }),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      const rootStyle = document.documentElement.style;

      viewportStub.setKeyboardInset(160);
      await waitForLayout();
      expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("160px");
      expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe(
        `${PHONE_LANDSCAPE_VIEWPORT.height - 160}px`,
      );
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find the composer form.",
      );
      await vi.waitFor(() => {
        expect(composerForm.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.height - 160 + 0.5,
        );
      });

      // Rotating to portrait re-derives the inset from the new geometry.
      await mounted.setViewport(PHONE_VIEWPORT);
      viewportStub.setKeyboardInset(300);
      await waitForLayout();
      expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("300px");
      expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe(
        `${PHONE_VIEWPORT.height - 300}px`,
      );

      viewportStub.setKeyboardInset(0);
      await waitForLayout();
      expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("");
      expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe("");
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("publishes no keyboard variables and changes no composer geometry without an inset", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-keyboard-desktop-baseline" as MessageId,
        targetText: "keyboard desktop baseline thread",
      }),
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find the composer form.",
      );
      const sendButton = await waitForSendButton();
      // Settle before the baseline is taken, not after.
      //
      // The composer's position depends on the virtualized timeline above it,
      // which converges over several frames after mount. Reading immediately
      // captured a mid-convergence position, and the comparison below then
      // attributed the remaining settling to the resize under test — a
      // ~313px "movement" that no resize caused.
      //
      // That made the assertion sensitive to anything that changes how long
      // style recalculation takes, including the *size of the stylesheet*:
      // adding 80 lines of inert CSS that no element in this suite matches was
      // enough to flip it, reproducibly. Waiting for two consecutive identical
      // readings measures what the test is named for — that a resize with no
      // keyboard inset moves nothing — instead of racing the timeline.
      // Stability is required across consecutive frames, not merely between two
      // reads: the timeline settles in bursts, so two samples taken inside one
      // quiet gap can agree while convergence is still in progress.
      let stableFrames = 0;
      let previousTop = Number.NaN;
      for (let attempt = 0; attempt < 600 && stableFrames < 8; attempt += 1) {
        await nextFrame();
        const top = composerForm.getBoundingClientRect().top;
        stableFrames = top === previousTop ? stableFrames + 1 : 0;
        previousTop = top;
      }
      expect(stableFrames, "composer geometry never stopped converging").toBeGreaterThanOrEqual(8);
      const baselineFormRect = composerForm.getBoundingClientRect();
      const baselineSendRect = sendButton.getBoundingClientRect();

      // A resize without any keyboard inset must publish nothing and move
      // nothing (desktop baseline guard).
      viewportStub.resizeTo({});
      await waitForLayout();

      const rootStyle = document.documentElement.style;
      expect(rootStyle.getPropertyValue(KEYBOARD_INSET_CSS_VAR)).toBe("");
      expect(rootStyle.getPropertyValue(VISIBLE_VIEWPORT_HEIGHT_CSS_VAR)).toBe("");

      const formRect = composerForm.getBoundingClientRect();
      const sendRect = sendButton.getBoundingClientRect();
      expect(formRect.top).toBeCloseTo(baselineFormRect.top, 2);
      expect(formRect.bottom).toBeCloseTo(baselineFormRect.bottom, 2);
      expect(sendRect.top).toBeCloseTo(baselineSendRect.top, 2);
      expect(sendRect.bottom).toBeCloseTo(baselineSendRect.bottom, 2);
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("promotes the workspace panel to a full-screen phone surface with history-coherent back", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-work-surface-promotion" as MessageId,
        targetText: "work surface promotion thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: "/",
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });

      // Home -> thread: the navigation stack the surface must unwind through.
      const homeHeading = await waitForElement(
        () => document.querySelector<HTMLElement>("h1"),
        "Unable to find the Home heading.",
      );
      expect(homeHeading.textContent).toBe("Threads");
      const threadRow = await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>('[role="listitem"] button')].find((button) =>
            button.textContent?.includes(THREAD_TITLE),
          ) ?? null,
        "Unable to find the Home thread row.",
      );
      threadRow.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(
          `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`,
        );
      });

      // The app-bar workspace toggle opens the full-screen surface (launcher).
      const workspaceToggle = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Toggle workspace panel"]'),
        "Unable to find the workspace toggle.",
      );
      workspaceToggle.click();
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(PHONE_VIEWPORT.height - 0.5);
      });
      expect(mounted.router.state.location.searchStr).toContain("workspaceOpen");

      // Launcher content fits the phone pane: the card stack scrolls instead
      // of clipping above the scroll start.
      const launcherViewport = await waitForElement(
        () => popup.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]'),
        "Unable to find the launcher scroll viewport.",
      );
      await vi.waitFor(() => {
        expect(launcherViewport.scrollHeight).toBeGreaterThan(launcherViewport.clientHeight);
      });
      launcherViewport.scrollTop = 0;
      await waitForLayout();
      const filesCard = await waitForElement(
        () =>
          [...launcherViewport.querySelectorAll<HTMLElement>("button")].find((button) =>
            button.textContent?.includes("Browse project files"),
          ) ?? null,
        "Unable to find the Files launcher card.",
      );
      expect(filesCard.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        launcherViewport.getBoundingClientRect().top - 0.5,
      );

      // Launcher -> Review pushes the diff surface through the same URL
      // params desktop uses.
      const reviewCard = await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find((button) =>
            button.textContent?.includes("View code changes"),
          ) ?? null,
        "Unable to find the Review launcher card.",
      );
      reviewCard.click();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceTab).toBe("review");
        expect(search.diff).toBe("1");
      });

      // Surface bar: visible back affordance with a 44px coarse hit area.
      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the surface back affordance.",
      );
      await withCoarsePointer(async () => {
        const hitArea = getComputedStyle(backButton, "::after");
        expect(hitArea.position).toBe("absolute");
        expect(parseFloat(hitArea.width)).toBeGreaterThanOrEqual(44);
        expect(parseFloat(hitArea.height)).toBeGreaterThanOrEqual(44);
      });

      // Phone review surface: wrap defaults on, the split toggle is gone, and
      // the page never scrolls horizontally.
      await waitForElement(
        () => popup.querySelector<HTMLElement>('[aria-label="Disable diff line wrapping"]'),
        "Unable to find the pressed wrap toggle.",
      );
      expect(popup.querySelector('[aria-label="Split diff view"]')).toBeNull();
      expect(popup.querySelector('[aria-label="Stacked diff view"]')).toBeNull();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE_VIEWPORT.width);

      // Browser back exits the surface to the thread, then Home — never the
      // app. (Tab pushes replace the launcher entry, so one back suffices.)
      mounted.router.history.back();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceTab).toBeUndefined();
        expect(search.diff).toBeUndefined();
        expect(search.workspaceOpen).toBeUndefined();
        expect(isElementVisible(popup)).toBe(false);
      });
      expect(mounted.router.state.location.pathname).toBe(`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`);
      mounted.router.history.back();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/");
      });
      await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>("h1")].find(
            (heading) => heading.textContent === "Threads",
          ) ?? null,
        "Unable to find the Home heading after unwinding history.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders desktop-shaped workspace links full-screen at 320px with contained diff scrolling and a files push", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-work-surface-roundtrip" as MessageId,
        targetText: "work surface roundtrip thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=review&diff=1`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });

      // The desktop-shaped deep link lands directly on the full-screen diff.
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(NARROW_PHONE_VIEWPORT.height - 0.5);
      });
      await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the surface back affordance.",
      );

      // The wide diff renders wrapped by default with no page-level overflow.
      await waitForElement(
        () => popup.querySelector<HTMLElement>('[data-diff-file-path="src/wide.ts"]'),
        "Unable to find the rendered diff file.",
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width);

      // Disabling wrap keeps the horizontal overflow inside the diff surface.
      const wrapToggle = await waitForElement(
        () => popup.querySelector<HTMLElement>('[aria-label="Disable diff line wrapping"]'),
        "Unable to find the wrap toggle.",
      );
      wrapToggle.click();
      const wideDiffFile = await waitForElement(
        () => popup.querySelector<HTMLElement>('[data-diff-file-path="src/wide.ts"]'),
        "Unable to find the rendered diff file after toggling wrap.",
      );
      await vi.waitFor(
        () => {
          expect(hasContainedHorizontalDiffOverflow(wideDiffFile)).toBe(true);
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
            NARROW_PHONE_VIEWPORT.width,
          );
        },
        { timeout: 10_000, interval: 50 },
      );

      // Files surface: single-pane tree -> full-width file view -> back.
      const launcherButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Workspace launcher"]'),
        "Unable to find the workspace launcher button.",
      );
      launcherButton.click();
      const filesCard = await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find((button) =>
            button.textContent?.includes("Browse project files"),
          ) ?? null,
        "Unable to find the Files launcher card.",
      );
      filesCard.click();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceTab).toBe("files");
        expect(search.preview).toBe("1");
      });
      // The tree renders full-width (no split rail, no tree toggle).
      const readmeRow = await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find(
            (button) => button.textContent?.trim() === "README.md",
          ) ?? null,
        "Unable to find the README.md tree row.",
      );
      expect(popup.querySelector("[data-preview-file-rail]")).toBeNull();
      expect(popup.querySelector('[aria-label="Hide workspace tree"]')).toBeNull();
      expect(readmeRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      readmeRow.click();
      const backToTree = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to workspace tree"]'),
        "Unable to find the back-to-tree affordance.",
      );
      // The file view replaces the tree in the single pane and renders the
      // fetched contents (inside the @pierre/diffs shadow DOM).
      expect(popup.querySelector('[aria-label="Filter files"]')).toBeNull();
      await vi.waitFor(
        () => {
          expect(surfaceContainsText(popup, "Work surface readme")).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );
      backToTree.click();
      await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find(
            (button) => button.textContent?.trim() === "README.md",
          ) ?? null,
        "Unable to find the tree after backing out of the file view.",
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width);

      // Back clears the same URL params desktop writes and returns to the
      // thread (no trap).
      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the surface back affordance.",
      );
      backButton.click();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceOpen).toBeUndefined();
        expect(search.workspaceTab).toBeUndefined();
        expect(search.preview).toBeUndefined();
        expect(isElementVisible(popup)).toBe(false);
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the thread app bar after closing the surface.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the terminal surface full-screen with a 44px toolbar above a stubbed keyboard", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-work-surface-terminal" as MessageId,
        targetText: "work surface terminal thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=terminal`,
    });

    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      await vi.waitFor(() => {
        expect(popup.getBoundingClientRect().width).toBeGreaterThanOrEqual(
          PHONE_VIEWPORT.width - 0.5,
        );
      });
      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the surface back affordance.",
      );

      // The terminal toolbar reaches the 44px phone floor.
      const toolbar = await waitForElement(
        () => popup.querySelector<HTMLElement>('[role="tablist"][aria-label="Terminals"]'),
        "Unable to find the terminal toolbar.",
      );
      await vi.waitFor(() => {
        expect(toolbar.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      });
      const newTerminalButton = await waitForElement(
        () =>
          [...popup.querySelectorAll<HTMLElement>("button")].find((button) =>
            button.getAttribute("aria-label")?.startsWith("New Terminal"),
          ) ?? null,
        "Unable to find the New Terminal action.",
      );
      expect(newTerminalButton.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      expect(newTerminalButton.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

      // With the software keyboard open, the surface shrinks by the published
      // inset: the terminal container (toolbar included) stays fully visible.
      const keyboardInset = 300;
      viewportStub.setKeyboardInset(keyboardInset);
      await waitForLayout();
      const visibleBottom = PHONE_VIEWPORT.height - keyboardInset;
      await vi.waitFor(() => {
        const drawer = popup.querySelector<HTMLElement>(".thread-terminal-drawer");
        expect(drawer).not.toBeNull();
        expect(drawer!.getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
        expect(toolbar.getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom + 0.5);
        expect(toolbar.getBoundingClientRect().top).toBeGreaterThanOrEqual(-0.5);
      });
      viewportStub.setKeyboardInset(0);
      await waitForLayout();

      // The terminal surface exits cleanly back to the thread through its own
      // back affordance (acceptance criterion, asserted on this surface).
      backButton.click();
      await vi.waitFor(() => {
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceOpen).toBeUndefined();
        expect(search.workspaceTab).toBeUndefined();
        expect(isElementVisible(popup)).toBe(false);
      });
      expect(mounted.router.state.location.pathname).toBe(`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`);
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the thread app bar after closing the terminal surface.",
      );
    } finally {
      stopAdapter();
      viewportStub.restore();
      await mounted.cleanup();
    }
  });

  it("gives the floating desktop overview overlay a working close affordance", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-overview-overlay-close" as MessageId,
        targetText: "overview overlay close thread",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      // Open the inline workspace panel, then the overview: this is the
      // audited floating overlay that previously had no close affordance.
      const workspaceToggle = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Toggle workspace panel"]'),
        "Unable to find the workspace toggle.",
      );
      workspaceToggle.click();
      // Wait for the inline panel to actually open (URL-driven) before
      // toggling the overview, so the toggle takes the floating-overlay path.
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Close workspace panel"]'),
        "Unable to find the opened inline workspace panel.",
      );
      const overviewToggle = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Toggle overview panel"]'),
        "Unable to find the overview toggle.",
      );
      overviewToggle.click();

      const closeOverview = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Close overview"]'),
        "Unable to find the overview close affordance.",
      );
      const branchHeader = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="overview-branch-header"]'),
        "Unable to find the overview branch header.",
      );
      const branchSelector = await waitForElement(
        () => branchHeader.querySelector<HTMLElement>('[data-appearance="panelRow"]'),
        "Unable to find the full-width overview branch selector.",
      );
      await waitForLayout();
      const branchSelectorHeight = Math.round(branchSelector.getBoundingClientRect().height);
      expect(branchSelectorHeight).toBe(36);
      expect(Math.round(branchHeader.getBoundingClientRect().height)).toBe(
        branchSelectorHeight + 1,
      );
      expect(branchSelector.getBoundingClientRect().width).toBeGreaterThan(200);

      const branchTrigger = branchSelector.querySelector<HTMLButtonElement>(
        '[data-slot="combobox-trigger"]',
      );
      expect(branchTrigger).not.toBeNull();
      await vi.waitFor(() => {
        expect(branchTrigger!.disabled).toBe(false);
      });
      branchTrigger!.click();
      await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to open the overview branch picker.",
      );
      await userEvent.keyboard("{Escape}");

      closeOverview.click();
      await vi.waitFor(() => {
        expect(document.querySelector('button[aria-label="Close overview"]')).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes the overview to a full-screen phone surface with a back affordance", async () => {
    // Rotation coverage: enter the overview on the desktop tier and rotate
    // across the boundary — the tier flip must preserve the open panel and
    // re-present it as a full-screen surface. (The phone-tier launcher path —
    // the thread kebab's Source control entry — is covered separately below.)
    const mounted = await mountChatView({
      viewport: ROTATED_MID_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-overview-phone-surface" as MessageId,
        targetText: "overview phone surface thread",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      const overviewToggle = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Toggle overview panel"]'),
        "Unable to find the overview toggle.",
      );
      overviewToggle.click();
      // Desktop <=980 regression guard: the overview renders as the right
      // sheet, narrower than the viewport, without the phone surface bar.
      const desktopSheet = await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>('[data-slot="sheet-popup"]')].find(
            isElementVisible,
          ) ?? null,
        "Unable to find the desktop overview sheet.",
      );
      await vi.waitFor(() => {
        const width = desktopSheet.getBoundingClientRect().width;
        expect(width).toBeGreaterThan(200);
        expect(width).toBeLessThan(ROTATED_MID_VIEWPORT.width * 0.7);
      });
      expect(document.querySelector('button[aria-label="Back to thread"]')).toBeNull();

      // Rotate across the tier boundary: the open overview re-presents as a
      // full-screen phone surface with an explicit back affordance (no trap).
      await mounted.setViewport(NARROW_TABLET_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Overview"),
        "Unable to find the phone overview surface.",
      );
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(true);
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.height - 0.5);
      });
      expect(popup.textContent).toContain("Overview");

      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the overview back affordance.",
      );
      backButton.click();
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(false);
      });
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        NARROW_TABLET_VIEWPORT.width,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the desktop inline panel and the sub-980 sheet presentation for workspace links", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-desktop-panel-guard" as MessageId,
        targetText: "desktop panel guard thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=review&diff=1`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });

      // 960px (desktop tier, <=980): the right sheet, not a full-screen
      // surface and not the phone surface bar. (The overview sheet keeps a
      // hidden keep-mounted popup in the DOM, so select the visible one.)
      const sheetPopup = await waitForElement(
        () =>
          [...document.querySelectorAll<HTMLElement>('[data-slot="sheet-popup"]')].find(
            isElementVisible,
          ) ?? null,
        "Unable to find the desktop right-panel sheet.",
      );
      await vi.waitFor(() => {
        const width = sheetPopup.getBoundingClientRect().width;
        expect(width).toBeGreaterThan(300);
        expect(width).toBeLessThan(DEFAULT_VIEWPORT.width * 0.6);
      });
      expect(queryPhoneSurfacePopup("Workspace")).toBeNull();
      expect(document.querySelector('button[aria-label="Back to thread"]')).toBeNull();
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Close workspace panel"]'),
        "Unable to find the desktop panel close button.",
      );
      // Desktop keeps the settings-driven wrap default (off) and the split
      // toggle.
      await waitForElement(
        () => document.querySelector<HTMLElement>('[aria-label="Enable diff line wrapping"]'),
        "Unable to find the desktop wrap toggle.",
      );
      await waitForElement(
        () => document.querySelector<HTMLElement>('[aria-label="Split diff view"]'),
        "Unable to find the desktop split toggle.",
      );

      // Above 980px the same URL renders the inline right panel.
      await mounted.setViewport(WIDE_FOOTER_VIEWPORT);
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>('[data-slot="sidebar"][data-side="right"]'),
        ).not.toBeNull();
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Close workspace panel"]'),
        "Unable to find the inline panel close button.",
      );
      expect(queryPhoneSurfacePopup("Workspace")).toBeNull();
      expect(document.querySelector('button[aria-label="Back to thread"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  /**
   * The reachability assertion measured on the REAL phone thread surface, not
   * on a replica: `mountChatView` renders the router, so the column comes
   * through `ChatThreadRouteView` → `SidebarInset` exactly as production does.
   *
   * The enumerated set is every control the dock row actually renders — the
   * workspace toggle, the thread-actions overflow, and every context-strip
   * pill — read out of the DOM rather than listed, so it cannot be quietly
   * narrowed and it covers whatever the real surface puts there. The two
   * named controls are additionally asserted present so the set can never
   * become empty and pass vacuously.
   */
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

  for (const viewport of [PHONE_VIEWPORT, NARROW_PHONE_VIEWPORT]) {
    it(`keeps every thread dock control in the bottom third at ${viewport.width}x${viewport.height}`, async () => {
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: `msg-user-reach-${viewport.name}` as MessageId,
          targetText: `reachability ${viewport.name} thread`,
        }),
      });

      try {
        await withCoarsePointer(async () => {
          await expectThreadDockInBottomThird(viewport);
        });
      } finally {
        await mounted.cleanup();
      }
    });

    // The same full-strength assertion as the two tests above, in the state
    // that used to break it: `ApprovalCard` and `ComposerPendingUserInputPanel`
    // render inside `ChatComposer`, so while the dock row sat above the whole
    // composer form an open approval grew the composer upward and carried the
    // dock with it (measured y=305 against 562.7 at 390x844, and y=75 against
    // 378.7 at 320x568 — back in the top third). The dock now renders inside
    // the composer beneath those panels, so the panel grows past it instead.
    it(`keeps every thread dock control in the bottom third with an approval open at ${viewport.width}x${viewport.height}`, async () => {
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotWithPendingApproval(),
      });

      try {
        await waitForElement(
          () => document.querySelector<HTMLElement>('[data-testid="pending-approval-detail"]'),
          "Unable to find the pending approval detail block.",
        );
        await withCoarsePointer(async () => {
          await expectThreadDockInBottomThird(viewport);
        });
      } finally {
        await mounted.cleanup();
      }
    });
  }

  it("mounts no phone thread dock on the desktop tier", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-desktop-no-dock" as MessageId,
        targetText: "desktop no dock thread",
      }),
    });

    try {
      await waitForLayout();
      expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      // The real desktop path: the dock, its strip, and the two controls it
      // owns are absent, and the desktop header keeps them instead.
      expect(document.querySelector('[data-slot="phone-thread-dock"]')).toBeNull();
      expect(document.querySelector('[data-slot="mobile-context-strip"]')).toBeNull();
      expect(document.querySelector('[data-slot="mobile-dock"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the overview surface from the thread dock's Source control pill", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-kebab-source-control" as MessageId,
        targetText: "kebab source control thread",
      }),
    });

    try {
      // Source control is a context-strip pill on the dock row now, not an
      // entry buried one level down inside the overflow sheet.
      const sourceControlPill = await waitForElement(
        () =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              '[data-slot="phone-thread-dock"] [data-slot="mobile-context-strip-pill"]',
            ),
          ].find((pill) => pill.textContent?.startsWith("Source control")) ?? null,
        "Unable to find the Source control pill.",
      );
      const pillRect = sourceControlPill.getBoundingClientRect();
      expect(pillRect.height).toBeGreaterThanOrEqual(44);
      expect(pillRect.width).toBeGreaterThanOrEqual(44);
      sourceControlPill.scrollIntoView({ block: "nearest", inline: "nearest" });
      sourceControlPill.click();

      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Overview"),
        "Unable to find the phone overview surface.",
      );
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(true);
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(PHONE_VIEWPORT.height - 0.5);
      });
      // The full-screen surface honors reduced motion and pads the landscape
      // side insets in addition to top/bottom.
      expect(popup.className).toContain("motion-reduce:transition-none");
      expect(popup.className).toContain("pl-safe");
      expect(popup.className).toContain("pr-safe");
      const backButton = await waitForElement(
        () => popup.querySelector<HTMLElement>('button[aria-label="Back to thread"]'),
        "Unable to find the overview back affordance.",
      );
      backButton.click();
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(false);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("defers the plan auto-open while the phone composer is focused", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        autoOpenPlanSidebar: true,
      }),
    );
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-plan-auto-open" as MessageId,
        targetText: "plan auto-open thread",
      }),
    });

    const emitPlanSnapshot = (input: { turnId: string; title: string; offset: number }) => {
      const base = fixture.snapshot;
      const nextThreads = base.threads.map((thread) =>
        thread.id === THREAD_ID
          ? Object.assign({}, thread, {
              title: input.title,
              activities: [
                ...thread.activities,
                {
                  id: EventId.make(`activity-plan-${input.turnId}`),
                  tone: "info" as const,
                  kind: "turn.plan.updated",
                  summary: "Plan updated",
                  payload: {
                    plan: [
                      { step: "Draft the change", status: "inProgress" },
                      { step: "Verify the change", status: "pending" },
                    ],
                  },
                  turnId: input.turnId as TurnId,
                  sequence: input.offset,
                  createdAt: isoAt(1_000 + input.offset),
                },
              ],
              updatedAt: isoAt(1_000 + input.offset),
            })
          : thread,
      );
      const next = {
        ...base,
        snapshotSequence: base.snapshotSequence + 1,
        threads: nextThreads,
      };
      fixture.snapshot = next;
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThreadWindow, {
        kind: "snapshot",
        snapshot: toThreadWindowSnapshot(
          next.snapshotSequence,
          nextThreads.find((thread) => thread.id === THREAD_ID)!,
        ),
      });
    };
    const threadTitleShown = (title: string) =>
      [...document.querySelectorAll<HTMLElement>("header p")].some(
        (element) => element.textContent === title,
      );

    try {
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(composerEditorHasFocus()).toBe(true);
      });

      // A plan arriving mid-composition must not steal focus into the
      // full-screen overview takeover or close the keyboard.
      emitPlanSnapshot({
        turnId: "turn-plan-live-1",
        title: "Planned thread",
        offset: 1,
      });
      await vi.waitFor(() => {
        expect(threadTitleShown("Planned thread")).toBe(true);
      });
      await waitForLayout();
      await waitForLayout();
      const overviewPopup = queryPhoneSurfacePopup("Overview");
      expect(overviewPopup === null || !isElementVisible(overviewPopup)).toBe(true);
      expect(composerEditorHasFocus()).toBe(true);

      // The deferred auto-open is dropped for this turn (not replayed on
      // blur): the plan stays reachable through the kebab's Source control
      // entry instead of a surprise takeover.
      (document.activeElement as HTMLElement).blur();
      await waitForLayout();
      await waitForLayout();
      const popupAfterBlur = queryPhoneSurfacePopup("Overview");
      expect(popupAfterBlur === null || !isElementVisible(popupAfterBlur)).toBe(true);

      // With the composer no longer focused, the next turn's plan auto-opens
      // the overview surface as configured.
      emitPlanSnapshot({
        turnId: "turn-plan-live-2",
        title: "Planned thread again",
        offset: 2,
      });
      await vi.waitFor(() => {
        expect(threadTitleShown("Planned thread again")).toBe(true);
      });
      await vi.waitFor(() => {
        const popup = queryPhoneSurfacePopup("Overview");
        expect(popup).not.toBeNull();
        expect(isElementVisible(popup!)).toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("presents phone settings full-screen from Home with the labeled section list", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-settings-entry" as MessageId,
        targetText: "phone settings entry thread",
      }),
      initialPath: "/",
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const settingsButton = await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Open settings"]'),
        "Unable to find the Home settings affordance.",
      );
      settingsButton.click();

      const popup = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="phone-settings-surface"]'),
        "Unable to find the phone settings surface.",
      );
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(PHONE_VIEWPORT.height - 0.5);
      });
      // The desktop dialog presentation stays off the phone tier.
      expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
      // Labeled 44px rows instead of the icon-only rail.
      for (const label of ["General", "Appearance", "Source Control", "Advanced"]) {
        const row = [...popup.querySelectorAll<HTMLButtonElement>("nav button")].find(
          (button) => button.textContent?.trim() === label,
        );
        expect(row, `Missing settings row "${label}".`).not.toBeUndefined();
        expect(row!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }

      // Escape closes the surface (desktop dialog parity).
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="phone-settings-surface"]')).toBeNull();
      });
    } finally {
      useSettingsDialogStore.setState({ open: false, section: "general" });
      await mounted.cleanup();
    }
  });

  it("keeps the desktop settings dialog presentation on desktop viewports", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-desktop-settings-guard" as MessageId,
        targetText: "desktop settings guard thread",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      useSettingsDialogStore.getState().openSettings();
      const dialog = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="dialog-popup"]'),
        "Unable to find the desktop settings dialog.",
      );
      expect(dialog.className).toContain("project-glass-surface");
      // The desktop dialog keeps its section rail; the phone surface never
      // mounts on the desktop tier.
      await waitForElement(
        () => dialog.querySelector<HTMLElement>('nav button[aria-label="General"]'),
        "Unable to find the desktop settings section rail.",
      );
      expect(document.querySelector('[data-testid="phone-settings-surface"]')).toBeNull();

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
      });
    } finally {
      useSettingsDialogStore.setState({ open: false, section: "general" });
      await mounted.cleanup();
    }
  });

  it("keeps the collapsed desktop sidebar chrome outside the window drag region", async () => {
    localStorage.setItem("chat_thread_sidebar_open", "false");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-collapsed-sidebar-chrome" as MessageId,
        targetText: "collapsed sidebar chrome thread",
      }),
    });

    try {
      const chrome = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-slot="collapsed-app-sidebar-chrome"]:not([inert])',
          ),
        "Unable to find the interactive collapsed sidebar chrome.",
      );
      expect(getComputedStyle(chrome).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      expect(chrome.querySelector('a[aria-label="Go to threads"]')).not.toBeNull();
      expect(chrome.querySelector('a[aria-label="Open statistics"]')).not.toBeNull();

      const breadcrumb = await waitForElement(
        () => document.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"]'),
        "Unable to find the thread breadcrumb beside the collapsed sidebar chrome.",
      );
      expect(chrome.getBoundingClientRect().right).toBeLessThanOrEqual(
        breadcrumb.getBoundingClientRect().left + 0.5,
      );

      const settingsButton = chrome.querySelector<HTMLButtonElement>(
        'button[aria-label="Settings"]',
      );
      expect(settingsButton).not.toBeNull();
      settingsButton!.click();
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="dialog-popup"]'),
        "Settings did not open from the collapsed sidebar chrome.",
      );
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
      });

      const showSidebarButton = chrome.querySelector<HTMLButtonElement>(
        'button[aria-label="Show sidebar"]',
      );
      expect(showSidebarButton).not.toBeNull();
      showSidebarButton!.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-slot="sidebar"][data-state="expanded"]'),
        ).not.toBeNull();
        expect(localStorage.getItem("chat_thread_sidebar_open")).toBe("true");
      });
    } finally {
      useSettingsDialogStore.setState({ open: false, section: "general" });
      await mounted.cleanup();
    }
  });

  it("keeps phone app-bar controls visible at 200% text scale at 320px and 390px", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-text-scale" as MessageId,
        targetText: "text scale thread",
      }),
    });

    const assertControlWithinViewport = (selector: string, viewportWidth: number) => {
      const control = document.querySelector<HTMLElement>(selector);
      expect(control, `Missing control ${selector} at 200% text scale.`).not.toBeNull();
      const rect = control!.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(-0.5);
      expect(
        rect.right,
        `Control ${selector} pushed past the viewport at 200% text scale.`,
      ).toBeLessThanOrEqual(viewportWidth + 0.5);
    };

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the phone app bar before scaling text.",
      );
      // The harness host is a grid whose auto track sizes to the content's
      // min-width; index.html's #root is a block that lays the app out at the
      // viewport width and clips. Cap the track so scaled layout matches
      // production geometry.
      const appHost = document.querySelector<HTMLElement>(
        "div.group\\/sidebar-wrapper",
      )?.parentElement;
      if (appHost instanceof HTMLElement) {
        appHost.style.gridTemplateColumns = "minmax(0, 1fr)";
        appHost.style.gridTemplateRows = "minmax(0, 1fr)";
      }
      // Emulate 200% browser text scaling: the layout is rem-based, so
      // doubling the root font size scales typography and rem-sized controls.
      document.documentElement.style.fontSize = "32px";
      const APP_BAR_SELECTORS = [
        'button[aria-label="Back to threads"]',
        'button[aria-label="Thread actions"]',
        'button[aria-label="Toggle workspace panel"]',
      ] as const;
      for (const viewport of [NARROW_PHONE_VIEWPORT, PHONE_VIEWPORT]) {
        await mounted.setViewport(viewport);
        await waitForLayout();
        for (const selector of APP_BAR_SELECTORS) {
          assertControlWithinViewport(selector, viewport.width);
        }
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
      }

      // Landscape (844x390) classifies as phone only with a coarse pointer;
      // with the landscape side safe-area padding it is the most
      // width-constrained case in the matrix.
      await withCoarsePointer(async () => {
        await mounted.setViewport(PHONE_LANDSCAPE_VIEWPORT);
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        await waitForLayout();
        for (const selector of APP_BAR_SELECTORS) {
          assertControlWithinViewport(selector, PHONE_LANDSCAPE_VIEWPORT.width);
        }
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.width,
        );
      });
      await mounted.setViewport(PHONE_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });

      // Home at 200%: the app-bar actions stay visible and tappable.
      document.querySelector<HTMLElement>('button[aria-label="Back to threads"]')!.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/");
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Search threads"]'),
        "Unable to find the Home app bar after navigating back.",
      );
      await waitForLayout();
      for (const selector of [
        'button[aria-label="Search threads"]',
        'button[aria-label="Open settings"]',
        'button[aria-label="New thread"]',
      ]) {
        assertControlWithinViewport(selector, PHONE_VIEWPORT.width);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    } finally {
      document.documentElement.style.fontSize = "";
      await mounted.cleanup();
    }
  });

  it("gives every visible phone control an accessible name across Home, thread, and sheets", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-phone-label-audit" as MessageId,
        targetText: "phone label audit thread",
      }),
    });

    const accessibleControlName = (control: HTMLElement): string => {
      const ariaLabel = control.getAttribute("aria-label")?.trim();
      if (ariaLabel) return ariaLabel;
      const labelledBy = control.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const content = control.textContent?.trim();
      if (content) return content;
      return control.getAttribute("title")?.trim() ?? "";
    };
    // Enumerate every visible control: anything without an accessible name is
    // an icon-only affordance a screen reader cannot describe.
    const unnamedVisibleControls = () =>
      [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter((control) => control.checkVisibility?.() ?? true)
        .filter((control) => accessibleControlName(control) === "")
        .map((control) => control.outerHTML.slice(0, 160));

    try {
      // Thread surface (app bar, timeline, collapsed composer).
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Back to threads"]'),
        "Unable to find the phone thread app bar.",
      );
      await waitForLayout();
      expect(unnamedVisibleControls()).toEqual([]);

      // The thread kebab sheet. (The keep-mounted work-surface popups stay in
      // the DOM while closed, so visibility decides open/closed here.)
      const visibleSheetPopups = () =>
        [...document.querySelectorAll<HTMLElement>('[data-slot="sheet-popup"]')].filter(
          isElementVisible,
        );
      await page.getByRole("button", { name: "Thread actions" }).click();
      await vi.waitFor(() => {
        expect(visibleSheetPopups().length).toBeGreaterThan(0);
      });
      expect(unnamedVisibleControls()).toEqual([]);
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(visibleSheetPopups().length).toBe(0);
      });

      // The expanded composer control set.
      await page.getByTestId("composer-editor").click();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-chat-composer-mobile-collapsed="false"]'),
        ).not.toBeNull();
      });
      await waitForLayout();
      expect(unnamedVisibleControls()).toEqual([]);

      // Home (app bar, project rows, thread rows and their kebabs).
      document.querySelector<HTMLElement>('button[aria-label="Back to threads"]')!.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe("/");
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('button[aria-label="Search threads"]'),
        "Unable to find the Home app bar.",
      );
      await waitForLayout();
      expect(unnamedVisibleControls()).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("pads phone surfaces from the safe-area insets directly instead of the root inset", async () => {
    // Chromium can stub env(safe-area-inset-*) through CDP; when this build
    // does not support the override the test still asserts the declared
    // classes, so the padding contract never goes unchecked.
    const setSafeAreaInsets = async (inset: number): Promise<boolean> => {
      try {
        await cdpSession().send("Emulation.setSafeAreaInsetsOverride", {
          insets: { top: inset, left: inset, right: inset, bottom: inset },
        });
      } catch {
        return false;
      }
      const probe = document.createElement("div");
      probe.style.paddingTop = "env(safe-area-inset-top, 0px)";
      document.body.append(probe);
      const resolved = Number.parseFloat(getComputedStyle(probe).paddingTop);
      probe.remove();
      return resolved === inset;
    };

    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-safe-area" as MessageId,
        targetText: "safe area thread",
      }),
    });

    let insetsStubbed = false;
    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const appBarHeader = await waitForElement(
        () => document.querySelector<HTMLElement>("header"),
        "Unable to find the phone thread app bar.",
      );
      // Declared contract: the phone tier pads its own app bar; the
      // root-level inset is scoped out for the phone tier.
      expect(appBarHeader.className).toContain("phone:pt-safe");
      // The harness mounts into its own host (index.html's #root is absent),
      // so probe the `#root` cascade with an empty element carrying the id.
      const root = document.createElement("div");
      root.id = "root";
      document.body.append(root);

      insetsStubbed = await setSafeAreaInsets(24);
      // The pinned Playwright Chromium supports the override; this assertion
      // keeps the geometry checks from silently degrading to class checks.
      expect(insetsStubbed).toBe(true);
      if (insetsStubbed) {
        await waitForLayout();
        // The root inset is disabled on the phone tier (no double padding,
        // no dvh overflow past the visual viewport bottom).
        expect(getComputedStyle(root).paddingTop).toBe("0px");
        // The app bar pads the top inset itself.
        expect(Number.parseFloat(getComputedStyle(appBarHeader).paddingTop)).toBeGreaterThanOrEqual(
          24,
        );
        // The composer stays clear of the bottom inset.
        const composerForm = document.querySelector<HTMLElement>(
          '[data-chat-composer-form="true"]',
        )!;
        expect(composerForm.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          PHONE_VIEWPORT.height - 24 + 0.5,
        );

        // The desktop tier keeps the root-level inset.
        await mounted.setViewport(DEFAULT_VIEWPORT);
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
        });
        await vi.waitFor(() => {
          expect(getComputedStyle(root).paddingTop).toBe("24px");
        });
      }
    } finally {
      if (insetsStubbed) {
        await setSafeAreaInsets(0);
      }
      await mounted.cleanup();
    }
  });

  // --- Acceptance-matrix gap fills (delivery step 10) ---
  // The consolidated cell → proving-test mapping lives in
  // AcceptanceMatrix.browser.tsx; the tests below fill the matrix cells only
  // this file's full-app harness can prove.

  it("hides keyboard-shortcut hints in the command palette on coarse pointers", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-kbd-hints" as MessageId,
        targetText: "shortcut hint thread",
      }),
      initialPath: "/",
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const openPaletteFromHome = async (): Promise<HTMLElement> => {
        const searchButton = await waitForElement(
          () => document.querySelector<HTMLElement>('button[aria-label="Search threads"]'),
          "Unable to find the Home search affordance.",
        );
        searchButton.click();
        return waitForElement(
          () => document.querySelector<HTMLElement>('[data-testid="command-palette"]'),
          "Unable to find the command palette.",
        );
      };
      const paletteShortcutHints = (palette: HTMLElement): HTMLElement[] => [
        ...palette.querySelectorAll<HTMLElement>('[data-slot="kbd"], [data-slot="kbd-group"]'),
      ];

      await withCoarsePointer(async () => {
        // The visible search entry point replaces the ⌘K hint on touch: the
        // palette opens from a button, and every rendered shortcut hint
        // inside it is hidden on the coarse pointer.
        const palette = await openPaletteFromHome();
        const hints = paletteShortcutHints(palette);
        expect(hints.length).toBeGreaterThan(0);
        for (const hint of hints) {
          expect(
            hint.checkVisibility?.() ?? true,
            "A keyboard-shortcut hint stayed visible on a coarse pointer.",
          ).toBe(false);
        }
        await userEvent.keyboard("{Escape}");
        await vi.waitFor(() => {
          expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
        });
      });

      // Fine-pointer guard: the same hints render again once the pointer is
      // hover-capable. (Device-less CI reports `pointer: none` after the
      // emulation revert, so the visibility leg gates on a fine pointer.)
      if (window.matchMedia("(pointer: fine)").matches) {
        const palette = await openPaletteFromHome();
        await vi.waitFor(() => {
          const visible = paletteShortcutHints(palette).filter(
            (hint) => hint.checkVisibility?.() ?? false,
          );
          expect(visible.length).toBeGreaterThan(0);
        });
        await userEvent.keyboard("{Escape}");
        await vi.waitFor(() => {
          expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
        });
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("contains the terminal surface at 320px and on a coarse landscape phone", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-terminal-matrix" as MessageId,
        targetText: "terminal matrix thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=terminal`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      // 320×568: the terminal surface is full-screen, its toolbar keeps the
      // 44px floor, and the page never scrolls horizontally.
      await vi.waitFor(() => {
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_PHONE_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(NARROW_PHONE_VIEWPORT.height - 0.5);
      });
      const toolbar = await waitForElement(
        () => popup.querySelector<HTMLElement>('[role="tablist"][aria-label="Terminals"]'),
        "Unable to find the terminal toolbar.",
      );
      await vi.waitFor(() => {
        expect(toolbar.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      });
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width);

      // Rotate to the coarse landscape phone: the surface survives the flip
      // (fine 844px is desktop; the coarse clause reclassifies it) with the
      // terminal contained, the URL untouched, and no horizontal overflow.
      // The tier flip re-presents the surface, so the landscape elements are
      // re-queried instead of reusing the portrait references.
      await mounted.setViewport(PHONE_LANDSCAPE_VIEWPORT);
      await withCoarsePointer(async () => {
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        const landscapePopup = await waitForElement(
          () => queryPhoneSurfacePopup("Workspace"),
          "Unable to find the phone work surface after rotating to landscape.",
        );
        await vi.waitFor(() => {
          expect(isElementVisible(landscapePopup)).toBe(true);
          const rect = landscapePopup.getBoundingClientRect();
          expect(rect.width).toBeGreaterThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.width - 0.5);
          expect(rect.height).toBeGreaterThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.height - 0.5);
        });
        const landscapeToolbar = await waitForElement(
          () =>
            landscapePopup.querySelector<HTMLElement>('[role="tablist"][aria-label="Terminals"]'),
          "Unable to find the terminal toolbar after rotating to landscape.",
        );
        await vi.waitFor(() => {
          const rect = landscapeToolbar.getBoundingClientRect();
          expect(rect.height).toBeGreaterThanOrEqual(44);
          expect(rect.bottom).toBeLessThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.height + 0.5);
        });
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.width,
        );
        const search = mounted.router.state.location.search as Record<string, unknown>;
        expect(search.workspaceTab).toBe("terminal");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("contains the review and files surfaces on a coarse landscape phone", async () => {
    const mounted = await mountChatView({
      viewport: PHONE_LANDSCAPE_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-landscape-work-surface" as MessageId,
        targetText: "landscape work surface thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=review&diff=1`,
    });

    try {
      await withCoarsePointer(async () => {
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
        });
        // The desktop-shaped deep link presents full-screen on the coarse
        // landscape phone with the wrapped diff contained.
        const popup = await waitForElement(
          () => queryPhoneSurfacePopup("Workspace"),
          "Unable to find the phone work surface.",
        );
        await vi.waitFor(() => {
          expect(isElementVisible(popup)).toBe(true);
          const rect = popup.getBoundingClientRect();
          expect(rect.width).toBeGreaterThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.width - 0.5);
          expect(rect.height).toBeGreaterThanOrEqual(PHONE_LANDSCAPE_VIEWPORT.height - 0.5);
        });
        await waitForElement(
          () => popup.querySelector<HTMLElement>('[data-diff-file-path="src/wide.ts"]'),
          "Unable to find the rendered diff file.",
        );
        await waitForElement(
          () => popup.querySelector<HTMLElement>('[aria-label="Disable diff line wrapping"]'),
          "Unable to find the pressed wrap toggle.",
        );
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.width,
        );

        // Every rendered surface-bar tab keeps the 44px floor in landscape.
        const tabs = [...popup.querySelectorAll<HTMLElement>('[role="tab"]')];
        expect(tabs.length).toBeGreaterThan(0);
        for (const tab of tabs) {
          expect(tab.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        }

        // The launcher pushes the single-pane files tree, still without
        // horizontal overflow.
        const launcherButton = await waitForElement(
          () => popup.querySelector<HTMLElement>('button[aria-label="Workspace launcher"]'),
          "Unable to find the workspace launcher button.",
        );
        launcherButton.click();
        const filesCard = await waitForElement(
          () =>
            [...popup.querySelectorAll<HTMLElement>("button")].find((button) =>
              button.textContent?.includes("Browse project files"),
            ) ?? null,
          "Unable to find the Files launcher card.",
        );
        filesCard.click();
        await vi.waitFor(() => {
          const search = mounted.router.state.location.search as Record<string, unknown>;
          expect(search.workspaceTab).toBe("files");
        });
        const readmeRow = await waitForElement(
          () =>
            [...popup.querySelectorAll<HTMLElement>("button")].find(
              (button) => button.textContent?.trim() === "README.md",
            ) ?? null,
          "Unable to find the README.md tree row.",
        );
        expect(readmeRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          PHONE_LANDSCAPE_VIEWPORT.width,
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves the open review surface across a mid-size rotation tier flip", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotWithWorkSurfaceCheckpoint({
        targetMessageId: "msg-user-review-rotation" as MessageId,
        targetText: "review rotation thread",
      }),
      resolveRpc: resolveWorkSurfaceRpc,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=review&diff=1`,
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const popup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface.",
      );
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(true);
        const rect = popup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.width - 0.5);
      });
      await waitForElement(
        () => popup.querySelector<HTMLElement>('[data-diff-file-path="src/wide.ts"]'),
        "Unable to find the rendered diff file.",
      );
      const initialSearch = mounted.router.state.location.searchStr;
      expect(initialSearch).toContain("workspaceTab");

      // Rotate across the 768px boundary: the same URL params re-present the
      // panel in the desktop sub-980 sheet without dropping the open state.
      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      expect(mounted.router.state.location.searchStr).toBe(initialSearch);
      await vi.waitFor(() => {
        expect(isElementVisible(popup)).toBe(false);
        const desktopSheet = [
          ...document.querySelectorAll<HTMLElement>('[data-slot="sheet-popup"]'),
        ].find(
          (sheet) =>
            isElementVisible(sheet) &&
            sheet.querySelector('[role="tablist"][aria-label="Workspace tabs"]') !== null,
        );
        expect(desktopSheet, "Missing the desktop workspace sheet.").not.toBeUndefined();
        expect(desktopSheet!.getBoundingClientRect().width).toBeLessThan(
          ROTATED_MID_VIEWPORT.width * 0.7,
        );
      });

      // Rotate back: the full-screen phone surface returns with the same
      // route state and no document-level overflow. (The tier flip
      // re-presents the surface, so the popup is re-queried.)
      await mounted.setViewport(NARROW_TABLET_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const restoredPopup = await waitForElement(
        () => queryPhoneSurfacePopup("Workspace"),
        "Unable to find the phone work surface after rotating back.",
      );
      await vi.waitFor(() => {
        expect(isElementVisible(restoredPopup)).toBe(true);
        const rect = restoredPopup.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.width - 0.5);
        expect(rect.height).toBeGreaterThanOrEqual(NARROW_TABLET_VIEWPORT.height - 0.5);
      });
      expect(mounted.router.state.location.searchStr).toBe(initialSearch);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        NARROW_TABLET_VIEWPORT.width,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves open settings across a mid-size rotation tier flip", async () => {
    const mounted = await mountChatView({
      viewport: NARROW_TABLET_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-settings-rotation" as MessageId,
        targetText: "settings rotation thread",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      useSettingsDialogStore.getState().openSettings("appearance");
      const surface = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="phone-settings-surface"]'),
        "Unable to find the phone settings surface.",
      );
      // The open-to-section entry lands directly on the pushed section page.
      await vi.waitFor(() => {
        const heading = surface.querySelector<HTMLElement>("h1[tabindex]");
        expect(heading?.textContent).toContain("Appearance");
      });

      // Rotate across the boundary: the desktop dialog takes over the same
      // open settings state; the phone surface unmounts.
      await mounted.setViewport(ROTATED_MID_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
      });
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="dialog-popup"]'),
        "Unable to find the desktop settings dialog after the tier flip.",
      );
      expect(document.querySelector('[data-testid="phone-settings-surface"]')).toBeNull();
      expect(useSettingsDialogStore.getState().open).toBe(true);
      expect(useSettingsDialogStore.getState().section).toBe("appearance");

      // Rotate back: the phone surface returns on the same section page.
      await mounted.setViewport(NARROW_TABLET_VIEWPORT);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      const restoredSurface = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="phone-settings-surface"]'),
        "Unable to find the phone settings surface after rotating back.",
      );
      await vi.waitFor(() => {
        const heading = restoredSurface.querySelector<HTMLElement>("h1[tabindex]");
        expect(heading?.textContent).toContain("Appearance");
      });
      expect(useSettingsDialogStore.getState().section).toBe("appearance");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        NARROW_TABLET_VIEWPORT.width,
      );
    } finally {
      useSettingsDialogStore.setState({ open: false, section: "general" });
      await mounted.cleanup();
    }
  });
});
