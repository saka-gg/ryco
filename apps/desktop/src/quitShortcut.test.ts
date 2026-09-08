import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopQuitShortcutMode } from "@ryco/contracts";
import { createQuitShortcutGuard } from "./quitShortcut.ts";

afterEach(() => vi.useRealTimers());
function fixture(mode: DesktopQuitShortcutMode, mac = true) {
  vi.useFakeTimers();
  let time = 0;
  const quit = vi.fn();
  const feedback = vi.fn();
  const guard = createQuitShortcutGuard({ mode: () => mode, mac, now: () => time, quit, feedback });
  const input = (type: string, extra = {}) =>
    guard.input({
      type,
      key: "q",
      control: !mac,
      meta: mac,
      shift: false,
      alt: false,
      isAutoRepeat: false,
      ...extra,
    });
  return {
    guard,
    input,
    quit,
    feedback,
    advance(ms: number) {
      time += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}
describe("quit shortcut", () => {
  it.each([true, false])(
    "requires two distinct presses and permits releasing the modifier (mac=%s)",
    (mac) => {
      const f = fixture("press-twice", mac);
      expect(f.input("keyDown")).toBe(true);
      f.input("keyDown", { isAutoRepeat: true });
      expect(f.quit).not.toHaveBeenCalled();
      f.input("keyUp");
      f.input("keyUp", { key: mac ? "Meta" : "Control", meta: false, control: false });
      f.advance(300);
      f.input("keyDown");
      expect(f.quit).toHaveBeenCalledOnce();
    },
  );
  it("expires double presses and cancels on blur", () => {
    const f = fixture("press-twice");
    f.input("keyDown");
    f.input("keyUp");
    f.advance(1600);
    f.input("keyDown");
    f.input("keyUp");
    expect(f.quit).not.toHaveBeenCalled();
    f.guard.reset();
    f.input("keyDown");
    expect(f.quit).not.toHaveBeenCalled();
    f.guard.reset();
  });
  it("holds until release without letting repeats quit", () => {
    const f = fixture("hold");
    f.input("keyDown");
    f.advance(1100);
    f.input("keyDown", { isAutoRepeat: true });
    expect(f.quit).not.toHaveBeenCalled();
    f.input("keyUp");
    expect(f.quit).toHaveBeenCalledOnce();
    f.input("keyUp", { key: "Meta", meta: false });
    expect(f.quit).toHaveBeenCalledOnce();
  });
  it("accepts releasing the modifier after a completed hold", () => {
    const f = fixture("hold");
    f.input("keyDown");
    f.advance(1100);
    f.input("keyUp", { key: "Meta", meta: false });
    expect(f.quit).toHaveBeenCalledOnce();
  });
  it("cancels short holds and focus loss without a later modifier triggering quit", () => {
    const f = fixture("hold");
    f.input("keyDown");
    f.advance(200);
    f.input("keyUp");
    f.input("keyDown");
    f.advance(1200);
    f.guard.reset();
    f.input("keyUp");
    f.input("keyDown", { key: "Meta" });
    expect(f.quit).not.toHaveBeenCalled();
  });
  it("does not intercept other modifier combinations", () => {
    const f = fixture("immediately");
    expect(f.input("keyDown", { control: true, meta: false })).toBe(false);
    expect(f.input("keyDown", { shift: true })).toBe(false);
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.input("keyDown")).toBe(true);
    expect(f.quit).toHaveBeenCalledOnce();
  });
});
