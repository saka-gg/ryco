import { assert, describe, it } from "@effect/vitest";
import net from "node:net";
import { performance } from "node:perf_hooks";

import { startDelayProxy } from "./delayProxy.ts";

const DELAY_MS = 40;

interface Echo {
  readonly port: number;
  readonly received: Array<{ readonly at: number; readonly text: string }>;
  readonly ended: Promise<void>;
  readonly socket: Promise<net.Socket>;
  readonly close: () => Promise<void>;
}

/** A target server that records what it receives and answers only after the client half-closed. */
async function startTarget(): Promise<Echo> {
  const received: Array<{ at: number; text: string }> = [];
  let resolveSocket!: (socket: net.Socket) => void;
  let resolveEnded!: () => void;
  const socket = new Promise<net.Socket>((resolve) => (resolveSocket = resolve));
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
  const connections = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    connections.add(connection);
    connection.setNoDelay(true);
    resolveSocket(connection);
    connection.on("data", (chunk) => received.push({ at: performance.now(), text: String(chunk) }));
    connection.on("end", resolveEnded);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    received,
    ended,
    socket,
    close: () =>
      new Promise<void>((resolve) => {
        // Half-open connections never finish on their own.
        for (const connection of connections) connection.destroy();
        server.close(() => resolve());
      }),
  };
}

function connect(port: number, allowHalfOpen = true): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ host: "127.0.0.1", port, allowHalfOpen }, () => resolve(client));
    client.setNoDelay(true);
    client.once("error", reject);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("delay proxy", () => {
  it("delivers every chunk in order and no sooner than the delay after it was sent", async () => {
    const target = await startTarget();
    const proxy = await startDelayProxy({
      listenPort: 0,
      targetPort: target.port,
      delayMs: DELAY_MS,
    });
    const client = await connect(proxy.port);
    try {
      // The send time of each byte, so coalesced chunks can still be checked.
      const sentAt: number[] = [];
      for (const text of ["a", "bb", "ccc", "d"]) {
        for (let index = 0; index < text.length; index += 1) sentAt.push(performance.now());
        client.write(text);
        await sleep(7);
      }
      const expected = "abbcccd";
      const deadline = performance.now() + 2_000;
      while (target.received.map((entry) => entry.text).join("").length < expected.length) {
        assert.isBelow(performance.now(), deadline, "the proxy delivered every byte");
        await sleep(5);
      }
      assert.equal(target.received.map((entry) => entry.text).join(""), expected);

      let offset = 0;
      for (const entry of target.received) {
        for (let index = 0; index < entry.text.length; index += 1) {
          const elapsed = entry.at - sentAt[offset + index]!;
          assert.isAtLeast(elapsed, DELAY_MS, `byte ${offset + index} was delayed`);
        }
        offset += entry.text.length;
      }
    } finally {
      client.destroy();
      await proxy.close();
      await target.close();
    }
  });

  it("delays the return direction too", async () => {
    const target = await startTarget();
    const proxy = await startDelayProxy({
      listenPort: 0,
      targetPort: target.port,
      delayMs: DELAY_MS,
    });
    const client = await connect(proxy.port);
    try {
      const reply = new Promise<number>((resolve) =>
        client.once("data", () => resolve(performance.now())),
      );
      client.write("ping");
      const serverSide = await target.socket;
      // Wait for the request to arrive so the reply timestamp is not taken before it.
      while (target.received.length === 0) await sleep(5);
      const repliedAt = performance.now();
      serverSide.write("pong");
      assert.isAtLeast((await reply) - repliedAt, DELAY_MS);
    } finally {
      client.destroy();
      await proxy.close();
      await target.close();
    }
  });

  it("forwards a half-close after the data that preceded it and still carries the reply", async () => {
    const target = await startTarget();
    const proxy = await startDelayProxy({
      listenPort: 0,
      targetPort: target.port,
      delayMs: DELAY_MS,
    });
    const client = await connect(proxy.port);
    try {
      const chunks: string[] = [];
      const clientEnded = new Promise<void>((resolve) => client.once("end", resolve));
      client.on("data", (chunk) => chunks.push(String(chunk)));

      client.end("request");
      await target.ended;
      assert.equal(target.received.map((entry) => entry.text).join(""), "request");

      // The client already half-closed; the target can still answer, then finish.
      const serverSide = await target.socket;
      serverSide.end("response");
      await clientEnded;
      assert.equal(chunks.join(""), "response");
    } finally {
      client.destroy();
      await proxy.close();
      await target.close();
    }
  });

  it("delivers a backlog to a slow reader after the sender is gone", async () => {
    const backlogBytes = 32 * 1024 * 1024;
    let received = 0;
    let resumeReading!: () => void;
    let resolveClosed!: () => void;
    const targetClosed = new Promise<void>((resolve) => (resolveClosed = resolve));
    const server = net.createServer({ allowHalfOpen: true }, (connection) => {
      connection.on("data", (chunk) => (received += chunk.length));
      connection.on("close", resolveClosed);
      // Not reading keeps the proxy's writes backed up, and finishing its own
      // side at once lets the client close while that backlog is still queued.
      connection.pause();
      connection.end();
      resumeReading = () => connection.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const proxy = await startDelayProxy({
      listenPort: 0,
      targetPort: (server.address() as net.AddressInfo).port,
      delayMs: 0,
    });
    const client = await connect(proxy.port, false);
    client.on("error", () => undefined);
    const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    try {
      client.end(Buffer.alloc(backlogBytes, 1));
      await clientClosed;
      await sleep(100);
      resumeReading();
      await Promise.race([
        targetClosed,
        sleep(10_000).then(() => Promise.reject(new Error("The target never saw the stream end."))),
      ]);
      assert.equal(received, backlogBytes);
    } finally {
      client.destroy();
      await proxy.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("destroys open connections when closed", async () => {
    const target = await startTarget();
    const proxy = await startDelayProxy({ listenPort: 0, targetPort: target.port, delayMs: 0 });
    // A client that closes together with its peer, as browsers do.
    const client = await connect(proxy.port, false);
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    try {
      // Once the target saw the byte the proxy has accepted the pair, so closing it has a pair to tear down.
      client.write("x");
      while (target.received.length === 0) await sleep(5);
      await proxy.close();
      await closed;
      await target.ended;
      assert.isTrue(client.destroyed);
    } finally {
      client.destroy();
      await target.close();
    }
  });
});
