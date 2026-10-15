import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

import type { Thread } from "../../types";
import { useLocalDispatchState, type UseLocalDispatchStateInput } from "./useLocalDispatchState";

function thread(id: string): Thread {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("environment-local"),
    latestTurn: null,
    session: null,
  } as unknown as Thread;
}

function inputFor(id: string): UseLocalDispatchStateInput {
  return {
    threadKey: `environment-local:${id}`,
    activeThread: thread(id),
    activeLatestTurn: null,
    phase: "ready",
    activePendingApproval: null,
    activePendingUserInput: null,
    threadError: null,
  };
}

describe("useLocalDispatchState", () => {
  it("marks the thread busy while its send dispatches", async () => {
    const hook = await renderHook((props?: UseLocalDispatchStateInput) =>
      useLocalDispatchState(props ?? inputFor("a")),
    );
    await hook.act(() => hook.result.current.bindLocalDispatch().beginLocalDispatch());
    expect(hook.result.current.isSendBusy).toBe(true);
  });

  it("never marks the thread shown later busy with a send from the one before", async () => {
    const hook = await renderHook(
      (props?: UseLocalDispatchStateInput) => useLocalDispatchState(props ?? inputFor("a")),
      { initialProps: inputFor("a") },
    );
    const sendFromA = hook.result.current.bindLocalDispatch();
    await hook.act(() => sendFromA.beginLocalDispatch());
    expect(hook.result.current.isSendBusy).toBe(true);

    // The view moves to thread B while A's send is still on its way.
    await hook.rerender(inputFor("b"));
    expect(hook.result.current.isSendBusy).toBe(false);
    // A's send reaches its turn start (begin again) after the switch.
    await hook.act(() => sendFromA.beginLocalDispatch({ preparingWorktree: true }));
    expect(hook.result.current.isSendBusy).toBe(false);
    expect(hook.result.current.isPreparingWorktree).toBe(false);

    // B's own send is busy, and A's settling does not clear it.
    const sendFromB = hook.result.current.bindLocalDispatch();
    await hook.act(() => sendFromB.beginLocalDispatch());
    expect(hook.result.current.isSendBusy).toBe(true);
    await hook.act(() => sendFromA.resetLocalDispatch());
    expect(hook.result.current.isSendBusy).toBe(true);
    await hook.act(() => sendFromB.resetLocalDispatch());
    expect(hook.result.current.isSendBusy).toBe(false);
  });

  it("still shows a thread busy when the view comes back to it mid-send", async () => {
    const hook = await renderHook(
      (props?: UseLocalDispatchStateInput) => useLocalDispatchState(props ?? inputFor("a")),
      { initialProps: inputFor("a") },
    );
    const sendFromA = hook.result.current.bindLocalDispatch();
    await hook.act(() => sendFromA.beginLocalDispatch());

    await hook.rerender(inputFor("b"));
    // A's send moves on to preparing its worktree while B is shown.
    await hook.act(() => sendFromA.beginLocalDispatch({ preparingWorktree: true }));
    await hook.rerender(inputFor("a"));
    expect(hook.result.current.isSendBusy).toBe(true);
    expect(hook.result.current.isPreparingWorktree).toBe(true);

    // The server acknowledges A's turn: its dispatch settles.
    await hook.rerender({ ...inputFor("a"), phase: "running", threadError: "failed" });
    expect(hook.result.current.isSendBusy).toBe(false);
    await hook.rerender(inputFor("a"));
    expect(hook.result.current.isSendBusy).toBe(false);
  });

  it("never creates a dispatch for a thread the view left before its send began", async () => {
    const hook = await renderHook(
      (props?: UseLocalDispatchStateInput) => useLocalDispatchState(props ?? inputFor("a")),
      { initialProps: inputFor("a") },
    );
    const sendFromA = hook.result.current.bindLocalDispatch();
    await hook.rerender(inputFor("b"));
    await hook.act(() => sendFromA.beginLocalDispatch());
    await hook.rerender(inputFor("a"));
    expect(hook.result.current.isSendBusy).toBe(false);
  });
});
