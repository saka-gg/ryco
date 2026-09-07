import { createServer } from "node:http";
import { expect, it } from "vitest";
import { belongsToProject, parseListeners, probeHttp } from "./discovery.ts";

it("parses IPv4/IPv6 listeners and deduplicates ports", () => {
  expect(
    parseListeners(
      "p10\ncnode\nn*:3000\nn[::1]:3000\np11\ncbun\nn127.0.0.1:5173\nninvalid",
      "darwin",
    ),
  ).toEqual([
    { port: 3000, pid: 10, process: "node" },
    { port: 5173, pid: 11, process: "bun" },
  ]);
});
it("ignores non-listening Windows sockets", () => {
  expect(
    parseListeners(
      "TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 123\nTCP 127.0.0.1:4000 127.0.0.1:3000 ESTABLISHED 124",
      "win32",
    ),
  ).toEqual([{ port: 3000, pid: 123, process: "Process 123" }]);
});
it("does not associate sibling directories or unknown processes with a project", () => {
  expect(belongsToProject("/repo/app", "/repo/application")).toBe(false);
  expect(belongsToProject("/repo/app", "/repo/app/subdir")).toBe(true);
  expect(belongsToProject("/repo/app", undefined)).toBe(false);
});
it("discovers HTTP without downloading response bodies", async () => {
  const server = createServer((request, response) => {
    expect(request.method).toBe("HEAD");
    expect(request.headers.authorization).toBeUndefined();
    response.writeHead(200, { "content-type": "text/html" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    if (!address || typeof address === "string") throw new Error("Missing port");
    await expect(probeHttp(address.port)).resolves.toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("bounds discovery even when a service trickles partial headers", async () => {
  const server = createServer((request) => {
    request.socket.write("HTTP/1.1 200 OK\r\nX-Slow: ");
    const interval = setInterval(() => request.socket.write("a"), 20);
    request.socket.on("close", () => clearInterval(interval));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    if (!address || typeof address === "string") throw new Error("Missing port");
    await expect(probeHttp(address.port)).resolves.toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 2500);
