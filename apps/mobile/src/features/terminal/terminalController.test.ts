import { createTerminalStateStore } from "@ryco/client-runtime/state/terminal";
import type {
  EnvironmentApi,
  EnvironmentId,
  TerminalEvent,
  TerminalSessionSnapshot,
  ThreadId,
} from "@ryco/contracts";
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@ryco/shared/terminalPaste";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  TERMINAL_RENDERER_VERSION,
  type NativeTerminalMessage,
  type RendererTerminalMessage,
} from "./terminalBridgeProtocol";
import { TerminalController, type TerminalControllerInputs } from "./terminalController";

const ENV = "env-a" as EnvironmentId;
const THREAD = "thread-a" as ThreadId;
const AT = "2026-10-28T12:00:00.000Z";

function snapshot(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    threadId: THREAD,
    terminalId: "default",
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 7,
    history: "$ ",
    exitCode: null,
    exitSignal: null,
    updatedAt: AT,
    cursor: { generation: "g1", sequence: 5 },
    ...overrides,
  };
}

function output(sequence: number, data: string, terminalId = "default"): TerminalEvent {
  return {
    type: "output",
    threadId: THREAD,
    terminalId,
    createdAt: AT,
    cursor: { generation: "g1", sequence },
    data,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function fakeApi() {
  const opens: Array<{
    input: Record<string, unknown>;
    answer: Deferred<TerminalSessionSnapshot>;
  }> = [];
  const writes: Array<{ input: { terminalId: string; data: string }; answer: Deferred<void> }> = [];
  const terminal = {
    open: vi.fn((input: Record<string, unknown>) => {
      const answer = deferred<TerminalSessionSnapshot>();
      opens.push({ input, answer });
      return answer.promise;
    }),
    write: vi.fn((input: { terminalId: string; data: string }) => {
      const answer = deferred<void>();
      writes.push({ input, answer });
      return answer.promise;
    }),
    resize: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
    restart: vi.fn(() => Promise.resolve(snapshot({ history: "restarted" }))),
    close: vi.fn(() => Promise.resolve()),
    onEvent: vi.fn(() => () => undefined),
  };
  return { api: { terminal } as unknown as EnvironmentApi, terminal, opens, writes };
}

function setup(options: { readonly mutationReady?: boolean } = {}) {
  const store = createTerminalStateStore();
  const lifecycleListeners = new Set<(foreground: boolean) => void>();
  let foreground = true;
  let clipboardText = "";
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const clipboard = {
    getString: vi.fn(() => Promise.resolve(clipboardText)),
    setString: vi.fn(() => Promise.resolve()),
  };
  let createdIds = 0;
  const controller = new TerminalController(ENV, THREAD, {
    store,
    clipboard,
    lifecycle: {
      isForeground: () => foreground,
      subscribe: (listener) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      },
    },
    createTerminalId: () => `mobile-${(createdIds += 1)}`,
    scheduleFrame: (callback) => frames.push(callback),
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  const server = fakeApi();
  const inputs: TerminalControllerInputs = {
    cwd: "/repo",
    worktreePath: null,
    api: server.api,
    connectionState: "connected",
    mutationReady: options.mutationReady ?? true,
    fontSize: 12,
  };
  controller.update(inputs);
  const detach = controller.attach();
  const sent: NativeTerminalMessage[] = [];
  controller.attachRenderer(1, (encoded) => {
    sent.push(JSON.parse(encoded) as NativeTerminalMessage);
    return true;
  });
  const renderer = (message: RendererTerminalMessage, generation = 1) =>
    controller.onRendererMessage(JSON.stringify(message), generation);
  renderer({ type: "ready", rendererVersion: TERMINAL_RENDERER_VERSION });
  return {
    store,
    controller,
    server,
    sent,
    renderer,
    detach,
    clipboard,
    setClipboard: (text: string) => {
      clipboardText = text;
    },
    setForeground: (next: boolean) => {
      foreground = next;
      for (const listener of lifecycleListeners) listener(next);
    },
    runFrames: () => {
      for (const frame of frames.splice(0)) frame();
    },
    update: (patch: Partial<TerminalControllerInputs>) =>
      controller.update({ ...inputs, ...patch }),
  };
}

/** Starts the default session and hydrates it, as the screen and renderer do. */
async function startHydrated(context: ReturnType<typeof setup>, history = "$ ") {
  context.controller.startTerminal();
  context.renderer({ type: "resize", terminalId: "default", cols: 80, rows: 24 });
  await flush();
  const open = context.server.opens.at(-1)!;
  open.answer.resolve(snapshot({ history }));
  await flush();
  const hydrate = context.sent.findLast((message) => message.type === "hydrate");
  if (hydrate?.type !== "hydrate") throw new Error("no hydrate message");
  context.renderer({ type: "hydrated", terminalId: "default", hydration: hydrate.hydration });
  return hydrate;
}

describe("terminal controller", () => {
  it("never creates a session by being shown", async () => {
    const context = setup();
    await flush();
    expect(context.controller.getSnapshot().screenState).toEqual({
      kind: "empty",
      canStart: true,
      readOnly: false,
    });
    expect(context.server.terminal.open).not.toHaveBeenCalled();
  });

  it("opens an explicitly started session with the workspace and the renderer's size", async () => {
    const context = setup();
    const hydrate = await startHydrated(context, "hello\r\n$ ");

    expect(context.server.terminal.open).toHaveBeenCalledTimes(1);
    expect(context.server.opens[0]!.input).toEqual({
      threadId: THREAD,
      terminalId: "default",
      cwd: "/repo",
      worktreePath: null,
      cols: 80,
      rows: 24,
    });
    expect(hydrate.history).toBe("hello\r\n$ ");
    expect(context.controller.getSnapshot()).toMatchObject({
      writable: true,
      screenState: { kind: "terminal", writable: true, connectionNotice: null },
    });
    expect(context.sent.at(-1)).toEqual({ type: "connection", writable: true });
  });

  it("writes typed input in order, one write at a time", async () => {
    const context = setup();
    await startHydrated(context);
    context.renderer({ type: "input", terminalId: "default", data: "l" });
    context.renderer({ type: "input", terminalId: "default", data: "s" });
    await flush();
    expect(context.server.writes.map((write) => write.input.data)).toEqual(["l"]);
    context.server.writes[0]!.answer.resolve();
    await flush();
    expect(context.server.writes.map((write) => write.input.data)).toEqual(["l", "s"]);
  });

  it("turns the next key into a control code after a one-shot Ctrl", async () => {
    const context = setup();
    await startHydrated(context);
    context.controller.toggleControl();
    expect(context.controller.getSnapshot().controlArmed).toBe(true);
    context.renderer({ type: "input", terminalId: "default", data: "c" });
    await flush();
    expect(context.server.writes[0]!.input.data).toBe("\u0003");
    expect(context.controller.getSnapshot().controlArmed).toBe(false);
  });

  it("keeps a viewer read-only: no start, no input, no session actions", async () => {
    const context = setup({ mutationReady: false });
    context.controller.startTerminal();
    expect(await context.controller.clear()).toBe(false);
    context.renderer({ type: "input", terminalId: "default", data: "x" });
    await flush();
    expect(context.server.terminal.open).not.toHaveBeenCalled();
    expect(context.server.terminal.write).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot().screenState).toMatchObject({
      kind: "empty",
      canStart: false,
    });
  });

  it("stops input the moment readiness is lost and keeps the output on screen", async () => {
    const context = setup();
    await startHydrated(context);
    context.update({ mutationReady: false, connectionState: "reconnecting" });
    context.renderer({ type: "input", terminalId: "default", data: "x" });
    await flush();
    expect(context.server.terminal.write).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot().screenState).toMatchObject({
      kind: "terminal",
      writable: false,
      connectionNotice: "Connecting…",
    });
  });

  it("applies live output after hydration, frame-batched and acknowledged", async () => {
    const context = setup();
    await startHydrated(context);
    context.store
      .getState()
      .applyTerminalEvent({ environmentId: ENV, threadId: THREAD }, output(6, "a"));
    context.store
      .getState()
      .applyTerminalEvent({ environmentId: ENV, threadId: THREAD }, output(7, "b"));
    context.runFrames();
    const writes = context.sent.filter((message) => message.type === "write");
    expect(writes.map((message) => message.type === "write" && message.data)).toEqual(["a", "b"]);
  });

  it("does not re-render for another thread's terminal output", async () => {
    const context = setup();
    await startHydrated(context);
    const listener = vi.fn();
    context.controller.subscribe(listener);
    context.store.getState().applyTerminalEvent(
      { environmentId: ENV, threadId: "thread-b" as ThreadId },
      {
        ...output(1, "elsewhere"),
        threadId: "thread-b",
      },
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores an open answer from a replaced connection", async () => {
    const context = setup();
    context.controller.startTerminal();
    context.renderer({ type: "resize", terminalId: "default", cols: 80, rows: 24 });
    await flush();
    const stale = context.server.opens[0]!;
    const replacement = fakeApi();
    context.update({ api: replacement.api });
    stale.answer.resolve(snapshot({ history: "stale" }));
    await flush();
    expect(context.sent.some((message) => message.type === "hydrate")).toBe(false);
    // The replacement connection is asked for its own snapshot.
    expect(replacement.terminal.open).toHaveBeenCalledTimes(1);
  });

  it("suspends in the background and re-hydrates from the snapshot instead of replaying", async () => {
    const context = setup();
    await startHydrated(context);
    context.setForeground(false);
    context.store
      .getState()
      .applyTerminalEvent({ environmentId: ENV, threadId: THREAD }, output(6, "while away"));
    context.runFrames();
    expect(context.sent.some((message) => message.type === "write")).toBe(false);
    expect(context.controller.getSnapshot().writable).toBe(false);

    context.setForeground(true);
    await flush();
    expect(context.server.terminal.open).toHaveBeenCalledTimes(2);
    context.server.opens[1]!.answer.resolve(
      snapshot({ history: "$ while away", cursor: { generation: "g1", sequence: 6 } }),
    );
    await flush();
    const hydrate = context.sent.findLast((message) => message.type === "hydrate");
    expect(hydrate).toMatchObject({ history: "$ while away" });
    if (hydrate?.type !== "hydrate") throw new Error("no hydrate");
    context.renderer({ type: "hydrated", terminalId: "default", hydration: hydrate.hydration });
    context.runFrames();
    // The buffered event is already in the snapshot: it is not written again.
    expect(context.sent.some((message) => message.type === "write")).toBe(false);
    expect(context.controller.getSnapshot().writable).toBe(true);
  });

  it("drops an open answer that lands after the app went to the background", async () => {
    const context = setup();
    context.controller.startTerminal();
    context.renderer({ type: "resize", terminalId: "default", cols: 80, rows: 24 });
    await flush();
    context.setForeground(false);
    context.server.opens[0]!.answer.resolve(snapshot());
    await flush();
    expect(context.sent.some((message) => message.type === "hydrate")).toBe(false);
  });

  it("pastes with bracketed paste markers once the program turned the mode on", async () => {
    const context = setup();
    await startHydrated(context);
    context.renderer({ type: "modes", terminalId: "default", bracketedPaste: true });
    context.setClipboard("echo hi\n");
    const pasted = context.controller.paste();
    await flush();
    expect(context.server.writes[0]!.input.data).toBe(
      `${BRACKETED_PASTE_START}echo hi\r${BRACKETED_PASTE_END}`,
    );
    context.server.writes[0]!.answer.resolve();
    await pasted;
    expect(context.controller.getSnapshot().pasting).toBe(false);
  });

  it("pastes plain text while bracketed paste is off", async () => {
    const context = setup();
    await startHydrated(context);
    context.setClipboard("ls\n");
    void context.controller.paste();
    await flush();
    expect(context.server.writes[0]!.input.data).toBe("ls\r");
  });

  it("stops a chunked paste when the target changes and closes the open paste", async () => {
    const context = setup();
    await startHydrated(context);
    context.renderer({ type: "modes", terminalId: "default", bracketedPaste: true });
    context.setClipboard("x".repeat(150_000));
    const pasted = context.controller.paste();
    await flush();
    expect(context.server.writes).toHaveLength(1);

    // The user moves to another session while the first chunk is in flight.
    context.controller.createTerminal();
    context.server.writes[0]!.answer.resolve();
    await flush();
    // No further chunk; the bracketed paste is closed on the original session.
    expect(context.server.writes.map((write) => write.input)).toEqual([
      expect.objectContaining({ terminalId: "default" }),
      { threadId: THREAD, terminalId: "default", data: BRACKETED_PASTE_END },
    ]);
    context.server.writes[1]!.answer.resolve();
    await pasted;
    expect(context.controller.getSnapshot().error?.title).toBe("Paste stopped");
  });

  it("queues a paste behind typed input to the same session", async () => {
    const context = setup();
    await startHydrated(context);
    context.renderer({ type: "input", terminalId: "default", data: "a" });
    context.setClipboard("b");
    void context.controller.paste();
    await flush();
    expect(context.server.writes.map((write) => write.input.data)).toEqual(["a"]);
    context.server.writes[0]!.answer.resolve();
    await flush();
    expect(context.server.writes.map((write) => write.input.data)).toEqual(["a", "b"]);
  });

  it("never closes a session on detach and ignores answers after it", async () => {
    const context = setup();
    await startHydrated(context);
    context.renderer({ type: "input", terminalId: "default", data: "x" });
    await flush();
    context.detach();
    context.server.writes[0]!.answer.reject(new Error("late"));
    await flush();
    expect(context.server.terminal.close).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot().error).toBeNull();
  });

  it("re-hydrates instead of dropping output when the renderer falls behind", async () => {
    const context = setup();
    await startHydrated(context);
    const ref = { environmentId: ENV, threadId: THREAD };
    for (let sequence = 6; sequence < 6 + 20; sequence += 1) {
      context.store.getState().applyTerminalEvent(ref, output(sequence, "x".repeat(60_000)));
    }
    context.runFrames();
    await flush();
    expect(context.server.terminal.open).toHaveBeenCalledTimes(2);
  });

  it("fails a renderer of another version and reloads without touching the session", async () => {
    const context = setup();
    await startHydrated(context);
    context.controller.reloadRenderer();
    const view = context.controller.getSnapshot();
    expect(view.rendererGeneration).toBe(2);
    context.controller.attachRenderer(2, () => true);
    context.renderer({ type: "ready", rendererVersion: "0" }, 2);
    expect(context.controller.getSnapshot().screenState).toEqual({ kind: "renderer-failed" });
    expect(context.server.terminal.restart).not.toHaveBeenCalled();
    expect(context.server.terminal.close).not.toHaveBeenCalled();
  });

  it("maps a failed open to fixed copy without the path", async () => {
    const context = setup();
    context.controller.startTerminal();
    context.renderer({ type: "resize", terminalId: "default", cols: 80, rows: 24 });
    await flush();
    context.server.opens[0]!.answer.reject({ _tag: "TerminalCwdError", cwd: "/secret/path" });
    await flush();
    const error = context.controller.getSnapshot().error;
    expect(error?.title).toBe("Workspace unavailable");
    expect(JSON.stringify(error)).not.toContain("/secret/path");
  });

  it("keeps at most eight renderer terminals and re-opens an evicted one when selected", async () => {
    const context = setup();
    await startHydrated(context);
    const ref = { environmentId: ENV, threadId: THREAD };
    // The node runs more sessions than the device keeps renderers for.
    for (let index = 1; index <= 9; index += 1) {
      context.store.getState().newTerminal(ref, `desktop-${index}`);
      context.controller.selectTerminal(`desktop-${index}`);
    }
    const disposed = context.sent.filter((message) => message.type === "dispose");
    expect(disposed.map((message) => message.type === "dispose" && message.terminalId)).toEqual([
      "default",
      "desktop-1",
    ]);
    expect(context.controller.getSnapshot().tabs).toHaveLength(10);
    expect(context.server.terminal.close).not.toHaveBeenCalled();
  });

  it("closes the active session only on the explicit action", async () => {
    const context = setup();
    await startHydrated(context);
    expect(await context.controller.close(false)).toBe(true);
    expect(context.server.terminal.close).toHaveBeenCalledWith({
      threadId: THREAD,
      terminalId: "default",
      deleteHistory: false,
    });
    expect(context.sent).toContainEqual({ type: "dispose", terminalId: "default" });
    expect(context.controller.getSnapshot().hasSession).toBe(false);
  });
});
