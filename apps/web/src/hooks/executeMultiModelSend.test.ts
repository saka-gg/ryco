import {
  MODEL_MULTI_SELECT_OFF,
  composeOutgoingPrompt,
  deriveProviderInstanceEntries,
  type FileReferenceDraft,
} from "@ryco/client-runtime/state/composer";
import {
  EnvironmentId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentApi,
  type ServerConfig,
  type ServerProvider,
} from "@ryco/contracts";
import { createModelCapabilities, createModelSelection } from "@ryco/shared/model";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readMultiModelSelection,
  readMultiModelSends,
  setMultiModelSelection,
  useMultiModelSendStore,
} from "../components/chat/multiModelSendStore";
import type { ComposerImageAttachment } from "../composerDraftStore";
import { DraftId } from "../composerDraftStore";
import type { TerminalContextDraft } from "../lib/terminalContext";
import {
  MULTI_MODEL_SEND_UNSUPPORTED_MESSAGE,
  executeMultiModelSend,
  isMultiModelSendBusy,
  multiModelSendRunsSetupScript,
  sendMultiModelTargetAsNew,
  type ExecuteMultiModelSendInput,
} from "./executeMultiModelSend";
import {
  readAndRememberProjectPreferences,
  resetNewDraftDefaultsCacheForTests,
} from "./newDraftDefaults";
import type { SendTurnComposerSnapshot } from "./executeChatSendTurn";

// The connection-generation check needs a live socket; these tests have none.
vi.mock("@ryco/client-runtime/state/composer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ryco/client-runtime/state/composer")>()),
  captureReviewedSendReadiness: () => () => {},
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const DRAFT_ID = DraftId.make("draft-compare");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const gpt = createModelSelection(codex, "gpt-5");
const opus = createModelSelection(claude, "claude-opus-4-6");

const capabilities = createModelCapabilities({ optionDescriptors: [] });
const providers: ServerProvider[] = [
  {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-22T00:00:00.000Z",
    models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities }],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-22T00:00:00.000Z",
    models: [{ slug: "claude-opus-4-6", name: "Opus", isCustom: false, capabilities }],
    slashCommands: [],
    skills: [],
    supportsAskMode: true,
  },
];
const providerEntries = deriveProviderInstanceEntries(providers);

const fileReference: FileReferenceDraft = {
  id: "ref-1",
  createdAt: "2026-10-22T00:00:00.000Z",
  path: "src/flaky.test.ts",
  lineStart: 4,
  lineEnd: 5,
  snippet: "it('passes', () => {\n  expect(1).toBe(1);",
  truncated: false,
};
const terminalContext: TerminalContextDraft = {
  id: "term-1",
  threadId: ThreadId.make("draft-thread"),
  createdAt: "2026-10-22T00:00:00.000Z",
  terminalId: "terminal-1",
  terminalLabel: "Terminal 1",
  lineStart: 1,
  lineEnd: 1,
  text: "FAIL src/flaky.test.ts",
};

function composerSnapshot(overrides: Partial<SendTurnComposerSnapshot> = {}) {
  return {
    prompt: "Fix the flaky test",
    trimmedPrompt: "Fix the flaky test",
    images: [],
    sendableTerminalContexts: [terminalContext],
    fileReferences: [fileReference],
    sourceControlContexts: [],
    selectedProvider: ProviderDriverKind.make("codex"),
    selectedModel: "gpt-5",
    selectedProviderModels: providers[0]!.models,
    selectedPromptEffort: null,
    selectedModelSelection: gpt,
    expiredTerminalContextCount: 0,
    ...overrides,
  } satisfies SendTurnComposerSnapshot;
}

function nodeConfig(requiredWorktreeBootstrap = true) {
  return {
    environment: { capabilities: { requiredWorktreeBootstrap } },
    settings: {},
  } as unknown as ServerConfig;
}

type DispatchedCommand = Parameters<EnvironmentApi["orchestration"]["dispatchCommand"]>[0];

function makeApi(
  options: {
    readonly config?: ServerConfig;
    readonly answer?: (command: DispatchedCommand) => Error | null;
  } = {},
) {
  const commands: DispatchedCommand[] = [];
  const api = {
    server: {
      getConfig: async () => options.config ?? nodeConfig(),
      getSettings: async () => ({ worktreeBranchPrefix: "ryco" }),
    },
    orchestration: {
      dispatchCommand: async (command: DispatchedCommand) => {
        commands.push(command);
        const error = options.answer?.(command) ?? null;
        if (error) throw error;
        return { sequence: commands.length };
      },
    },
  } as unknown as EnvironmentApi;
  return { api, commands };
}

function makeComposerDeps() {
  const refs = {
    promptRef: { current: "Fix the flaky test" },
    composerImagesRef: { current: [] as ComposerImageAttachment[] },
    composerTerminalContextsRef: { current: [terminalContext] },
    composerFileReferencesRef: { current: [fileReference] },
  };
  const draft = {
    composerDraftTarget: DRAFT_ID,
    clearComposerDraftContent: vi.fn(),
    setComposerDraftTokenMode: vi.fn(),
    setComposerDraftPrompt: vi.fn(),
    addComposerDraftImages: vi.fn(),
    setComposerDraftTerminalContexts: vi.fn(),
    setComposerDraftFileReferences: vi.fn(),
    readComposerDraftContent: vi.fn(() => null),
  };
  return { refs, draft };
}

function sendInput(
  api: EnvironmentApi,
  overrides: Partial<Omit<ExecuteMultiModelSendInput, "refs" | "draft">> = {},
): ExecuteMultiModelSendInput & ReturnType<typeof makeComposerDeps> {
  const deps = makeComposerDeps();
  return {
    api,
    environmentId: ENVIRONMENT_ID,
    draftId: DRAFT_ID,
    projectId: ProjectId.make("project-1"),
    projectCwd: "/repo/project",
    baseBranch: "origin/main",
    fetchOrigin: true,
    composer: composerSnapshot(),
    selections: [gpt, opus],
    providerEntries,
    settings: { runtimeMode: "full-access", interactionMode: "ask", tokenMode: "balanced" },
    enforceBuildMode: false,
    sourceControl: { fetcher: async (context) => context },
    formatOutgoingPrompt: ({ provider, text }) => `[${provider}] ${text}`,
    composerHandle: { readComposer: () => null },
    composerChanged: () => false,
    ...deps,
    ...overrides,
  };
}

const latestSend = () => readMultiModelSends(DRAFT_ID)[0];

const turnStarts = (commands: ReadonlyArray<DispatchedCommand>) =>
  commands.filter(
    (command): command is Extract<DispatchedCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start",
  );

afterEach(() => {
  useMultiModelSendStore.setState({ byDraftId: {} });
  resetNewDraftDefaultsCacheForTests();
});

describe("executeMultiModelSend", () => {
  it("sends one prompt, composed like a normal send, to every model in its own worktree", async () => {
    const { api, commands } = makeApi();
    setMultiModelSelection(DRAFT_ID, { enabled: true, selections: [gpt, opus] });
    const input = sendInput(api);

    const result = await executeMultiModelSend(input);

    expect(result.kind).toBe("sent");
    const starts = turnStarts(commands);
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((command) => command.threadId)).size).toBe(2);
    const composed = composeOutgoingPrompt({
      prompt: "Fix the flaky test",
      fileReferences: [fileReference],
      terminalContexts: [terminalContext],
    });
    expect(starts.map((command) => command.message.text)).toEqual([
      `[codex] ${composed}`,
      `[claudeAgent] ${composed}`,
    ]);
    for (const command of starts) {
      expect(command.bootstrap).toMatchObject({
        requireWorktree: true,
        createThread: { projectId: "project-1" },
        prepareWorktree: { projectCwd: "/repo/project", baseBranch: "origin/main" },
      });
      expect(command.bootstrap?.prepareWorktree?.branch).toMatch(/^ryco\//);
    }
    // Ask mode stays only where the provider supports it.
    expect(starts.map((command) => command.interactionMode)).toEqual(["default", "ask"]);
    expect(starts.map((command) => command.modelSelection?.instanceId)).toEqual([codex, claude]);
    // The composer is cleared, the user stays in it, and comparing is off again.
    expect(input.draft.clearComposerDraftContent).toHaveBeenCalledWith(DRAFT_ID);
    expect(input.refs.promptRef.current).toBe("");
    expect(input.draft.setComposerDraftPrompt).not.toHaveBeenCalled();
    expect(readMultiModelSelection(DRAFT_ID)).toBe(MODEL_MULTI_SELECT_OFF);
    const record = latestSend();
    expect(readMultiModelSends(DRAFT_ID)).toHaveLength(1);
    expect(record?.sending).toBe(false);
    expect(record?.tracker.read().targets.map((target) => target.status.kind)).toEqual([
      "started",
      "started",
    ]);
  });

  it("puts the prompt back and keeps only the models the node did not create", async () => {
    const { api } = makeApi({
      answer: (command) =>
        command.type === "thread.turn.start" && command.modelSelection?.instanceId === claude
          ? new OrchestrationDispatchCommandError({ message: "Worktree setup failed." })
          : null,
    });
    setMultiModelSelection(DRAFT_ID, { enabled: true, selections: [gpt, opus] });
    const input = sendInput(api);

    await executeMultiModelSend(input);

    const targets = latestSend()!.tracker.read().targets;
    expect(targets.map((target) => target.status)).toEqual([
      { kind: "started" },
      { kind: "not-created", message: "Worktree setup failed." },
    ]);
    expect(input.draft.setComposerDraftPrompt).toHaveBeenCalledWith(DRAFT_ID, "Fix the flaky test");
    expect(input.draft.setComposerDraftFileReferences).toHaveBeenCalledWith(DRAFT_ID, [
      fileReference,
    ]);
    expect(readMultiModelSelection(DRAFT_ID)).toEqual({
      enabled: true,
      selections: [targets[1]!.plan.modelSelection],
      retry: true,
    });
  });

  it("keeps the selection as it was when no model started", async () => {
    const { api } = makeApi({
      answer: () => new OrchestrationDispatchCommandError({ message: "Not a repository." }),
    });
    const selection = { enabled: true, selections: [gpt, opus] } as const;
    setMultiModelSelection(DRAFT_ID, selection);

    await executeMultiModelSend(sendInput(api));

    expect(readMultiModelSelection(DRAFT_ID)).toBe(selection);
  });

  it("leaves an unconfirmed model to an explicit retry and does not restore the prompt", async () => {
    const { api } = makeApi({
      answer: (command) =>
        command.type === "thread.turn.start" && command.modelSelection?.instanceId === claude
          ? new Error("Socket closed")
          : null,
    });
    setMultiModelSelection(DRAFT_ID, { enabled: true, selections: [gpt, opus] });
    const input = sendInput(api);

    await executeMultiModelSend(input);

    expect(
      latestSend()!
        .tracker.read()
        .targets.map((target) => target.status.kind),
    ).toEqual(["started", "uncertain"]);
    expect(input.draft.setComposerDraftPrompt).not.toHaveBeenCalled();
    expect(readMultiModelSelection(DRAFT_ID)).toBe(MODEL_MULTI_SELECT_OFF);
  });

  it("refuses before anything goes out on a node that cannot isolate each model", async () => {
    const { api, commands } = makeApi({ config: nodeConfig(false) });
    const input = sendInput(api);

    const result = await executeMultiModelSend(input);

    expect(result).toEqual({ kind: "refused", message: MULTI_MODEL_SEND_UNSUPPORTED_MESSAGE });
    expect(commands).toHaveLength(0);
    expect(input.draft.clearComposerDraftContent).not.toHaveBeenCalled();
    expect(readMultiModelSends(DRAFT_ID)).toEqual([]);
    expect(isMultiModelSendBusy(DRAFT_ID)).toBe(false);
  });

  it("refuses a model that left the catalog instead of sending it elsewhere", async () => {
    const { api, commands } = makeApi();
    const result = await executeMultiModelSend(
      sendInput(api, { selections: [gpt, createModelSelection(claude, "claude-gone")] }),
    );
    expect(result).toEqual({
      kind: "refused",
      message: "claude-gone is not available on Claude.",
    });
    expect(commands).toHaveLength(0);
  });

  it("sends a streamed file inline to every model, and refuses one whose bytes are gone", async () => {
    const streamed: ComposerImageAttachment = {
      type: "file",
      id: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      previewUrl: "",
      file: new File(["notes"], "notes.txt", { type: "text/plain" }),
      uploadToken: "upload-token-1",
    };
    const { api, commands } = makeApi();
    await executeMultiModelSend(
      sendInput(api, { composer: composerSnapshot({ images: [streamed] }) }),
    );
    for (const command of turnStarts(commands)) {
      expect(command.message.attachments).toHaveLength(1);
      expect(command.message.attachments[0]).toMatchObject({ type: "file", name: "notes.txt" });
      expect(command.message.attachments[0]).not.toHaveProperty("uploadToken");
      expect((command.message.attachments[0] as { dataUrl?: string }).dataUrl).toMatch(/^data:/);
    }

    useMultiModelSendStore.setState({ byDraftId: {} });
    const reloaded = makeApi();
    const result = await executeMultiModelSend(
      sendInput(reloaded.api, {
        composer: composerSnapshot({ images: [{ ...streamed, file: null }] }),
      }),
    );
    expect(result).toEqual({
      kind: "refused",
      message: "Attach 'notes.txt' again to send it to several models.",
    });
    expect(reloaded.commands).toHaveLength(0);
  });

  it("keeps edits made while the send was prepared", async () => {
    const { api } = makeApi();
    const input = sendInput(api, { composerChanged: () => true });
    await executeMultiModelSend(input);
    expect(input.draft.clearComposerDraftContent).not.toHaveBeenCalled();
    expect(input.refs.promptRef.current).toBe("Fix the flaky test");
  });

  it("keeps an earlier send with a model not confirmed beside the draft's next sends", async () => {
    let lose = true;
    const { api } = makeApi({
      answer: (command) =>
        lose &&
        command.type === "thread.turn.start" &&
        command.modelSelection?.instanceId === claude
          ? new Error("Socket closed")
          : null,
    });
    await executeMultiModelSend(sendInput(api));
    const first = latestSend()!;
    expect(first.tracker.read().targets.map((target) => target.status.kind)).toEqual([
      "started",
      "uncertain",
    ]);
    lose = false;

    // The next send does not take the unconfirmed model's place: its thread
    // id is held nowhere else.
    await executeMultiModelSend(sendInput(api));
    const second = latestSend()!;
    expect(readMultiModelSends(DRAFT_ID)).toEqual([second, first]);
    expect(second.tracker.read().submissionId).not.toBe(first.tracker.read().submissionId);

    // A settled send gives way to the next one; the unconfirmed one stays.
    await executeMultiModelSend(sendInput(api));
    expect(readMultiModelSends(DRAFT_ID)).toEqual([latestSend(), first]);
    expect(first.tracker.read().targets[1]!.status.kind).toBe("uncertain");
  });

  it("sends an unconfirmed model again as new once the node refused its retry", async () => {
    let call = 0;
    const { api, commands } = makeApi({
      answer: (command) => {
        if (command.type !== "thread.turn.start" || command.modelSelection?.instanceId !== claude) {
          return null;
        }
        call += 1;
        // Lost with the connection, then refused on what that attempt left.
        return call === 1
          ? new Error("Socket closed")
          : new OrchestrationDispatchCommandError({
              message: "fatal: a branch named 'ryco/1a2b3c4d' already exists",
            });
      },
    });
    setMultiModelSelection(DRAFT_ID, { enabled: true, selections: [gpt, opus] });
    const input = sendInput(api);
    await executeMultiModelSend(input);
    const record = latestSend()!;
    const unconfirmed = record.tracker.read().targets[1]!;
    const deps = { refs: input.refs, composerHandle: input.composerHandle, draft: input.draft };
    const asNew = () =>
      sendMultiModelTargetAsNew({ ...deps, draftId: DRAFT_ID, record, key: unconfirmed.plan.key });

    // Not before the node refused the identical retry.
    expect(asNew()).toBe("unavailable");
    await record.tracker.retryUncertain(unconfirmed.plan.key, { api, turnVisible: () => false });
    expect(record.tracker.read().targets[1]!.status).toMatchObject({
      kind: "uncertain",
      retryRefusal: "fatal: a branch named 'ryco/1a2b3c4d' already exists",
    });

    // Never over something the composer holds.
    input.refs.promptRef.current = "Another prompt";
    expect(asNew()).toBe("composer-not-empty");
    expect(record.tracker.read().targets).toHaveLength(2);
    input.refs.promptRef.current = "";

    expect(asNew()).toBe("restored");
    expect(input.draft.setComposerDraftPrompt).toHaveBeenCalledWith(DRAFT_ID, "Fix the flaky test");
    expect(input.draft.setComposerDraftFileReferences).toHaveBeenCalledWith(DRAFT_ID, [
      fileReference,
    ]);
    expect(readMultiModelSelection(DRAFT_ID)).toEqual({
      enabled: true,
      selections: [unconfirmed.plan.modelSelection],
      retry: true,
    });
    // It left its send, so it can neither be retried nor sent as new twice.
    expect(record.tracker.read().targets.map((target) => target.plan.key)).toEqual([
      record.tracker.read().targets[0]!.plan.key,
    ]);
    expect(asNew()).toBe("unavailable");
    expect(turnStarts(commands)).toHaveLength(3);
  });

  it("says the setup script runs only where the send's own preference runs it", async () => {
    const projectId = ProjectId.make("project-1");
    const preferencesNode = {
      environment: { capabilities: { requiredWorktreeBootstrap: true, projectPreferences: true } },
      settings: {},
    } as unknown as ServerConfig;
    const runs = (config: ServerConfig | null, hasSetupScript = true) =>
      multiModelSendRunsSetupScript({
        hasSetupScript,
        config,
        environmentId: ENVIRONMENT_ID,
        projectId,
      });

    expect(runs(preferencesNode, false)).toBe("no");
    // An older node runs it in every new worktree.
    expect(runs(nodeConfig())).toBe("yes");
    // The node decides from the project's preference: unknown here until read.
    expect(runs(preferencesNode)).toBe("maybe");
    expect(runs(null)).toBe("maybe");
    const remember = (runSetupScript: boolean) =>
      readAndRememberProjectPreferences({
        api: {
          server: {
            getProjectPreferences: async () => ({
              runSetupScript: { value: runSetupScript, source: "project" },
            }),
          },
        } as unknown as EnvironmentApi,
        environmentId: ENVIRONMENT_ID,
        config: preferencesNode,
        projectId,
      });
    await remember(false);
    expect(runs(preferencesNode)).toBe("no");
    await remember(true);
    expect(runs(preferencesNode)).toBe("yes");
  });
});
