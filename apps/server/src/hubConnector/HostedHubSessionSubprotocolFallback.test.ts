import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket as NetSocket } from "node:net";

import { HostedHubSession, type HubSessionSocket } from "@ryco/client-runtime/relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * The account socket against a server that completes the upgrade without echoing
 * `Sec-WebSocket-Protocol` — what a proxy that strips the header hands a browser — and then sends
 * a version 1 `ready`. Node's WebSocket enforces the WHATWG rule browsers enforce: a handshake
 * that offered a subprotocol and got none back fails before `open`. The socket is built by the web
 * app's own browser adapter, exactly as the hosted app builds it.
 */
const { createBrowserRelaySocket } = (await import(
  /* @vite-ignore */ new URL("../../../web/src/hostedHub/relaySocket.ts", import.meta.url).href
)) as {
  readonly createBrowserRelaySocket: (
    url: string,
    createSocket: undefined,
    onInvalidMessage: undefined,
    protocols: readonly string[],
  ) => HubSessionSocket;
};

const ACCOUNT_ID = `acct_${"a".repeat(22)}`;
const SESSION_ID = `sess_${"s".repeat(22)}`;

describe("Hub session behind a proxy that strips the subprotocol (real sockets)", () => {
  let server: Server;
  const sockets: NetSocket[] = [];
  const offered: (string | undefined)[] = [];
  beforeEach(async () => {
    server = createServer();
    server.on("upgrade", (request, socket: NetSocket) => {
      sockets.push(socket);
      socket.on("error", () => undefined);
      offered.push(request.headers["sec-websocket-protocol"]);
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // One unmasked binary frame: version 1 `ready`.
      socket.write(Uint8Array.of(0x82, 7, 4, 0, 0, 0, 0, 1, 8));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    offered.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reaches ready on the next handshake by offering no subprotocol", async () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing port");
    const statuses: string[] = [];
    const session = new HostedHubSession({
      expectedIdentity: { accountId: ACCOUNT_ID, sessionId: SESSION_ID },
      createSocket: (protocols) =>
        createBrowserRelaySocket(
          `ws://127.0.0.1:${address.port}/v1/relay/session`,
          undefined,
          undefined,
          protocols,
        ),
      timers: {
        now: Date.now,
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
        queueMicrotask,
      },
      random: () => 0,
      onStatus: (status) => statuses.push(status),
    });
    try {
      session.start();
      await vi.waitFor(() => expect(statuses).toContain("online"), { timeout: 5_000 });
      // The first handshake offered version 2 and failed in the client; the second offered none.
      expect(offered.slice(0, 2)).toEqual(["ryco.hub-session.v2", undefined]);
      expect(session.serverMintedOpenAvailable()).toBe(false);
    } finally {
      session.dispose();
    }
  });
});
