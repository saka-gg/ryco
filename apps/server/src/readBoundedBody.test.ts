import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { readBoundedBody } from "./readBoundedBody.ts";

const LIMIT = 16;

describe("readBoundedBody", () => {
  it("reads a body under the limit as UTF-8, across chunks", async () => {
    const stream = new PassThrough();
    const body = readBoundedBody(stream, LIMIT);
    stream.write(Buffer.from("hé"));
    stream.end(Buffer.from("llo"));
    await expect(body).resolves.toBe("héllo");
  });

  it("reads an empty body", async () => {
    const stream = new PassThrough();
    const body = readBoundedBody(stream, LIMIT);
    stream.end();
    await expect(body).resolves.toBe("");
  });

  it("accepts a body of exactly the limit", async () => {
    const stream = new PassThrough();
    const body = readBoundedBody(stream, LIMIT);
    stream.write("a".repeat(LIMIT - 1));
    stream.end("b");
    await expect(body).resolves.toBe(`${"a".repeat(LIMIT - 1)}b`);
  });

  it("resolves null once the body grows past the limit and drains the rest", async () => {
    const stream = new PassThrough();
    const body = readBoundedBody(stream, LIMIT);
    stream.write("a".repeat(LIMIT));
    stream.write("b");
    await expect(body).resolves.toBeNull();
    // The rest of the body is dropped, not buffered, and the stream still ends.
    const ended = new Promise<void>((resolve) => stream.once("end", () => resolve()));
    stream.end("c".repeat(LIMIT * 4));
    await ended;
    expect(stream.readableLength).toBe(0);
  });

  it("rejects with the stream's error", async () => {
    const stream = new PassThrough();
    const body = readBoundedBody(stream, LIMIT);
    stream.write("partial");
    const failure = new Error("socket hang up");
    stream.destroy(failure);
    await expect(body).rejects.toBe(failure);
  });

  describe("over HTTP", () => {
    let server: Server | undefined;
    afterEach(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    });

    const listen = (onRequest: Parameters<typeof createServer>[1]) =>
      new Promise<number>((resolve) => {
        server = createServer(onRequest);
        server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
      });

    it("lets the caller answer an over-limit request instead of leaving it hanging", async () => {
      const port = await listen((request, response) => {
        void readBoundedBody(request, LIMIT).then((body) => {
          response.writeHead(body === null ? 413 : 200);
          response.end(body ?? "");
        });
      });
      const oversized = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        body: "x".repeat(256 * 1024),
        signal: AbortSignal.timeout(5_000),
      });
      expect(oversized.status).toBe(413);
      const atLimit = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        body: "y".repeat(LIMIT),
        signal: AbortSignal.timeout(5_000),
      });
      expect(atLimit.status).toBe(200);
      expect(await atLimit.text()).toBe("y".repeat(LIMIT));
    });

    it("rejects when the client aborts mid-body", async () => {
      let settled!: Promise<string | null>;
      const reading = new Promise<void>((resolve) => {
        void listen((request) => {
          settled = readBoundedBody(request, 1024);
          resolve();
        }).then((port) => {
          const client = httpRequest({
            host: "127.0.0.1",
            port,
            method: "POST",
            headers: { "content-length": "512" },
          });
          client.on("error", () => {});
          client.write("x".repeat(64), () => setTimeout(() => client.destroy(), 20));
        });
      });
      await reading;
      await expect(settled).rejects.toThrow();
    });
  });
});
