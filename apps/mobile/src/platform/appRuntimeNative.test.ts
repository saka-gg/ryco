import { describe, expect, it, vi } from "vite-plus/test";

import { beginNativeBackgroundStay, type RycoAppRuntimeNativeModule } from "./appRuntimeNative";

function fakeNative(grant = 7) {
  const listeners = new Set<(event: { readonly stayId: number }) => void>();
  const expired = new Set<number>();
  const native = {
    beginBackgroundStay: vi.fn(() => grant),
    endBackgroundStay: vi.fn((stayId: number) => {
      expired.delete(stayId);
    }),
    backgroundStayExpired: vi.fn((stayId: number) => expired.has(stayId)),
    addListener: vi.fn(
      (
        _event: "onBackgroundStayExpiring",
        listener: (event: { readonly stayId: number }) => void,
      ) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
    ),
  } satisfies Pick<
    RycoAppRuntimeNativeModule,
    "beginBackgroundStay" | "endBackgroundStay" | "backgroundStayExpired" | "addListener"
  >;
  return {
    native,
    listeners,
    iosExpires(stayId: number) {
      expired.add(stayId);
      for (const listener of listeners) listener({ stayId });
    },
  };
}

describe("the native background stay", () => {
  it("is null when iOS grants no background task", () => {
    const { native } = fakeNative(0);
    expect(beginNativeBackgroundStay(native, vi.fn())).toBeNull();
    expect(native.addListener).not.toHaveBeenCalled();
  });

  it("reports iOS taking its own stay back, and only its own", () => {
    const fake = fakeNative();
    const expire = vi.fn();
    const stay = beginNativeBackgroundStay(fake.native, expire)!;
    fake.iosExpires(3);
    expect(expire).not.toHaveBeenCalled();
    expect(stay.expiredByPlatform()).toBe(false);
    fake.iosExpires(7);
    expect(expire).toHaveBeenCalledOnce();
    expect(stay.expiredByPlatform()).toBe(true);
  });

  it("gives the task back once and stops listening", () => {
    const fake = fakeNative();
    const stay = beginNativeBackgroundStay(fake.native, vi.fn())!;
    stay.end();
    stay.end();
    expect(fake.native.endBackgroundStay).toHaveBeenCalledOnce();
    expect(fake.native.endBackgroundStay).toHaveBeenCalledWith(7);
    expect(fake.listeners.size).toBe(0);
  });
});
