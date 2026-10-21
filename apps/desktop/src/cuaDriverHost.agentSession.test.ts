// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CuaReply } from "@ryco/shared/cuaDriverProtocol";
import {
  capability,
  cleanupFixtures,
  cuaRequest,
  deferred,
  fixture,
  waitForEvent,
} from "./cuaDriverHost.fixtures.ts";

afterEach(cleanupFixtures);

/** The args of every `set_agent_cursor_style` call the fixture recorded. */
function stylePayloads(events: Array<{ event: string }>): Array<Record<string, unknown>> {
  return events
    .filter((row) => row.event.startsWith("style:"))
    .map((row) => JSON.parse(row.event.slice("style:".length)) as Record<string, unknown>);
}

describe("agent cursor style", () => {
  const pressKey = (endpoint: string) =>
    cuaRequest<CuaReply>(endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter", _synara_foreground_observation_ms: 0 },
    });

  it("pushes the custom colors once per generation, on the session open", async () => {
    const f = await fixture(capability, {
      cursorStyle: () => ({ fill: "#101010", rim: "#F0F0F0", shadow: "#000000" }),
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    // A second action reuses the same generation and session: the style is
    // setup, not per-action traffic.
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });

    const events = await f.events();
    expect(events.filter((row) => row.event === "motion-100-0")).toHaveLength(1);
    const payloads = stylePayloads(events);
    expect(payloads).toHaveLength(1);
    expect(Object.keys(payloads[0]!).toSorted()).toEqual(["fill", "rim", "session", "shadow"]);
    expect(payloads[0]!.session).toMatch(/^synara-/);
    // Colors are normalized to lowercase before they reach the driver.
    expect(payloads[0]!.fill).toBe("#101010");
    expect(payloads[0]!.rim).toBe("#f0f0f0");
    expect(payloads[0]!.shadow).toBe("#000000");
  });

  it("sends only the channels that carry a usable color", async () => {
    const f = await fixture(capability, {
      cursorStyle: () => ({ fill: "#ABCDEF", rim: "not-a-color" }),
    });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    const payloads = stylePayloads(await f.events());
    expect(payloads).toHaveLength(1);
    expect(Object.keys(payloads[0]!).toSorted()).toEqual(["fill", "session"]);
    expect(payloads[0]!.fill).toBe("#abcdef");
  });

  it("makes no style call for the stock default", async () => {
    // No cursorStyle option at all is the packaged default: the driver keeps
    // its stock monochrome cursor and hears nothing from the host.
    const f = await fixture();
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    expect(events.some((row) => row.event === "motion-100-0")).toBe(true);
    expect(stylePayloads(events)).toHaveLength(0);
  });

  it("makes no style call for a stock-resolving option", async () => {
    const f = await fixture(capability, { cursorStyle: () => null });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    expect(stylePayloads(await f.events())).toHaveLength(0);
  });

  it("keeps an unpatched upstream driver on its stock cursor", async () => {
    const f = await fixture(capability, {
      unpatched: true,
      nativeRevision: null,
      cursorStyle: () => ({ fill: "#101010" }),
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "list_windows", args: {} }),
    ).resolves.toMatchObject({ ok: true, driverNativeRevision: 0 });
    const events = await f.events();
    expect(events.some((row) => row.event === "motion-100-0")).toBe(true);
    expect(stylePayloads(events)).toHaveLength(0);
  });

  it("live-pushes a preference change to the warm session, once", async () => {
    let style: { fill?: string; rim?: string } | null = { fill: "#101010" };
    const f = await fixture(capability, { cursorStyle: () => style });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });

    style = { fill: "#101010", rim: "#f0f0f0" };
    await f.host.setCursorStyle(style);
    // An unchanged value is already applied: the second push is skipped.
    await f.host.setCursorStyle(style);

    const payloads = stylePayloads(await f.events());
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ fill: "#101010", rim: "#f0f0f0" });
    expect(payloads[1]!.session).toBe(payloads[0]!.session);
  });

  it("resets a warm session to stock when the preference clears", async () => {
    let style: { fill?: string } | null = { fill: "#101010" };
    const f = await fixture(capability, { cursorStyle: () => style });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });

    style = null;
    await f.host.setCursorStyle(null);

    const payloads = stylePayloads(await f.events());
    expect(payloads).toHaveLength(2);
    // A stock change carries the session and no colors, so the driver's
    // omitted-channel stock treatment is what repaints the cursor.
    expect(Object.keys(payloads[1]!).toSorted()).toEqual(["session"]);
  });

  it("never spawns a driver just to apply a settings change", async () => {
    const f = await fixture(capability, { cursorStyle: () => ({ fill: "#101010" }) });
    await f.host.setCursorStyle({ fill: "#101010" });
    // No generation was ever spawned or warmed by the settings change; the
    // next real call opens its session with the preference from the getter.
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(pressKey(f.endpoint)).resolves.toMatchObject({ ok: true });
    expect(stylePayloads(await f.events())).toHaveLength(1);
  });

  it("styles a task's own cursor session before its first action, once", async () => {
    const f = await fixture(capability, { cursorStyle: () => ({ fill: "#101010" }) });
    const task = { threadId: "thread", turnId: "turn" };
    const press = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
        task,
      });
    for (let i = 0; i < 2; i++) await expect(press()).resolves.toMatchObject({ ok: true });

    const payloads = stylePayloads(await f.events());
    // Two calls: the shared session at open, then the task cursor session the
    // action actually paints under. The second action reuses both.
    expect(payloads).toHaveLength(2);
    expect(payloads[1]!.session).toBe("agent·thread");
    expect(payloads[1]!.fill).toBe("#101010");
  });

  it("resets a task cursor session to stock on its next action", async () => {
    let style: { fill?: string } | null = { fill: "#101010" };
    const f = await fixture(capability, { cursorStyle: () => style });
    const task = { threadId: "thread", turnId: "turn" };
    const press = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
        task,
      });
    await expect(press()).resolves.toMatchObject({ ok: true });

    style = null;
    await f.host.setCursorStyle(null);
    // The live change resets the shared session and forgets what each task
    // session had, so the task's next action repaints it stock.
    await expect(press()).resolves.toMatchObject({ ok: true });
    // A third action has nothing left to reset.
    await expect(press()).resolves.toMatchObject({ ok: true });

    const payloads = stylePayloads(await f.events());
    expect(payloads).toHaveLength(4);
    expect(Object.keys(payloads[2]!).toSorted()).toEqual(["session"]); // shared session reset
    expect(payloads[3]!.session).toBe("agent·thread");
    expect(Object.keys(payloads[3]!).toSorted()).toEqual(["session"]);
  });

  it("sends no style call for a stock task session", async () => {
    const f = await fixture();
    await expect(
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
        task: { threadId: "thread", turnId: "turn" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(stylePayloads(await f.events())).toHaveLength(0);
  });
});

describe("task-owned user stop", () => {
  const task = { threadId: "thread", turnId: "turn" };
  it("end_task succeeds without a native preview", async () => {
    const f = await fixture();
    await expect(cuaRequest(f.endpoint, { method: "end_task", task })).resolves.toMatchObject({
      ok: true,
    });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("user Stop refuses subsequent calls from the same turn", async () => {
    const f = await fixture();
    await f.host.stopTaskByUser(task);
    const blocked = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      task,
      args: { key: "enter", pid: 42, window_id: 10 },
    });
    expect(blocked).toMatchObject({ ok: false, effect: "not-dispatched" });
    expect(blocked.error).toContain("user stopped");
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    const next = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_window_state",
      task: { ...task, turnId: "next" },
      modelObservation: true,
      args: { pid: 42, window_id: 10 },
    });
    expect(next.ok).toBe(true);
  });

  it.each([
    { threadId: "other-thread", turnId: "turn" },
    { threadId: "thread", turnId: "new-turn" },
  ])(
    "stopping queued $threadId/$turnId's sibling preserves its native input",
    async (activeTask) => {
      const f = await fixture(capability, { inputDelayMs: 300, logSessions: true });
      const active = cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "type_text",
        task: activeTask,
        args: { text: "fixture" },
      });
      await waitForEvent(f, "dispatch");
      const queued = cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        task,
        args: { key: "enter" },
      });
      await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
        ok: true,
        result: { stop_scope: "task" },
      });
      await expect(queued).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      await expect(active).resolves.toMatchObject({ ok: true });
      await expect(
        cuaRequest(f.endpoint, {
          method: "call",
          name: "press_key",
          task: activeTask,
          args: { key: "enter" },
        }),
      ).resolves.toMatchObject({ ok: true });
      const events = (await f.events()).map((row) => row.event);
      expect(events.filter((event) => event === "start")).toHaveLength(1);
      expect(events.filter((event) => event === "key")).toHaveLength(1);
      expect(events).toContain("effect");
      expect(events).not.toContain("interrupt");
      expect(events).not.toContain("retiring");
    },
  );

  it("drains matching native input and reports that queued siblings share the generation fence", async () => {
    const f = await fixture();
    const active = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "type_text",
      task,
      args: { text: "fixture" },
    });
    await waitForEvent(f, "dispatch");
    const sibling = { threadId: "other-thread", turnId: "turn" };
    const queued = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      task: sibling,
      args: { key: "enter" },
    });
    await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "generation" },
    });
    await expect(active).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await expect(queued).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        task: sibling,
        args: { key: "enter" },
      }),
    ).resolves.toMatchObject({ ok: true });
    const events = (await f.events()).map((row) => row.event);
    expect(events.indexOf("interrupt-ack")).toBeLessThan(events.indexOf("key"));
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(events).not.toContain("effect");
    expect(events).not.toContain("cancel");
    expect(events).not.toContain("retiring");
  });

  it("cancels only the matching observation without interrupting queued sibling input", async () => {
    const f = await fixture(capability, { delayObservation: true });
    const observation = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_window_state",
      task,
      modelObservation: true,
      args: { pid: 42, window_id: 10 },
    });
    await waitForEvent(f, "observe");
    const sibling = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      task: { threadId: "other-thread", turnId: "turn" },
      args: { key: "enter" },
    });
    await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "task" },
    });
    await expect(observation).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    await expect(sibling).resolves.toMatchObject({ ok: true });
    expect((await f.events()).some((row) => row.event === "interrupt")).toBe(false);
  });

  it("releases a matching permission wait without cancelling AppSnap's shared check", async () => {
    const entered = deferred<void>();
    const pending = deferred<{ accessibility: boolean; screenRecording: boolean }>();
    const f = await fixture(capability, {
      checkPermissions: () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const check = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "check_permissions",
      task,
    });
    await entered.promise;
    await f.host.stopTaskByUser(task);
    await expect(check).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key", args: { key: "enter" } }),
    ).resolves.toMatchObject({ ok: true });
    pending.resolve({ accessibility: true, screenRecording: true });
    expect((await f.events()).some((row) => row.event === "interrupt")).toBe(false);
  });

  it("revokes a task during native startup without retiring the sibling's shared generation", async () => {
    const f = await fixture(capability, { metadataDelayMs: 100 });
    const starting = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      task,
      args: { key: "enter" },
    });
    await waitForEvent(f, "start");
    await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "task" },
    });
    await expect(starting).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key", args: { key: "enter" } }),
    ).resolves.toMatchObject({ ok: true });
    const events = (await f.events()).map((row) => row.event);
    expect(events.filter((event) => event === "key")).toHaveLength(1);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(events).not.toContain("interrupt");
    expect(events).not.toContain("retiring");
  });

  it("keeps native input ownership when a detached launch-preview read finishes", async () => {
    const f = await fixture(capability, {
      delayListWindowsMs: 100,
      frameTap: {
        update: () => {},
        endTask: async () => {},
        stop: async () => {},
        dispose: async () => {},
      },
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task: { threadId: "launching-thread", turnId: "turn" },
      args: { name: "Calculator" },
    });
    await waitForEvent(f, "list-windows");
    const active = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "type_text",
      task,
      args: { text: "fixture" },
    });
    await waitForEvent(f, "dispatch");
    await waitForEvent(f, "list-windows-replied");
    await expect(cuaRequest(f.endpoint, { method: "stop", task })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "generation" },
    });
    await expect(active).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    const events = (await f.events()).map((row) => row.event);
    expect(events).toContain("interrupt-ack");
    expect(events).not.toContain("effect");
    expect(events).not.toContain("retiring");
  });

  it("drains its thread's active native input when Stop omits a turn identity", async () => {
    const f = await fixture();
    const active = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "type_text",
      task,
      args: { text: "fixture" },
    });
    await waitForEvent(f, "dispatch");
    await expect(
      cuaRequest(f.endpoint, { method: "stop", task: { threadId: task.threadId } }),
    ).resolves.toMatchObject({ ok: true, result: { stop_scope: "generation" } });
    await expect(active).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    const events = (await f.events()).map((row) => row.event);
    expect(events).toContain("interrupt-ack");
    expect(events).not.toContain("effect");
    expect(events).not.toContain("retiring");
  });

  it.each(["idle", "queued"] as const)(
    "thread-wide Stop preserves a sibling when its own work is %s",
    async (state) => {
      let activations = 0;
      const f = await fixture(capability, {
        inputDelayMs: 500,
        activateInputMonitor: async () => {
          activations += 1;
        },
      });
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        task,
        args: { pid: 42, window_id: 10 },
      });
      const sibling = cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "type_text",
        task: { threadId: "other-thread", turnId: "turn" },
        args: { text: "fixture" },
      });
      await waitForEvent(f, "dispatch");
      const queued =
        state === "queued"
          ? ["queued-turn", "other-queued-turn"].map((turnId) =>
              cuaRequest<CuaReply>(f.endpoint, {
                method: "call",
                name: "press_key",
                task: { threadId: task.threadId, turnId },
                args: { key: "enter" },
              }),
            )
          : [];
      if (state === "queued") await vi.waitFor(() => expect(activations).toBe(3));
      await expect(
        cuaRequest(f.endpoint, { method: "stop", task: { threadId: task.threadId } }),
      ).resolves.toMatchObject({ ok: true, result: { stop_scope: "task" } });
      for (const call of queued)
        await expect(call).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      await expect(sibling).resolves.toMatchObject({ ok: true });
      await expect(
        cuaRequest(f.endpoint, {
          method: "call",
          name: "press_key",
          task,
          args: { key: "enter" },
        }),
      ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      await expect(
        cuaRequest(f.endpoint, {
          method: "call",
          name: "press_key",
          task: { threadId: task.threadId, turnId: "new-turn-after-stop" },
          args: { key: "enter" },
        }),
      ).resolves.toMatchObject({ ok: true });
      const events = (await f.events()).map((row) => row.event);
      expect(events.filter((event) => event === "key")).toHaveLength(1);
      expect(events).toContain("effect");
      expect(events).not.toContain("interrupt");
      expect(events).not.toContain("retiring");
    },
  );
});

describe("frame tap launch prime", () => {
  const task = { threadId: "thread", turnId: "turn" };
  const calculator = {
    pid: 101,
    window_id: 202,
    app_name: "Calculator",
    title: "Calculator",
    bounds: { x: 0, y: 0, width: 400, height: 600 },
    is_on_screen: true,
  };
  function tapDouble() {
    const updates: Array<unknown> = [];
    return {
      updates,
      host: {
        update: (target: unknown) => {
          updates.push(target);
        },
        endTask: async () => {},
        stop: async () => {},
        dispose: async () => {},
      },
    };
  }
  it("points the tap at the launched app's main window", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, {
      frameTap: tap.host,
      listWindows: [calculator],
    });
    const launched = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { name: "Calculator" },
    });
    expect(launched.ok).toBe(true);
    await vi.waitFor(() => expect(tap.updates).toHaveLength(1));
    expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
  });
  it("matches bundle ids by their tail component", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, {
      frameTap: tap.host,
      listWindows: [calculator],
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { bundle_id: "com.apple.Calculator" },
    });
    await vi.waitFor(() => expect(tap.updates).toHaveLength(1));
    expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
  });
  it("stays quiet when no on-screen window matches", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, {
      frameTap: tap.host,
      listWindows: [calculator],
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { name: "TextEdit" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
  it("skips the prime for ended tasks", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, {
      frameTap: tap.host,
      listWindows: [calculator],
    });
    await cuaRequest(f.endpoint, { method: "end_task", task });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "launch_app",
      task,
      args: { name: "Calculator" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
});

describe("frame tap browser targeting", () => {
  const task = { threadId: "thread", turnId: "turn" };
  function tapDouble() {
    const updates: Array<unknown> = [];
    return {
      updates,
      host: {
        update: (target: unknown) => {
          updates.push(target);
        },
        endTask: async () => {},
        stop: async () => {},
        dispose: async () => {},
      },
    };
  }
  it("points the tap at the window a browser bind call names", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host });
    const bound = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      task,
      args: { pid: 101, window_id: 202 },
    });
    expect(bound.ok).toBe(true);
    await vi.waitFor(() => expect(tap.updates).toHaveLength(1));
    expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
  });
  it("keeps the tap parked on target-id-only browser calls", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host });
    const navigated = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      task,
      args: { target_id: "cua:1:2", tab_id: "tab-1", url: "https://example.test" },
    });
    expect(navigated.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
  it("a refused bind call proves nothing and leaves the tap parked", async () => {
    const tap = tapDouble();
    const f = await fixture(capability, { frameTap: tap.host, browserRefusal: true });
    const refused = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      task,
      args: { pid: 101, window_id: 202 },
    });
    expect(refused.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tap.updates).toEqual([]);
  });
});

describe("per-agent cursor identity", () => {
  const press = (endpoint: string, task?: Record<string, unknown>) =>
    cuaRequest<CuaReply>(endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
      ...(task ? { task } : {}),
    });

  it("parks between actions, hides only the completed turn and preserves its session", async () => {
    const f = await fixture(capability, { logSessions: true, logCursorState: true });
    const first = { threadId: "cursor-thread", turnId: "turn-1" };
    const next = { threadId: "cursor-thread", turnId: "turn-2" };
    await press(f.endpoint, first);
    await press(f.endpoint, next);
    await cuaRequest(f.endpoint, { method: "end_task", task: first });
    expect((await f.events()).map((e) => e.event)).not.toContain(
      "cursor-enabled:false:agent·cursor-thread",
    );
    await cuaRequest(f.endpoint, { method: "end_task", task: next });
    let events = (await f.events()).map((e) => e.event);
    expect(events).toContain("cursor-enabled:false:agent·cursor-thread");
    expect(events.some((e) => e.includes("end_session"))).toBe(false);
    await press(f.endpoint, { ...next, turnId: "turn-3" });
    events = (await f.events()).map((e) => e.event);
    expect(events.filter((e) => e === "cursor-enabled:true:agent·cursor-thread")).toHaveLength(2);
    expect(events.filter((e) => e === "start")).toHaveLength(1);
  });

  it("reads cursor state only on mint/first action and logs no labels or content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = await fixture(capability, { logCursorState: true });
      const task = { threadId: "cursor-thread", turnId: "turn-1", label: "PRIVATE LABEL" };
      await cuaRequest(f.endpoint, { method: "call", name: "get_window_state", args: {}, task });
      await press(f.endpoint, task);
      await press(f.endpoint, task);
      expect((await f.events()).filter((e) => e.event.startsWith("cursor-state:"))).toHaveLength(2);
      const logs = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logs).toContain('"stage":"session-created"');
      expect(logs).toContain('"stage":"first-action"');
      expect(logs).toContain('"overlay_scope":"main_display"');
      expect(logs).not.toContain("PRIVATE LABEL");
      expect(logs).not.toContain('"x":10');
    } finally {
      info.mockRestore();
    }
  });

  it("retries unacknowledged cursor visibility without retrying input", async () => {
    const f = await fixture(capability, {
      logCursorState: true,
      cursorEnableFailures: 1,
      cursorHideFailures: 1,
    });
    const task = { threadId: "cursor-retry", turnId: "turn-1" };
    await press(f.endpoint, task);
    await press(f.endpoint, task);
    await cuaRequest(f.endpoint, { method: "end_task", task });
    await cuaRequest(f.endpoint, { method: "end_task", task });
    await cuaRequest(f.endpoint, { method: "end_task", task });
    const events = (await f.events()).map((e) => e.event);
    expect(events.filter((e) => e === "cursor-enabled:true:agent·cursor-retry")).toHaveLength(2);
    expect(events.filter((e) => e === "cursor-enabled:false:agent·cursor-retry")).toHaveLength(2);
    expect(events.filter((e) => e === "key")).toHaveLength(2);
  });

  it("starts preview and shield cleanup before waiting for the cursor queue", async () => {
    const frameEnded = deferred<void>();
    const shieldEnded = deferred<void>();
    const task = { threadId: "queued-cleanup", turnId: "turn-1" };
    const f = await fixture(capability, {
      inputDelayMs: 300,
      frameTap: {
        update: () => {},
        endTask: async () => {
          frameEnded.resolve();
        },
        stop: async () => {},
        dispose: async () => {},
      },
      shield: {
        engage: async () => {},
        release: async () => {},
        releaseAll: async () => 0,
        endTask: async () => {
          shieldEnded.resolve();
        },
        stop: async () => {},
        dispose: async () => {},
      },
    });
    const action = cuaRequest(f.endpoint, {
      method: "call",
      name: "type_text",
      args: { text: "fixture" },
      task,
    });
    await waitForEvent(f, "dispatch");
    const end = cuaRequest(f.endpoint, { method: "end_task", task });
    await Promise.all([frameEnded.promise, shieldEnded.promise]);
    expect((await f.events()).some((e) => e.event === "effect")).toBe(false);
    await Promise.all([action, end]);
  });

  it("reports a failed cursor query without replaying input or retiring the driver", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = await fixture(capability, { cursorUnavailable: true });
      await expect(press(f.endpoint, { threadId: "cursor-thread" })).resolves.toMatchObject({
        ok: true,
      });
      await expect(press(f.endpoint, { threadId: "cursor-thread" })).resolves.toMatchObject({
        ok: true,
      });
      const events = (await f.events()).map((e) => e.event);
      expect(events.filter((e) => e === "key")).toHaveLength(2);
      expect(events.filter((e) => e === "start")).toHaveLength(1);
      const logs = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logs).toContain('"status":"unavailable"');
      expect(logs).not.toContain("private overlay error");
    } finally {
      info.mockRestore();
    }
  });

  it("logs structured actuator failures with attribution but no raw native message", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = await fixture(capability, {
        actionResult: {
          isError: true,
          content: [{ type: "text", text: "PRIVATE FIELD VALUE" }],
          structuredContent: {
            effect: "dispatched-unknown",
            diagnostics: {
              delivery_path: "ax",
              actuator: "ax_press",
              error_code: "ax_dispatch_failed",
              ax_error: -25204,
              message: "PRIVATE FIELD VALUE",
              title: "PRIVATE WINDOW",
            },
          },
        },
      });
      await press(f.endpoint, { threadId: "failure-thread", turnId: "failure-turn" });
      const logs = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logs).toContain('"event":"computer_action"');
      expect(logs).toContain('"turn":"failure-turn"');
      expect(logs).toContain('"ax_error":-25204');
      expect(logs).toContain("The accessibility actuator reported a native error.");
      expect(logs).not.toContain("PRIVATE FIELD VALUE");
      expect(logs).not.toContain("PRIVATE WINDOW");
    } finally {
      info.mockRestore();
    }
  });

  it("dispatches each task's calls under its own cursor session label", async () => {
    const f = await fixture(capability, { logSessions: true });
    await expect(
      press(f.endpoint, { threadId: "t-1", label: "Research run" }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(press(f.endpoint, { threadId: "t-2", label: "Docs pass" })).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(
      press(f.endpoint, { threadId: "t-1", label: "Research run" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(press(f.endpoint)).resolves.toMatchObject({ ok: true });
    const names = (await f.events()).map((row) => row.event);
    // Each thread's actions ride — and badge — its own session cursor.
    expect(names).toContain("session:agent·Research run·t-1:press_key");
    expect(names).toContain("session:agent·Docs pass·t-2:press_key");
    // The shared generation session still backs unattributed calls.
    expect(
      names.some((event) => event.startsWith("session:synara-") && event.endsWith(":press_key")),
    ).toBe(true);
    // Task sessions mint lazily on dispatch: the only explicit start_session
    // is the generation's own bootstrap one — no extra round trip per label.
    expect(names.filter((event) => event.startsWith("open_session:start_session:"))).toEqual([
      expect.stringMatching(/^open_session:start_session:synara-[0-9a-f-]+$/),
    ]);
  });

  it("keeps cursors distinct when two threads share one display label", async () => {
    // The badge text is the session string itself, so the label alone cannot
    // key the cursor — two agents named "Research run" must still get their
    // own cursors and badge tints via the embedded thread id.
    const f = await fixture(capability, { logSessions: true });
    await expect(
      press(f.endpoint, { threadId: "t-1", label: "Research run" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      press(f.endpoint, { threadId: "t-2", label: "Research run" }),
    ).resolves.toMatchObject({ ok: true });
    const names = (await f.events()).map((row) => row.event);
    expect(names).toContain("session:agent·Research run·t-1:press_key");
    expect(names).toContain("session:agent·Research run·t-2:press_key");
  });

  it("falls back to the thread id when a task carries no display label", async () => {
    const f = await fixture(capability, { logSessions: true });
    await expect(press(f.endpoint, { threadId: "t-9" })).resolves.toMatchObject({ ok: true });
    expect((await f.events()).map((row) => row.event)).toContain("session:agent·t-9:press_key");
  });

  it("sanitizes badge-breaking characters out of the minted label", async () => {
    const f = await fixture(capability, { logSessions: true });
    await expect(
      press(f.endpoint, {
        threadId: "t-1",
        label: "Res\u0000earch\nrun\u200B",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).map((row) => row.event)).toContain(
      "session:agent·Researchrun·t-1:press_key",
    );
  });

  it("a caller session arg can never override the minted agent label", async () => {
    const f = await fixture(capability, { logSessions: true });
    await expect(
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        task: { threadId: "t-1", label: "Research run" },
        args: { key: "enter", session: "forged" },
      }),
    ).resolves.toMatchObject({ ok: true });
    const names = (await f.events()).map((row) => row.event);
    expect(names.some((event) => event.startsWith("session:forged"))).toBe(false);
    expect(names).toContain("session:agent·Research run·t-1:press_key");
  });

  it("revives an ended task session in place instead of retiring the generation", async () => {
    // A task-scoped label can die on driver idle expiry while the generation
    // stays healthy: the heal is a start_session revival on the same label,
    // not a new driver process the way a shared-session death forces.
    const f = await fixture(capability, {
      sessionDeathOnce: true,
      logSessions: true,
    });
    const task = { threadId: "t-1", label: "Research run" };
    const reply = await press(f.endpoint, task);
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).not.toBe(true);
    const events = (await f.events()).map((row) => row.event);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(events).toContain("open_session:start_session:agent·Research run·t-1");
    expect(events.filter((event) => event === "key")).toHaveLength(1);
    expect(events).toContain("session:agent·Research run·t-1:press_key");
  });
});
