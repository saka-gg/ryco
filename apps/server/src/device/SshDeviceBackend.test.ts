import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { SshDeviceBackend, deviceHostSshArgs, type SpawnDeviceHost } from "./SshDeviceBackend.ts";
import { SshDeviceHostConfig, sshDeviceHostId } from "./deviceHostConfig.ts";
import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";
import { startDeviceHostSession } from "./deviceHostWorker.ts";

const config = { name: "Mac", target: "build-mac", executable: "/opt/ryco/bin/ryco" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

function fixture() {
  const native = new FakeDeviceBackend();
  const children: (EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  })[] = [];
  let starts = 0;
  const spawnProcess = (() => {
    starts += 1;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        child.stdin.end();
        return true;
      },
    });
    children.push(child);
    const session = startDeviceHostSession(native, child.stdin, child.stdout);
    void session.then((s) => {
      void s.done.then(() => child.emit("close", 0));
    });
    cleanup.push(async () => {
      await (await session).close();
    });
    return child;
  }) as SpawnDeviceHost;
  const backend = new SshDeviceBackend(config, spawnProcess);
  cleanup.push(() => backend.dispose());
  return { backend, native, children, starts: () => starts };
}

describe("SSH device host transport", () => {
  it("shares startup, preserves argv/stdin values and routes full device operations", async () => {
    const { backend, native, starts } = fixture();
    const [, devices] = await Promise.all([
      backend.availability(),
      backend.listDevices({ includeShutdown: true }),
    ]);
    expect(starts()).toBe(1);
    const udid = devices[0]!.udid;
    await backend.boot(udid);
    const text = "Quotes ' \" ` $() and\na second line";
    await backend.typeText(udid, text);
    expect(native.callsOfKind("typeText")[0]?.text).toBe(text);
    const frames: number[] = [];
    await backend.attachStream(udid, (frame) => frames.push(frame.sequence));
    native.emitFrame(udid, { sequence: 7 });
    expect(frames).toEqual([7]);
    expect(backend.geometry(udid)).not.toBeNull();
    expect((await backend.screenshot(udid)).udid).toBe(udid);
    expect((await backend.launch(udid, "com.example.app")).udid).toBe(udid);
    await expect(backend.install(udid, "/same-path/different-artifact.app")).rejects.toThrow(
      "SSH app delivery",
    );
    expect(native.callsOfKind("install")).toHaveLength(0);
    await backend.detachStream(udid);
    native.emitFrame(udid, { sequence: 8 });
    expect(frames).toEqual([7]);
  });

  it("invalidates a pending mutation on disconnect and never reconnects to replay it", async () => {
    const { backend, native, children, starts } = fixture();
    const udid = (await backend.listDevices({ includeShutdown: true }))[0]!.udid;
    await backend.boot(udid);
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    native.tap = async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const pending = backend.tap(udid, 1, 2);
    const rejection = expect(pending).rejects.toThrow("disconnected");
    await entered;
    children[0]!.emit("close", 255);
    await rejection;
    await expect(backend.tap(udid, 2, 3)).rejects.toThrow("disconnected");
    expect(starts()).toBe(1);
    finish();
  });

  it("reconnects only on fresh discovery and does not restore old streams", async () => {
    const { backend, children, starts } = fixture();
    const udid = (await backend.listDevices({ includeShutdown: true }))[0]!.udid;
    await backend.boot(udid);
    await backend.attachStream(udid, () => undefined);
    children[0]!.emit("close", 255);
    expect(backend.geometry(udid)).toBeNull();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    try {
      await backend.listDevices({ includeShutdown: true });
      expect(starts()).toBe(2);
      expect(backend.geometry(udid)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects a mismatched worker before sending any operation", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    let sent = "";
    child.stdin.on("data", (chunk) => {
      sent += String(chunk);
    });
    const backend = new SshDeviceBackend(config, (() => {
      queueMicrotask(() => child.stdout.write('{"type":"ready","protocol":1,"version":"wrong"}\n'));
      return child;
    }) as SpawnDeviceHost);
    cleanup.push(() => backend.dispose());
    await expect(backend.listDevices()).rejects.toThrow("incompatible");
    expect(sent).toBe("");
  });

  it("uses strict host-key checking and quoted executables without agent forwarding", () => {
    const args = deviceHostSshArgs({
      ...config,
      executable: "/opt/Ryco's tools/ryco",
      identityFile: "/keys/build key",
      port: 2222,
    });
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain("BatchMode=yes");
    expect(args.at(-1)).toBe("exec '/opt/Ryco'\\''s tools/ryco' device-host-stdio");
    expect(() =>
      Schema.decodeUnknownSync(SshDeviceHostConfig)({ ...config, target: "-oProxyCommand=evil" }),
    ).toThrow();
    expect(sshDeviceHostId({ ...config, name: "Renamed" })).toBe(sshDeviceHostId(config));
    expect(sshDeviceHostId({ ...config, target: "another-mac" })).not.toBe(sshDeviceHostId(config));
  });
});
