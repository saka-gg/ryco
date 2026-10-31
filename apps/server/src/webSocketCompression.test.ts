import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "vite-plus/test";

import { DEVICE_FRAME_WS_PATH } from "@ryco/shared/deviceFrame";
import { NODE_BROWSER_FRAME_WS_PATH } from "@ryco/shared/nodeBrowserFrame";

import {
  installWebSocketCompressionPolicy,
  isDirectLoopbackUpgrade,
  isLoopbackRangeAddress,
  WEBSOCKET_PER_MESSAGE_DEFLATE,
} from "./webSocketCompression.ts";

/** The extensions a client offering permessage-deflate ends up with. */
async function negotiatedExtensions(
  skipLoopback: boolean,
  headers: Record<string, string> = {},
  path = "/ws",
): Promise<string> {
  const server = Http.createServer();
  installWebSocketCompressionPolicy(server, { skipDirectLoopback: skipLoopback });
  const wss = new NodeSocket.NodeWS.WebSocketServer({
    noServer: true,
    perMessageDeflate: WEBSOCKET_PER_MESSAGE_DEFLATE,
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => ws.close());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string>((resolve, reject) => {
      const client = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${port}${path}`, {
        perMessageDeflate: true,
        headers,
      });
      client.once("open", () => resolve(client.extensions));
      client.once("error", reject);
    });
  } finally {
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Sends `messages` from the server over a connection that negotiated permessage-deflate and
 * returns how many bytes each one took on the wire (frame headers included). The server sends
 * the next message only once the client has counted the previous one, so no read mixes two.
 */
async function wireBytesPerMessage(messages: ReadonlyArray<string>): Promise<number[]> {
  const server = Http.createServer();
  const wss = new NodeSocket.NodeWS.WebSocketServer({
    noServer: true,
    perMessageDeflate: WEBSOCKET_PER_MESSAGE_DEFLATE,
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      let next = 0;
      // The client asks for each message once it has counted the one before.
      ws.on("message", () => {
        const message = messages[next];
        next += 1;
        if (message !== undefined) ws.send(message);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<number[]>((resolve, reject) => {
      const client = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${port}/ws`, {
        perMessageDeflate: true,
      });
      const sizes: number[] = [];
      let pending = 0;
      client.once("upgrade", (response) => {
        response.socket.prependListener("data", (chunk: Buffer) => {
          pending += chunk.length;
        });
      });
      client.once("open", () => client.send("next"));
      client.on("message", () => {
        sizes.push(pending);
        pending = 0;
        if (sizes.length === messages.length) {
          client.close();
          resolve(sizes);
        } else {
          client.send("next");
        }
      });
      client.once("error", reject);
    });
  } finally {
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A streamed-delta frame of about `bytes` bytes, like the ones a turn sends every 32 ms. */
function liveFrame(bytes: number, seed: number): string {
  const text = "the agent explains what it changed and why the tests pass ".repeat(
    Math.ceil(bytes / 58),
  );
  return JSON.stringify({
    _tag: "Chunk",
    requestId: "17",
    values: [{ type: "thread.message-sent", sequence: seed, payload: { text } }],
  }).slice(0, bytes);
}

describe("WebSocket compression policy", () => {
  it("recognizes loopback peers in every address form", () => {
    expect(isLoopbackRangeAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRangeAddress("127.10.0.3")).toBe(true);
    expect(isLoopbackRangeAddress("::1")).toBe(true);
    expect(isLoopbackRangeAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("keeps compression for network peers", () => {
    expect(isLoopbackRangeAddress(undefined)).toBe(false);
    expect(isLoopbackRangeAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackRangeAddress("100.64.0.7")).toBe(false);
    expect(isLoopbackRangeAddress("::ffff:10.0.0.4")).toBe(false);
    expect(isLoopbackRangeAddress("fe80::1")).toBe(false);
  });

  it("tells relayed remote clients from direct loopback peers", () => {
    const upgrade = (remoteAddress: string, headers: Http.IncomingHttpHeaders = {}) =>
      ({ socket: { remoteAddress }, headers }) as unknown as Http.IncomingMessage;
    expect(isDirectLoopbackUpgrade(upgrade("127.0.0.1"))).toBe(true);
    expect(
      isDirectLoopbackUpgrade(upgrade("127.0.0.1", { "x-forwarded-for": "100.101.102.103" })),
    ).toBe(false);
    expect(isDirectLoopbackUpgrade(upgrade("::1", { forwarded: "for=100.101.102.103" }))).toBe(
      false,
    );
    expect(isDirectLoopbackUpgrade(upgrade("192.168.1.20"))).toBe(false);
  });

  it("negotiates permessage-deflate unless loopback peers are skipped", async () => {
    expect(await negotiatedExtensions(false)).toContain("permessage-deflate");
    expect(await negotiatedExtensions(true)).toBe("");
    // A local reverse proxy relaying a remote client keeps compression.
    expect(await negotiatedExtensions(true, { "x-forwarded-for": "100.101.102.103" })).toContain(
      "permessage-deflate",
    );
  });

  it("compresses live frames from 512 bytes, each message on its own", async () => {
    const frame = liveFrame(1_200, 1);
    const tiny = liveFrame(300, 2);
    const [first, second, small] = await wireBytesPerMessage([frame, frame, tiny]);
    // A 1.2 KB streamed delta goes out compressed (it went out as is under the old 16 KiB
    // threshold).
    expect(first).toBeLessThan(frame.length * 0.6);
    // No context is shared between messages: the same frame again costs the same, so no
    // message's compressed length depends on what earlier messages held.
    expect(second).toBe(first);
    // Below the threshold a frame goes out as is (plus its 4-byte header).
    expect(small).toBe(tiny.length + 4);
  });

  it("never negotiates permessage-deflate for device frames, in any mode", async () => {
    const deviceFrames = `${DEVICE_FRAME_WS_PATH}?udid=SIM-1`;
    expect(await negotiatedExtensions(false, {}, deviceFrames)).toBe("");
    // Relayed remote viewers too.
    expect(
      await negotiatedExtensions(true, { "x-forwarded-for": "100.101.102.103" }, deviceFrames),
    ).toBe("");
    expect(
      await negotiatedExtensions(false, { "x-forwarded-for": "100.101.102.103" }, "/ws/device"),
    ).toContain("permessage-deflate");
  });

  it("never negotiates permessage-deflate for node browser frames, in any mode", async () => {
    const frames = `${NODE_BROWSER_FRAME_WS_PATH}?tab=tab-1&maxWidth=1600`;
    expect(await negotiatedExtensions(false, {}, frames)).toBe("");
    expect(await negotiatedExtensions(true, { "x-forwarded-for": "100.101.102.103" }, frames)).toBe(
      "",
    );
  });
});
