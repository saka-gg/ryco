import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { APP_DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/client-runtime/state/settings";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Whether the store shows the open thread as settled: it changes only when the test says.
const store = vi.hoisted(() => ({ settled: false }));
vi.mock("../inboxSidebar/inboxSidebarModel", () => ({
  resolveCurrentThreadLifecycle: (input: {
    thread: { environmentId: string; id: string; title: string };
  }) => ({
    target: { environmentId: input.thread.environmentId, threadId: input.thread.id },
    title: input.thread.title,
    availability: {
      settle: { enabled: true, blocker: null, settled: store.settled },
      snooze: { enabled: true, blocker: null, snoozedUntil: null },
      archive: { enabled: true, blocker: null },
      markUnread: { enabled: true, blocker: null },
    },
  }),
  threadLifecycleDisabledReason: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (options: unknown) => options,
}));
vi.mock("../../sidebarUndo", () => ({ sidebarUndo: { latest: () => null, undo: vi.fn() } }));
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({ confirmThreadArchive: false }),
}));
vi.mock("../../lib/composerFocus", () => ({ isComposerFocused: () => false }));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: { getState: () => ({ markThreadUnread: vi.fn() }) },
}));

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { isMacPlatform } from "../../lib/utils";
import type { SidebarThreadOrStub } from "../../types";
import {
  startThreadLifecycleShortcuts,
  type ThreadLifecycleCommands,
  type ThreadLifecycleShortcutsProps,
} from "./threadLifecycleShortcutsController";

const target = { environmentId: EnvironmentId.make("node"), threadId: ThreadId.make("thread") };
const thread = {
  id: target.threadId,
  environmentId: target.environmentId,
  title: "Fix the relay",
  archivedAt: null,
  latestUserMessageAt: "2026-10-24T08:00:00.000Z",
  latestTurn: null,
} as unknown as SidebarThreadOrStub;

const props: ThreadLifecycleShortcutsProps = {
  routeThreadRef: target,
  threadByKey: new Map([[scopedThreadKey(target), thread]]),
  projects: [],
  worktrees: [],
  environments: [],
  localQueuedThreadKeys: new Set(),
  deliveryUnknownThreadKeys: new Set(),
  pinnedThreadKeys: new Set(),
  autoSettleAfterDays: null,
  archiveThread: async () => {},
  keybindings: APP_DEFAULT_RESOLVED_KEYBINDINGS,
  readShortcutContext: () => ({}),
};

/** A command the node has not answered yet. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** ⌥⇧⌘ plus the letter on macOS, Ctrl+Alt+Shift elsewhere. */
function pressLifecycleChord(letter: "A" | "D" | "S"): Event {
  const useMetaForMod = isMacPlatform(navigator.platform);
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key: letter,
    code: `Key${letter}`,
    altKey: true,
    shiftKey: true,
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
    repeat: false,
    isComposing: false,
  });
  window.dispatchEvent(event);
  return event;
}

/** Lets the answered commands' callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: (() => void) | null = null;

beforeEach(() => {
  store.settled = false;
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      activeElement: null,
      querySelector: () => null,
      querySelectorAll: () => [],
    }),
  );
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
});

describe("startThreadLifecycleShortcuts", () => {
  it("sends a lifecycle action once until the node has answered it", async () => {
    const settle = deferred<boolean>();
    const archive = deferred<void>();
    const commands = {
      dispatchThreadSettlement: vi.fn(() => settle.promise),
      dispatchThreadSnooze: vi.fn(async () => {}),
      requestThreadArchive: vi.fn(() => archive.promise),
    } satisfies ThreadLifecycleCommands;
    stop = startThreadLifecycleShortcuts(() => props, commands);

    expect(pressLifecycleChord("D").defaultPrevented).toBe(true);
    // The store still shows the thread as active: a second press would settle it
    // again and drop the first settle's Undo.
    expect(pressLifecycleChord("D").defaultPrevented).toBe(true);
    expect(pressLifecycleChord("A").defaultPrevented).toBe(true);
    expect(pressLifecycleChord("S").defaultPrevented).toBe(true);
    expect(commands.dispatchThreadSettlement).toHaveBeenCalledOnce();
    expect(commands.dispatchThreadSettlement).toHaveBeenCalledWith(target, true);
    expect(commands.requestThreadArchive).not.toHaveBeenCalled();
    expect(useCommandPaletteStore.getState().openIntent).toBeNull();
    // The palette offers nothing that would send it again.
    const lifecycle = useCommandPaletteStore.getState().readCurrentThreadLifecycle?.();
    expect(lifecycle?.pending).toBe(true);
    lifecycle?.setSettled(true);
    lifecycle?.archive();
    expect(commands.dispatchThreadSettlement).toHaveBeenCalledOnce();
    expect(commands.requestThreadArchive).not.toHaveBeenCalled();

    store.settled = true;
    settle.resolve(true);
    await flush();
    expect(useCommandPaletteStore.getState().readCurrentThreadLifecycle?.()?.pending).toBe(false);
    pressLifecycleChord("D");
    expect(commands.dispatchThreadSettlement).toHaveBeenCalledTimes(2);
    expect(commands.dispatchThreadSettlement).toHaveBeenLastCalledWith(target, false);
    await flush();

    // An archive holds the thread the same way.
    pressLifecycleChord("A");
    pressLifecycleChord("A");
    expect(commands.requestThreadArchive).toHaveBeenCalledOnce();
    archive.resolve();
    await flush();
    pressLifecycleChord("A");
    expect(commands.requestThreadArchive).toHaveBeenCalledTimes(2);
  });
});
