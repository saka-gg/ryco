import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { ChatFileUploadStatus } from "@ryco/client-runtime/state/composer";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, String(value)),
    };
  }
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  (globalThis as { window?: unknown }).window = { localStorage, sessionStorage };

  const statuses = new Map<string, unknown>();
  const engineListeners = new Set<() => void>();
  const engine = {
    get: (id: string) => (statuses.has(id) ? { status: statuses.get(id) } : null),
    subscribe: (listener: () => void) => {
      engineListeners.add(listener);
      return () => engineListeners.delete(listener);
    },
    release: vi.fn(),
    retry: vi.fn(),
    set(id: string, status: unknown) {
      statuses.set(id, status);
      for (const listener of engineListeners) listener();
    },
  };
  const drafts = {
    draftsByThreadKey: {} as Record<string, { prompt: string; images: Array<{ id: string }> }>,
    setPrompt: vi.fn(),
    addImages: vi.fn(),
    setTerminalContexts: vi.fn(),
    setFileReferences: vi.fn(),
  };
  const storeListeners = new Set<() => void>();
  const envListeners = new Set<() => void>();
  return {
    localStorage,
    sessionStorage,
    statuses,
    engine,
    drafts,
    storeListeners,
    envListeners,
    environment: { shellLive: true, mutationReady: true },
    view: null as null | { detailLoaded: boolean; projectedMessageIds: Set<string> },
    serverQueue: null as null | { entries: Array<{ messageId: string }> },
    toast: vi.fn(),
    retainDetail: vi.fn(() => () => undefined),
    restoreBytes: vi.fn(async () => undefined),
  };
});

vi.mock("./composerFileUpload", () => ({
  composerFileUploadEngine: harness.engine,
  useComposerFileUploadRecords: () => new Map(),
}));
vi.mock("./composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => harness.drafts,
    persist: { hasHydrated: () => true, onFinishHydration: () => undefined },
  },
  ensureComposerDraftAttachmentsRestored: harness.restoreBytes,
}));
vi.mock("./composerDraftPersistence", () => ({
  hydrateDraftImagesFromPersisted: (rows: Array<{ id: string }>) =>
    rows.map((row) => ({ ...row, file: null, previewUrl: "" })),
}));
vi.mock("./components/ui/toast", () => ({
  toastManager: { add: harness.toast },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("./environments/runtime/service", () => ({
  retainThreadDetailSubscription: harness.retainDetail,
}));
vi.mock("./messageQueueEnvironment", () => ({
  readWebQueueEnvironment: () => harness.environment,
  subscribeWebQueueEnvironmentReadiness: (listener: () => void) => {
    harness.envListeners.add(listener);
    return () => harness.envListeners.delete(listener);
  },
}));
vi.mock("./store", () => ({
  useStore: {
    getState: () => ({}),
    subscribe: (listener: () => void) => {
      harness.storeListeners.add(listener);
      return () => harness.storeListeners.delete(listener);
    },
  },
}));
vi.mock("@ryco/client-runtime/state/message-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ryco/client-runtime/state/message-queue")>()),
  readQueueThreadView: () => harness.view,
  selectThreadFollowUpQueue: () => harness.serverQueue,
}));

const REF = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const KEY = scopedThreadKey(REF);
const EXPIRES = "2099-01-01T00:00:00.000Z";

function file(id: string, extra: object = {}) {
  return {
    type: "file" as const,
    id,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 10,
    previewUrl: "",
    file: null,
    ...extra,
  };
}

function snapshot(images: ReturnType<typeof file>[], prompt = "Read these") {
  return {
    prompt,
    trimmedPrompt: prompt,
    images,
    sendableTerminalContexts: [],
    fileReferences: [],
    sourceControlContexts: [],
  } as never;
}

async function load() {
  vi.resetModules();
  const held = await import("./heldSends");
  const records = await import("./heldSendRecords");
  const { useMessageQueueStore } = await import("./messageQueueStore");
  return { held, records, queue: useMessageQueueStore };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function uploaded(token: string): ChatFileUploadStatus {
  return { kind: "uploaded", uploadToken: token, expiresAt: EXPIRES };
}

beforeEach(() => {
  harness.localStorage.clear();
  harness.sessionStorage.clear();
  harness.statuses.clear();
  harness.drafts.draftsByThreadKey = {};
  harness.environment = { shellLive: true, mutationReady: true };
  harness.view = null;
  harness.serverQueue = null;
  vi.clearAllMocks();
});
afterEach(() => {
  harness.storeListeners.clear();
  harness.envListeners.clear();
});

describe("held sends", () => {
  it("applies each finished upload and stops waiting after the last one", async () => {
    const { held, queue, records } = await load();
    harness.statuses.set("f1", { kind: "uploading", progress: 0.1 });
    harness.statuses.set("f2", { kind: "pending" });
    held.holdSendForUploads({
      threadKey: KEY,
      entry: { id: "m1", composer: snapshot([file("f1"), file("f2")]), settings: {} as never },
      awaiting: ["f1", "f2"],
      sentAs: "send",
      draftTarget: REF,
    });
    await flush();
    const entry = () => queue.getState().queuesByThreadKey[KEY]?.[0];
    expect(entry()?.uploadHold).toEqual({ awaiting: ["f1", "f2"], sentAs: "send" });
    expect(records.readHeldSendRecords()[0]).toMatchObject({
      messageId: "m1",
      threadKey: KEY,
      prompt: "Read these",
      attachments: [
        expect.objectContaining({ id: "f1", uploadState: "needsReattach" }),
        expect.objectContaining({ id: "f2", uploadState: "needsReattach" }),
      ],
    });

    harness.engine.set("f1", uploaded("tok-1"));
    await flush();
    expect(entry()?.uploadHold?.awaiting).toEqual(["f2"]);
    expect(entry()?.composer.images[0]).toMatchObject({ uploadToken: "tok-1" });
    // A reload now would bring the uploaded file back by its token.
    expect(records.readHeldSendRecords()[0]?.attachments[0]).toMatchObject({
      id: "f1",
      uploadToken: "tok-1",
    });

    harness.engine.set("f2", uploaded("tok-2"));
    await flush();
    expect(entry()?.uploadHold).toEqual({ awaiting: [], sentAs: "send" });
    expect(entry()?.composer.images.map((image) => image.uploadToken)).toEqual(["tok-1", "tok-2"]);
  });

  it("does not stop waiting for a failed upload, and a retry picks it up", async () => {
    const { held, queue } = await load();
    harness.statuses.set("f1", { kind: "uploading", progress: 0.5 });
    held.holdSendForUploads({
      threadKey: KEY,
      entry: { id: "m1", composer: snapshot([file("f1")]), settings: {} as never },
      awaiting: ["f1"],
      sentAs: "queue",
      draftTarget: REF,
    });
    harness.engine.set("f1", { kind: "failed", retryable: true, message: "Network error" });
    await flush();
    expect(queue.getState().queuesByThreadKey[KEY]?.[0]?.uploadHold?.awaiting).toEqual(["f1"]);
    held.retryHeldUpload("f1");
    expect(harness.engine.retry).toHaveBeenCalledWith("f1");
    harness.engine.set("f1", uploaded("tok"));
    await flush();
    expect(queue.getState().queuesByThreadKey[KEY]?.[0]?.uploadHold?.awaiting).toEqual([]);
  });

  it("sends without a removed file, and drops a message left with nothing to send", async () => {
    const { held, queue } = await load();
    harness.statuses.set("f1", { kind: "failed", retryable: false, message: "Too big" });
    held.holdSendForUploads({
      threadKey: KEY,
      entry: { id: "m1", composer: snapshot([file("f1")]), settings: {} as never },
      awaiting: ["f1"],
      sentAs: "send",
      draftTarget: REF,
    });
    held.holdSendForUploads({
      threadKey: KEY,
      entry: { id: "m2", composer: snapshot([file("f2")], ""), settings: {} as never },
      awaiting: ["f2"],
      sentAs: "send",
      draftTarget: REF,
    });
    held.removeHeldAttachment(KEY, "m1", "f1");
    held.removeHeldAttachment(KEY, "m2", "f2");
    const remaining = queue.getState().queuesByThreadKey[KEY] ?? [];
    expect(remaining.map((entry) => entry.id)).toEqual(["m1"]);
    expect(remaining[0]?.uploadHold?.awaiting).toEqual([]);
    expect(remaining[0]?.composer.images).toEqual([]);
    expect(harness.engine.release).toHaveBeenCalledWith("f1");
  });

  it("drops the recovery record once the message left the queue, keeping uploads a draft took back", async () => {
    const { held, queue, records } = await load();
    harness.statuses.set("f1", { kind: "uploading", progress: 0 });
    harness.statuses.set("f2", { kind: "uploading", progress: 0 });
    held.holdSendForUploads({
      threadKey: KEY,
      entry: { id: "m1", composer: snapshot([file("f1")]), settings: {} as never },
      awaiting: ["f1"],
      sentAs: "send",
      draftTarget: REF,
    });
    held.holdSendForUploads({
      threadKey: KEY,
      entry: { id: "m2", composer: snapshot([file("f2")]), settings: {} as never },
      awaiting: ["f2"],
      sentAs: "send",
      draftTarget: REF,
    });
    await flush();
    expect(held.takeHeldSend(KEY, "m2")?.id).toBe("m2");
    // Cancelled: its file went back into the draft before it left the queue.
    harness.drafts.draftsByThreadKey[KEY] = { prompt: "Read these", images: [{ id: "f2" }] };
    queue.getState().remove(KEY, "m2");
    // Sent.
    queue.getState().remove(KEY, "m1");
    await flush();
    expect(records.readHeldSendRecords()).toEqual([]);
    expect(harness.engine.release).toHaveBeenCalledWith("f1");
    expect(harness.engine.release).not.toHaveBeenCalledWith("f2");
  });

  it("never gives back a message that is being sent", async () => {
    const { held, queue } = await load();
    held.holdSendForUploads({
      threadKey: KEY,
      entry: {
        id: "m1",
        composer: snapshot([file("f1", { uploadToken: "t", expiresAt: EXPIRES })]),
        settings: {} as never,
      },
      awaiting: [],
      sentAs: "send",
      draftTarget: REF,
    });
    expect(queue.getState().beginSend(KEY, "m1")).toBe(true);
    expect(held.takeHeldSend(KEY, "m1")).toBeNull();
  });
});

describe("held sends after a reload", () => {
  function leaveRecord(records: Awaited<ReturnType<typeof load>>["records"]) {
    records.updateHeldSendRecords(() => [
      {
        messageId: "m1",
        threadKey: KEY,
        draftTarget: { kind: "thread" },
        tabId: records.heldSendTabId(),
        heartbeatAt: Date.now(),
        prompt: "Read these",
        attachments: [
          {
            type: "file",
            id: "f1",
            name: "f1.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
            uploadState: "needsReattach",
          },
        ],
        terminalContexts: [],
        fileReferences: [],
      },
    ]);
  }

  it("puts a message that never went out back into its draft, after what the draft holds", async () => {
    const { held, records } = await load();
    leaveRecord(records);
    harness.drafts.draftsByThreadKey[KEY] = { prompt: "Typed later", images: [] };
    harness.view = { detailLoaded: false, projectedMessageIds: new Set() };
    held.ensureHeldSendWatcher();
    // The thread's messages are read before deciding.
    expect(harness.retainDetail).toHaveBeenCalledTimes(1);
    expect(harness.drafts.setPrompt).not.toHaveBeenCalled();

    harness.view = { detailLoaded: true, projectedMessageIds: new Set(["other"]) };
    for (const listener of harness.storeListeners) listener();
    expect(harness.drafts.setPrompt).toHaveBeenCalledExactlyOnceWith(
      REF,
      "Typed later\n\nRead these",
    );
    expect(harness.drafts.addImages).toHaveBeenCalledWith(REF, [
      expect.objectContaining({ id: "f1" }),
    ]);
    expect(records.readHeldSendRecords()).toEqual([]);
    // Settled once: later changes restore nothing more.
    for (const listener of harness.storeListeners) listener();
    expect(harness.drafts.setPrompt).toHaveBeenCalledTimes(1);
  });

  it("drops a message the thread already has, so it is never sent twice", async () => {
    const { held, records } = await load();
    leaveRecord(records);
    harness.view = { detailLoaded: true, projectedMessageIds: new Set(["m1"]) };
    held.ensureHeldSendWatcher();
    expect(harness.drafts.setPrompt).not.toHaveBeenCalled();
    expect(records.readHeldSendRecords()).toEqual([]);
  });

  it("waits for the environment before deciding", async () => {
    const { held, records } = await load();
    leaveRecord(records);
    harness.environment = { shellLive: false, mutationReady: false };
    held.ensureHeldSendWatcher();
    expect(records.readHeldSendRecords()).toHaveLength(1);
    harness.environment = { shellLive: true, mutationReady: true };
    harness.view = null;
    for (const listener of harness.envListeners) listener();
    // A draft's first message whose thread was never created comes back.
    expect(harness.drafts.setPrompt).toHaveBeenCalledTimes(1);
    expect(records.readHeldSendRecords()).toEqual([]);
  });

  it("leaves another live tab's messages alone", async () => {
    const { held, records } = await load();
    records.updateHeldSendRecords(() => [
      {
        messageId: "m9",
        threadKey: KEY,
        draftTarget: { kind: "thread" },
        tabId: "other-tab",
        heartbeatAt: Date.now(),
        prompt: "Theirs",
        attachments: [],
        terminalContexts: [],
        fileReferences: [],
      },
    ]);
    held.ensureHeldSendWatcher();
    expect(harness.drafts.setPrompt).not.toHaveBeenCalled();
    expect(records.readHeldSendRecords()).toHaveLength(1);
  });
});
