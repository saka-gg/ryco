import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// A one-component stand-in for React's state and effect bookkeeping: an effect runs after its
// render when its dependencies changed, after cleaning up the previous run.
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
    useState<T>(initial: T) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      const slot = slots[index] as { value: T };
      return [
        slot.value,
        (next: T) => {
          slot.value = next;
        },
      ] as const;
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

const native = vi.hoisted(() => ({
  readAlertExcerpt: vi.fn(() => new Promise<string | null>(() => {})),
  removeAlertExcerpt: vi.fn(async () => undefined),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: hooks.useEffect,
  useState: hooks.useState,
}));
vi.mock("./pushKeyCustody", () => ({ readMobileRycoPush: () => native }));

import { useAlertExcerptPrompts } from "./useAlertExcerptPrompts";

const ENV = "env-a" as EnvironmentId;
const THREAD = "thread-a" as ThreadId;

function render(liveLoaded: boolean) {
  hooks.render(() => {
    useAlertExcerptPrompts({ environmentId: ENV, threadId: THREAD, liveLoaded });
  });
}

afterEach(() => {
  hooks.unmount();
  vi.clearAllMocks();
});

describe("useAlertExcerptPrompts", () => {
  it("removes the record when live detail loads before the read answers", () => {
    render(false);
    expect(native.readAlertExcerpt).toHaveBeenCalledWith(ENV, THREAD);
    expect(native.removeAlertExcerpt).not.toHaveBeenCalled();
    render(true);
    expect(native.removeAlertExcerpt).toHaveBeenCalledTimes(1);
    expect(native.removeAlertExcerpt).toHaveBeenCalledWith(ENV, THREAD);
  });

  it("removes the record of a thread already live, without reading it", () => {
    render(true);
    expect(native.readAlertExcerpt).not.toHaveBeenCalled();
    expect(native.removeAlertExcerpt).toHaveBeenCalledTimes(1);
  });

  it("leaves the record while live detail has not loaded", () => {
    render(false);
    render(false);
    expect(native.removeAlertExcerpt).not.toHaveBeenCalled();
  });
});
