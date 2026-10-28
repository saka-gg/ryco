import { APP_DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/client-runtime/state/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import type { CurrentThreadLifecycle } from "../../commandPaletteStore";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";
import {
  createThreadUndoShortcut,
  resolveUndoShortcutOwner,
  runThreadLifecycleShortcut,
  shouldIgnoreThreadLifecycleShortcut,
  threadLifecycleActionForCommand,
  type UndoShortcutOwner,
} from "./threadLifecycleShortcuts.logic";

function lifecycle(overrides: Partial<CurrentThreadLifecycle> = {}): CurrentThreadLifecycle {
  return {
    title: "Fix the build",
    settled: false,
    snoozed: false,
    pending: false,
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

  it("takes the key and sends nothing while an action awaits the node", () => {
    for (const settled of [false, true]) {
      const pending = lifecycle({ pending: true, settled, snoozed: settled });
      const ui = shortcutUi();
      for (const action of ["settle", "snooze", "archive"] as const) {
        expect(runThreadLifecycleShortcut(action, pending, ui)).toBe(true);
      }
      expect(pending.setSettled).not.toHaveBeenCalled();
      expect(pending.snooze).not.toHaveBeenCalled();
      expect(pending.archive).not.toHaveBeenCalled();
      expect(ui.pickSnoozeTime).not.toHaveBeenCalled();
      expect(ui.notify).not.toHaveBeenCalled();
      // Mark unread is this client's own state, so it still runs.
      runThreadLifecycleShortcut("markUnread", pending, ui);
      expect(pending.markUnread).toHaveBeenCalledOnce();
    }
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

  it("match Ctrl+Alt+Shift elsewhere, by the physical key outside a text field", () => {
    const chord = { ctrlKey: true, altKey: true, shiftKey: true };
    expect(resolve({ ...chord, key: "D", code: "KeyD" }, "Win32")).toBe("thread.settle");
    // Polish AltGr+Shift+S types "Ś" only in a text field (dialog.browser.tsx covers that);
    // anywhere else it types nothing, so the S key snoozes.
    expect(resolve({ ...chord, key: "Ś", code: "KeyS" }, "Win32")).toBe("thread.snooze");
    expect(
      resolve(
        { ...chord, key: "Ś", code: "KeyS", getModifierState: (key) => key === "AltGraph" },
        "Win32",
      ),
    ).toBe("thread.snooze");
  });
});

describe("the Undo shortcut", () => {
  const useMetaForMod = isMacPlatform(navigator.platform);

  function key(keyName: string, overrides: Record<string, unknown> = {}) {
    return {
      type: "keydown",
      key: keyName,
      code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides,
    };
  }

  /** ⌘Z on macOS, Ctrl+Z elsewhere. */
  function undoKey(overrides: Record<string, unknown> = {}) {
    return key("z", { metaKey: useMetaForMod, ctrlKey: !useMetaForMod, ...overrides });
  }

  describe("resolveUndoShortcutOwner", () => {
    const owner = (
      event: ReturnType<typeof key>,
      context: Parameters<typeof resolveUndoShortcutOwner>[2] = {},
    ) => resolveUndoShortcutOwner(event, APP_DEFAULT_RESOLVED_KEYBINDINGS, context);

    it("is null for any other key, during IME composition and in the terminal", () => {
      expect(owner(key("x", { metaKey: useMetaForMod, ctrlKey: !useMetaForMod }))).toBeNull();
      expect(owner(undoKey({ shiftKey: true }))).toBeNull();
      expect(owner(undoKey({ isComposing: true }))).toBeNull();
      expect(owner(undoKey(), { terminalFocus: true })).toBeNull();
    });

    it("leaves the key to a control that handled it and to the model picker", () => {
      expect(owner(undoKey({ defaultPrevented: true }))).toBe("control");
      expect(owner(undoKey(), { modelPickerOpen: true })).toBe("control");
    });

    it("takes the key outside any text field", () => {
      expect(owner(undoKey())).toBe("none");
    });
  });

  describe("createThreadUndoShortcut", () => {
    type UndoShortcut = ReturnType<typeof createThreadUndoShortcut>;

    function setup(initialNoticeId: number | null) {
      let noticeId = initialNoticeId;
      let pressedIn: UndoShortcutOwner = "composer";
      const undo = vi.fn((id: number) => {
        // Undo removes its notice; the one before it becomes the newest.
        noticeId = id > 1 ? id - 1 : null;
      });
      const shortcut = createThreadUndoShortcut({
        latestNoticeId: () => noticeId,
        undo,
        owner: (event) => (event.key === "z" && !event.isComposing ? pressedIn : null),
      });
      return {
        shortcut,
        undo,
        notify: (id: number) => {
          noticeId = id;
        },
        pressIn: (owner: UndoShortcutOwner) => {
          pressedIn = owner;
        },
      };
    }

    it("undoes the newest notice outside text fields, and not without one", () => {
      const { shortcut, undo, pressIn } = setup(3);
      pressIn("none");
      // Outside text fields the key needs no claim.
      shortcut.keydown(key("a"));
      const event = undoKey();
      shortcut.keydown(event);
      expect(undo).toHaveBeenCalledWith(3);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();

      const empty = setup(null);
      empty.pressIn("none");
      const unhandled = undoKey();
      empty.shortcut.keydown(unhandled);
      expect(empty.undo).not.toHaveBeenCalled();
      expect(unhandled.preventDefault).not.toHaveBeenCalled();
    });

    it("reads nothing about a key while no notice is shown", () => {
      const owner = vi.fn((): UndoShortcutOwner | null => "none");
      const shortcut = createThreadUndoShortcut({
        latestNoticeId: () => null,
        undo: vi.fn(),
        owner,
      });
      shortcut.keydown(key("a"));
      const event = undoKey();
      shortcut.keydown(event);
      expect(owner).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("leaves text fields, code editors and dialogs their own undo", () => {
      const { shortcut, undo, pressIn } = setup(1);
      pressIn("control");
      const event = undoKey();
      shortcut.keydown(event);
      expect(undo).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("claims the composer for a new notice, also for a second Undo in a row", () => {
      const { shortcut, undo, notify } = setup(null);
      shortcut.keydown(key("a"));
      notify(1);
      notify(2);
      shortcut.keydown(key("Meta", { metaKey: true }));
      shortcut.keydown(undoKey());
      expect(undo).toHaveBeenLastCalledWith(2);
      shortcut.keydown(undoKey());
      expect(undo).toHaveBeenLastCalledWith(1);
    });

    it("hands the composer its own undo after any other key, IME keydown or edit", () => {
      const releases: ReadonlyArray<(shortcut: UndoShortcut) => void> = [
        (shortcut) => shortcut.keydown(key("a")),
        (shortcut) => shortcut.keydown(undoKey({ isComposing: true })),
        (shortcut) => shortcut.edit(),
      ];
      for (const release of releases) {
        const { shortcut, undo, notify } = setup(1);
        release(shortcut);
        const event = undoKey();
        shortcut.keydown(event);
        expect(undo).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();

        // A newer notice claims it again.
        notify(2);
        shortcut.keydown(undoKey());
        expect(undo).toHaveBeenCalledWith(2);
      }
    });

    it("undoes once while the key is held, and swallows only that key's repeats", () => {
      const { shortcut, undo, pressIn } = setup(2);
      pressIn("none");
      shortcut.keydown(undoKey());
      const repeat = undoKey({ repeat: true });
      shortcut.keydown(repeat);
      // A modifier pressed mid-hold leaves the key held.
      shortcut.keydown(key("Shift", { shiftKey: true }));
      const laterRepeat = undoKey({ repeat: true });
      shortcut.keydown(laterRepeat);
      expect(undo).toHaveBeenCalledOnce();
      expect(repeat.preventDefault).toHaveBeenCalled();
      expect(laterRepeat.preventDefault).toHaveBeenCalled();

      const otherRepeat = key("a", { repeat: true });
      shortcut.keydown(otherRepeat);
      expect(otherRepeat.preventDefault).not.toHaveBeenCalled();

      shortcut.keydown(key("a"));
      const repeatAfterOtherKey = undoKey({ repeat: true });
      shortcut.keydown(repeatAfterOtherKey);
      expect(repeatAfterOtherKey.preventDefault).not.toHaveBeenCalled();
    });
  });
});
