import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hasReachedStartupPhase,
  makeStartupMarkName,
  createPrimaryShellFrameProbe,
  markStartupPhase,
  markStartupPhaseAfterPaint,
  measureStartupPhasesEndingAt,
  onStartupPhase,
  resetStartupPhasesForTests,
  SHELL_SUBSCRIPTION_RPC_TAG,
} from "./startupInstrumentation";

function startupMarks(): string[] {
  return performance
    .getEntriesByType("mark")
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("ryco:startup:"));
}

function startupMeasures(): string[] {
  return performance
    .getEntriesByType("measure")
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("ryco:startup:"));
}

describe("startupInstrumentation", () => {
  beforeEach(() => {
    resetStartupPhasesForTests();
    performance.clearMarks();
    performance.clearMeasures();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses a stable startup mark prefix", () => {
    expect(makeStartupMarkName("primary-shell-snapshot-applied")).toBe(
      "ryco:startup:primary-shell-snapshot-applied",
    );
  });

  it("runs phase listeners once, and immediately for phases already reached", () => {
    const early = vi.fn();
    const cancelled = vi.fn();
    onStartupPhase("primary-shell-painted", early);
    const cancel = onStartupPhase("primary-shell-painted", cancelled);
    cancel();

    markStartupPhase("primary-shell-painted");
    markStartupPhase("primary-shell-painted");

    expect(early).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    expect(hasReachedStartupPhase("primary-shell-painted")).toBe(true);

    const late = vi.fn();
    onStartupPhase("primary-shell-painted", late);
    expect(late).toHaveBeenCalledOnce();
  });

  it("marks the first shell frame when it arrives off the wire, before decoding", () => {
    expect(SHELL_SUBSCRIPTION_RPC_TAG).toBe(ORCHESTRATION_WS_METHODS.subscribeShell);
    const socket = new EventTarget();
    const probe = createPrimaryShellFrameProbe(() => socket);
    const created = probe.webSocketConstructor("ws://localhost/ws");
    expect(created).toBe(socket);
    const receive = (data: string) => socket.dispatchEvent(new MessageEvent("message", { data }));

    probe.onRequestStart({ id: "7", tag: ORCHESTRATION_WS_METHODS.subscribeThreadWindow });
    probe.onRequestStart({ id: "3", tag: SHELL_SUBSCRIPTION_RPC_TAG });
    receive('{"_tag":"Chunk","requestId":"7","values":[]}');
    receive('{"_tag":"Exit","requestId":"3","exit":{}}');
    expect(hasReachedStartupPhase("primary-shell-frame-received")).toBe(false);

    receive('[{"_tag":"Pong"},{"_tag":"Chunk","requestId":"3","values":[{"snapshot":1}]}]');
    receive('{"_tag":"Chunk","requestId":"3","values":[]}');
    expect(hasReachedStartupPhase("primary-shell-frame-received")).toBe(true);
    expect(
      startupMarks().filter((name) => name === "ryco:startup:primary-shell-frame-received"),
    ).toHaveLength(1);

    // Later sockets (reconnects) are not instrumented once the phase is marked.
    const reconnect = new EventTarget();
    const addEventListener = vi.spyOn(reconnect, "addEventListener");
    createPrimaryShellFrameProbe(() => reconnect).webSocketConstructor("ws://localhost/ws");
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("accepts numeric request ids", () => {
    const socket = new EventTarget();
    const probe = createPrimaryShellFrameProbe(() => socket);
    probe.webSocketConstructor("ws://localhost/ws");
    probe.onRequestStart({ id: "12", tag: SHELL_SUBSCRIPTION_RPC_TAG });
    socket.dispatchEvent(
      new MessageEvent("message", { data: '{"_tag":"Chunk","requestId":120,"values":[]}' }),
    );
    expect(hasReachedStartupPhase("primary-shell-frame-received")).toBe(false);
    socket.dispatchEvent(
      new MessageEvent("message", { data: '{"_tag":"Chunk","requestId":12,"values":[]}' }),
    );
    expect(hasReachedStartupPhase("primary-shell-frame-received")).toBe(true);
  });

  it("measures the sidebar commit and the painted shell once both ends exist", () => {
    markStartupPhase("primary-shell-usable");
    markStartupPhase("primary-sidebar-committed");
    measureStartupPhasesEndingAt("primary-sidebar-committed");
    markStartupPhase("primary-shell-painted");
    measureStartupPhasesEndingAt("primary-shell-painted");

    expect(startupMeasures()).toEqual(
      expect.arrayContaining([
        "ryco:startup:primary-sidebar-commit",
        "ryco:startup:primary-shell-paint",
        "ryco:startup:primary-shell-painted",
      ]),
    );
  });

  it("skips measures whose start phase never happened", () => {
    markStartupPhase("primary-sidebar-committed");
    measureStartupPhasesEndingAt("primary-sidebar-committed");

    expect(startupMeasures()).not.toContain("ryco:startup:primary-sidebar-commit");
  });

  it("marks a phase after the next frame is presented, once", async () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });

    markStartupPhaseAfterPaint("primary-shell-painted");
    markStartupPhaseAfterPaint("primary-shell-painted");
    expect(frames).toHaveLength(1);
    expect(hasReachedStartupPhase("primary-shell-painted")).toBe(false);

    // The frame callback runs before paint; the mark lands on the task after it.
    frames[0]?.();
    expect(hasReachedStartupPhase("primary-shell-painted")).toBe(false);
    await vi.waitFor(() => expect(hasReachedStartupPhase("primary-shell-painted")).toBe(true));

    expect(hasReachedStartupPhase("primary-shell-painted")).toBe(true);
    expect(
      startupMarks().filter((name) => name === "ryco:startup:primary-shell-painted"),
    ).toHaveLength(1);
  });
});
