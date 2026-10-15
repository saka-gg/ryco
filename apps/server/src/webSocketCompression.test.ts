import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "vite-plus/test";

import { DEVICE_FRAME_WS_PATH } from "@ryco/shared/deviceFrame";

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
});
