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
