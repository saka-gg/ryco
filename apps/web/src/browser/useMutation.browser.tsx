import { describe, expect, it } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

import { useMutation } from "../rpc/useMutation";

/** A mutation whose calls are settled by hand, one deferred per variable. */
function setup() {
  const calls = new Map<
    string,
    { readonly resolve: (value: string) => void; readonly reject: (error: Error) => void }
  >();
  const mutationFn = (variable: string) =>
    new Promise<string>((resolve, reject) => {
      calls.set(variable, { resolve, reject });
    });
  return { calls, mutationFn };
}

describe("useMutation overlapping calls", () => {
  it("follows the latest call when an older one resolves later", async () => {
    const { calls, mutationFn } = setup();
    const hook = await renderHook(() => useMutation({ mutationFn }));
    let pa!: Promise<string>;
    let pb!: Promise<string>;
    await hook.act(() => {
      pa = hook.result.current.mutateAsync("a");
      pb = hook.result.current.mutateAsync("b");
    });
    await hook.act(async () => {
      calls.get("a")!.resolve("A");
      await pa;
    });
    expect(hook.result.current.isPending).toBe(true);
    expect(hook.result.current.variables).toBe("b");
    await hook.act(async () => {
      calls.get("b")!.resolve("B");
      await pb;
    });
    await expect.poll(() => hook.result.current.status).toBe("success");
    expect(hook.result.current.data).toBe("B");
  });

  it("keeps the latest success when an older call fails afterwards", async () => {
    const { calls, mutationFn } = setup();
    const hook = await renderHook(() => useMutation({ mutationFn }));
    let pa!: Promise<string>;
    let pb!: Promise<string>;
    await hook.act(() => {
      pa = hook.result.current.mutateAsync("a");
      pb = hook.result.current.mutateAsync("b");
    });
    await hook.act(async () => {
      calls.get("b")!.resolve("B");
      await pb;
    });
    await hook.act(async () => {
      calls.get("a")!.reject(new Error("late failure"));
      await expect(pa).rejects.toThrow("late failure");
    });
    expect(hook.result.current.status).toBe("success");
    expect(hook.result.current.data).toBe("B");
  });

  it("ignores a call that settles after reset", async () => {
    const { calls, mutationFn } = setup();
    const hook = await renderHook(() => useMutation({ mutationFn }));
    let pa!: Promise<string>;
    await hook.act(() => {
      pa = hook.result.current.mutateAsync("a");
    });
    await hook.act(() => hook.result.current.reset());
    await hook.act(async () => {
      calls.get("a")!.resolve("A");
      await pa;
    });
    expect(hook.result.current.status).toBe("idle");
  });
});
