import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const f = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: f.spawn }));
import { transcribeNative } from "./native.ts";
afterEach(() => vi.restoreAllMocks());
it("cancellation kills the owned child and waits for its close event", async () => {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  child.kill = vi.fn();
  child.send = vi.fn();
  f.spawn.mockReturnValue(child);
  const abort = new AbortController();
  let settled = false;
  const result = transcribeNative("/unused-model", new Uint8Array([1, 0]), abort.signal).finally(
    () => {
      settled = true;
    },
  );
  const caught = result.catch((error: Error) => error.message);
  abort.abort();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", null, "SIGKILL");
  expect(await caught).toContain("cancelled");
  expect(f.spawn.mock.calls[0]?.[2].env).not.toHaveProperty("OPENAI_API_KEY");
});
it("successful text is not published until the helper exits", async () => {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  child.kill = vi.fn();
  child.send = vi.fn();
  f.spawn.mockReturnValue(child);
  let settled = false;
  const result = transcribeNative(
    "/unused-model",
    new Uint8Array([1, 0]),
    new AbortController().signal,
  ).then((text) => {
    settled = true;
    return text;
  });
  child.emit("message", { text: "hello" });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("close", null, "SIGKILL");
  expect(await result).toBe("hello");
});
