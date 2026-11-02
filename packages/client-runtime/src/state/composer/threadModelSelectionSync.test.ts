import { EnvironmentId, type ModelSelection, ProviderInstanceId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scopeThreadRef } from "../../scoped.ts";
import { createComposerDraftStore } from "./draftStore.ts";
import type { ComposerDraftStorage } from "./draftSplitStorage.ts";
import {
  createThreadModelSelectionSync,
  syncComposerDraftWithThreadModelSelection,
  THREAD_MODEL_SELECTION_PERSIST_DELAY_MS,
  threadModelSelectionToPersist,
  type ThreadModelSelectionView,
} from "./threadModelSelectionSync.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const selection = (model: string, effort?: string, instanceId = claude): ModelSelection => ({
  instanceId,
  model,
  ...(effort ? { options: [{ id: "effort", value: effort }] } : {}),
});
const THREAD = "environment:thread";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Persist = (modelSelection: ModelSelection) => Promise<unknown>;

/** One composer on one chat: what it shows, and what the node stores. */
function composer(initial: ModelSelection, persist = vi.fn<Persist>(() => Promise.resolve())) {
  const state = {
    server: initial as ModelSelection | null | undefined,
    picked: null as ModelSelection | null,
  };
  const shown: ModelSelection[] = [];
  const reportFailure = vi.fn<(error: unknown) => void>();
  const view = (): ThreadModelSelectionView => ({
    serverModelSelection: state.server,
    composerModelSelection: state.picked ?? state.server,
    show: (modelSelection) => {
      shown.push(modelSelection);
      state.picked = null;
    },
    persist,
    reportFailure,
  });
  return { state, shown, view, persist, reportFailure };
}

describe("threadModelSelectionToPersist", () => {
  it("stores a pick of the thread's own instance that differs from what it stores", () => {
    expect(
      threadModelSelectionToPersist({
        serverModelSelection: selection("opus", "high"),
        composerModelSelection: selection("opus", "max"),
      }),
    ).toEqual(selection("opus", "max"));
  });

  it("stores nothing for the same selection, another instance, or a chat the node lacks", () => {
    expect(
      threadModelSelectionToPersist({
        serverModelSelection: { instanceId: claude, model: "opus", options: [] },
        composerModelSelection: { instanceId: claude, model: "opus" },
      }),
    ).toBeNull();
    expect(
      threadModelSelectionToPersist({
        serverModelSelection: selection("opus"),
        composerModelSelection: selection("gpt-5.1", undefined, ProviderInstanceId.make("codex")),
      }),
    ).toBeNull();
    expect(
      threadModelSelectionToPersist({
        serverModelSelection: undefined,
        composerModelSelection: selection("opus"),
      }),
    ).toBeNull();
  });
});

describe("createThreadModelSelectionSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => ({ sync: createThreadModelSelectionSync() });

  it("stores a pick once its pause ends, folding rapid changes into one write", async () => {
    const { sync } = setup();
    const chat = composer(selection("opus", "high"));
    const { persist } = chat;
    sync.updateView(THREAD, chat.view());
    for (const effort of ["medium", "low", "max"]) {
      chat.state.picked = selection("opus", effort);
      sync.updateView(THREAD, chat.view());
      sync.committed(THREAD);
      await vi.advanceTimersByTimeAsync(THREAD_MODEL_SELECTION_PERSIST_DELAY_MS / 2);
    }
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(THREAD_MODEL_SELECTION_PERSIST_DELAY_MS);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(selection("opus", "max"));
  });

  it("shows a pick another client stored", () => {
    const { sync } = setup();
    const chat = composer(selection("opus", "high"));
    const { persist } = chat;
    sync.updateView(THREAD, chat.view());
    chat.state.server = selection("sonnet", "high");
    sync.updateView(THREAD, chat.view());
    sync.serverChanged(THREAD);
    expect(chat.shown).toEqual([selection("sonnet", "high")]);
    expect(persist).not.toHaveBeenCalled();
  });

  it("holds back another client's change while its own pick is pending, then shows the result", async () => {
    const write = deferred();
    const { sync } = setup();
    const chat = composer(
      selection("opus", "high"),
      vi.fn<Persist>(() => write.promise),
    );
    sync.updateView(THREAD, chat.view());
    chat.state.picked = selection("opus", "max");
    sync.updateView(THREAD, chat.view());
    sync.committed(THREAD);
    // Another client stores a pick while this one waits out its pause and while it is written.
    chat.state.server = selection("sonnet");
    sync.updateView(THREAD, chat.view());
    sync.serverChanged(THREAD);
    await vi.advanceTimersByTimeAsync(THREAD_MODEL_SELECTION_PERSIST_DELAY_MS);
    sync.serverChanged(THREAD);
    expect(chat.shown).toEqual([]);
    // This client's write landed last: the node now stores its pick.
    chat.state.server = selection("opus", "max");
    sync.updateView(THREAD, chat.view());
    write.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(chat.shown).toEqual([selection("opus", "max")]);
  });

  it("goes back to what the thread stores when the node refuses the pick", async () => {
    const refused = new Error("Thread is archived.");
    const { sync } = setup();
    const chat = composer(
      selection("opus", "high"),
      vi.fn<Persist>(() => Promise.reject(refused)),
    );
    sync.updateView(THREAD, chat.view());
    chat.state.picked = selection("opus", "max");
    sync.updateView(THREAD, chat.view());
    sync.committed(THREAD);
    await vi.advanceTimersByTimeAsync(THREAD_MODEL_SELECTION_PERSIST_DELAY_MS);
    expect(chat.reportFailure).toHaveBeenCalledWith(refused);
    expect(chat.shown).toEqual([selection("opus", "high")]);
    expect(chat.state.picked).toBeNull();
  });

  it("stores a pick still waiting out its pause when the composer leaves the chat", async () => {
    const { sync } = setup();
    const chat = composer(selection("opus", "high"));
    const { persist } = chat;
    sync.updateView(THREAD, chat.view());
    chat.state.picked = selection("sonnet", "high");
    sync.updateView(THREAD, chat.view());
    sync.committed(THREAD);
    sync.release(THREAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(persist).toHaveBeenCalledWith(selection("sonnet", "high"));
    // Nothing is shown in a composer that is gone.
    sync.serverChanged(THREAD);
    expect(chat.shown).toEqual([]);
  });

  it("keeps a pick of another instance for the send that hands off", async () => {
    const { sync } = setup();
    const chat = composer(selection("opus", "high"));
    const { persist } = chat;
    sync.updateView(THREAD, chat.view());
    chat.state.picked = selection("gpt-5.1", undefined, ProviderInstanceId.make("codex"));
    sync.updateView(THREAD, chat.view());
    sync.committed(THREAD);
    await vi.advanceTimersByTimeAsync(THREAD_MODEL_SELECTION_PERSIST_DELAY_MS);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("syncComposerDraftWithThreadModelSelection", () => {
  const memoryStorage = (): ComposerDraftStorage => {
    const values = new Map<string, string>();
    return {
      getItem: (name) => values.get(name) ?? null,
      setItem: (name, value) => void values.set(name, value),
      removeItem: (name) => void values.delete(name),
      keys: () => values.keys(),
      releaseAttachments: () => undefined,
    };
  };
  const makeStore = () =>
    createComposerDraftStore({
      storage: memoryStorage(),
      flushStorage: () => undefined,
      revokePreviewUrl: () => undefined,
      hydrateImages: () => [],
      readPersistedAttachmentIds: () => [],
    }).useComposerDraftStore;
  const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));

  it("turns the draft's pick of the stored instance into the stored selection", () => {
    const store = makeStore();
    store.getState().setModelSelection(threadRef, selection("opus", "high"));
    syncComposerDraftWithThreadModelSelection(store, threadRef, selection("sonnet", "max"));
    const draft = store.getState().getComposerDraft(threadRef);
    expect(draft?.modelSelectionByProvider[claude]).toEqual(selection("sonnet", "max"));
    expect(draft?.activeProvider).toBe(claude);
  });

  it("leaves a pending pick of another instance and a draft without a pick alone", () => {
    const store = makeStore();
    const codex = ProviderInstanceId.make("codex");
    store.getState().setModelSelection(threadRef, selection("gpt-5.1", undefined, codex));
    const before = store.getState().getComposerDraft(threadRef);
    syncComposerDraftWithThreadModelSelection(store, threadRef, selection("sonnet", "max"));
    expect(store.getState().getComposerDraft(threadRef)).toBe(before);

    const empty = makeStore();
    syncComposerDraftWithThreadModelSelection(empty, threadRef, selection("sonnet", "max"));
    expect(empty.getState().getComposerDraft(threadRef)).toBeNull();
  });
});
