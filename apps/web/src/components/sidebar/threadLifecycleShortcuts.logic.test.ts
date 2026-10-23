import { APP_DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/client-runtime/state/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import type { CurrentThreadLifecycle } from "../../commandPaletteStore";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";
import {
  runThreadLifecycleShortcut,
  shouldIgnoreThreadLifecycleShortcut,
  threadLifecycleActionForCommand,
} from "./threadLifecycleShortcuts.logic";

function lifecycle(overrides: Partial<CurrentThreadLifecycle> = {}): CurrentThreadLifecycle {
  return {
    title: "Fix the build",
    settled: false,
    snoozed: false,
    disabledReasons: { settle: null, snooze: null, archive: null, markUnread: null },
    snoozeOptions: () => [],
    setSettled: vi.fn(),
    snooze: vi.fn(),
    archive: vi.fn(),
    markUnread: vi.fn(),
    ...overrides,
  };
}

function shortcutUi() {
  return { notify: vi.fn(), pickSnoozeTime: vi.fn() };
}

function keydown(overrides: Partial<Parameters<typeof shouldIgnoreThreadLifecycleShortcut>[0]>) {
  return {
    type: "keydown",
    key: "d",
    code: "KeyD",
    metaKey: true,
    ctrlKey: false,
    altKey: true,
    shiftKey: true,
    defaultPrevented: false,
    repeat: false,
    ...overrides,
  };
}

describe("threadLifecycleActionForCommand", () => {
  it("maps the lifecycle commands and nothing else", () => {
    expect(threadLifecycleActionForCommand("thread.settle")).toBe("settle");
    expect(threadLifecycleActionForCommand("thread.snooze")).toBe("snooze");
    expect(threadLifecycleActionForCommand("thread.archive")).toBe("archive");
    expect(threadLifecycleActionForCommand("thread.markUnread")).toBe("markUnread");
    expect(threadLifecycleActionForCommand("thread.pinToggle")).toBeNull();
    expect(threadLifecycleActionForCommand(null)).toBeNull();
  });
});

describe("runThreadLifecycleShortcut", () => {
  it("settles an active thread and moves a settled one back to Active", () => {
    const active = lifecycle();
    expect(runThreadLifecycleShortcut("settle", active, shortcutUi())).toBe(true);
    expect(active.setSettled).toHaveBeenCalledWith(true);

    const settled = lifecycle({ settled: true });
    runThreadLifecycleShortcut("settle", settled, shortcutUi());
    expect(settled.setSettled).toHaveBeenCalledWith(false);
  });

  it("picks a snooze time for an awake thread and wakes a snoozed one", () => {
    const awake = lifecycle();
    const ui = shortcutUi();
    runThreadLifecycleShortcut("snooze", awake, ui);
    expect(ui.pickSnoozeTime).toHaveBeenCalledOnce();
    expect(awake.snooze).not.toHaveBeenCalled();

    const snoozed = lifecycle({ snoozed: true });
    const snoozedUi = shortcutUi();
    runThreadLifecycleShortcut("snooze", snoozed, snoozedUi);
    expect(snoozed.snooze).toHaveBeenCalledWith(null);
    expect(snoozedUi.pickSnoozeTime).not.toHaveBeenCalled();
  });

  it("archives and marks unread", () => {
    const current = lifecycle();
    runThreadLifecycleShortcut("archive", current, shortcutUi());
    runThreadLifecycleShortcut("markUnread", current, shortcutUi());
    expect(current.archive).toHaveBeenCalledOnce();
    expect(current.markUnread).toHaveBeenCalledOnce();
  });

  it("says why an action cannot run and runs nothing", () => {
    const busy = lifecycle({
      disabledReasons: {
        settle: "Wait for the running work to finish.",
        snooze: null,
        archive: null,
        markUnread: null,
      },
    });
    const ui = shortcutUi();
    expect(runThreadLifecycleShortcut("settle", busy, ui)).toBe(true);
    expect(ui.notify).toHaveBeenCalledWith("Wait for the running work to finish.");
    expect(busy.setSettled).not.toHaveBeenCalled();
  });

  it("leaves the key to the focused control without an open thread", () => {
    const ui = shortcutUi();
    expect(runThreadLifecycleShortcut("archive", null, ui)).toBe(false);
    expect(ui.notify).not.toHaveBeenCalled();
  });
});

describe("shouldIgnoreThreadLifecycleShortcut", () => {
  it("takes a chord pressed once", () => {
    expect(shouldIgnoreThreadLifecycleShortcut(keydown({}))).toBe(false);
  });

  it("ignores held keys, IME composition, bare modifiers and handled keys", () => {
    expect(shouldIgnoreThreadLifecycleShortcut(keydown({ repeat: true }))).toBe(true);
    expect(shouldIgnoreThreadLifecycleShortcut(keydown({ isComposing: true }))).toBe(true);
    expect(shouldIgnoreThreadLifecycleShortcut(keydown({ key: "Shift" }))).toBe(true);
    expect(shouldIgnoreThreadLifecycleShortcut(keydown({ defaultPrevented: true }))).toBe(true);
  });
});

describe("lifecycle default keys", () => {
  const resolve = (event: Partial<ShortcutEventLike>, platform: string) =>
    resolveShortcutCommand(
      {
        type: "keydown",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        key: "",
        ...event,
      },
      APP_DEFAULT_RESOLVED_KEYBINDINGS,
      { platform },
    );

  it("match ⌥⇧⌘ chords on macOS, also where Option reports AltGraph", () => {
    const chord = { metaKey: true, altKey: true, shiftKey: true };
    expect(resolve({ ...chord, key: "Î", code: "KeyD" }, "MacIntel")).toBe("thread.settle");
    // Firefox reports Option as AltGraph; ⌥⇧S types "Í".
    expect(
      resolve(
        { ...chord, key: "Í", code: "KeyS", getModifierState: (key) => key === "AltGraph" },
        "MacIntel",
      ),
    ).toBe("thread.snooze");
    expect(resolve({ ...chord, key: "Å", code: "KeyA" }, "MacIntel")).toBe("thread.archive");
    expect(resolve({ ...chord, key: "¨", code: "KeyU" }, "MacIntel")).toBe("thread.markUnread");
  });

  it("match Ctrl+Alt+Shift elsewhere, but not a letter typed with AltGr", () => {
    const chord = { ctrlKey: true, altKey: true, shiftKey: true };
    expect(resolve({ ...chord, key: "D", code: "KeyD" }, "Win32")).toBe("thread.settle");
    // Polish AltGr+Shift+S types "Ś".
    expect(resolve({ ...chord, key: "Ś", code: "KeyS" }, "Win32")).toBeNull();
    expect(
      resolve(
        { ...chord, key: "Ś", code: "KeyS", getModifierState: (key) => key === "AltGraph" },
        "Win32",
      ),
    ).toBeNull();
  });
});
