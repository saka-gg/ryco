import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_BACKEND_FATAL_EXIT_CODE,
  parseDesktopBackendLifecycleFrame,
} from "@ryco/shared/desktopResourceTelemetry";

import {
  BackendFatalStartupError,
  BackendPortMismatchError,
  BackendOutputTail,
  BackendReadinessTracker,
  createBackendFailurePolicy,
} from "./backendStartup.ts";

describe("backend lifecycle frames", () => {
  // One protocol definition: the backend writes and the desktop reads the
  // frames through the shared parser.
  it("drives readiness from frames parsed by the shared protocol parser", async () => {
    const tracker = new BackendReadinessTracker(7926);
    for (const line of [
      '{"type":"startup-phase","name":"migrations","ms":22}',
      '{"type":"http-bound","port":7926}',
      '{"type":"sample"}',
      '{"type":"http-serving","port":7926}',
    ]) {
      const frame = parseDesktopBackendLifecycleFrame(JSON.parse(line));
      if (frame !== null) tracker.handleFrame(frame);
    }
    await expect(tracker.promise).resolves.toBe("protocol");
  });

  it("fails readiness on a parsed fatal frame", async () => {
    const tracker = new BackendReadinessTracker(7926);
    const frame = parseDesktopBackendLifecycleFrame({
      type: "fatal",
      code: "schema-too-new",
      message: "Upgrade Ryco",
    });
    expect(frame).not.toBeNull();
    tracker.handleFrame(frame!);
    await expect(tracker.promise).rejects.toBeInstanceOf(BackendFatalStartupError);
    expect(tracker.fatal).toEqual({ code: "schema-too-new", message: "Upgrade Ryco" });
  });
});

describe("BackendReadinessTracker", () => {
  it("is ready on the backend's http-serving frame", async () => {
    const tracker = new BackendReadinessTracker(7926);
    tracker.handleFrame({ type: "http-bound", port: 7926 });
    expect(tracker.settled).toBe(false);
    tracker.handleFrame({ type: "http-serving", port: 7926 });
    await expect(tracker.promise).resolves.toBe("protocol");
  });

  it("falls back to the Listening log line of older backends", async () => {
    const tracker = new BackendReadinessTracker(7926);
    tracker.pushOutput("[00:00:01.000] INFO (#1): Listening on http://127.0.0.1:79");
    expect(tracker.settled).toBe(false);
    tracker.pushOutput("26\n");
    await expect(tracker.promise).resolves.toBe("listening");
  });

  it("rejects a backend serving a port the renderer cannot reach", async () => {
    const tracker = new BackendReadinessTracker(7926);
    tracker.handleFrame({ type: "http-serving", port: 3773 });
    await expect(tracker.promise).rejects.toBeInstanceOf(BackendPortMismatchError);
    await expect(tracker.promise).rejects.toThrow("serving port 3773, expected 7926");

    const logged = new BackendReadinessTracker(7926);
    logged.pushOutput("INFO (#1): Listening on http://0.0.0.0:3773\n");
    await expect(logged.promise).rejects.toBeInstanceOf(BackendPortMismatchError);
  });

  it("reports a fatal startup error and keeps its details", async () => {
    const tracker = new BackendReadinessTracker(7926);
    tracker.handleFrame({ type: "fatal", code: "schema-too-new", message: "Database is newer" });
    await expect(tracker.promise).rejects.toBeInstanceOf(BackendFatalStartupError);
    expect(tracker.fatal).toEqual({ code: "schema-too-new", message: "Database is newer" });
  });

  it("settles once", async () => {
    const tracker = new BackendReadinessTracker(7926);
    tracker.handleFrame({ type: "http-serving", port: 7926 });
    tracker.fail(new Error("exited later"));
    await expect(tracker.promise).resolves.toBe("protocol");
  });
});

describe("createBackendFailurePolicy", () => {
  it("halts after three consecutive exits before readiness", () => {
    const policy = createBackendFailurePolicy();
    const preReady = { reachedReady: false, exitCode: 1, fatal: false };
    expect(policy.recordExit(preReady)).toEqual({ action: "restart" });
    expect(policy.recordExit(preReady)).toEqual({ action: "restart" });
    expect(policy.recordExit(preReady)).toEqual({
      action: "halt",
      reason: "crash-loop",
      consecutiveFailures: 3,
    });
  });

  it("keeps restarting crashes after readiness and resets the count on readiness", () => {
    const policy = createBackendFailurePolicy();
    policy.recordExit({ reachedReady: false, exitCode: 1, fatal: false });
    policy.recordExit({ reachedReady: false, exitCode: 1, fatal: false });
    policy.recordReady();
    expect(policy.recordExit({ reachedReady: false, exitCode: 1, fatal: false })).toEqual({
      action: "restart",
    });
    for (let index = 0; index < 5; index += 1) {
      expect(policy.recordExit({ reachedReady: true, exitCode: null, fatal: false })).toEqual({
        action: "restart",
      });
    }
  });

  it("halts at once on a fatal frame or the configuration-error exit code", () => {
    expect(
      createBackendFailurePolicy().recordExit({ reachedReady: false, exitCode: 1, fatal: true }),
    ).toMatchObject({ action: "halt", reason: "fatal" });
    expect(
      createBackendFailurePolicy().recordExit({
        reachedReady: false,
        exitCode: DESKTOP_BACKEND_FATAL_EXIT_CODE,
        fatal: false,
      }),
    ).toMatchObject({ action: "halt", reason: "fatal" });
  });
});

describe("BackendOutputTail", () => {
  it("keeps the last lines without terminal colours", () => {
    const tail = new BackendOutputTail(64);
    tail.push("line 1\n");
    tail.push(Buffer.from("\u001b[31mError: schema 77 is newer\u001b[0m\r\nline 3\n"));
    expect(tail.lines(2)).toEqual(["Error: schema 77 is newer", "line 3"]);
  });
});
