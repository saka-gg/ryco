import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { createSpeechService, type SpeechDependencies } from "./service.ts";
import type { SpeechRequest } from "@ryco/contracts";
function fixture() {
  const deps: SpeechDependencies = {
    supported: () => true,
    ready: vi.fn(async () => true),
    install: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    transcribe: vi.fn(async () => "hello"),
  };
  const service = createSpeechService(deps);
  return {
    deps,
    service,
    run: (input: SpeechRequest, owner = "a") => Effect.runPromise(service.request(owner, input)),
  };
}
afterEach(() => vi.useRealTimers());
it("status never installs and unsupported is truthful", async () => {
  const f = fixture();
  f.deps.ready = async () => false;
  expect(await f.run({ action: "status" })).toEqual({ state: "missing-model" });
  expect(f.deps.install).not.toHaveBeenCalled();
  f.deps.supported = () => false;
  expect(await f.run({ action: "status" })).toEqual({ state: "unsupported" });
});
it("admits only one job and binds chunks/cancel to its connection owner", async () => {
  const f = fixture();
  await f.run({ action: "begin", requestId: "1" });
  await expect(f.run({ action: "begin", requestId: "2" }, "b")).rejects.toThrow(
    "already processing",
  );
  await expect(
    f.run({ action: "chunk", requestId: "1", sequence: 0, pcm: "AQA=" }, "b"),
  ).rejects.toThrow("unavailable");
  await f.run({ action: "cancel", requestId: "1" }, "b");
  expect((await f.run({ action: "status" })).state).toBe("busy");
  await f.service.closeOwner("a");
  expect((await f.run({ action: "status" })).state).toBe("ready");
});
it("rejects malformed/order violations and releases the slot", async () => {
  const f = fixture();
  await f.run({ action: "begin", requestId: "1" });
  await expect(
    f.run({ action: "chunk", requestId: "1", sequence: 1, pcm: "AQA=" }),
  ).rejects.toThrow("Invalid");
  expect((await f.run({ action: "status" })).state).toBe("ready");
});
it("connection-owner cleanup aborts inference and awaits its cleanup", async () => {
  const f = fixture();
  let aborted = false;
  f.deps.transcribe = async (_, signal) =>
    new Promise<string>((_, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("cancelled"));
        },
        { once: true },
      ),
    );
  await f.run({ action: "begin", requestId: "1" });
  await f.run({ action: "chunk", requestId: "1", sequence: 0, pcm: "AQA=" });
  const result = f.run({ action: "finish", requestId: "1" }).catch(() => {});
  await vi.waitFor(() => expect((f.service as unknown) !== null).toBe(true));
  await f.service.closeOwner("a");
  await result;
  expect(aborted).toBe(true);
  expect((await f.run({ action: "status" })).state).toBe("ready");
});
it("expires abandoned uploads", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.run({ action: "begin", requestId: "1" });
  await vi.advanceTimersByTimeAsync(150_000);
  expect((await f.run({ action: "status" })).state).toBe("ready");
});
it("requires a model before accepting audio", async () => {
  const f = fixture();
  f.deps.ready = async () => false;
  await expect(f.run({ action: "begin", requestId: "1" })).rejects.toThrow("Install");
  expect(f.deps.install).not.toHaveBeenCalled();
});
it("does not release the inference slot until cancelled compute has exited", async () => {
  const f = fixture();
  let exit!: () => void;
  let started = false;
  let signalled = false;
  f.deps.transcribe = async (_, signal) => {
    started = true;
    return new Promise<string>((_, reject) => {
      exit = () => reject(new Error("exited"));
      signal.addEventListener("abort", () => {
        signalled = true;
      });
    });
  };
  await f.run({ action: "begin", requestId: "1" });
  await f.run({ action: "chunk", requestId: "1", sequence: 0, pcm: "AQA=" });
  const inference = f.run({ action: "finish", requestId: "1" }).catch(() => {});
  await vi.waitFor(() => expect(started).toBe(true));
  const closing = f.service.closeOwner("a");
  expect(signalled).toBe(true);
  expect((await f.run({ action: "status" })).state).toBe("busy");
  await expect(f.run({ action: "begin", requestId: "2" }, "b")).rejects.toThrow(
    "already processing",
  );
  exit();
  await closing;
  await inference;
  expect((await f.run({ action: "status" })).state).toBe("ready");
});
it("cancellation arriving before begin prevents a late job", async () => {
  const f = fixture();
  await f.run({ action: "cancel", requestId: "late" });
  await expect(f.run({ action: "begin", requestId: "late" })).rejects.toThrow("cancelled");
});
