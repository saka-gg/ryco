// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { CuaDriverHost } from "./cuaDriverHost.ts";
import { cuaHostProcessIsAlive } from "./cuaRuntimeOwnership.ts";
import type { ComputerInputMonitorState } from "./escapeKillSwitchMonitor.ts";
import {
  cuaRequest as rawCuaRequest,
  CUA_NATIVE_REVISION,
  type CuaReply,
} from "@ryco/shared/cuaDriverProtocol";
import {
  capability,
  cleanupFixtures,
  cuaRequest,
  deferred,
  fixture,
  waitForEvent,
} from "./cuaDriverHost.fixtures.ts";

afterEach(cleanupFixtures);

describe("Cua macOS host retirement", () => {
  it("starts the compact cursor once per generation and owns the observation budget", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) {
      const reply = await cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
      });
      expect(reply.ok).toBe(true);
      expect(reply.hostPlatform).toBe("darwin");
    }
    const events = (await f.events()).map((row) => row.event);
    expect(events.filter((event) => event === "motion-100-0")).toHaveLength(1);
    expect(events.filter((event) => event === "observation-budget-100")).toHaveLength(2);
  });

  it.each(["stop", "suspend", "pauseDesktop"] as const)(
    "%s does not wait for another feature's permission dialog",
    async (method) => {
      const entered = deferred<void>();
      const pending = deferred<{
        accessibility: boolean;
        screenRecording: boolean;
      }>();
      const f = await fixture(capability, {
        checkPermissions: () => {
          entered.resolve();
          return pending.promise;
        },
      });
      const check = cuaRequest(f.endpoint, {
        method: "call",
        name: "check_permissions",
      });
      await entered.promise;
      await f.host[method]("screen-lock");
      await expect(check).resolves.toMatchObject({
        ok: false,
        effect: "not-dispatched",
      });
      // Releasing this Computer wait does not cancel the shared request.
      pending.resolve({ accessibility: true, screenRecording: true });
      await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    },
    2_000,
  );

  it("releases a disconnected permission check without retiring a later native session", async () => {
    const entered = deferred<void>();
    const pending = deferred<{
      accessibility: boolean;
      screenRecording: boolean;
    }>();
    const f = await fixture(capability, {
      checkPermissions: () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const controller = new AbortController();
    const check = cuaRequest(
      f.endpoint,
      { method: "call", name: "check_permissions" },
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    await check;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_screen_size" }, { timeoutMs: 2_000 }),
    ).resolves.toMatchObject({ ok: true });
    pending.resolve({ accessibility: true, screenRecording: true });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("checks permissions through the fresh shared helper without starting Cua or requesting grants", async () => {
    let permissions = { accessibility: false, screenRecording: false };
    const f = await fixture(capability, {
      checkPermissions: async () => permissions,
    });
    const check = () =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "check_permissions",
        args: { prompt: true },
      });
    await expect(check()).resolves.toMatchObject({
      result: {
        structuredContent: {
          accessibility: false,
          screen_recording: false,
          source: {
            attribution: "host",
            host_bundle_id: "fixture",
            probe: "appsnap-permission-helper",
          },
        },
      },
    });
    permissions = { accessibility: true, screenRecording: true };
    await expect(check()).resolves.toMatchObject({
      result: {
        structuredContent: { accessibility: true, screen_recording: true },
      },
    });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an uncached confirming read before accepting a changed permission snapshot", async () => {
    let granted = false;
    const checks: boolean[] = [];
    const f = await fixture(capability, {
      checkPermissions: async (options) => {
        checks.push(options?.force === true);
        return { accessibility: granted, screenRecording: granted };
      },
    });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    granted = true;
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    expect(checks).toEqual([false, false, true]);
  });

  it("retires a cached native process once when grants change, then requires fresh observation", async () => {
    let granted = true;
    const f = await fixture(capability, {
      checkPermissions: async () => ({
        accessibility: granted,
        screenRecording: granted,
      }),
    });
    const check = () => cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await check();
    await cuaRequest(f.endpoint, { method: "call", name: "get_screen_size" });
    granted = false;
    await expect(check()).resolves.toMatchObject({
      desktopEpoch: 1,
      result: { structuredContent: { accessibility: false } },
    });
    expect((await f.events()).filter((event) => event.event === "cleanup-ack")).toHaveLength(1);
    await check();
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    granted = true;
    await check();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });

  it("does not bypass failed cleanup when refreshed permissions change", async () => {
    let granted = true;
    const f = await fixture(capability, {
      cleanup: "incomplete",
      checkPermissions: async () => ({
        accessibility: granted,
        screenRecording: granted,
      }),
    });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await cuaRequest(f.endpoint, { method: "call", name: "get_screen_size" });
    // A dispatched action makes this generation's input state unprovable, so
    // the failed cleanup must keep the driver alive and admission closed.
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    granted = false;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });
  it("does not start while locked and requires fresh state after all desktop pauses end", async () => {
    const f = await fixture();
    await f.host.pauseDesktop("screen-lock");
    await f.host.pauseDesktop("system-sleep");
    f.host.resume(); // A backend restart cannot unlock the desktop.
    const press = () => cuaRequest(f.endpoint, { method: "call", name: "press_key" });
    await expect(press()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: "computer_input_paused", effect: "refused" },
      },
    });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    f.host.resumeDesktop("screen-lock");
    await expect(press()).resolves.toMatchObject({ result: { isError: true } });
    f.host.resumeDesktop("system-sleep");
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await expect(press()).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
      args: { pid: 1, window_id: 2 },
    });
    await expect(press()).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("lets a task open an app after unlock, before it has anything to observe", async () => {
    // "Open Calculator" after sleep: the app has no window yet, so requiring a
    // fresh look first would leave the task nothing it could observe.
    const f = await fixture();
    await f.host.pauseDesktop("screen-lock");
    const launch = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "launch_app",
        args: { name: "Calculator" },
      });
    await expect(launch()).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    f.host.resumeDesktop("screen-lock");
    const launched = await launch();
    expect(launched.ok).toBe(true);
    expect(launched.result?.structuredContent?.code).toBeUndefined();
    // Acting on something on screen still needs the fresh look.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({
      result: { structuredContent: { code: "computer_input_paused" } },
    });
  });

  it("piggybacks sorted pauses and the never-reset interruption count on every reply", async () => {
    const f = await fixture();
    const probe = () => cuaRequest<CuaReply>(f.endpoint, { method: "probe" });
    await expect(probe()).resolves.toMatchObject({
      desktopEpoch: 0,
      desktopPauses: [],
      desktopInterruptions: 0,
    });
    await f.host.pauseDesktop("system-sleep");
    await f.host.pauseDesktop("screen-lock");
    const paused = await probe();
    expect(paused.desktopPauses).toEqual(["screen-lock", "system-sleep"]);
    expect(paused.desktopInterruptions).toBe(2);
    // Refusals carry the same state: a paused action reports the reasons and
    // the count alongside its computer_input_paused result.
    await expect(
      cuaRequest<CuaReply>(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({
      desktopPauses: ["screen-lock", "system-sleep"],
      desktopInterruptions: 2,
      result: { structuredContent: { code: "computer_input_paused" } },
    });
    // The reasons net back to empty on resume while the count keeps the
    // proof that the interruption cycle ran.
    f.host.resumeDesktop("screen-lock");
    await expect(probe()).resolves.toMatchObject({
      desktopPauses: ["system-sleep"],
      desktopInterruptions: 2,
    });
    f.host.resumeDesktop("system-sleep");
    await expect(probe()).resolves.toMatchObject({
      desktopPauses: [],
      desktopInterruptions: 2,
    });
  });

  it("retires a driver-ended session and retries once with a fresh one", async () => {
    // The driver can end a session the host still holds (restart, timeout).
    // Without a heal, every later call fails the same way and no model-side
    // retry can recover. The driver confirms nothing dispatched, so one
    // retire-plus-retry is replay-safe.
    const f = await fixture(capability, { sessionDeathOnce: true });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).not.toBe(true);
    const events = await f.events();
    // The dead generation retired (new driver process) and the key reached
    // the fresh session exactly once.
    expect(events.filter((event) => event.event === "start")).toHaveLength(2);
    expect(events.filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("retires a transport-reported session death and retries once fresh", async () => {
    // The live driver surfaced session death as an ok:false reply rather than
    // an isError result: undetected, every later call died on the same id.
    const f = await fixture(capability, { sessionDeathTransport: true });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).not.toBe(true);
    const events = await f.events();
    expect(events.filter((event) => event.event === "start")).toHaveLength(2);
    expect(events.filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("locking cancels active native input and rejects waiting input before dispatch", async () => {
    const f = await fixture();
    const active = cuaRequest(f.endpoint, {
      method: "call",
      name: "type_text",
      args: { text: "fixture" },
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await f.events().catch(() => [])).some((event) => event.event === "dispatch")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(true);
    const queued = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "press_key",
    });
    await f.host.pauseDesktop("screen-lock");
    expect(await active).toMatchObject({ ok: false });
    const queuedReply = await queued;
    expect(queuedReply.ok === false || queuedReply.result?.isError === true).toBe(true);
    const events = await f.events();
    expect(events.some((event) => event.event === "cleanup-ack")).toBe(true);
    expect(events.some((event) => event.event === "effect" || event.event === "key")).toBe(false);
  });

  it("unlock does not bypass an unacknowledged cleanup barrier", async () => {
    const f = await fixture(capability, { cleanup: "incomplete" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    await expect(f.host.pauseDesktop("screen-lock")).rejects.toThrow(
      "did not confirm native input cleanup",
    );
    f.host.resumeDesktop("screen-lock");
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_window_state" }),
    ).resolves.toMatchObject({ ok: false });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("preview and readiness reads cannot release the post-unlock model observation gate", async () => {
    const f = await fixture();
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    const press = () => cuaRequest(f.endpoint, { method: "call", name: "press_key" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "get_desktop_state" }),
    ).resolves.toMatchObject({ ok: true, desktopEpoch: 1 });
    await cuaRequest(f.endpoint, { method: "call", name: "get_window_state" });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
      args: { empty: true },
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_input_ready" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    await expect(press()).resolves.toMatchObject({ result: { isError: true } });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_window_state",
      modelObservation: true,
    });
    await expect(press()).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("a disconnected observation cannot release the post-unlock gate", async () => {
    const f = await fixture(capability, { delayObservation: true });
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    const controller = new AbortController();
    const observation = cuaRequest(
      f.endpoint,
      {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
      },
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    await waitForEvent(f, "observe");
    controller.abort();
    expect(await observation).toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ result: { isError: true } });
    expect((await f.events()).some((event) => event.event === "key")).toBe(false);
  });

  it("ignores a permission probe that reverts on the confirming re-read", async () => {
    // The AppSnap helper can read TCC mid-transition and report a grant that
    // the next probe reverts. Arming the gate on that phantom read deadlocked
    // production: every action runs check_permissions first via refresh(), so
    // the helper re-armed the gate after each observation cleared it.
    let probes = 0;
    const f = await fixture(capability, {
      checkPermissions: async () => {
        probes += 1;
        return { accessibility: true, screenRecording: probes !== 2 };
      },
    });
    const check = () => cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await expect(check()).resolves.toMatchObject({ desktopEpoch: 0 });
    await expect(check()).resolves.toMatchObject({
      desktopEpoch: 0,
      result: { structuredContent: { screen_recording: true } },
    });
    expect(probes).toBe(3);
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("a flapping permission helper cannot deadlock input behind the observation gate", async () => {
    let probes = 0;
    const f = await fixture(capability, {
      checkPermissions: async () => {
        probes += 1;
        return { accessibility: true, screenRecording: probes % 2 === 1 };
      },
    });
    const check = () => cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    const observe = () =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
        args: { pid: 1, window_id: 2 },
      });
    await check();
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    for (let i = 0; i < 3; i += 1) {
      await observe();
      await check();
      await expect(
        cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it("refuses an observation a stop interrupted instead of silently voiding the clear", async () => {
    const f = await fixture(capability, { delayObservation: true });
    await f.host.pauseDesktop("screen-lock");
    f.host.resumeDesktop("screen-lock");
    const observe = () =>
      cuaRequest(f.endpoint, {
        method: "call",
        name: "get_window_state",
        modelObservation: true,
        args: { pid: 1, window_id: 2 },
      });
    const interrupted = observe();
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await f.events().catch(() => [])).some((event) => event.event === "observe")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // stopInput (turn Stop/revokeControl) used to bump only the input epoch:
    // the in-flight image still returned while its gate clear was skipped.
    await cuaRequest(f.endpoint, { method: "stop" });
    await expect(interrupted).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: "computer_input_paused" },
      },
    });
    await observe();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("preserves multibyte UTF-8 across incoming socket chunks", async () => {
    const authority = capability + "-è🧪";
    const f = await fixture(authority);
    const request = Buffer.from(JSON.stringify({ method: "probe", capability: authority }) + "\n");
    const split = request.indexOf(Buffer.from("🧪")) + 1;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(f.endpoint);
      let result = "";
      socket.setTimeout(2_000, () => socket.destroy(new Error("Fixture socket timed out.")));
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        result += chunk.toString("utf8");
      });
      socket.once("end", () => resolve(result));
      socket.once("connect", () => {
        socket.write(request.subarray(0, split));
        setTimeout(() => socket.write(request.subarray(split)), 30);
      });
    });
    expect(JSON.parse(reply)).toMatchObject({ ok: true });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires GUI authority even when a provider discovers the socket", async () => {
    const f = await fixture();
    await expect(
      rawCuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("releases uncertain input before termination and waits for exit before replacement", async () => {
    const f = await fixture();
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "check_permissions",
      args: {},
    });
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 120, mutation: true },
      ),
    ).rejects.toMatchObject({ effect: "dispatched-unknown" });
    await f.host.stop();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "check_permissions",
        args: {},
      }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    const exit = events.find((e) => e.event === "exit" && e.pid === starts[0].pid);
    expect(exit).toBeDefined();
    expect(starts[1].time).toBeGreaterThanOrEqual(exit.time);
    expect(events.some((e) => e.event === "effect")).toBe(false);
    expect(events.filter((e) => e.event === "dispatch")).toHaveLength(1);
    const first = events.filter((e) => e.pid === starts[0].pid).map((e) => e.event);
    expect(first).toEqual([
      "start",
      "motion-100-0",
      "dispatch",
      "cancel",
      "release",
      "cleanup-ack",
      "retiring",
      "exit",
    ]);
  });
  it("releases held input through the helper when the driver dies mid-action", async () => {
    let releaseCalls = 0;
    const released = async () => {
      releaseCalls += 1;
    };
    const f = await fixture(capability, {
      crash: true,
      releaseHeldInput: released,
    });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    // The fake driver exits on dispatch, so the call's retire runs the
    // OS-level release before the request reports its failure.
    await expect(
      cuaRequest(
        f.endpoint,
        { method: "call", name: "type_text", args: { text: "fixture" } },
        { timeoutMs: 300, mutation: true },
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(releaseCalls).toBe(1);
    // A confirmed release makes the desktop provably clean: the dead
    // generation clears, so the next request spawns a replacement instead of
    // poisoning admission for the host's lifetime.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });
  it("keeps admission closed for the host's lifetime when held-input release fails", async () => {
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
    // Without a confirmed release the held state is unprovable — no
    // replacement generation may spawn over it, now or later.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    await expect(f.host.stop()).rejects.toThrow("admission is closed");
  });
  it("replaces a driver that wedges during startup instead of closing admission", async () => {
    const f = await fixture(capability, {
      hangSession: true,
      dropCancel: true,
      startupTimeoutMs: 150,
    });
    // The wedged startup call is bounded by the startup timeout; its
    // retirement cannot confirm cleanup (the socket drops mid-request), but
    // no action ever reached this generation so nothing can be held.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    // Terminating the provably input-free generation clears it, so the next
    // request spawns a fresh driver instead of failing closed forever.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((event) => event.event === "start");
    expect(starts).toHaveLength(2);
    expect(events.filter((e) => e.pid === starts[0].pid).map((e) => e.event)).toEqual([
      "start",
      "session-hang",
      "cancel",
      "retiring",
      "exit",
    ]);
  });
  it("rejects later backend requests throughout suspension and resumes only on explicit restart", async () => {
    const f = await fixture();
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    const stopping = f.host.suspend();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "must not arrive" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "not-dispatched",
      error: expect.stringContaining("suspended"),
    });
    await stopping;
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(false);
    f.host.resume();
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    const starts = events.filter((event) => event.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1].time).toBeGreaterThanOrEqual(
      events.find((event) => event.event === "exit" && event.pid === starts[0].pid).time,
    );
  });
  it("does not let resume bypass failed cleanup during backend suspension", async () => {
    const f = await fixture(capability, { cleanup: "incomplete" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "press_key",
      args: { key: "enter" },
    });
    await expect(f.host.suspend()).rejects.toThrow("did not confirm native input cleanup");
    f.host.resume();
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "must not arrive" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    expect((await f.events()).some((event) => event.event === "dispatch")).toBe(false);
  });
  it.each(["incomplete", "wrong-pid", "missing-admission"] as const)(
    "keeps the process alive and blocks replacement after %s cleanup",
    async (cleanup) => {
      const f = await fixture(capability, { cleanup });
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "check_permissions",
      });
      // An input-dispatched generation can hold OS state the acknowledgement
      // cannot account for, so the driver stays alive and unreplaced.
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
      });
      await expect(f.host.stop()).rejects.toThrow("did not confirm native input cleanup");
      await expect(
        cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
      ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
      const events = await f.events();
      expect(events.map((e) => e.event)).toEqual([
        "start",
        "motion-100-0",
        "key",
        "observation-budget-100",
        "cancel",
        "cleanup-ack",
      ]);
      expect(() => process.kill(events[0].pid, 0)).not.toThrow();
    },
  );
  it("preserves an uncertain action effect when cleanup also fails", async () => {
    const f = await fixture(capability, {
      cleanup: "incomplete",
      failAction: true,
    });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "fixture" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      effect: "dispatched-unknown",
      error: expect.stringContaining("did not confirm native input cleanup"),
    });
    expect((await f.events()).some((e) => e.event === "retiring")).toBe(false);
  });
  it("blocks replacement when a driver crashes during input", async () => {
    const f = await fixture(capability, { crash: true });
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "fixture" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((e) => e.event === "start")).toHaveLength(1);
  });
  it("rejects an upstream binary before native input is admitted", async () => {
    const f = await fixture(capability, { unpatched: true });
    // The default host still expects the patched build, so it passes the
    // Synara cursor flags — a faithful upstream binary exits on arguments it
    // cannot parse, which refuses the call before any input is dispatched.
    // Even a binary that tolerated them would fail the revision handshake.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "type_text",
        args: { text: "fixture" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).map((e) => e.event)).toEqual(["start"]);
  });
  it("drives an unpatched upstream binary when nativeRevision is null", async () => {
    const f = await fixture(capability, {
      unpatched: true,
      nativeRevision: null,
    });
    // The upstream spawn omits the Synara cursor flags (the fake would exit
    // on them), the handshake accepts the absent revision field, and replies
    // report the observed driver as unpatched — the backend's cue to narrow
    // advertised capabilities.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "list_windows",
        args: {},
        capability,
      }),
    ).resolves.toMatchObject({ ok: true, driverNativeRevision: 0 });
    expect((await f.events()).map((e) => e.event)).toEqual([
      "start",
      "motion-100-0",
      "list-windows",
    ]);
  });
  it("refuses unlisted driver operations before starting a daemon", async () => {
    const f = await fixture();
    const response = await cuaRequest<{ ok: boolean }>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: { url: "https://example.com" },
    });
    expect(response.ok).toBe(false);
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("admits wait_for_settle as a read through the allowlist", async () => {
    const f = await fixture();
    // The fixture driver answers any listed name {}; the allowlist is what a
    // refused name would have failed inside the host before ever spawning.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "wait_for_settle",
        args: { pid: 42, window_id: 10, timeout_ms: 5_000, quiet_ms: 1_000 },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).some((event) => event.event === "start")).toBe(true);
  });
});

describe("driver warm-up on first touch", () => {
  const FLAG = "SYNARA_CUA_WARM_ON_FIRST_TOUCH";
  let savedFlag: string | undefined;
  let captured = false;

  const setFlag = (value: string | undefined) => {
    if (!captured) {
      captured = true;
      savedFlag = process.env[FLAG];
    }
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
  };

  afterEach(() => {
    if (captured) {
      if (savedFlag === undefined) delete process.env[FLAG];
      else process.env[FLAG] = savedFlag;
      captured = false;
      savedFlag = undefined;
    }
    vi.restoreAllMocks();
  });

  it.each([undefined, "0", "off"])("leaves the driver cold when the flag is %s", async (value) => {
    setFlag(value);
    const f = await fixture(capability, {
      checkPermissions: async () => ({
        accessibility: true,
        screenRecording: true,
      }),
    });
    await expect(cuaRequest(f.endpoint, { method: "probe" })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "check_permissions" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("warms spawn and handshake on the first probe without opening a session", async () => {
    setFlag("1");
    const f = await fixture();
    await expect(cuaRequest(f.endpoint, { method: "probe" })).resolves.toMatchObject({
      ok: true,
    });
    const warmed = await waitForEvent(f, "start");
    expect(warmed.filter((event) => event.event === "start")).toHaveLength(1);
    // Warm stops at the validated handshake on purpose: session setup — the
    // fixture's motion event — never reaches the driver before real work.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await f.events()).some((event) => event.event === "motion-100-0")).toBe(false);
    // The first real call reuses the warmed generation: no second spawn, and
    // the once-per-generation cursor setup runs exactly once now.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
      }),
    ).resolves.toMatchObject({ ok: true });
    const events = await f.events();
    expect(events.filter((event) => event.event === "start")).toHaveLength(1);
    expect(events.filter((event) => event.event === "motion-100-0")).toHaveLength(1);
    expect(events.filter((event) => event.event === "key")).toHaveLength(1);
  });

  it("does not prewarm a macOS driver before the first real permission grants", async () => {
    setFlag("1");
    let granted = false;
    const f = await fixture(capability, {
      checkPermissions: async () => ({ accessibility: granted, screenRecording: granted }),
    });
    await cuaRequest(f.endpoint, { method: "probe" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    granted = true;
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    expect(
      (await waitForEvent(f, "start")).filter((event) => event.event === "start"),
    ).toHaveLength(1);
  });

  it("warms on a permission check too, and only once per host lifetime", async () => {
    setFlag("yes");
    const f = await fixture(capability, {
      checkPermissions: async () => ({
        accessibility: true,
        screenRecording: true,
      }),
    });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await waitForEvent(f, "start");
    // Later first-touch requests do not spawn again — warm is once-only even
    // while it is still in flight.
    await cuaRequest(f.endpoint, { method: "probe" });
    await cuaRequest(f.endpoint, { method: "call", name: "check_permissions" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    // A stop retires the warmed generation; the next probe must not conjure a
    // replacement — warm ran its once.
    await f.host.stop();
    await cuaRequest(f.endpoint, { method: "probe" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(1);
    // Real work still starts a driver on demand, paying the cold start then.
    await expect(
      cuaRequest(f.endpoint, { method: "call", name: "press_key" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });

  it("does not treat housekeeping requests as first touches", async () => {
    setFlag("1");
    const f = await fixture();
    await cuaRequest(f.endpoint, {
      method: "end_task",
      task: { threadId: "thread", turnId: "turn" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logs a failed warm and leaves the first real call's own startup intact", async () => {
    setFlag("1");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = await fixture(capability, { unpatched: true });
    await expect(cuaRequest(f.endpoint, { method: "probe" })).resolves.toMatchObject({
      ok: true,
    });
    const events = await waitForEvent(f, "start");
    const pid = events.find((event) => event.event === "start")!.pid;
    // This deliberately incompatible fixture exits before installing its
    // graceful-exit logger. Verify process death instead of waiting for a
    // log event that can never be emitted on this startup-failure path.
    await vi.waitFor(() => expect(cuaHostProcessIsAlive(pid)).toBe(false));
    await vi.waitFor(() =>
      expect(
        info.mock.calls.some((call) => String(call[0]).includes("driver warm-up failed")),
      ).toBe(true),
    );
    // The warm failure retired its generation cleanly; the real call spawns
    // again and fails on the same handshake, not on anything warm poisoned.
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
      }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect((await f.events()).filter((event) => event.event === "start")).toHaveLength(2);
  });
});

describe("browser surface", () => {
  const task = { threadId: "thread", turnId: "turn" };
  it("attributes browser calls to a per-thread lifecycle session under the control transport", async () => {
    const f = await fixture();
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      task,
      args: { url: "https://example.com" },
    });
    expect(reply.ok).toBe(true);
    const events = (await f.events()).map((row) => row.event);
    // The first browser call opened the persistent control connection; the
    // dispatch then rode the thread's lifecycle label under that transport id.
    expect(events.some((event) => event.startsWith("session-begin:synara-transport-"))).toBe(true);
    expect(
      events.some((event) =>
        event.startsWith("browser:browser_navigate:synara-browser-thread:synara-transport-"),
      ),
    ).toBe(true);
    // A caller-supplied session can never override the minted label.
    const forged = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_click",
      task,
      args: { target_id: "t", tab_id: "tab", ref: "p1:0", session: "forged" },
    });
    expect(forged.ok).toBe(true);
    expect(
      (await f.events()).some((row) =>
        String(row.event).startsWith("browser:browser_click:forged"),
      ),
    ).toBe(false);
    expect(
      (await f.events()).some((row) =>
        String(row.event).startsWith(
          "browser:browser_click:synara-browser-thread:synara-transport-",
        ),
      ),
    ).toBe(true);
  });
  it("refuses browser calls without task attribution before starting a daemon", async () => {
    const f = await fixture();
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: { url: "https://example.com" },
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("task attribution");
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("ends the thread's browser session on end_browser_thread and revives it on the next call", async () => {
    const f = await fixture();
    const click = () =>
      cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "browser_click",
        task,
        args: { target_id: "t", tab_id: "tab", ref: "p1:0" },
      });
    await expect(click()).resolves.toMatchObject({ ok: true });
    await expect(
      cuaRequest(f.endpoint, { method: "end_browser_thread", task }),
    ).resolves.toMatchObject({ ok: true });
    await expect(click()).resolves.toMatchObject({ ok: true });
    const lifecycle = (await f.events())
      .map((row) => row.event)
      .filter(
        (event) =>
          event.startsWith("browser:") ||
          event.startsWith("start_session:") ||
          event.startsWith("end_session:"),
      );
    expect(lifecycle).toEqual([
      expect.stringMatching(/^browser:browser_click:synara-browser-thread:/),
      expect.stringMatching(/^end_session:synara-browser-thread:synara-transport-/),
      expect.stringMatching(/^start_session:synara-browser-thread:synara-transport-/),
      expect.stringMatching(/^browser:browser_click:synara-browser-thread:/),
    ]);
  });
  it("keeps end_browser_thread a no-op for a thread that never used the browser", async () => {
    const f = await fixture();
    await expect(
      cuaRequest(f.endpoint, { method: "end_browser_thread", task }),
    ).resolves.toMatchObject({ ok: true });
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a browser bind that names one of this app's own pids", async () => {
    const f = await fixture(capability, { ownPids: () => new Set([424242]) });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      task,
      args: { pid: 424242, window_id: 20 },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.structuredContent).toMatchObject({
      effect: "refused",
      code: "browser_self_target",
    });
    // The refusal is decided at admission: no daemon ever started.
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
    // An unrelated pid still dispatches normally.
    const other = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      task,
      args: { pid: 777, window_id: 20 },
    });
    expect(other.ok).toBe(true);
    expect(
      (await f.events()).some((row) => String(row.event).startsWith("browser:get_browser_state:")),
    ).toBe(true);
  });
});

describe("verified Linux browser input capability", () => {
  const task = { threadId: "linux-browser", turnId: "turn" };
  async function linuxFixture(options: Parameters<typeof fixture>[1] = {}) {
    return fixture(capability, {
      platform: "linux",
      unpatched: true,
      nativeRevision: null,
      reportedRevision: CUA_NATIVE_REVISION,
      browserInputControl: 1,
      inputMonitorState: () => ({ ready: true }),
      ...options,
    });
  }

  it.each([
    { browserInputControl: undefined },
    { browserInputControl: true },
    { browserInputControl: "1" },
    { reportedRevision: CUA_NATIVE_REVISION - 1 },
  ])("refuses browser input with an unverified child capability %j", async (options) => {
    const f = await linuxFixture(options);
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: { synara_browser_input_control: 1, browserInputControlVerified: true },
      browserInputControlVerified: true,
      task,
    });
    expect(reply).toMatchObject({
      hostPlatform: "linux",
      driverBrowserInputControl: false,
      result: { structuredContent: { code: "linux_browser_cleanup_unavailable" } },
    });
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
  });

  it("requires the embedded metadata PID to match the child before trusting its marker", async () => {
    const f = await linuxFixture({ metadataPidOffset: 1 });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    });
    expect(reply).toMatchObject({
      ok: false,
      effect: "not-dispatched",
      driverBrowserInputControl: false,
    });
    expect(reply.error).toContain("handshake failed");
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
  });

  it("carries verified epochs and native browser drain across disconnect without a cold restart", async () => {
    const f = await linuxFixture({ browserHang: true, inputDelayMs: 150 });
    const controller = new AbortController();
    const call = cuaRequest(
      f.endpoint,
      { method: "call", name: "browser_type", args: { text: "fixture" }, task },
      { mutation: true, signal: controller.signal },
    ).catch((error: unknown) => error);
    await waitForEvent(f, "browser-dispatch");
    controller.abort();
    expect(await call).toMatchObject({ effect: "dispatched-unknown" });
    await waitForEvent(f, "interrupt");
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    });
    expect(reply.driverBrowserInputControl).toBe(true);
    expect(reply.result).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 180));
    const events = (await f.events()).map((event) => event.event);
    expect(events.filter((event) => event === "release")).toHaveLength(1);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(
      events.findIndex((event) => event.startsWith("browser:browser_navigate:")),
    ).toBeGreaterThan(events.indexOf("interrupt-ack"));
    expect(events).not.toContain("browser-effect");
    await expect(
      cuaRequest(f.endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter" },
        deliveryMode: "foreground",
        task,
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { code: "linux_input_cleanup_unavailable" } },
    });
    expect((await f.events()).some((event) => event.event === "key")).toBe(false);
  });

  it("does not dispatch a cold browser call stopped while its capability handshake is pending", async () => {
    const f = await linuxFixture({ metadataDelayMs: 100 });
    const call = cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    }).catch((error: unknown) => error);
    await waitForEvent(f, "start");
    await cuaRequest(f.endpoint, { method: "stop" });
    await expect(call).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
  });

  it.each(["clipboard_read", "clipboard_write", "kill_app", "move_cursor"])(
    "preserves the trusted epoch envelope for admitted Linux %s without opening synthetic input",
    async (name) => {
      const f = await linuxFixture();
      const request = { method: "call", name, args: {}, task };
      expect((await cuaRequest<CuaReply>(f.endpoint, request)).result).toEqual({});
      await cuaRequest(f.endpoint, { method: "stop" });
      expect((await cuaRequest<CuaReply>(f.endpoint, request)).result).toEqual({});
      expect(
        (await f.events()).filter((event) => event.event === `permitted-native:${name}`),
      ).toHaveLength(2);
    },
  );

  it("does not spawn or expose the browser marker to an unauthenticated caller", async () => {
    const f = await linuxFixture();
    const reply = await rawCuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
      capability: "not-authorized",
    });
    expect(reply).toMatchObject({
      ok: false,
      effect: "not-dispatched",
      driverBrowserInputControl: false,
    });
    expect(reply.error).toContain("authority");
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["missing", undefined],
    ["unavailable", () => ({ ready: false, error: "linux_global_escape_unavailable" })],
  ] as const)(
    "refuses browser mutations with a %s Linux Escape listener while retaining reads",
    async (_label, inputMonitorState) => {
      const f = await linuxFixture({ inputMonitorState });
      const call = (name: string, args: Record<string, unknown>) =>
        cuaRequest<CuaReply>(f.endpoint, { method: "call", name, args, task });
      const denied = await call("browser_navigate", {});
      expect(denied).toMatchObject({
        driverBrowserInputControl: true,
        result: { structuredContent: { code: "input_monitor_unavailable" } },
      });
      expect((await call("get_browser_state", {})).result).toEqual({});
      expect((await call("browser_dialog", { action: "inspect" })).result).toEqual({});
      expect((await call("browser_prepare", { pid: 700, allow_launch: false })).result).toEqual({});
      expect(
        (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
      ).toBe(false);
    },
  );

  it("reports the Linux Escape diagnosis when listener activation itself fences input", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
    let host: CuaDriverHost;
    const f = await linuxFixture({
      inputMonitorState: () => state,
      activateInputMonitor: async () => {
        state = { ready: false, error: "linux_escape_portal_unverified" };
        host.inputMonitorStateChanged(state);
      },
    });
    host = f.host;
    // Reproduce the real startup order: passive discovery has already warmed
    // the driver, so a failed listener activation invalidates its input epoch.
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: {},
      task,
    });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_prepare",
      args: { allow_launch: true, windowed: false },
      task,
    });
    expect(reply).toMatchObject({
      ok: true,
      result: {
        isError: true,
        structuredContent: {
          effect: "refused",
          code: "input_monitor_unavailable",
          input_monitor_error: "linux_escape_portal_unverified",
        },
      },
    });
    await waitForEvent(f, "interrupt-ack");
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_prepare:")),
    ).toBe(false);
  });

  it.each(["before", "after"] as const)(
    "preserves a real Stop %s listener failure while activation is pending",
    async (stopOrder) => {
      let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
      const activationStarted = deferred<void>();
      const activationFinished = deferred<void>();
      const f = await linuxFixture({
        inputMonitorState: () => state,
        activateInputMonitor: async () => {
          activationStarted.resolve();
          await activationFinished.promise;
        },
      });
      await cuaRequest(f.endpoint, {
        method: "call",
        name: "get_browser_state",
        args: {},
        task,
      });
      const call = cuaRequest<CuaReply>(f.endpoint, {
        method: "call",
        name: "browser_prepare",
        args: { allow_launch: true, windowed: false },
        task,
      }).catch((error: unknown) => error);
      await activationStarted.promise;
      try {
        if (stopOrder === "before") await cuaRequest(f.endpoint, { method: "stop" });
        state = { ready: false, error: "linux_escape_portal_unverified" };
        f.host.inputMonitorStateChanged(state);
        if (stopOrder === "after") await cuaRequest(f.endpoint, { method: "stop" });
      } finally {
        activationFinished.resolve();
      }
      await expect(call).resolves.toMatchObject({
        ok: false,
        error: "Cancelled before listener activation completed.",
        effect: "not-dispatched",
      });
      expect(
        (await f.events()).some((event) => event.event.startsWith("browser:browser_prepare:")),
      ).toBe(false);
    },
  );

  it("arms Linux Escape only for task-attributed work, excluding passive discovery and previews", async () => {
    let state: ComputerInputMonitorState = { ready: false, error: "input_monitor_idle" };
    const activateInputMonitor = vi.fn(async () => {
      state = { ready: true };
    });
    const onInputMonitorArmedChange = vi.fn((armed: boolean) => {
      if (!armed) state = { ready: false, error: "input_monitor_idle" };
    });
    const f = await linuxFixture({
      activateInputMonitor,
      inputMonitorState: () => state,
      onInputMonitorArmedChange,
    });
    await cuaRequest(f.endpoint, { method: "probe" });
    await cuaRequest(f.endpoint, { method: "call", name: "clipboard_read", args: {} });
    const unattributed = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
    });
    expect(unattributed.error).toContain("task attribution");
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "browser_prepare",
      args: { pid: 700, allow_launch: false },
      task,
    });
    await cuaRequest(f.endpoint, {
      method: "call",
      name: "get_browser_state",
      args: {},
      modelObservation: false,
      task,
    });
    expect(activateInputMonitor).not.toHaveBeenCalled();
    expect(onInputMonitorArmedChange).not.toHaveBeenCalled();
    const action = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    });
    expect(action.result).toEqual({});
    expect(activateInputMonitor).toHaveBeenCalledTimes(1);
    await cuaRequest(f.endpoint, { method: "end_task", task });
    expect(onInputMonitorArmedChange).toHaveBeenLastCalledWith(false);
    expect(f.host.isInputMonitorRequested).toBe(false);
  });

  it("refuses Linux browser dispatch if its Escape listener is lost during session setup", async () => {
    let checks = 0;
    const f = await linuxFixture({
      inputMonitorState: () =>
        ++checks === 1 ? { ready: true } : { ready: false, error: "linux_escape_shortcut_lost" },
    });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "call",
      name: "browser_navigate",
      args: {},
      task,
    });
    expect(reply.result?.structuredContent).toMatchObject({
      code: "input_monitor_unavailable",
      input_monitor_error: "linux_escape_shortcut_lost",
    });
    expect(
      (await f.events()).some((event) => event.event.startsWith("browser:browser_navigate:")),
    ).toBe(false);
  });
});

describe("activation shield host method", () => {
  const task = { threadId: "thread", turnId: "turn" };
  const engageArgs = {
    action: "engage",
    shield_id: "shield-abc123",
    frame: { x: 100, y: 50, width: 400, height: 300 },
    window_id: 4242,
    pid: 777,
    label: "Synara activating Calculator",
  };
  const recordingShield = () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      calls,
      engage: async (request: unknown, shieldTask?: unknown) => {
        calls.push({ method: "engage", args: [request, shieldTask] });
      },
      release: async (shieldId: string) => {
        calls.push({ method: "release", args: [shieldId] });
      },
      releaseAll: async () => {
        calls.push({ method: "releaseAll", args: [] });
        return calls.filter((call) => call.method === "engage").length;
      },
      endTask: async (ended: unknown) => {
        calls.push({ method: "endTask", args: [ended] });
      },
      stop: async () => {
        calls.push({ method: "stop", args: [] });
      },
      dispose: async () => {
        calls.push({ method: "dispose", args: [] });
      },
    };
  };

  it("routes engage to the shield host with parsed args and task attribution", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "shield",
      task,
      args: engageArgs,
    });
    expect(reply.ok).toBe(true);
    expect(reply.result).toMatchObject({
      engaged: true,
      shield_id: "shield-abc123",
    });
    expect(shield.calls).toHaveLength(1);
    const call = shield.calls[0]!;
    expect(call.method).toBe("engage");
    expect(call.args[0]).toEqual({
      shieldId: "shield-abc123",
      frame: { x: 100, y: 50, width: 400, height: 300 },
      windowId: 4242,
      pid: 777,
      label: "Synara activating Calculator",
    });
    expect(call.args[1]).toEqual(task);
    // A shield engage is host-local: no driver generation was ever started.
    await expect(f.events()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses engage when no shield surface is configured", async () => {
    const f = await fixture();
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "shield",
      task,
      args: engageArgs,
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("not available");
    expect(reply.effect).toBe("not-dispatched");
  });

  it("refuses engage while the desktop is paused but still accepts release", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    await f.host.pauseDesktop("screen-lock");
    try {
      const reply = await cuaRequest<CuaReply>(f.endpoint, {
        method: "shield",
        task,
        args: engageArgs,
      });
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain("paused");
      // Teardown is never gated on the pause.
      await expect(
        cuaRequest<CuaReply>(f.endpoint, {
          method: "shield",
          args: { action: "release", shield_id: "shield-abc123" },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(shield.calls.map((call) => call.method)).toEqual(["stop", "release"]);
    } finally {
      f.host.resumeDesktop("screen-lock");
    }
  });

  it("rejects malformed shield args before touching the surface", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    for (const args of [
      { action: "engage", shield_id: "bad id with spaces" },
      {
        action: "engage",
        shield_id: "shield-1",
        frame: { x: 0, y: 0, width: -4, height: 4 },
        window_id: 1,
        pid: 1,
      },
      {
        action: "engage",
        shield_id: "shield-1",
        frame: { x: 0, y: 0, width: 4, height: 4 },
        window_id: 0,
        pid: 1,
      },
      { action: "release" },
      { action: "detonate" },
      "engage",
    ]) {
      const reply = await cuaRequest<CuaReply>(f.endpoint, {
        method: "shield",
        task,
        args,
      });
      expect(reply.ok).toBe(false);
      expect(reply.effect).toBe("not-dispatched");
    }
    expect(shield.calls).toHaveLength(0);
  });

  it("release_all is the forced-release path and reports the live count", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    await cuaRequest<CuaReply>(f.endpoint, {
      method: "shield",
      task,
      args: engageArgs,
    });
    const reply = await cuaRequest<CuaReply>(f.endpoint, {
      method: "shield",
      args: { action: "release_all" },
    });
    expect(reply.ok).toBe(true);
    expect(reply.result).toMatchObject({ released: 1 });
    expect(shield.calls.map((call) => call.method)).toEqual(["engage", "releaseAll"]);
  });

  it("end_task releases the task's shields", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    await cuaRequest<CuaReply>(f.endpoint, {
      method: "end_task",
      task,
    });
    expect(shield.calls.map((call) => call.method)).toEqual(["endTask"]);
    expect(shield.calls[0]!.args[0]).toEqual(task);
  });

  it("stop and dispose release the whole shield surface", async () => {
    const shield = recordingShield();
    const f = await fixture(capability, { shield });
    await f.host.stop();
    expect(shield.calls.map((call) => call.method)).toContain("stop");
  });

  it("shield requests still require host authority", async () => {
    const f = await fixture();
    const socket = createConnection(f.endpoint);
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("connect", () => {
        socket.write(
          JSON.stringify({
            method: "shield",
            args: { action: "release_all" },
          }) + "\n",
        );
      });
      socket.once("data", (chunk) => {
        try {
          resolve(JSON.parse(chunk.toString()));
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
    });
    socket.destroy();
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain("authority");
  });
});

describe("orphaned driver sweep", () => {
  afterEach(() => {
    vi.doUnmock("./cuaRuntimeOwnership.ts");
    vi.resetModules();
  });

  it("runs once per process, just before the first driver is spawned", async () => {
    const sweptAt: number[] = [];
    const ownership = await vi.importActual<typeof import("./cuaRuntimeOwnership.ts")>(
      "./cuaRuntimeOwnership.ts",
    );
    // A fresh copy of the host module: the sweep is process-wide state that the
    // statically imported copy has already used up.
    vi.resetModules();
    vi.doMock("./cuaRuntimeOwnership.ts", () => ({
      ...ownership,
      sweepOwnedCuaRuntimeDirectories: () => {
        sweptAt.push(Date.now());
        return [];
      },
    }));
    const { CuaDriverHost: FreshCuaDriverHost } = await import("./cuaDriverHost.ts");
    const touch = (endpoint: string) =>
      cuaRequest<CuaReply>(endpoint, {
        method: "call",
        name: "press_key",
        args: { key: "enter", _synara_foreground_observation_ms: 0 },
      });

    const first = await fixture(capability, { hostClass: FreshCuaDriverHost });
    expect(sweptAt).toHaveLength(0);
    await expect(touch(first.endpoint)).resolves.toMatchObject({ ok: true });
    expect(sweptAt).toHaveLength(1);
    const started = (await first.events()).find((row) => row.event === "start");
    expect(started).toBeDefined();
    expect(sweptAt[0]!).toBeLessThanOrEqual(started!.time);

    const second = await fixture(capability, { hostClass: FreshCuaDriverHost });
    await expect(touch(second.endpoint)).resolves.toMatchObject({ ok: true });
    expect(sweptAt).toHaveLength(1);
  });
});
