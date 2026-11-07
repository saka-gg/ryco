import { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { SidebarUndoNotice } from "@ryco/client-runtime/state/threads";
import { describe, expect, it } from "vite-plus/test";

import { presentUndoNotice, shouldDismissToast } from "./sidebarUndoNoticeModel";

const target = { environmentId: EnvironmentId.make("node"), threadId: ThreadId.make("task") };

function notice(overrides: Partial<SidebarUndoNotice> = {}): SidebarUndoNotice {
  return { id: 1, action: "archive", target, pending: false, ...overrides };
}

describe("undo toast", () => {
  it("shows nothing without a notice and only the newest of several", () => {
    expect(presentUndoNotice([])).toBeNull();
    expect(
      presentUndoNotice([notice({ id: 1 }), notice({ id: 2, action: "snooze" })]),
    ).toMatchObject({ id: 2, message: "Task snoozed" });
  });

  it("names each action and its thread, with an accessible Undo", () => {
    for (const [action, message] of [
      ["archive", "Task archived"],
      ["settle", "Task settled"],
      ["snooze", "Task snoozed"],
      ["hide", "Task hidden"],
      ["unpin", "Task unpinned"],
    ] as const) {
      expect(presentUndoNotice([notice({ action, threadTitle: "Fix login" })])).toEqual({
        id: 1,
        message,
        detail: "Fix login",
        undoLabel: `Undo ${action} Fix login`,
        undoDisabled: false,
        announcement: `${message}: Fix login. Undo available.`,
      });
    }
  });

  it("announces nothing while the command applies or the Undo runs", () => {
    expect(presentUndoNotice([notice({ applying: true })])).toMatchObject({
      message: "Updating task…",
      announcement: null,
    });
    expect(presentUndoNotice([notice({ pending: true })])).toMatchObject({
      undoDisabled: true,
      announcement: null,
    });
  });

  it("uses a bulk notice's own copy", () => {
    expect(
      presentUndoNotice([
        notice({
          count: 3,
          copy: { title: "3 tasks settled", undoLabel: "Undo settling 3 tasks" },
        }),
      ]),
    ).toMatchObject({ message: "3 tasks settled", undoLabel: "Undo settling 3 tasks" });
  });

  it("dismisses on a quarter-width drag or a fling in its direction", () => {
    expect(shouldDismissToast({ translationX: 90, velocityX: 0, width: 340 })).toBe(true);
    expect(shouldDismissToast({ translationX: 40, velocityX: 0, width: 340 })).toBe(false);
    expect(shouldDismissToast({ translationX: -20, velocityX: -900, width: 340 })).toBe(true);
    expect(shouldDismissToast({ translationX: 20, velocityX: -900, width: 340 })).toBe(false);
  });
});
