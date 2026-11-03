import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CdpLease } from "./cdpLease.ts";
import { FakeWebContents } from "../computerUse/embeddedBrowser.fixtures.ts";

function setup() {
  const contents = new FakeWebContents();
  const lease = new CdpLease(contents as unknown as WebContents);
  const methods = () => contents.debugger.commands.map(({ method }) => method);
  return { contents, debugger: contents.debugger, lease, methods };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Lets queued microtasks (the fake's command responses) run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("CdpLease", () => {
  it("shares one attachment between holders", () => {
    const { debugger: api, lease } = setup();
    expect(lease.isAttached()).toBe(false);
    expect(lease.acquire("agent")).toBe(true);
    expect(lease.acquire("agent")).toBe(false);
    expect(lease.acquire("picker")).toBe(true);
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(api.attach).toHaveBeenCalledWith("1.3");
    expect(lease.isAttached()).toBe(true);
    expect(lease.holds("agent")).toBe(true);
    expect(lease.holds("picker")).toBe(true);
  });

  it("runs ready steps once per attachment, in order, before the first command, whoever attached", async () => {
    const { debugger: api, lease, methods } = setup();
    lease.onReady(async (send) => {
      await send("First.step", { order: 1 });
    });
    lease.onReady(async (send) => {
      await send("Second.step");
    });
    lease.acquire("picker");
    lease.acquire("agent");
    await lease.send("Page.getFrameTree");
    await lease.send("Runtime.evaluate", { expression: "1" });
    expect(api.commands).toEqual([
      { method: "First.step", params: { order: 1 } },
      { method: "Second.step", params: {} },
      { method: "Page.getFrameTree", params: {} },
      { method: "Runtime.evaluate", params: { expression: "1" } },
    ]);
    lease.release("picker");
    lease.release("agent");
    // A new attachment (this time the agent's) runs them again.
    lease.acquire("agent");
    await lease.ready();
    await lease.send("Page.reload");
    expect(methods().slice(4)).toEqual(["First.step", "Second.step", "Page.reload"]);
  });

  it("sends skipReady commands without waiting for the ready steps", async () => {
    const { debugger: api, lease, methods } = setup();
    const gate = deferred();
    api.respond = (method) => (method === "Slow.step" ? gate.promise : {});
    lease.onReady(async (send) => {
      await send("Slow.step");
    });
    lease.acquire("agent");
    const normal = lease.send("Page.reload");
    await expect(
      lease.send("Page.handleJavaScriptDialog", {}, { skipReady: true }),
    ).resolves.toEqual({});
    expect(methods()).toEqual(["Slow.step", "Page.handleJavaScriptDialog"]);
    gate.resolve({});
    await normal;
    expect(methods()).toEqual(["Slow.step", "Page.handleJavaScriptDialog", "Page.reload"]);
  });

  it("sends a child target's command on its flat session, after the page's ready steps", async () => {
    const { debugger: api, lease } = setup();
    api.respond = (method, _params, sessionId) =>
      method === "DOM.enable" ? { session: sessionId ?? "page" } : {};
    lease.onReady(async (send) => {
      await send("Ready.step");
    });
    lease.acquire("picker");
    await expect(lease.send("DOM.enable", {}, { sessionId: "frame-session" })).resolves.toEqual({
      session: "frame-session",
    });
    await expect(lease.send("DOM.enable")).resolves.toEqual({ session: "page" });
    expect(api.commands).toEqual([
      { method: "Ready.step", params: {} },
      { method: "DOM.enable", params: {}, sessionId: "frame-session" },
      { method: "DOM.enable", params: {} },
    ]);
    // A page command keeps Electron's two-argument call.
    expect(api.sendCommand).toHaveBeenLastCalledWith("DOM.enable", {});
  });

  it("rejects the triggering command when a ready step fails and retries the steps next time", async () => {
    const { debugger: api, lease, methods } = setup();
    let failures = 1;
    api.respond = (method) => {
      if (method === "First.step" && failures-- > 0) throw new Error("step failed");
      return {};
    };
    lease.onReady(async (send) => {
      await send("First.step");
    });
    lease.onReady(async (send) => {
      await send("Second.step");
    });
    lease.acquire("agent");
    await expect(lease.send("Page.reload")).rejects.toThrow("step failed");
    expect(methods()).toEqual(["First.step"]);
    await lease.send("Page.reload");
    expect(methods()).toEqual(["First.step", "First.step", "Second.step", "Page.reload"]);
    expect(api.attach).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "detaches on the last release and notifies once (Electron emits detach: %s)",
    (emitOnSelfDetach) => {
      const { debugger: api, lease } = setup();
      api.emitOnSelfDetach = emitOnSelfDetach;
      const detached = vi.fn();
      lease.onDetach(detached);
      lease.acquire("agent");
      lease.acquire("picker");
      lease.release("agent");
      lease.release("agent");
      expect(api.detach).not.toHaveBeenCalled();
      expect(lease.isAttached()).toBe(true);
      expect(lease.holds("picker")).toBe(true);
      expect(detached).not.toHaveBeenCalled();
      lease.release("picker");
      expect(api.detach).toHaveBeenCalledTimes(1);
      expect(api.isAttached()).toBe(false);
      expect(lease.isAttached()).toBe(false);
      expect(detached).toHaveBeenCalledTimes(1);
      expect(detached).toHaveBeenCalledWith("released");
      lease.release("picker");
      lease.release("agent");
      expect(api.detach).toHaveBeenCalledTimes(1);
      expect(detached).toHaveBeenCalledTimes(1);
    },
  );

  it("clears holders when Electron ends the session and attaches again on the next acquire", async () => {
    const { debugger: api, lease, methods } = setup();
    const detached = vi.fn();
    lease.onDetach(detached);
    lease.onReady(async (send) => {
      await send("Ready.step");
    });
    lease.acquire("agent");
    lease.acquire("picker");
    await lease.send("Page.reload");
    api.externalDetach("canceled_by_user");
    expect(detached).toHaveBeenCalledTimes(1);
    expect(detached).toHaveBeenCalledWith("canceled_by_user");
    expect(lease.isAttached()).toBe(false);
    expect(lease.holds("agent")).toBe(false);
    expect(lease.holds("picker")).toBe(false);
    // Nobody holds the old session any more: releasing is a no-op and never detaches.
    lease.release("picker");
    expect(api.detach).not.toHaveBeenCalled();
    expect(lease.acquire("agent")).toBe(true);
    expect(api.attach).toHaveBeenCalledTimes(2);
    await lease.send("Page.reload");
    expect(methods()).toEqual(["Ready.step", "Page.reload", "Ready.step", "Page.reload"]);
  });

  it("never lets a ready step that outlived its session reach the next one", async () => {
    const { debugger: api, lease, methods } = setup();
    const gate = deferred();
    const late = vi.fn<(error: unknown) => void>();
    let runs = 0;
    lease.onReady(async (send) => {
      if (runs++ > 0) return;
      await gate.promise;
      await send("Late.step").catch((error: unknown) => {
        late(error);
        throw error;
      });
    });
    lease.acquire("agent");
    const first = lease.ready();
    const settled = expect(first).rejects.toThrow("Browser debugger is not attached.");
    lease.release("agent");
    lease.acquire("agent");
    gate.resolve(undefined);
    await settled;
    expect(late).toHaveBeenCalledTimes(1);
    await lease.send("Page.reload");
    expect(methods()).toEqual(["Page.reload"]);
    expect(api.attach).toHaveBeenCalledTimes(2);
  });

  it("fans out debugger events and isolates listener errors", () => {
    const { debugger: api, lease } = setup();
    const failing = vi.fn(() => {
      throw new Error("listener failed");
    });
    const received = vi.fn();
    lease.onEvent(failing);
    const unsubscribe = lease.onEvent(received);
    expect(() =>
      api.message("Page.frameNavigated", { frame: { id: "main" } }, "session"),
    ).not.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(
      "Page.frameNavigated",
      { frame: { id: "main" } },
      "session",
    );
    unsubscribe();
    api.message("Page.loadEventFired");
    expect(received).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(api.listenerCount("message")).toBe(1);
  });

  it("reports the page's own events, which Electron gives an empty sessionId, without a session", () => {
    const { debugger: api, lease } = setup();
    const received = vi.fn();
    lease.onEvent(received);
    api.message("Overlay.inspectNodeRequested", { backendNodeId: 7 }, "");
    expect(received).toHaveBeenCalledWith(
      "Overlay.inspectNodeRequested",
      { backendNodeId: 7 },
      undefined,
    );
  });

  it("never attaches from send, times out, and rejects pending commands when the session ends", async () => {
    const { debugger: api, lease } = setup();
    await expect(lease.send("Page.reload")).rejects.toThrow("Browser debugger is not attached.");
    await expect(lease.ready()).rejects.toThrow("Browser debugger is not attached.");
    expect(api.attach).not.toHaveBeenCalled();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    api.respond = (method) => (method === "Runtime.evaluate" ? new Promise(() => {}) : {});
    lease.acquire("agent");
    const timedOut = lease.send("Runtime.evaluate", {}, { timeoutMs: 1_000 });
    const timeout = expect(timedOut).rejects.toThrow("Browser command timed out.");
    await vi.advanceTimersByTimeAsync(999);
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await timeout;
    // In time: resolves, and the timer is cleared.
    await expect(lease.send("Page.reload", {}, { timeoutMs: 1_000 })).resolves.toEqual({});
    expect(vi.getTimerCount()).toBe(0);

    const pending = lease.send("Runtime.evaluate");
    const closed = expect(pending).rejects.toThrow("target closed while handling command");
    await flush();
    lease.release("agent");
    await closed;
  });

  it("counts waiting for ready steps against the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { debugger: api, lease, methods } = setup();
    api.respond = (method) => (method === "Hung.step" ? new Promise(() => {}) : {});
    lease.onReady(async (send) => {
      await send("Hung.step");
    });
    lease.acquire("agent");
    const timedOut = lease.send("Page.reload", {}, { timeoutMs: 500 });
    const timeout = expect(timedOut).rejects.toThrow("Browser command timed out.");
    await vi.advanceTimersByTimeAsync(500);
    await timeout;
    expect(methods()).toEqual(["Hung.step"]);
  });

  it("fails a ready run that never settles, so a session another holder keeps is not stuck behind it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { debugger: api, lease, methods } = setup();
    const hung = deferred();
    let runs = 0;
    api.respond = (method) => (method === "Hung.step" && runs === 1 ? hung.promise : {});
    lease.onReady(async (send) => {
      runs++;
      await send("Hung.step");
      await send("After.step");
    });
    lease.acquire("picker");
    lease.acquire("agent");
    const first = lease.send("Page.reload");
    const timedOut = expect(first).rejects.toThrow("Browser command timed out.");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    // The agent gives up, but the picker keeps the session: the next call runs the steps again.
    lease.release("agent");
    expect(lease.isAttached()).toBe(true);
    expect(lease.acquire("agent")).toBe(true);
    await lease.send("Page.reload");
    expect(methods()).toEqual(["Hung.step", "Hung.step", "After.step", "Page.reload"]);
    // The abandoned run never sends again, even once its command answers.
    hung.resolve({});
    await flush();
    expect(methods()).toEqual(["Hung.step", "Hung.step", "After.step", "Page.reload"]);
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("snapshots the ready steps when a run starts", async () => {
    const { lease, methods } = setup();
    lease.acquire("agent");
    // Added after acquire but before the first command: runs on this attachment.
    lease.onReady(async (send) => {
      await send("Early.step");
    });
    await lease.send("Page.reload");
    // Added after the run succeeded: waits for the next attachment.
    lease.onReady(async (send) => {
      await send("Late.step");
    });
    await lease.send("Page.reload");
    expect(methods()).toEqual(["Early.step", "Page.reload", "Page.reload"]);
    lease.release("agent");
    lease.acquire("agent");
    await lease.send("Page.reload");
    expect(methods().slice(3)).toEqual(["Early.step", "Late.step", "Page.reload"]);
  });

  it("attaches again when the session ended without a detach event reaching it", async () => {
    const { debugger: api, lease, methods } = setup();
    const detached = vi.fn();
    lease.onDetach(detached);
    lease.onReady(async (send) => {
      await send("Ready.step");
    });
    lease.acquire("agent");
    lease.acquire("picker");
    await lease.send("Page.reload");
    // The session goes away silently (no "detach" event).
    api.emitOnSelfDetach = false;
    api.detach();
    expect(lease.isAttached()).toBe(true);
    expect(lease.acquire("agent")).toBe(true);
    expect(detached).toHaveBeenCalledTimes(1);
    expect(detached).toHaveBeenCalledWith("target closed");
    expect(lease.holds("picker")).toBe(false);
    expect(api.attach).toHaveBeenCalledTimes(2);
    await lease.send("Page.reload");
    expect(methods()).toEqual(["Ready.step", "Page.reload", "Ready.step", "Page.reload"]);
  });

  it("never touches the debugger of destroyed contents", () => {
    const { contents, debugger: api, lease } = setup();
    const detached = vi.fn();
    lease.onDetach(detached);
    lease.acquire("agent");
    contents.destroy();
    // Electron's target-closed detach came first and ended the session.
    expect(detached).toHaveBeenCalledWith("target closed");
    expect(() => api.isAttached()).toThrow("Object has been destroyed");
    expect(() => lease.release("agent")).not.toThrow();
    expect(() => lease.dispose()).not.toThrow();
    expect(() => lease.dispose()).not.toThrow();
    expect(() => lease.acquire("agent")).toThrow("Browser tab closed.");
  });

  it("releases without touching contents destroyed without a detach event", async () => {
    const { contents, lease } = setup();
    lease.acquire("agent");
    lease.acquire("picker");
    contents.destroyed = true;
    expect(() => lease.release("agent")).not.toThrow();
    expect(() => lease.release("picker")).not.toThrow();
    expect(() => lease.acquire("agent")).toThrow("Browser tab closed.");
    await expect(lease.send("Page.reload")).rejects.toThrow("Browser debugger is not attached.");
    expect(() => lease.dispose()).not.toThrow();
  });

  it("dispose() removes its Electron listeners, detaches and notifies nobody", () => {
    const { debugger: api, lease } = setup();
    const detached = vi.fn();
    const event = vi.fn();
    lease.onDetach(detached);
    lease.onEvent(event);
    expect(api.listenerCount("message")).toBe(1);
    expect(api.listenerCount("detach")).toBe(1);
    lease.acquire("agent");
    lease.dispose();
    expect(api.listenerCount("message")).toBe(0);
    expect(api.listenerCount("detach")).toBe(0);
    expect(api.detach).toHaveBeenCalledTimes(1);
    expect(api.isAttached()).toBe(false);
    expect(detached).not.toHaveBeenCalled();
    api.message("Page.loadEventFired");
    expect(event).not.toHaveBeenCalled();
    expect(() => lease.acquire("picker")).toThrow("Browser tab closed.");
    lease.dispose();
    expect(api.detach).toHaveBeenCalledTimes(1);
  });

  it("dispose() leaves an unattached debugger alone", () => {
    const { debugger: api, lease } = setup();
    lease.acquire("agent");
    lease.release("agent");
    lease.dispose();
    expect(api.detach).toHaveBeenCalledTimes(1);
    expect(api.attach).toHaveBeenCalledTimes(1);
  });
});
