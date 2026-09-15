import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVoiceController,
  VOICE_MAX_BYTES,
  type VoiceRecording,
  type VoiceApi,
} from "./index.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let valid = true,
    id = 0;
  const bytes = new Uint8Array([1, 0, 2, 0]);
  const recording = { stop: vi.fn(async () => bytes), cancel: vi.fn() };
  const capture = { available: true, start: vi.fn(async () => recording as VoiceRecording) };
  const request = vi.fn<VoiceApi["request"]>(async (input) =>
    input.action === "status"
      ? { state: "ready" }
      : input.action === "finish"
        ? { state: "transcribed", text: "hello" }
        : { state: "accepted" },
  );
  const insert = vi.fn();
  const controller = createVoiceController({
    capture,
    api: { request },
    authorize: () => ({ isCurrent: () => valid, canCancel: () => valid }),
    encode: (value) => Array.from(value).join(","),
    id: () => `${++id}`,
    insert,
  });
  return {
    controller,
    bytes,
    capture,
    request,
    recording,
    insert,
    invalidate: () => {
      valid = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("voice controller", () => {
  it("never downloads on start and inserts only after explicit review", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    expect(f.request.mock.calls.map(([input]) => input.action)).toEqual([
      "status",
      "begin",
      "chunk",
      "finish",
    ]);
    expect(f.controller.getSnapshot().phase).toBe("review");
    expect(f.insert).not.toHaveBeenCalled();
    f.controller.edit("edited");
    f.controller.insert();
    expect(f.insert).toHaveBeenCalledWith("edited");
    expect(f.bytes).toEqual(new Uint8Array(4));
  });
  it("shows missing model without starting capture", async () => {
    const f = fixture();
    f.request.mockResolvedValue({ state: "missing-model" });
    await f.controller.start();
    expect(f.controller.getSnapshot().phase).toBe("missing-model");
    expect(f.capture.start).not.toHaveBeenCalled();
    f.controller.cancel();
  });
  it("a delayed old permission result only cancels its own recording", async () => {
    const f = fixture();
    const old = deferred<VoiceRecording>();
    const oldRecording = { stop: vi.fn(), cancel: vi.fn() };
    f.capture.start.mockImplementationOnce(() => old.promise);
    const starting = f.controller.start();
    await vi.waitFor(() => expect(f.capture.start).toHaveBeenCalledTimes(1));
    f.controller.cancel();
    await f.controller.start();
    old.resolve(oldRecording);
    await starting;
    expect(oldRecording.cancel).toHaveBeenCalledOnce();
    expect(f.recording.cancel).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().phase).toBe("recording");
    f.controller.cancel();
  });
  it.each(["chunk", "finish"] as const)(
    "fences authorization/environment loss during %s",
    async (action) => {
      const f = fixture();
      const pending = deferred<Awaited<ReturnType<VoiceApi["request"]>>>();
      const normal = f.request.getMockImplementation()!;
      f.request.mockImplementation((input) =>
        input.action === action ? pending.promise : normal(input),
      );
      await f.controller.start();
      const stopped = f.controller.stop();
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([input]) => input.action === action)).toBe(true),
      );
      f.invalidate();
      pending.resolve({ state: "transcribed", text: "late" });
      await stopped;
      expect(f.controller.getSnapshot().phase).toBe("error");
      f.controller.insert();
      expect(f.insert).not.toHaveBeenCalled();
      expect(f.bytes).toEqual(new Uint8Array(4));
    },
  );
  it("zeroes audio on upload failure", async () => {
    const f = fixture();
    const normal = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.action === "chunk" ? Promise.reject(new Error("offline")) : normal(input),
    );
    await f.controller.start();
    await f.controller.stop();
    expect(f.bytes).toEqual(new Uint8Array(4));
    expect(f.controller.getSnapshot().phase).toBe("error");
  });
  it("zeroes oversized audio without uploading", async () => {
    const f = fixture();
    const bytes = new Uint8Array(VOICE_MAX_BYTES + 2).fill(1);
    f.recording.stop.mockResolvedValue(bytes);
    await f.controller.start();
    await f.controller.stop();
    expect(bytes.every((value) => value === 0)).toBe(true);
    expect(f.request.mock.calls.some(([input]) => input.action === "begin")).toBe(false);
  });
  it("stops at 60 seconds", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.recording.stop).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().phase).toBe("review");
    f.controller.cancel();
  });
  it("cancellation fences late inference without cancelling a replacement", async () => {
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<VoiceApi["request"]>>>();
    const normal = f.request.getMockImplementation()!;
    f.request.mockImplementation((input) =>
      input.action === "finish" ? pending.promise : normal(input),
    );
    await f.controller.start();
    const stopped = f.controller.stop();
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([input]) => input.action === "finish")).toBe(true),
    );
    f.controller.cancel();
    await f.controller.start();
    pending.resolve({ state: "transcribed", text: "late" });
    await stopped;
    expect(f.controller.getSnapshot().phase).toBe("recording");
    expect(f.insert).not.toHaveBeenCalled();
    f.controller.cancel();
  });
});
it("cancel zeroes local audio even when an upload reply never arrives", async () => {
  const f = fixture();
  const pending = deferred<Awaited<ReturnType<VoiceApi["request"]>>>();
  const normal = f.request.getMockImplementation()!;
  f.request.mockImplementation((input) =>
    input.action === "chunk" ? pending.promise : normal(input),
  );
  await f.controller.start();
  const stopped = f.controller.stop();
  await vi.waitFor(() =>
    expect(f.request.mock.calls.some(([input]) => input.action === "chunk")).toBe(true),
  );
  f.controller.cancel();
  await stopped;
  expect(f.bytes).toEqual(new Uint8Array(4));
  expect(f.controller.getSnapshot().phase).toBe("idle");
});
