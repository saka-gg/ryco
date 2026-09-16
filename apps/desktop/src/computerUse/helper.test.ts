import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn, execFile: vi.fn() }));
import { ComputerNativeHelper } from "./helper.ts";

function child() {
  const process = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), { write: vi.fn() });
  return Object.assign(process, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}
it("handles broken stdin and allows a fresh helper after failure", async () => {
  const first = child(),
    second = child();
  spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const helper = new ComputerNativeHelper("helper", "state");
  const failed = expect(helper.call("hello")).rejects.toThrow("stopped");
  first.stdin.emit("error", new Error("EPIPE"));
  await failed;
  const resumed = helper.call("hello");
  second.stdout.write(JSON.stringify({ id: 2, ok: true, result: "ready" }) + "\n");
  await expect(resumed).resolves.toBe("ready");
  helper.stop();
});
it("ignores a late write error from a stopped helper after its replacement starts", async () => {
  const first = child(),
    second = child();
  spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const helper = new ComputerNativeHelper("helper", "state");
  const failed = expect(helper.call("hello")).rejects.toThrow("stopped");
  helper.stop();
  await failed;
  const resumed = helper.call("hello");
  first.stdin.write.mock.calls[0]![1](new Error("late EPIPE"));
  expect(second.kill).not.toHaveBeenCalled();
  second.stdout.write(JSON.stringify({ id: 2, ok: true, result: "ready" }) + "\n");
  await expect(resumed).resolves.toBe("ready");
  helper.stop();
});
it("stops immediately on macOS sharing termination, even between requests", async () => {
  const process = child();
  spawn.mockReturnValueOnce(process);
  const stopped = vi.fn();
  const helper = new ComputerNativeHelper("helper", "state", stopped);
  const ready = helper.call("hello");
  process.stdout.write(JSON.stringify({ id: 1, ok: true, result: "ready" }) + "\n");
  await ready;
  process.stdout.write('{"event":"capture_stopped"}\n');
  expect(process.kill).toHaveBeenCalledWith("SIGKILL");
  expect(stopped).toHaveBeenCalledTimes(1);
  process.stdout.write('{"event":"capture_stopped"}\n');
  expect(stopped).toHaveBeenCalledTimes(1);
});
it("rejects in-flight work and ignores late responses after macOS stops sharing", async () => {
  const process = child();
  spawn.mockReturnValueOnce(process);
  const stopped = vi.fn();
  const helper = new ComputerNativeHelper("helper", "state", stopped);
  const failed = expect(helper.call("click")).rejects.toThrow("stopped");
  process.stdout.write('{"event":"capture_stopped"}\n{"id":1,"ok":true,"result":"late"}\n');
  await failed;
  expect(stopped).toHaveBeenCalledTimes(1);
});
