import { describe, expect, it } from "vitest";

import type { DeviceKeyEvent, DeviceTouchPhase } from "./DeviceBackend.ts";
import { createDeviceInputSession, type DeviceInputTarget } from "./deviceInputSession.ts";

type Call =
  | {
      readonly kind: "touch";
      readonly phase: DeviceTouchPhase;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: "key"; readonly usage: number; readonly direction: "down" | "up" }
  | { readonly kind: "paste"; readonly text: string };

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

function harness(options: { readonly queueLimit?: number } = {}) {
  const calls: Call[] = [];
  const reports: Array<{ input: string; message: string }> = [];
  let generation = 0;
  let gate: Promise<void> | null = null;
  const failures: Array<(call: Call) => Error | null> = [];
  const run = async (call: Call) => {
    calls.push(call);
    if (gate) await gate;
    for (const failure of failures) {
      const error = failure(call);
      if (error) throw error;
    }
  };
  const target: DeviceInputTarget = {
    touch: (_udid, phase, x, y) => run({ kind: "touch", phase, x, y }),
    keyEvent: (_udid, event: DeviceKeyEvent) =>
      run({ kind: "key", usage: event.keyCode, direction: event.direction }),
    paste: (_udid, text) => run({ kind: "paste", text }),
    inputFence: () => {
      const at = generation;
      return () => at === generation;
    },
  };
  const session = createDeviceInputSession({
    udid: "DEVICE",
    target,
    report: (input, message) => reports.push({ input, message }),
    ...(options.queueLimit ? { queueLimit: options.queueLimit } : {}),
  });
  return {
    session,
    calls,
    reports,
    reboot: () => {
      generation += 1;
    },
    hold: () => {
      const next = deferred();
      gate = next.promise;
      return () => {
        gate = null;
        next.resolve();
      };
    },
    fail: (when: (call: Call) => Error | null) => failures.push(when),
  };
}

const touch = (phase: DeviceTouchPhase, x: number, y = 100) =>
  ({ type: "device.touch", phase, x, y }) as const;

describe("device input session", () => {
  it("delivers a gesture in order", async () => {
    const { session, calls } = harness();
    session.push(touch("down", 10));
    session.push(touch("move", 20));
    session.push(touch("up", 30));
    await settle();
    expect(calls).toEqual([
      { kind: "touch", phase: "down", x: 10, y: 100 },
      { kind: "touch", phase: "move", x: 20, y: 100 },
      { kind: "touch", phase: "up", x: 30, y: 100 },
    ]);
  });

  it("coalesces moves waiting behind a slow injection, never downs or ups", async () => {
    const { session, calls, hold } = harness();
    const release = hold();
    session.push(touch("down", 10));
    for (let x = 11; x <= 40; x += 1) session.push(touch("move", x));
    session.push(touch("up", 41));
    release();
    await settle();
    expect(calls.map((call) => (call.kind === "touch" ? `${call.phase}:${call.x}` : ""))).toEqual([
      "down:10",
      "move:40",
      "up:41",
    ]);
  });

  it("keeps keys and pastes in arrival order with touches", async () => {
    const { session, calls } = harness();
    session.push(touch("down", 1));
    session.push({ type: "device.key", usage: 0x04, phase: "down" });
    session.push(touch("up", 1));
    session.push({ type: "device.paste", text: "ab", group: 1, final: false });
    session.push({ type: "device.key", usage: 0x04, phase: "up" });
    session.push({ type: "device.paste", text: "c", group: 1, final: true });
    await settle();
    expect(calls.map((call) => call.kind + (call.kind === "paste" ? `:${call.text}` : ""))).toEqual(
      ["touch", "key", "touch", "key", "paste:abc"],
    );
  });

  it("drops the rest of a gesture after the device reboots", async () => {
    const { session, calls, reboot } = harness();
    session.push(touch("down", 1));
    await settle();
    reboot();
    session.push(touch("move", 2));
    session.push(touch("up", 3));
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("reports a failed move once, lifts the finger and ignores the rest of the gesture", async () => {
    const { session, calls, reports, fail } = harness();
    fail((call) =>
      call.kind === "touch" && call.phase === "move" && call.x === 2
        ? new Error("input may have been partially delivered; do not replay")
        : null,
    );
    session.push(touch("down", 1));
    session.push(touch("move", 2));
    await settle();
    session.push(touch("move", 3));
    session.push(touch("up", 4));
    await settle();
    expect(reports).toEqual([
      { input: "touch", message: "input may have been partially delivered; do not replay" },
    ]);
    expect(calls.map((call) => (call.kind === "touch" ? `${call.phase}:${call.x}` : ""))).toEqual([
      "down:1",
      "move:2",
      "up:2",
    ]);
  });

  it("lifts a held finger and releases held keys when the socket closes", async () => {
    const { session, calls } = harness();
    session.push(touch("down", 5));
    session.push(touch("move", 6));
    session.push({ type: "device.key", usage: 0xe1, phase: "down" });
    await settle();
    await session.close();
    expect(calls.slice(-2)).toEqual([
      { kind: "touch", phase: "up", x: 6, y: 100 },
      { kind: "key", usage: 0xe1, direction: "up" },
    ]);
    session.push(touch("down", 7));
    await settle();
    expect(calls).toHaveLength(5);
  });

  it("ends an unfinished gesture when a new one starts", async () => {
    const { session, calls } = harness();
    session.push(touch("down", 1));
    session.push(touch("down", 9));
    await settle();
    expect(calls.map((call) => (call.kind === "touch" ? `${call.phase}:${call.x}` : ""))).toEqual([
      "down:1",
      "up:1",
      "down:9",
    ]);
  });

  it("pastes nothing of a group that grows past the limit", async () => {
    const { session, calls, reports } = harness();
    const chunk = "x".repeat(256);
    for (let index = 0; index < 64; index += 1) {
      session.push({ type: "device.paste", text: chunk, group: 3, final: false });
    }
    session.push({ type: "device.paste", text: chunk, group: 3, final: true });
    await settle();
    expect(calls).toEqual([]);
    expect(reports.map((report) => report.input)).toEqual(["paste"]);
  });

  it("discards an unfinished paste when a new one starts", async () => {
    const { session, calls } = harness();
    session.push({ type: "device.paste", text: "lost", group: 1, final: false });
    session.push({ type: "device.paste", text: "kept", group: 2, final: true });
    await settle();
    expect(calls).toEqual([{ kind: "paste", text: "kept" }]);
  });

  it("bounds the queue and reports the overflow once", async () => {
    const { session, calls, reports, hold } = harness({ queueLimit: 3 });
    const release = hold();
    for (let usage = 4; usage < 12; usage += 1) {
      session.push({ type: "device.key", usage, phase: "down" });
    }
    release();
    await settle();
    // One in flight when the gate closed, then three queued.
    expect(calls).toHaveLength(4);
    expect(reports).toHaveLength(1);
  });
});

describe("device input session overflow", () => {
  it("still delivers releases when the queue is full", async () => {
    const { session, calls, hold } = harness({ queueLimit: 2 });
    const release = hold();
    session.push({ type: "device.key", usage: 0x04, phase: "down" });
    session.push({ type: "device.key", usage: 0x05, phase: "down" });
    session.push({ type: "device.key", usage: 0x06, phase: "down" });
    session.push({ type: "device.key", usage: 0x07, phase: "down" });
    session.push({ type: "device.key", usage: 0x04, phase: "up" });
    release();
    await settle();
    expect(calls.at(-1)).toEqual({ kind: "key", usage: 0x04, direction: "up" });
  });
});
