import * as net from "node:net";
import { describe, expect, it, vi } from "vitest";

import { encodeTouch, ScrcpyTouchAction, type ScrcpyVideoEvent } from "./scrcpyProtocol.ts";
import { ScrcpySession, type ScrcpyHost } from "./scrcpySession.ts";
import {
  fakeChild,
  mediaPacket,
  sessionPacket,
  startFakeScrcpyServer,
} from "./scrcpyTestServer.ts";

function host(port: number) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const adb = vi.fn<ScrcpyHost["adb"]>(async (args) =>
    Buffer.from(args.includes("forward") && args.includes("tcp:0") ? `${port}\n` : ""),
  );
  const spawnAdb = vi.fn<ScrcpyHost["spawnAdb"]>(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  return {
    adb,
    spawnAdb,
    children,
    host: { adb, spawnAdb, delay: async () => {} } satisfies ScrcpyHost,
  };
}

describe("ScrcpySession", () => {
  it("waits out a forward tunnel that accepts before the server listens", async () => {
    const server = await startFakeScrcpyServer({ video: false, refuseFirst: 3 });
    const fake = host(server.port);
    const session = await ScrcpySession.start(fake.host, { transportId: "7", video: null });
    session.send(encodeTouch(ScrcpyTouchAction.down, 10, 20, { width: 100, height: 200 }));
    await session.setClipboard("hé", true);
    await vi.waitFor(() => expect(server.control().byteLength).toBe(32 + 14 + 3));
    expect(server.control()[0]).toBe(2);
    const command = fake.spawnAdb.mock.calls[0]![0];
    expect(command.slice(0, 3)).toEqual(["-t", "7", "shell"]);
    expect(command[3]).toContain("com.genymobile.scrcpy.Server 5.0.1");
    expect(command[3]).toContain("video=false");
    expect(command[3]).toContain("tunnel_forward=true");
    await session.close();
    expect(fake.children[0]!.killed).toBe(true);
    expect(fake.adb.mock.calls.at(-1)![0]).toEqual([
      "-t",
      "7",
      "forward",
      "--remove",
      `tcp:${server.port}`,
    ]);
    expect(() => session.send(Uint8Array.of(17))).toThrow("input channel closed");
    await server.close();
  });

  it("streams video events in order and ends once when the socket closes", async () => {
    const server = await startFakeScrcpyServer({
      video: true,
      initialVideo: Buffer.concat([
        sessionPacket(758, 1600),
        mediaPacket({ config: true, pts: 0n, data: [0, 0, 0, 1, 0x67] }),
      ]),
    });
    const fake = host(server.port);
    const events: ScrcpyVideoEvent[] = [];
    const ended = vi.fn();
    const session = await ScrcpySession.start(fake.host, {
      transportId: "1",
      video: { maxSize: 1600, maxFps: 60, bitRate: 8_000_000 },
      onVideo: (event) => events.push(event),
      onEnded: ended,
    });
    expect(fake.spawnAdb.mock.calls[0]![0][3]).toContain("max_size=1600");
    server.sendVideo(mediaPacket({ key: true, pts: 16_000n, data: [0, 0, 0, 1, 0x65] }));
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events.map((event) => event.kind)).toEqual(["codec", "session", "packet", "packet"]);
    session.resetVideo();
    await vi.waitFor(() => expect(server.control().at(-1)).toBe(17));
    await server.close();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(session.isOpen).toBe(false);
  });

  it("reports a server that exits before it accepts, with its output", async () => {
    const fake = host(1);
    fake.spawnAdb.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stderr!.emit("data", Buffer.from("ERROR: Could not open video stream\n"));
        child.kill("SIGTERM");
      });
      return child;
    });
    await expect(ScrcpySession.start(fake.host, { transportId: "1", video: null })).rejects.toThrow(
      "Could not open video stream",
    );
  });

  it("rejects without calling onEnded when the server exits during start", async () => {
    const fake = host(1);
    fake.spawnAdb.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    });
    const ended = vi.fn();
    await expect(
      ScrcpySession.start(fake.host, { transportId: "1", video: null, onEnded: ended }),
    ).rejects.toThrow("scrcpy-server exited (1)");
    expect(ended).not.toHaveBeenCalled();
  });

  it("rejects a session whose server exits after the first socket is accepted", async () => {
    const server = await startFakeScrcpyServer({ video: true });
    const fake = host(server.port);
    const opened: net.Socket[] = [];
    const ended = vi.fn();
    const start = ScrcpySession.start(
      {
        ...fake.host,
        connect: (port) => {
          // The server dies while the video session opens its control socket.
          if (opened.length === 1) fake.children[0]!.emit("exit", 1, null);
          const socket = net.connect(port, "127.0.0.1");
          opened.push(socket);
          return socket;
        },
      },
      {
        transportId: "1",
        video: { maxSize: 1600, maxFps: 60, bitRate: 8_000_000 },
        onEnded: ended,
      },
    );
    await expect(start).rejects.toThrow("scrcpy-server exited (1)");
    expect(ended).not.toHaveBeenCalled();
    expect(opened.map((socket) => socket.destroyed)).toEqual([true, true]);
    await server.close();
  });
  it("fails the start when the video socket resets while control connects", async () => {
    const server = await startFakeScrcpyServer({ video: true });
    const fake = host(server.port);
    const opened: net.Socket[] = [];
    const start = ScrcpySession.start(
      {
        ...fake.host,
        connect: (port) => {
          // The video socket resets while the control socket is being opened.
          if (opened.length === 1) opened[0]!.destroy(new Error("read ECONNRESET"));
          const socket = net.connect(port, "127.0.0.1");
          opened.push(socket);
          return socket;
        },
      },
      { transportId: "1", video: { maxSize: 1600, maxFps: 60, bitRate: 8_000_000 } },
    );
    await expect(start).rejects.toThrow();
    expect(opened.every((socket) => socket.destroyed)).toBe(true);
    await server.close();
  });

  it("gives up on a tunnel that accepts but never sends the dummy byte", async () => {
    const accepted: net.Socket[] = [];
    const silent = net.createServer((socket) => accepted.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as net.AddressInfo).port;
    try {
      const fake = host(port);
      await expect(
        ScrcpySession.start(fake.host, { transportId: "1", video: null, connectTimeoutMs: 300 }),
      ).rejects.toThrow("did not accept a connection");
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 5_000);
});
