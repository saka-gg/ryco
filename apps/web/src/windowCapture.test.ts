import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  EnvironmentId,
  ThreadId,
  type DesktopAppSnapCapture,
  type ScopedThreadRef,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ add: vi.fn((_options: unknown) => "toast") }));
vi.mock("./components/ui/toast", () => ({ toastManager: toasts }));
// Node has no localStorage; this stands in for the draft records written to it,
// which the draft store reads back to verify a save.
const storedAttachmentIds = vi.hoisted(() => new Set<string>());
const readStoredAttachmentIds = vi.hoisted(() => vi.fn(() => [...storedAttachmentIds]));
vi.mock("./composerDraftPersistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./composerDraftPersistence")>()),
  readPersistedAttachmentIdsFromStorage: readStoredAttachmentIds,
}));

import { useComposerDraftStore } from "./composerDraftStore";
import {
  captureWindowIntoComposer,
  registerWindowCaptureSink,
  resetWindowCaptureIntakeForTests,
  windowCaptureAttachmentId,
  windowCaptureErrorMessage,
  windowCaptureFileName,
  type WindowCaptureAttachResult,
  type WindowCaptureSink,
} from "./windowCapture";

const TARGET = scopeThreadRef(EnvironmentId.make("environment-local"), ThreadId.make("thread-1"));
const OTHER_TARGET = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-2"),
);

function capture(id: string, patch: Partial<DesktopAppSnapCapture> = {}): DesktopAppSnapCapture {
  return {
    id,
    capturedAt: "2026-10-22T10:00:00.000Z",
    name: `appsnap-${id}.png`,
    mimeType: "image/png",
    sizeBytes: 3,
    bytes: new Uint8Array([1, 2, 3]),
    sourceAppName: "Safari",
    sourceBundleIdentifier: "com.apple.Safari",
    sourceAppIconDataUrl: null,
    sourceWindowTitle: "Release notes",
    ...patch,
  };
}

function createBridge(pending: DesktopAppSnapCapture[] = []) {
  const listeners = {
    captured: [] as Array<(capture: DesktopAppSnapCapture) => void>,
  };
  const bridge = {
    getState: vi.fn(),
    setup: vi.fn(),
    setShortcut: vi.fn(),
    listWindows: vi.fn(async () => []),
    captureWindow: vi.fn(async (windowId: number) => capture(`picker-${windowId}`)),
    // Like the desktop app: metadata only, bytes per capture.
    listPendingCaptures: vi.fn(async () => pending.map(({ bytes: _bytes, ...entry }) => entry)),
    readPendingCapture: vi.fn(
      async (captureId: string) => pending.find((shot) => shot.id === captureId) ?? null,
    ),
    acknowledgeCapture: vi.fn(async (_captureId: string) => undefined),
    onState: vi.fn(() => () => undefined),
    onCaptured: vi.fn((listener: (capture: DesktopAppSnapCapture) => void) => {
      listeners.captured.push(listener);
      return () => undefined;
    }),
    onError: vi.fn(() => () => undefined),
  };
  vi.stubGlobal("window", { desktopBridge: { windowCapture: bridge } });
  return { bridge, emitCaptured: (shot: DesktopAppSnapCapture) => listeners.captured[0]?.(shot) };
}

function persist(attachmentId: string, file: File, target: ScopedThreadRef = TARGET): void {
  storedAttachmentIds.add(attachmentId);
  useComposerDraftStore.getState().syncPersistedAttachments(target, [
    {
      type: "image",
      id: attachmentId,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      bytes: "local",
    },
  ]);
}

/**
 * A composer double: adds through the real draft store, then persists like the
 * composer effect (at once, never, or when the test calls `persistNow`).
 */
function createSink(
  result: WindowCaptureAttachResult = "attached",
  options: {
    persist: "now" | "later" | "never";
    land: boolean;
    available?: boolean;
    target?: ScopedThreadRef;
  } = {
    persist: "now",
    land: true,
  },
) {
  const attached: string[] = [];
  const unsaved: Array<() => void> = [];
  const target = options.target ?? TARGET;
  const sink: WindowCaptureSink = {
    target,
    available: options.available ?? true,
    attach: vi.fn(async ({ attachmentId, file }) => {
      if (result !== "attached") return result;
      attached.push(file.name);
      // A draft that does not resolve drops the image without saying so.
      if (!options.land) return "attached";
      useComposerDraftStore.getState().addImage(target, {
        type: "image",
        id: attachmentId,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: `blob:${attachmentId}`,
        file,
      });
      // Like the composer, it saves only what the draft took; an image identical
      // to one already there is dropped without saying so.
      const taken = useComposerDraftStore
        .getState()
        .getComposerDraft(target)
        ?.images.some((image) => image.id === attachmentId);
      if (!taken) return "attached";
      if (options.persist === "now") queueMicrotask(() => persist(attachmentId, file, target));
      if (options.persist === "later") unsaved.push(() => persist(attachmentId, file, target));
      return "attached";
    }),
    focus: vi.fn(),
  };
  return { sink, attached, persistNow: () => unsaved.splice(0).forEach((run) => run()) };
}

/** Lets queued deliveries and draft verifications run; works with faked timeouts too. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  resetWindowCaptureIntakeForTests();
  storedAttachmentIds.clear();
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  toasts.add.mockClear();
  readStoredAttachmentIds.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("window capture naming", () => {
  it("names the file after the app and window, safely", () => {
    expect(windowCaptureFileName(capture("a"))).toBe("Safari - Release notes.png");
    expect(
      windowCaptureFileName(
        capture("a", { sourceAppName: "Ghostty", sourceWindowTitle: "Ghostty" }),
      ),
    ).toBe("Ghostty.png");
    expect(
      windowCaptureFileName(
        capture("a", { sourceAppName: "Finder", sourceWindowTitle: "~/src/ryco\u0007\\notes" }),
      ),
    ).toBe("Finder - ~ src ryco notes.png");
    expect(
      windowCaptureFileName(capture("a", { sourceAppName: null, sourceWindowTitle: null })),
    ).toBe("Window.png");
  });

  it("derives a stable attachment id and plain error text", () => {
    expect(windowCaptureAttachmentId("picker-9b2c")).toBe("capture-picker-9b2c");
    expect(windowCaptureAttachmentId("a/b c")).toBe("capture-abc");
    expect(
      windowCaptureErrorMessage(
        new Error(
          "Error invoking remote method 'desktop:window-capture:list-windows': Error: Timed out.",
        ),
      ),
    ).toBe("Timed out.");
  });
});

describe("window capture intake", () => {
  it("does nothing without the desktop capture bridge", () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    const { sink } = createSink();
    const unregister = registerWindowCaptureSink(sink);
    unregister();
    expect(sink.attach).not.toHaveBeenCalled();
  });

  it("delivers pending captures to a registering composer and acknowledges once saved", async () => {
    const { bridge } = createBridge([capture("one")]);
    const { sink, attached } = createSink();
    registerWindowCaptureSink(sink);
    await settle();
    expect(attached).toEqual(["Safari - Release notes.png"]);
    expect(bridge.readPendingCapture).toHaveBeenCalledWith("one");
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("one");
    // Pending captures land silently; only live captures take the caret.
    expect(sink.focus).not.toHaveBeenCalled();
  });

  it("acknowledges a capture a draft already saved without reading or attaching it again", async () => {
    const { bridge } = createBridge([capture("one")]);
    const first = createSink();
    const unregister = registerWindowCaptureSink(first.sink);
    await settle();
    unregister();
    bridge.acknowledgeCapture.mockClear();

    const second = createSink();
    registerWindowCaptureSink(second.sink);
    await settle();
    expect(second.sink.attach).not.toHaveBeenCalled();
    expect(bridge.readPendingCapture).toHaveBeenCalledTimes(1);
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("one");
  });

  it("keeps an unsaved draft copy pending without attaching it twice", async () => {
    const { bridge } = createBridge([capture("one")]);
    const first = createSink("attached", { persist: "later", land: true });
    const unregister = registerWindowCaptureSink(first.sink);
    await settle();
    unregister();

    // Switching threads drains again while the first draft has not saved it.
    const second = createSink();
    registerWindowCaptureSink(second.sink);
    await settle();
    expect(second.sink.attach).not.toHaveBeenCalled();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();

    first.persistNow();
    await settle();
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("one");
  });

  it("takes the draft store's verified save without reading storage itself", async () => {
    const { bridge } = createBridge([capture("one")]);
    registerWindowCaptureSink(createSink().sink);
    await settle();
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("one");
    // The store's own read-back, once per save; typing reads nothing.
    expect(readStoredAttachmentIds).toHaveBeenCalledTimes(1);
    for (const prompt of ["a", "ab", "abc"]) {
      useComposerDraftStore.getState().setPrompt(TARGET, prompt);
    }
    expect(readStoredAttachmentIds).toHaveBeenCalledTimes(1);
  });

  it("reads no draft's attachments while a watched capture waits and the user types", async () => {
    const { bridge } = createBridge([capture("one")]);
    registerWindowCaptureSink(createSink("attached", { persist: "never", land: true }).sink);
    await settle();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();

    // Another draft whose attachment lists count every read.
    useComposerDraftStore.getState().setPrompt(OTHER_TARGET, "elsewhere");
    let reads = 0;
    const counted = <T extends object>(list: T): T =>
      new Proxy(list, {
        get: (target, key, receiver) => {
          reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
    useComposerDraftStore.setState((state) => ({
      draftsByThreadKey: Object.fromEntries(
        Object.entries(state.draftsByThreadKey).map(([threadKey, draft]) => [
          threadKey,
          draft.prompt === "elsewhere"
            ? { ...draft, images: counted([]), persistedAttachments: counted([]) }
            : draft,
        ]),
      ),
    }));

    reads = 0;
    for (const prompt of ["a", "ab", "abc"]) {
      useComposerDraftStore.getState().setPrompt(TARGET, prompt);
    }
    expect(reads).toBe(0);
  });

  it("waits for the draft record, not just the staged attachment", async () => {
    const { bridge } = createBridge([capture("one")]);
    const { sink } = createSink("attached", { persist: "never", land: true });
    registerWindowCaptureSink(sink);
    await settle();
    // Staged, but the draft record never took it (e.g. storage is full).
    useComposerDraftStore.getState().syncPersistedAttachments(TARGET, [
      {
        type: "image",
        id: windowCaptureAttachmentId("one"),
        name: "Safari - Release notes.png",
        mimeType: "image/png",
        sizeBytes: 3,
        bytes: "local",
      },
    ]);
    await settle();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
  });

  it("treats a capture that stays out of every draft as sent or removed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { bridge } = createBridge([capture("one")]);
    const first = createSink("attached", { persist: "never", land: true });
    registerWindowCaptureSink(first.sink);
    await settle();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();

    // Sending clears the image from the draft; it counts once it stays out.
    useComposerDraftStore.getState().removeImage(TARGET, windowCaptureAttachmentId("one"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("one");
    vi.useRealTimers();

    // A later drain (the acknowledgement may have been lost) does not attach it again.
    const second = createSink();
    registerWindowCaptureSink(second.sink);
    await settle();
    expect(second.sink.attach).not.toHaveBeenCalled();
    expect(first.sink.attach).toHaveBeenCalledTimes(1);
  });

  it("keeps watching a capture a failed send put back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { bridge } = createBridge([capture("one")]);
    const { sink, persistNow } = createSink("attached", { persist: "later", land: true });
    registerWindowCaptureSink(sink);
    await settle();
    const [image] = useComposerDraftStore.getState().getComposerDraft(TARGET)!.images;

    // The send clears the draft, its dispatch fails and puts the image back.
    useComposerDraftStore.getState().clearComposerContent(TARGET);
    await vi.advanceTimersByTimeAsync(3_000);
    useComposerDraftStore.getState().addImages(TARGET, [image!]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();

    // A drain meanwhile neither attaches it twice nor drops its watch.
    registerWindowCaptureSink(createSink().sink);
    await settle();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(TARGET)!.images).toHaveLength(1);

    persistNow();
    await settle();
    expect(bridge.acknowledgeCapture).toHaveBeenCalledExactlyOnceWith("one");
  });

  it("keeps a capture the draft silently dropped pending and says where it goes", async () => {
    const { bridge } = createBridge();
    const { sink } = createSink("attached", { persist: "now", land: false });
    registerWindowCaptureSink(sink);
    await captureWindowIntoComposer(42, sink);
    await settle();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Window captured",
        description:
          "This chat couldn't take it. It's kept and added the next time you open a chat.",
      }),
    );
  });

  it("acknowledges a repeat capture its draft already holds an identical copy of", async () => {
    const pending: DesktopAppSnapCapture[] = [];
    const { bridge, emitCaptured } = createBridge(pending);
    const { sink, attached } = createSink();
    registerWindowCaptureSink(sink);
    await settle();
    // The same unchanged window captured twice: new ids, identical bytes and name.
    for (const id of ["first", "second"]) {
      const shot = capture(id);
      pending.push(shot);
      emitCaptured(shot);
      await settle();
    }
    expect(attached).toEqual(["Safari - Release notes.png", "Safari - Release notes.png"]);
    expect(
      useComposerDraftStore
        .getState()
        .getComposerDraft(TARGET)!
        .images.map((image) => image.id),
    ).toEqual([windowCaptureAttachmentId("first")]);
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("first");
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("second");
    expect(sink.focus).toHaveBeenCalledTimes(2);
    expect(toasts.add).not.toHaveBeenCalled();

    // Sent; a later drain for another chat (an acknowledgement may have been
    // lost) attaches neither copy there.
    useComposerDraftStore.getState().clearComposerContent(TARGET);
    const other = createSink("attached", { persist: "now", land: true, target: OTHER_TARGET });
    registerWindowCaptureSink(other.sink);
    await settle();
    expect(other.sink.attach).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(OTHER_TARGET)?.images ?? []).toEqual(
      [],
    );
  });

  it("sends shortcut captures to the focused composer and focuses it", async () => {
    const { bridge, emitCaptured } = createBridge();
    const background = createSink();
    const focused = createSink();
    registerWindowCaptureSink(background.sink);
    registerWindowCaptureSink(focused.sink);
    await settle();
    emitCaptured(capture("live"));
    await settle();
    expect(focused.sink.attach).toHaveBeenCalledTimes(1);
    expect(background.sink.attach).not.toHaveBeenCalled();
    expect(focused.sink.focus).toHaveBeenCalledTimes(1);
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("live");
  });

  it("keeps a shortcut capture for a focused composer without a chat, not another pane's", async () => {
    const pending: DesktopAppSnapCapture[] = [];
    const { bridge, emitCaptured } = createBridge(pending);
    const otherPane = createSink();
    registerWindowCaptureSink(otherPane.sink);
    // The user moved to a composer that has no chat open yet.
    const focused = createSink("attached", { persist: "now", land: true, available: false });
    const unregister = registerWindowCaptureSink(focused.sink);
    await settle();
    const shot = capture("live");
    pending.push(shot);
    emitCaptured(shot);
    await settle();
    expect(otherPane.sink.attach).not.toHaveBeenCalled();
    expect(otherPane.sink.focus).not.toHaveBeenCalled();
    expect(focused.sink.attach).not.toHaveBeenCalled();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Window captured",
        description: "Open a chat to attach it.",
      }),
    );

    // Its chat opens: the composer registers again, now available, and takes it.
    unregister();
    const ready = createSink();
    registerWindowCaptureSink(ready.sink);
    await settle();
    expect(ready.attached).toEqual(["Safari - Release notes.png"]);
    expect(otherPane.sink.attach).not.toHaveBeenCalled();
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("live");
  });

  it("keeps a shortcut capture pending while no composer is open", async () => {
    const { bridge, emitCaptured } = createBridge();
    const { sink } = createSink();
    const unregister = registerWindowCaptureSink(sink);
    await settle();
    unregister();
    emitCaptured(capture("later"));
    await settle();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Window captured",
        description: "Open a chat to attach it.",
      }),
    );
  });

  it("drops a capture the composer refused and keeps one it could not take yet", async () => {
    const refused = createBridge([capture("refused")]);
    registerWindowCaptureSink(createSink("rejected").sink);
    await settle();
    expect(refused.bridge.acknowledgeCapture).toHaveBeenCalledWith("refused");

    resetWindowCaptureIntakeForTests();
    const notReady = createBridge([capture("not-ready")]);
    registerWindowCaptureSink(createSink("unavailable").sink);
    await settle();
    expect(notReady.bridge.acknowledgeCapture).not.toHaveBeenCalled();
    // A pending capture lands quietly later; nothing to tell the user yet.
    expect(toasts.add).not.toHaveBeenCalled();
  });

  it("captures a picked window into the composer that opened the picker", async () => {
    const { bridge } = createBridge();
    const { sink, attached } = createSink();
    registerWindowCaptureSink(sink);
    await captureWindowIntoComposer(42, sink);
    await settle();
    expect(bridge.captureWindow).toHaveBeenCalledWith(42);
    expect(attached).toHaveLength(1);
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("picker-42");

    bridge.captureWindow.mockRejectedValueOnce(new Error("The window disappeared."));
    await captureWindowIntoComposer(43, sink);
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Couldn't capture the window",
        description: "The window disappeared.",
      }),
    );
  });

  it("says so when the open chat cannot take a capture, then attaches it on the next one", async () => {
    const pending: DesktopAppSnapCapture[] = [];
    const { bridge } = createBridge(pending);
    const { sink } = createSink("unavailable");
    const unregister = registerWindowCaptureSink(sink);
    await settle();
    bridge.captureWindow.mockImplementationOnce(async (windowId: number) => {
      // The desktop app keeps it pending until it is acknowledged.
      const shot = capture(`picker-${windowId}`);
      pending.push(shot);
      return shot;
    });
    await captureWindowIntoComposer(42, sink);
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Window captured",
        description:
          "This chat couldn't take it. It's kept and added the next time you open a chat.",
      }),
    );

    unregister();
    const next = createSink();
    registerWindowCaptureSink(next.sink);
    await settle();
    expect(next.attached).toEqual(["Safari - Release notes.png"]);
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("picker-42");
  });
});
