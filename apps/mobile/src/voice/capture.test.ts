import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  permission: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  addListener: vi.fn(),
}));
vi.mock("@ryco/mobile-voice", () => ({ default: f }));
import { createNativeVoiceCapture } from "./capture";
beforeEach(() => {
  vi.resetAllMocks();
  f.permission.mockResolvedValue(true);
  f.start.mockResolvedValue(undefined);
  f.stop.mockResolvedValue("AQA=");
  f.cancel.mockResolvedValue(undefined);
  f.addListener.mockReturnValue({ remove: vi.fn() });
});
it("does not start native capture after a delayed cancelled permission grant", async () => {
  let grant!: (value: boolean) => void;
  f.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  let id = 0;
  const capture = createNativeVoiceCapture(() => `${++id}`);
  const abort = new AbortController();
  const old = capture.start(abort.signal).catch(() => null);
  abort.abort();
  const current = await capture.start(new AbortController().signal);
  grant(true);
  await old;
  expect(f.start).toHaveBeenCalledExactlyOnceWith("2");
  expect(f.cancel).not.toHaveBeenCalled();
  await current.stop();
  expect(f.stop).toHaveBeenCalledWith("2");
});
it("stopping and cancelling use only their own native capture token", async () => {
  let id = 0;
  const capture = createNativeVoiceCapture(() => `${++id}`);
  const first = await capture.start(new AbortController().signal);
  const second = await capture.start(new AbortController().signal);
  first.cancel();
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith("1");
  expect(await second.stop()).toEqual(new Uint8Array([1, 0]));
  expect(f.stop).toHaveBeenCalledWith("2");
});
it("reports only matching interruption events", async () => {
  const interrupted = vi.fn();
  const recording = await createNativeVoiceCapture(() => "one").start(
    new AbortController().signal,
    interrupted,
  );
  const listener = f.addListener.mock.calls[0]![1];
  listener({ id: "other" });
  expect(interrupted).not.toHaveBeenCalled();
  listener({ id: "one" });
  expect(interrupted).toHaveBeenCalledOnce();
  recording.cancel();
});
