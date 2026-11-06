// Parallel Computer Use sessions on one driver: which calls overlap, which take
// turns, and which still run alone. See
// docs/superpowers/specs/2026-11-06-computer-use-parallel-sessions.md.
import { afterEach, describe, expect, it } from "vitest";
import type { CuaReply } from "@ryco/shared/cuaDriverProtocol";
import {
  capability,
  cleanupFixtures,
  cuaRequest,
  fixture,
  waitForEvent,
  waitForQueuedOperations,
} from "./cuaDriverHost.fixtures.ts";

afterEach(cleanupFixtures);

const taskA = { threadId: "thread-a", turnId: "turn" };
const taskB = { threadId: "thread-b", turnId: "turn" };
const safari = { pid: 42, window_id: 10 };
const notes = { pid: 43, window_id: 11 };

type Fixture = Awaited<ReturnType<typeof fixture>>;
const call = (f: Fixture, name: string, task: object, args: object, extra: object = {}) =>
  cuaRequest<CuaReply>(f.endpoint, { method: "call", name, task, args, ...extra });
const eventNames = async (f: Fixture) => (await f.events()).map((row) => row.event);

describe("parallel computer sessions on one driver", () => {
  it("answers another task's read while background input is in flight", async () => {
    const f = await fixture(capability, { inputDelayMs: 2_000 });
    const typing = call(f, "type_text", taskA, { ...safari, text: "fixture" });
    await waitForEvent(f, "dispatch");
    await expect(
      call(f, "get_window_state", taskB, notes, { modelObservation: true }),
    ).resolves.toMatchObject({ ok: true });
    expect(await eventNames(f)).not.toContain("effect");
    await expect(typing).resolves.toMatchObject({ ok: true });
  });

  it("lets background input of two apps take turns on the driver gate instead of failing", async () => {
    const f = await fixture(capability, { inputDelayMs: 150 });
    const typing = call(f, "type_text", taskA, { ...safari, text: "fixture" });
    await waitForEvent(f, "dispatch");
    const key = call(f, "press_key", taskB, { ...notes, key: "enter" });
    await expect(typing).resolves.toMatchObject({ ok: true });
    await expect(key).resolves.toMatchObject({ ok: true });
    const events = await eventNames(f);
    // The driver refuses overlapping exclusive input, so the host never sends it.
    expect(events.indexOf("effect")).toBeLessThan(events.indexOf("key"));
  });

  it("dispatches exact semantic writes on different windows together", async () => {
    const f = await fixture(capability, { inputDelayMs: 400 });
    const first = call(f, "type_text", taskA, { ...safari, text: "a", semantic_only: true });
    const second = call(f, "type_text", taskB, { ...notes, text: "b", semantic_only: true });
    await waitForEvent(f, "dispatch", 2);
    expect(await eventNames(f)).not.toContain("effect");
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("keeps two semantic writes on the same window in order", async () => {
    const f = await fixture(capability, { inputDelayMs: 150 });
    const first = call(f, "type_text", taskA, { ...safari, text: "a", semantic_only: true });
    await waitForEvent(f, "dispatch");
    const second = call(f, "type_text", taskB, { ...safari, text: "b", semantic_only: true });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    const events = (await eventNames(f)).filter(
      (event) => event === "dispatch" || event === "effect",
    );
    expect(events).toEqual(["dispatch", "effect", "dispatch", "effect"]);
  });

  it("runs foreground input alone: it waits for reads, and later reads wait for it", async () => {
    const f = await fixture(capability, { holdObservation: true, inputDelayMs: 100 });
    const read = call(f, "get_window_state", taskB, notes);
    await waitForEvent(f, "observe");
    const foreground = call(f, "type_text", taskA, {
      ...safari,
      text: "fixture",
      delivery_mode: "foreground",
    });
    const laterRead = call(f, "list_windows", taskB, {});
    // Neither the foreground input nor the read queued behind it may start
    // while the first read is still running.
    await waitForQueuedOperations(f, 2);
    expect(await eventNames(f)).not.toContain("dispatch");
    expect(await eventNames(f)).not.toContain("list-windows");
    await f.releaseObservation();
    await expect(read).resolves.toMatchObject({ ok: true });
    await expect(foreground).resolves.toMatchObject({ ok: true });
    await expect(laterRead).resolves.toMatchObject({ ok: true });
    const events = await eventNames(f);
    expect(events.indexOf("effect")).toBeLessThan(events.indexOf("list-windows"));
  });

  it("still fences every queued sibling when Stop interrupts foreground input", async () => {
    const f = await fixture();
    const foreground = call(f, "type_text", taskA, {
      ...safari,
      text: "fixture",
      delivery_mode: "foreground",
    });
    await waitForEvent(f, "dispatch");
    const queued = call(f, "press_key", taskB, { ...notes, key: "enter" });
    await expect(cuaRequest(f.endpoint, { method: "stop", task: taskA })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "generation" },
    });
    await expect(foreground).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    await expect(queued).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
  });

  it("does not interrupt the driver when the stopped task has no input in flight", async () => {
    const f = await fixture(capability, { inputDelayMs: 150 });
    const typing = call(f, "type_text", taskB, { ...notes, text: "fixture" });
    await waitForEvent(f, "dispatch");
    await expect(cuaRequest(f.endpoint, { method: "stop", task: taskA })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "task" },
    });
    await expect(typing).resolves.toMatchObject({ ok: true });
    expect(await eventNames(f)).not.toContain("interrupt");
  });

  it("makes a task whose semantic write the scoped Stop drain cut off observe again", async () => {
    const f = await fixture(capability, { inputDelayMs: 2_000 });
    const stopped = call(f, "type_text", taskA, { ...safari, text: "a", semantic_only: true });
    await waitForEvent(f, "dispatch");
    const cutOff = call(f, "type_text", taskB, { ...notes, text: "b", semantic_only: true });
    await waitForEvent(f, "dispatch", 2);
    await expect(cuaRequest(f.endpoint, { method: "stop", task: taskA })).resolves.toMatchObject({
      ok: true,
      result: { stop_scope: "input" },
    });
    await expect(stopped).resolves.toMatchObject({ ok: false, effect: "dispatched-unknown" });
    // The driver's gate is process-wide: the drain also ended B's write.
    await expect(cutOff).resolves.toMatchObject({ ok: false });
    const refused = await call(f, "press_key", taskB, { ...notes, key: "enter" });
    expect(refused.result?.structuredContent?.code).toBe("computer_input_paused");
  });

  it("survives an Escape while an admitted input is still setting up its cursor", async () => {
    const f = await fixture();
    // Physical Escape lands after the call was admitted but before it reaches
    // the driver: the interrupt waits for the call, so the call must not wait
    // for the interrupt in turn.
    const host = f.host as unknown as {
      setTaskCursorEnabled: (...args: unknown[]) => Promise<boolean>;
    };
    const original = host.setTaskCursorEnabled.bind(f.host);
    let pressed = false;
    host.setTaskCursorEnabled = async (...args: unknown[]) => {
      if (!pressed) {
        pressed = true;
        expect(f.host.emergencyStopInput()).toBe(true);
      }
      return original(...args);
    };
    await expect(
      call(f, "type_text", taskA, { ...safari, text: "fixture" }),
    ).resolves.toMatchObject({ ok: false, effect: "not-dispatched" });
    await expect(call(f, "list_windows", taskB, {})).resolves.toMatchObject({ ok: true });
    expect(await eventNames(f)).not.toContain("dispatch");
  });

  it("fences only the task whose background action lost focus", async () => {
    const f = await fixture(capability, {
      actionResult: { isError: true, structuredContent: { code: "focus_restore_failed" } },
    });
    await call(f, "press_key", taskA, { ...safari, key: "enter" });
    // The other task keeps working on its own app.
    const other = await call(f, "press_key", taskB, { ...notes, key: "enter" });
    expect(other.result?.structuredContent?.code).toBe("focus_restore_failed");
    // The task that lost focus must observe its target before acting again.
    const refused = await call(f, "press_key", taskA, { ...safari, key: "enter" });
    expect(refused.result?.structuredContent?.code).toBe("computer_input_paused");
    expect((await eventNames(f)).filter((event) => event === "key")).toHaveLength(2);
  });
});
