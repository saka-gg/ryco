import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";
import { startDeviceHostSession } from "./deviceHostWorker.ts";

function send(input: PassThrough, id: number, method: string, args: unknown[]) {
  input.write(JSON.stringify({ id, method, args }) + "\n");
}

describe("SSH worker ownership", () => {
  it("waits for an in-flight boot at EOF, cleans only its own boot and cancels queued input", async () => {
    const backend = new FakeDeviceBackend();
    const devices = await backend.listDevices({ includeShutdown: true });
    const owned = devices[0]!.udid;
    const user = devices[1]!.udid;
    backend.bootExternally(user);
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const boot = backend.boot.bind(backend);
    backend.boot = async (udid) => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return boot(udid);
    };
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const session = await startDeviceHostSession(backend, input, output);
    send(input, 1, "boot", [owned]);
    await entered;
    send(input, 2, "tap", [owned, 1, 2]);
    const closing = session.close();
    finish();
    await closing;
    expect(backend.callsOfKind("shutdown").map((c) => c.udid)).toEqual([owned]);
    expect(backend.callsOfKind("tap")).toHaveLength(0);
  });

  it("fails closed on invalid methods and oversized requests", async () => {
    for (const request of [
      JSON.stringify({ id: 1, method: "dispose", args: [] }) + "\n",
      "x".repeat(65537),
    ]) {
      const backend = new FakeDeviceBackend();
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const session = await startDeviceHostSession(backend, input, output);
      input.write(request);
      await session.done;
      expect(backend.callsOfKind("boot")).toHaveLength(0);
    }
  });
});
