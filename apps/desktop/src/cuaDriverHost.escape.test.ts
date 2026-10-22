// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ESCAPE_INPUT_COOLDOWN_MS } from "./cuaDriverHost.ts";
import type { ComputerInputMonitorState } from "./escapeKillSwitchMonitor.ts";
import type { CuaReply } from "@ryco/shared/cuaDriverProtocol";
import {
  capability,
  cleanupFixtures,
  cuaRequest,
  deferred,
  fixture,
  foregroundCollision,
  waitForEvent,
} from "./cuaDriverHost.fixtures.ts";

afterEach(cleanupFixtures);

describe("physical Escape interrupt", () => {
  const pressKey = (endpoint: string) =>
    cuaRequest<CuaReply>(endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });

  it("ignores the press when nothing is driving, so Escape stays an ordinary key", async () => {
    const f = await fixture();
    // No live or spawning generation and no held latch: the host reports the
    // press did not engage, and mutating admission still works afterwards.
    expect(f.host.emergencyStopInput()).toBe(false);
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
  });

  it("drains native input, keeps the generation, and requires fresh observation after Escape", async () => {
    let releaseCalls = 0;
    const f = await fixture(capability, {
      releaseHeldInput: async () => {
        releaseCalls += 1;
      },
    });
    // Prime a live generation.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });

    // The fake driver holds a type_text reply for 10s — the wedged-provider
    // shape the interrupt exists for. The press must not wait on it.
    const hung = cuaRequest(
      f.endpoint,
      { method: "call", name: "type_text", args: { text: "fixture" } },
      { timeoutMs: 5_000, mutation: true },
    );
    await waitForEvent(f, "dispatch");
    expect(f.host.emergencyStopInput()).toBe(true);
    // A socket abort returns promptly, while the separate native interrupt
    // drains the old operation and releases its own held input.
    await expect(hung).resolves.toMatchObject({ ok: false });
    await waitForEvent(f, "interrupt-ack");
    expect(releaseCalls).toBe(0);
    const mid = await f.events();
    expect(mid.some((event) => event.event === "interrupt")).toBe(true);
    expect(mid.filter((event) => event.event === "release")).toHaveLength(1);
    expect(mid.some((event) => event.event === "effect")).toBe(false);
    expect(mid.some((event) => event.event === "cancel")).toBe(false);
    expect(mid.some((event) => event.event === "retiring")).toBe(false);
    expect(mid.filter((event) => event.event === "start")).toHaveLength(1);

    // Inside the cooldown a mutating call is refused with the paused
    // dialect, while reads keep dispatching on the same generation.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      ok: true,
      result: {
        isError: true,
        structuredContent: { effect: "refused", code: "computer_input_paused" },
      },
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "list_windows" }),
    ).resolves.toMatchObject({ ok: true });

    // Time alone cannot make the model's old target state fresh. A preview
    // or target-readiness probe cannot clear the model-observation gate.
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
      desktopInterruptions: 0,
    });
    await cuaRequest(f.endpoint, { method: "call", name: "get_window_state" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_input_ready" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
    const after = await f.events();
    expect(after.filter((event) => event.event === "start")).toHaveLength(1);
    expect(after.filter((event) => event.event === "key")).toHaveLength(2);
    expect(after.some((event) => event.event === "retiring")).toBe(false);
  });

  it("interrupts the in-flight action on the backend stop verb without retiring", async () => {
    let releaseCalls = 0;
    const f = await fixture(capability, {
      releaseHeldInput: async () => {
        releaseCalls += 1;
      },
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    const hung = cuaRequest(
      f.endpoint,
      { method: "call", name: "type_text", args: { text: "fixture" } },
      { timeoutMs: 5_000, mutation: true },
    );
    await waitForEvent(f, "dispatch");
    // The same socket verb the backend's stopInput sends on turn Stop,
    // control revoke, and the relayed physical-Escape notice.
    await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({
      ok: true,
    });
    await expect(hung).resolves.toMatchObject({ ok: false });
    expect(releaseCalls).toBe(0);
    // Native interrupt is reusable; cancel_input still belongs to retirement.
    const mid = await f.events();
    expect(mid.some((event) => event.event === "interrupt-ack")).toBe(true);
    expect(mid.some((event) => event.event === "effect")).toBe(false);
    expect(mid.some((event) => event.event === "cancel")).toBe(false);
    expect(mid.some((event) => event.event === "retiring")).toBe(false);
    expect(mid.filter((event) => event.event === "start")).toHaveLength(1);
    // A bare stop arms no cooldown — the cooldown belongs to the physical
    // press — so the next action dispatches immediately on the live driver.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    const after = await f.events();
    expect(after.filter((event) => event.event === "key")).toHaveLength(2);
    expect(after.filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("keeps admission closed after a driver crash until the held-input release is confirmed", async () => {
    const release = deferred<void>();
    const f = await fixture(capability, {
      crash: true,
      releaseHeldInput: async () => {
        await release.promise;
      },
    });
    // The fake driver exits on dispatch. The call's own retirement stays
    // pending on the release gate (or the interrupt's abort lands first —
    // either way the crashed generation is still the host's live reference
    // when Escape lands) — and the request's reply is legitimately blocked
    // on that cleanup, which is why it is not awaited yet.
    const crashing = cuaRequest(
      f.endpoint,
      { method: "call", name: "type_text", args: { text: "fixture" } },
      { timeoutMs: 5_000, mutation: true },
    );
    await waitForEvent(f, "crash");
    expect(f.host.emergencyStopInput()).toBe(true);
    // Let the crash retirement finish: with the release confirmed the dead
    // generation clears, and nothing else holds admission.
    release.resolve();
    await expect(crashing).resolves.toMatchObject({ ok: false });
    // stop() joins the pending retirement chain, so its return proves the
    // generation cleared rather than merely having had time to.
    await f.host.stop();
    // The replacement generation still needs a fresh model observation;
    // successful crash cleanup does not validate the interrupted model state.
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
  });

  it("stays fail-closed when the crash cleanup is unconfirmed, with no Escape latch involved", async () => {
    const f = await fixture(capability, {
      crash: true,
      releaseHeldInput: () => Promise.reject(new Error("helper gone")),
    });
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 1_000, mutation: true },
      ),
    ).resolves.toMatchObject({ ok: false });
    // The driver died mid-input and nothing confirmed the OS-level release:
    // the generation stays referenced, and the interrupt cannot reopen what
    // the unprovable held-input state is closing.
    expect(f.host.emergencyStopInput()).toBe(true);
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("keeps input closed after an incomplete native interrupt and rechecks the drain before dispatch", async () => {
    const releaseHeldInput = vi.fn(async () => {});
    const f = await fixture(capability, { interruptCleanup: "once-incomplete", releaseHeldInput });
    await pressKey(f.endpoint);
    await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({ ok: false });
    expect(releaseHeldInput).toHaveBeenCalledTimes(1);
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
    const events = (await f.events()).map((event) => event.event);
    expect(events.filter((event) => event === "interrupt")).toHaveLength(2);
    expect(events.filter((event) => event === "key")).toHaveLength(2);
    expect(events.lastIndexOf("interrupt-ack")).toBeLessThan(events.lastIndexOf("key"));
    expect(events.filter((event) => event === "start")).toHaveLength(1);
  });

  it.each(["wrong-pid", "missing-admission", "incomplete"] as const)(
    "never resumes input on a %s interruption acknowledgement",
    async (interruptCleanup) => {
      const f = await fixture(capability, { interruptCleanup });
      await pressKey(f.endpoint);
      await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({
        ok: false,
      });
      await expect(pressKey(f.endpoint)).resolves.toMatchObject({
        ok: false,
        effect: "not-dispatched",
      });
      expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
    },
  );

  it("keeps background control running through the human's typing, clicks and app switches", async () => {
    const f = await fixture();
    const task = { threadId: "background", turnId: "turn" };
    const args = { pid: 700, window_id: 900, key: "enter" };
    await cuaRequest(f.endpoint, { method: "call", name: "press_key", args, task });
    // Keys in the controlled app (⌘-Tab included), clicks on its window, and
    // input anywhere else: none of it touches background work.
    expect(f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 700 })).toBe(
      false,
    );
    expect(
      f.host.physicalInput({ type: "physical-input", kind: "pointer", pid: 700, windowId: 900 }),
    ).toBe(false);
    expect(f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 701 })).toBe(
      false,
    );
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key", args, task }),
    ).resolves.toMatchObject({ ok: true, result: {} });
    expect((await f.events()).filter((event) => event.event === "interrupt")).toHaveLength(0);
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(2);
  });

  it("interrupts foreground input even when the physical event belongs to a different app", async () => {
    const f = await fixture();
    const hung = cuaRequest(
      f.endpoint,
      {
        method: "call",
        name: "type_text",
        args: { pid: 700, window_id: 900, delivery_mode: "foreground", text: "fixture" },
      },
      { mutation: true },
    );
    await waitForEvent(f, "dispatch");
    expect(f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 701 })).toBe(true);
    await expect(hung).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await waitForEvent(f, "interrupt-ack");
    expect((await f.events()).filter((event) => event.event === "release")).toHaveLength(1);
  });

  it.each([true, false])(
    "keeps foreground recovery paused through continued typing (scoped target: %s)",
    async (scoped) => {
      const f = await fixture(capability, { delayObservation: true });
      const task = { threadId: "foreground-recovery", turnId: "turn" };
      const target = scoped ? { pid: 700, window_id: 900 } : {};
      const typing = cuaRequest(
        f.endpoint,
        {
          method: "call",
          name: "type_text",
          args: { ...target, delivery_mode: "foreground", text: "fixture" },
          task,
        },
        { mutation: true },
      );
      await waitForEvent(f, "dispatch");
      const physicalInput = () =>
        f.host.physicalInput({ type: "physical-input", kind: "keyboard", pid: 700 });
      expect(physicalInput()).toBe(true);
      await expect(typing).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
      await waitForEvent(f, "interrupt-ack");
      await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));

      const observe = () =>
        cuaRequest(f.endpoint, {
          method: "call",
          name: "get_window_state",
          args: target,
          modelObservation: true,
          task,
        });
      const act = () =>
        cuaRequest(f.endpoint, {
          method: "call",
          name: "press_key",
          args: { ...target, delivery_mode: "foreground", key: "enter" },
          task,
        });
      const reading = observe();
      await waitForEvent(f, "observe");
      // The interrupted action already returned; input must still invalidate this read.
      expect(physicalInput()).toBe(true);
      await expect(reading).resolves.toMatchObject({
        result: { structuredContent: { code: "computer_input_paused" } },
      });
      await expect(act()).resolves.toMatchObject({
        result: { structuredContent: { code: "computer_input_paused" } },
      });
      // An early read must not disarm recovery tracking during the new cooldown.
      await observe();
      expect(physicalInput()).toBe(true);
      expect((await f.events()).filter((event) => event.event === "interrupt")).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
      await expect(act()).resolves.toMatchObject({
        result: { structuredContent: { code: "computer_input_paused" } },
      });
      await observe();
      await expect(act()).resolves.toMatchObject({ ok: true, result: {} });
      expect(physicalInput()).toBe(false);
      expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
    },
  );

  it("starts listener activation only on use and disarms it when the last task ends", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
    const activateInputMonitor = vi.fn(async () => {
      state = { ready: true };
    });
    const onInputMonitorArmedChange = vi.fn((armed: boolean) => {
      if (!armed) state = { ready: false, error: "input_monitor_idle" };
    });
    const f = await fixture(capability, {
      activateInputMonitor,
      onInputMonitorArmedChange,
      inputMonitorState: () => state,
    });
    expect(activateInputMonitor).not.toHaveBeenCalled();
    const task = { threadId: "activation", turnId: "turn" };
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
      task,
    });
    expect(activateInputMonitor).toHaveBeenCalledTimes(1);
    await cuaRequest(f.endpoint, { method: "end_task", task });
    expect(onInputMonitorArmedChange).toHaveBeenLastCalledWith(false);
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
      task: { ...task, turnId: "next" },
    });
    expect(activateInputMonitor).toHaveBeenCalledTimes(2);
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(2);
  });

  it("keeps passive status checks and previews idle until actual model Computer work starts", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
    const activateInputMonitor = vi.fn(async () => {
      state = { ready: true };
    });
    const onInputMonitorArmedChange = vi.fn((armed: boolean) => {
      if (!armed) state = { ready: false, error: "input_monitor_idle" };
    });
    const f = await fixture(capability, {
      activateInputMonitor,
      onInputMonitorArmedChange,
      inputMonitorState: () => state,
      checkPermissions: async () => ({
        accessibility: true,
        screenRecording: true,
        inputMonitoring: true,
      }),
    });
    for (let i = 0; i < 3; i += 1) {
      await cuaRequest(f.endpoint, { method: "probe" });
      const status = await cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "check_permissions",
      });
      expect(status.result?.structuredContent).not.toHaveProperty("input_monitor_ready");
      expect(status.result?.structuredContent).not.toHaveProperty("input_monitor_error");
    }
    const task = { threadId: "passive-preview", turnId: "turn" };
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      args: { pid: 700, window_id: 900 },
      task,
      modelObservation: false,
    });
    expect(activateInputMonitor).not.toHaveBeenCalled();
    expect(onInputMonitorArmedChange).not.toHaveBeenCalled();
    expect(f.host.isInputMonitorRequested).toBe(false);
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      args: { pid: 700, window_id: 900 },
      task,
      modelObservation: true,
    });
    expect(activateInputMonitor).toHaveBeenCalledTimes(1);
    expect(f.host.isInputMonitorRequested).toBe(true);
    await cuaRequest(f.endpoint, { method: "end_task", task });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    expect(activateInputMonitor).toHaveBeenCalledTimes(1);
    expect(f.host.isInputMonitorRequested).toBe(false);
    expect(onInputMonitorArmedChange).toHaveBeenLastCalledWith(false);
  });

  it("exposes granted-but-unavailable monitoring and requires recovery before input", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "event_tap_unavailable" };
    const f = await fixture(capability, {
      inputMonitorState: () => state,
      checkPermissions: async () => ({
        accessibility: true,
        screenRecording: true,
        inputMonitoring: true,
      }),
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      result: { structuredContent: { effect: "refused", code: "input_monitor_unavailable" } },
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          input_monitoring: true,
          input_monitor_ready: false,
          input_monitor_error: "event_tap_unavailable",
        },
      },
    });
    state = { ready: true };
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
    state = { ready: false, error: "input_monitor_unavailable" };
    f.host.inputMonitorStateChanged(state);
    await waitForEvent(f, "interrupt-ack");
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      result: { structuredContent: { code: "input_monitor_unavailable" } },
      desktopInterruptions: 0,
    });
    state = { ready: true };
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
  });

  it("drains an interrupted browser mutation and uses the new epoch without retiring its binding", async () => {
    const f = await fixture(capability, { browserHang: true });
    const task = { threadId: "browser-stop", turnId: "turn" };
    const hung = cuaRequest(
      f.endpoint,
      { method: "call", name: "browser_type", args: { text: "fixture" }, task },
      { mutation: true },
    );
    await waitForEvent(f, "browser-dispatch");
    await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({ ok: true });
    await expect(hung).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "browser_navigate", args: {}, task }),
    ).resolves.toMatchObject({ ok: true, result: {} });
    const events = (await f.events()).map((event) => event.event);
    expect(events.filter((event) => event === "release")).toHaveLength(1);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(events).not.toContain("browser-effect");
  });

  it.each(["type_text", "browser_type"])(
    "drains already-dispatched %s when its caller disconnects, without replay or replacement",
    async (name) => {
      const f = await fixture(capability, { browserHang: true, inputDelayMs: 150 });
      const controller = new AbortController();
      const call = cuaRequest(
        f.endpoint,
        {
          method: "call",
          name,
          args: { text: "fixture" },
          task: { threadId: "disconnect", turnId: "turn" },
        },
        { mutation: true, signal: controller.signal },
      ).catch((error: unknown) => error);
      await waitForEvent(f, name === "browser_type" ? "browser-dispatch" : "dispatch");
      controller.abort();
      expect(await call).toMatchObject({ effect: "dispatched-unknown" });
      await waitForEvent(f, "interrupt");
      // The next call is admitted behind the matching native cleanup ACK.
      await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true, result: {} });
      await new Promise((resolve) => setTimeout(resolve, 180));
      const events = (await f.events()).map((event) => event.event);
      expect(events.filter((event) => event === "release")).toHaveLength(1);
      expect(events.filter((event) => event === "start")).toHaveLength(1);
      expect(events.indexOf("key")).toBeGreaterThan(events.indexOf("interrupt-ack"));
      expect(events).not.toContain("effect");
      expect(events).not.toContain("browser-effect");
    },
  );

  it("requires a live Escape listener for browser mutations but keeps browser reads available", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "event_tap_unavailable" };
    const f = await fixture(capability, { inputMonitorState: () => state });
    const task = { threadId: "listener-browser", turnId: "turn" };
    const action = () =>
      cuaRequest(f.endpoint, { method: "call", name: "browser_navigate", args: {}, task });
    await expect(action()).resolves.toMatchObject({
      result: { structuredContent: { code: "input_monitor_unavailable" } },
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_browser_state", args: {}, task }),
    ).resolves.toMatchObject({ ok: true, result: {} });
    state = { ready: true };
    await expect(action()).resolves.toMatchObject({ ok: true, result: {} });
    expect(
      (await f.events()).filter((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toHaveLength(1);
  });

  it("rechecks browser listener readiness after asynchronous session setup", async () => {
    let checks = 0;
    const f = await fixture(capability, {
      inputMonitorState: () =>
        ++checks === 1 ? { ready: true } : { ready: false, error: "event_tap_unavailable" },
    });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "browser_navigate",
        args: {},
        task: { threadId: "late-listener-failure", turnId: "turn" },
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { code: "input_monitor_unavailable" } },
    });
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
  });

  it("does not mistake OS releases or later reads for an unconfirmed browser release", async () => {
    const releaseHeldInput = vi.fn(async () => {});
    const f = await fixture(capability, { browserCleanupUnconfirmed: true, releaseHeldInput });
    const task = { threadId: "browser-cleanup", turnId: "turn" };
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "browser_type", args: {}, task }),
    ).resolves.toMatchObject({
      result: { isError: true, structuredContent: { input_cleanup_unconfirmed: true } },
    });
    await cuaRequest(f.endpoint, { method: "call", name: "get_browser_state", args: {}, task });
    await expect(cuaRequest(f.endpoint, { method: "stop" })).resolves.toMatchObject({ ok: false });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({
      ok: false,
      effect: "not-dispatched",
    });
    expect(releaseHeldInput).not.toHaveBeenCalled();
    expect((await f.events()).some((event) => event.event === "key")).toBe(false);
  });

  it("does not let another task, window, preview, or mismatched read clear native takeover", async () => {
    const f = await fixture();
    const taskA = { threadId: "task-a", turnId: "turn" };
    const taskB = { threadId: "task-b", turnId: "turn" };
    const windowA = { pid: 701, window_id: 901 };
    const windowB = { pid: 700, window_id: 900 };
    const observe = (task: typeof taskA, args: Record<string, unknown>, modelObservation = true) =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        args,
        modelObservation,
        task,
      });
    const click = (task: typeof taskA, args: Record<string, unknown>) =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { ...args, key: "enter" },
        task,
      });
    await observe(taskA, windowA);
    await observe(taskB, windowB);
    await foregroundCollision(f, taskB, windowB);
    await observe(taskA, windowB);
    await observe(taskB, windowA);
    await observe(taskB, windowB, false);
    await observe(taskB, { ...windowB, fixture_wrong_window: true });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_desktop_state",
      modelObservation: true,
      task: taskB,
    });
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    await expect(click(taskA, windowA)).resolves.toMatchObject({ ok: true, result: {} });
    await expect(click(taskB, windowB)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
      desktopInterruptions: 0,
    });
    await observe(taskB, windowB);
    await expect(click(taskB, windowB)).resolves.toMatchObject({ ok: true, result: {} });
  });

  it("fences input after uncertain focus restoration until a fresh model observation", async () => {
    const result = {
      isError: true,
      structuredContent: { effect: "unverifiable", code: "focus_restore_failed" },
    };
    const f = await fixture(capability, { actionResult: result });
    const task = { threadId: "restore-failure", turnId: "turn" };
    const target = { pid: 700, window_id: 900 };
    const act = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { ...target, key: "enter" },
        task,
      });
    const read = (modelObservation: boolean) =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        args: target,
        modelObservation,
        task,
      });
    expect((await act()).result).toEqual(result);
    await read(false);
    expect((await act()).result?.structuredContent?.code).toBe("computer_input_paused");
    expect((await f.events()).filter((e) => e.event === "key")).toHaveLength(1);
    await read(true);
    // The fixture fails again, but exactly one new explicitly observed action ran.
    expect((await act()).result).toEqual(result);
    expect((await f.events()).filter((e) => e.event === "key")).toHaveLength(2);
  });

  it("recovers native takeover through a fresh usable sibling, never an empty or stale read", async () => {
    const f = await fixture();
    const task = { threadId: "sibling-recovery", turnId: "turn" };
    const observe = (args: Record<string, unknown>) =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        args,
        modelObservation: true,
        task,
      });
    const act = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { pid: 700, window_id: 901, key: "enter" },
        task,
      });
    await observe({ pid: 700, window_id: 900 });
    await foregroundCollision(f, task, { pid: 700, window_id: 900 });
    const cooldown = await act();
    expect(cooldown.result?.structuredContent?.wait_seconds).toBeGreaterThan(0);
    expect(cooldown.result?.structuredContent?.requery_hint).toBeTypeOf("string");
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    for (const extra of [
      {},
      { fixture_usable: true, fixture_degraded: "ax_window_unresolved" },
      { fixture_usable: true, fixture_stale: true },
    ]) {
      await observe({ pid: 700, window_id: 901, ...extra });
      expect((await act()).result?.structuredContent?.code).toBe("computer_input_paused");
    }
    await observe({ pid: 700, window_id: 901, fixture_usable: true });
    expect(await act()).toMatchObject({ ok: true, result: {} });
  });

  it.each(["dom_refs_v1", "semantic_v2"])(
    "requires the affected task's exact %s browser snapshot after an interrupt",
    async (snapshot_format) => {
      const f = await fixture(capability, { browserObservations: true });
      const task = { threadId: "browser-takeover", turnId: "turn" };
      const otherTask = { threadId: "other-browser-task", turnId: "turn" };
      const window = { pid: 700, window_id: 900 };
      const browser = { target_id: "target-700-900", tab_id: "tab-a", snapshot_format };
      const observe = (args: Record<string, unknown>, modelObservation = true, owner = task) =>
        cuaRequest(f.endpoint, {
          method: "call",
          name: "get_browser_state",
          args,
          modelObservation,
          task: owner,
        });
      const action = () =>
        cuaRequest<CuaReply>(f.endpoint, {
          method: "call",
          name: "browser_click",
          args: browser,
          task,
        });
      await observe(window);
      await observe(browser);
      expect(f.host.emergencyStopInput()).toBe(true);
      await waitForEvent(f, "interrupt-ack");
      await observe(browser, true, otherTask);
      await observe(window);
      await observe(browser, false);
      await observe({ ...browser, fixture_wrong_target: true });
      await observe({ ...browser, tab_id: "other-tab" });
      // Rebinding the same native window mints new tab IDs. Seeing that new
      // tab must not unlock input through the still-valid old capability.
      await observe({ ...window, fixture_target_id: "target-rebound" });
      await observe({ target_id: "target-rebound", tab_id: "new-tab", snapshot_format });
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        args: window,
        modelObservation: true,
        task,
      });
      await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
      await expect(action()).resolves.toMatchObject({
        result: { structuredContent: { code: "computer_input_paused" } },
        desktopInterruptions: 0,
      });
      await observe(browser);
      expect((await action()).result).toEqual({});
    },
  );

  it("keeps Escape browser recovery separate from native reads and rejects an interrupted browser snapshot", async () => {
    const f = await fixture(capability, {
      browserObservations: true,
      delayBrowserObservation: true,
    });
    const task = { threadId: "browser-escape", turnId: "turn" };
    const window = { pid: 700, window_id: 900 };
    const browser = { target_id: "target-700-900", tab_id: "tab-a" };
    await cuaRequest(f.endpoint, { method: "call", name: "get_browser_state", args: window, task });
    expect(f.host.emergencyStopInput()).toBe(true);
    await waitForEvent(f, "interrupt-ack");
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_desktop_state",
      modelObservation: true,
      task,
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: window,
      modelObservation: true,
      task,
    });
    const reading = cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: browser,
      modelObservation: true,
      task,
    });
    await waitForEvent(f, "browser-observe");
    expect(f.host.emergencyStopInput()).toBe(true);
    await expect(reading).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_INPUT_COOLDOWN_MS + 50));
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "browser_navigate", args: browser, task }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: browser,
      modelObservation: true,
      task,
    });
    expect(
      (
        await cuaRequest<CuaReply>(f.endpoint, {
          method: "call",
          name: "browser_navigate",
          args: browser,
          task,
        })
      ).result,
    ).toEqual({});
  });

  it("permits separate isolated setup after retirement while old browser targets stay paused", async () => {
    const f = await fixture(capability, { browserObservations: true });
    const task = { threadId: "browser-recovery-setup", turnId: "turn" };
    const oldTarget = { target_id: "old-browser", tab_id: "old-tab" };
    const newTarget = { target_id: "new-browser", tab_id: "new-tab" };
    const call = (name: string, args: Record<string, unknown>, modelObservation = false) =>
      cuaRequest<CuaReply>(f.endpoint, { method: "call", name, args, modelObservation, task });
    await call("get_browser_state", oldTarget, true);
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    await expect(
      call("browser_prepare", { pid: 700, allow_launch: true, profile: { mode: "isolated_new" } }),
    ).resolves.toMatchObject({ result: { structuredContent: { code: "computer_input_paused" } } });
    expect(
      (await call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } }))
        .result,
    ).toEqual({});
    await expect(call("browser_navigate", newTarget)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await call("get_browser_state", { pid: 701, fixture_target_id: "new-browser" }, true);
    await expect(call("browser_navigate", newTarget)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await call("get_browser_state", newTarget, true);
    expect((await call("browser_navigate", newTarget)).result).toEqual({});
    await expect(call("browser_navigate", oldTarget)).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    await call("get_browser_state", oldTarget, true);
    expect((await call("browser_navigate", oldTarget)).result).toEqual({});
  });

  it("has no rearm method left on the host protocol", async () => {
    const f = await fixture();
    const reply = await cuaRequest<CuaReply>(f.endpoint, { method: "rearm" });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("Unsupported computer host request.");
  });
});
