import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// A one-component stand-in for React's ref and effect bookkeeping: an effect
// runs after its render when its dependencies changed, after cleaning up the
// previous run. Enough to see what a hook registers across re-renders.
const hooks = vi.hoisted(() => {
  type EffectSlot = { deps: ReadonlyArray<unknown> | undefined; cleanup: (() => void) | void };
  let slots: Array<unknown> = [];
  let cursor = 0;
  let pending: Array<() => void> = [];
  return {
    render(component: () => void) {
      cursor = 0;
      component();
      const effects = pending;
      pending = [];
      for (const effect of effects) effect();
    },
    unmount() {
      for (const slot of slots) {
        if (slot && typeof slot === "object" && "cleanup" in slot) {
          (slot as EffectSlot).cleanup?.();
        }
      }
      slots = [];
    },
    useRef<T>(current: T) {
      const index = cursor++;
      slots[index] ??= { current };
      return slots[index] as { current: T };
    },
    useEffect(effect: () => (() => void) | void, deps?: ReadonlyArray<unknown>) {
      const index = cursor++;
      const previous = slots[index] as EffectSlot | undefined;
      const changed =
        previous === undefined ||
        deps === undefined ||
        deps.some((dep, position) => !Object.is(dep, previous.deps?.[position]));
      if (!changed) return;
      pending.push(() => {
        previous?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
    },
  };
});

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: hooks.useEffect,
  useRef: hooks.useRef,
}));

import {
  dispatchHardwareKeyboardCommand,
  getRegisteredHardwareKeyboardCommands,
  subscribeToHardwareKeyboardCommandRegistrations,
  THREAD_JUMP_COMMANDS,
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

type Handler = ((command: HardwareKeyboardCommand) => void) | undefined;

function renderHook(handler: Handler) {
  hooks.render(() => useHardwareKeyboardCommand(THREAD_JUMP_COMMANDS, handler));
}

afterEach(() => hooks.unmount());

describe("useHardwareKeyboardCommand", () => {
  it("runs the latest handler without registering again when only the handler changes", () => {
    const first = vi.fn();
    renderHook(first);
    const registered = getRegisteredHardwareKeyboardCommands();
    expect([...registered]).toEqual(THREAD_JUMP_COMMANDS);

    const listener = vi.fn();
    const unsubscribe = subscribeToHardwareKeyboardCommandRegistrations(listener);
    const latest = vi.fn();
    // A list rebuilt for new rows hands in a new handler on every render.
    renderHook(latest);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
    expect(getRegisteredHardwareKeyboardCommands()).toBe(registered);
    expect(dispatchHardwareKeyboardCommand("thread.jump.4")).toBe(true);
    expect(latest).toHaveBeenCalledExactlyOnceWith("thread.jump.4");
    expect(first).not.toHaveBeenCalled();
  });

  it("registers only while a handler is given, and not after unmount", () => {
    renderHook(undefined);
    expect(getRegisteredHardwareKeyboardCommands().size).toBe(0);
    expect(dispatchHardwareKeyboardCommand("thread.jump.1")).toBe(false);

    const handler = vi.fn();
    renderHook(handler);
    expect(dispatchHardwareKeyboardCommand("thread.jump.1")).toBe(true);
    renderHook(undefined);
    expect(getRegisteredHardwareKeyboardCommands().size).toBe(0);

    renderHook(handler);
    hooks.unmount();
    expect(dispatchHardwareKeyboardCommand("thread.jump.1")).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
