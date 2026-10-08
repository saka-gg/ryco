// @effect-diagnostics nodeBuiltinImport:off - raw sockets speak SOCKS5 and DNS to the proxy.
import * as NodeDgram from "node:dgram";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { vi } from "vite-plus/test";

import { isLocalAddress, makePublicProxy, publicProxy } from "./publicProxy.ts";

// A public IPv4 address this machine holds, which no private range covers.
const OWN_PUBLIC_IPV4 = "203.0.113.7";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOS>();
  return {
    ...actual,
    networkInterfaces: () => ({
      ...actual.networkInterfaces(),
      "ryco-test": [
        {
          address: OWN_PUBLIC_IPV4,
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: `${OWN_PUBLIC_IPV4}/24`,
        },
      ],
    }),
  };
});

/** Sends a SOCKS5 greeting and CONNECT, and resolves with the reply code. */
const connectThrough = (proxyPort: number, target: Buffer, version = 5) =>
  Effect.callback<{ readonly code: number; readonly socket: NodeNet.Socket }>((resume) => {
    const socket = NodeNet.connect(proxyPort, "127.0.0.1", () => {
      socket.write(Buffer.from([5, 1, 0]));
      socket.write(Buffer.concat([Buffer.from([version, 1, 0]), target]));
    });
    // The proxy may reset a refused connection.
    socket.on("error", () => {});
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      // Method selection (2 bytes) then the 10-byte reply.
      if (received.length >= 12) resume(Effect.succeed({ code: received[3]!, socket }));
    });
    socket.on("close", () => resume(Effect.succeed({ code: received[3] ?? -1, socket })));
  });

const ipv4Target = (address: string, port: number) => {
  const target = Buffer.alloc(7);
  target[0] = 1;
  address.split(".").forEach((octet, index) => (target[1 + index] = Number(octet)));
  target.writeUInt16BE(port, 5);
  return target;
};

const ipv6Target = (address: string, port: number) => {
  const target = Buffer.alloc(19);
  target[0] = 4;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  groups.forEach((group, index) => target.writeUInt16BE(Number.parseInt(group, 16), 1 + index * 2));
  target.writeUInt16BE(port, 17);
  return target;
};

/** `a.b.c.d` as the two hex groups of an IPv4-mapped IPv6 address. */
const toHexPair = (address: string) => {
  const [a = 0, b = 0, c = 0, d = 0] = address.split(".").map(Number);
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
};

const domainTarget = (host: string, port: number) => {
  const name = Buffer.from(host, "latin1");
  const target = Buffer.alloc(4 + name.length);
  target[0] = 3;
  target[1] = name.length;
  name.copy(target, 2);
  target.writeUInt16BE(port, 2 + name.length);
  return target;
};

/** A TCP server on loopback that records every connection it accepts. */
const loopbackServer = Effect.acquireRelease(
  Effect.callback<{ readonly server: NodeNet.Server; readonly accepted: Array<string> }>(
    (resume) => {
      const accepted: Array<string> = [];
      const server = NodeNet.createServer((socket) => {
        accepted.push(`${socket.remoteAddress}`);
        socket.destroy();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, accepted })));
    },
  ),
  ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
);

/**
 * A DNS server on loopback that answers A and AAAA questions from `records`,
 * never answers names in `silent`, and records every question it receives.
 */
const fakeDnsServer = (
  records: Readonly<Record<string, { readonly a?: string; readonly aaaa?: string }>>,
  silent: (name: string) => boolean,
) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly socket: NodeDgram.Socket;
      readonly questions: Array<string>;
      readonly server: string;
    }>((resume) => {
      const questions: Array<string> = [];
      const socket = NodeDgram.createSocket("udp4");
      socket.on("message", (query, peer) => {
        const labels: Array<string> = [];
        let at = 12;
        while (query[at]! > 0) {
          labels.push(query.subarray(at + 1, at + 1 + query[at]!).toString("latin1"));
          at += 1 + query[at]!;
        }
        const name = labels.join(".").toLowerCase();
        const type = query.readUInt16BE(at + 1);
        questions.push(`${name} ${type === 1 ? "A" : type === 28 ? "AAAA" : type}`);
        if (silent(name)) return;
        const question = query.subarray(12, at + 5);
        const record = records[name];
        const address = type === 1 ? record?.a : type === 28 ? record?.aaaa : undefined;
        const answer =
          address === undefined
            ? Buffer.alloc(0)
            : Buffer.concat([
                Buffer.from([0xc0, 12, 0, type, 0, 1, 0, 0, 0, 60, 0, type === 1 ? 4 : 16]),
                type === 1
                  ? Buffer.from(address.split(".").map(Number))
                  : ipv6Target(address, 0).subarray(1, 17),
              ]);
        const header = Buffer.alloc(12);
        query.copy(header, 0, 0, 2);
        // A response to a recursive query; no such name unless the name is known.
        header.writeUInt16BE(record === undefined ? 0x8183 : 0x8180, 2);
        header.writeUInt16BE(1, 4);
        header.writeUInt16BE(address === undefined ? 0 : 1, 6);
        socket.send(Buffer.concat([header, question, answer]), peer.port, peer.address);
      });
      socket.bind(0, "127.0.0.1", () =>
        resume(Effect.succeed({ socket, questions, server: `127.0.0.1:${socket.address().port}` })),
      );
    }),
    ({ socket }) => Effect.callback<void>((resume) => void socket.close(() => resume(Effect.void))),
  );

describe("isLocalAddress", () => {
  it.each([
    ["127.0.0.1", 4, true],
    ["10.1.2.3", 4, true],
    ["100.64.0.1", 4, true],
    ["169.254.169.254", 4, true],
    ["172.16.5.4", 4, true],
    ["192.168.1.1", 4, true],
    ["192.0.0.170", 4, true],
    ["198.18.0.1", 4, true],
    ["224.0.0.251", 4, true],
    ["255.255.255.255", 4, true],
    ["0.0.0.0", 4, true],
    [OWN_PUBLIC_IPV4, 4, true],
    ["::1", 6, true],
    ["::", 6, true],
    ["::ffff:127.0.0.1", 6, true],
    ["::ffff:a00:1", 6, true],
    [`::ffff:${toHexPair(OWN_PUBLIC_IPV4)}`, 6, true],
    ["fd12:3456::1", 6, true],
    ["fe80::1%lo0", 6, true],
    ["fec0::1", 6, true],
    ["ff02::1", 6, true],
    ["64:ff9b::7f00:1", 6, true],
    ["64:ff9b::a9fe:a9fe", 6, true],
    ["64:ff9b:1::1", 6, true],
    ["2002:c0a8:101::1", 6, true],
    ["2001::1", 6, true],
    ["100::1", 6, true],
    ["not an address", 4, true],
    ["8.8.8.8", 4, false],
    ["1.1.1.1", 4, false],
    ["::ffff:808:808", 6, false],
    ["64:ff9b::808:808", 6, false],
    ["2002:808:808::1", 6, false],
    ["2606:4700:4700::1111", 6, false],
  ] as const)("%s is local: %s", (address, family, local) => {
    expect(isLocalAddress(address, family)).toBe(local);
  });
});

describe("publicProxy", () => {
  it.effect("refuses loopback and private targets, by address or by name", () =>
    Effect.gen(function* () {
      const port = yield* publicProxy;
      for (const target of [
        ipv4Target("127.0.0.1", 80),
        ipv4Target("10.1.2.3", 80),
        ipv4Target("169.254.169.254", 80),
        ipv4Target("198.18.0.1", 80),
        domainTarget("localhost", 80),
        domainTarget("ryco-page.localhost", 80),
        // IPv6 forms that carry a local IPv4 address: NAT64, 6to4, Teredo,
        // IPv4-compatible, and IPv4-mapped.
        ipv6Target("64:ff9b::7f00:1", 80),
        ipv6Target("64:ff9b::a00:1", 80),
        ipv6Target("2002:7f00:1::1", 80),
        ipv6Target("2001::1", 80),
        ipv6Target("::7f00:1", 80),
        ipv6Target("::ffff:7f00:1", 80),
        ipv6Target("::1", 80),
      ]) {
        const { code, socket } = yield* connectThrough(port, target);
        socket.destroy();
        expect(code).toBe(2);
      }
      // Port 0 is not a connection target.
      const { code, socket } = yield* connectThrough(port, ipv4Target("1.1.1.1", 0));
      socket.destroy();
      expect(code).toBe(7);
    }).pipe(Effect.scoped),
  );

  it.effect("never connects to a service listening on loopback", () =>
    Effect.gen(function* () {
      const { server, accepted } = yield* loopbackServer;
      const address = server.address();
      const servicePort = typeof address === "object" && address !== null ? address.port : 0;
      const port = yield* publicProxy;
      for (const target of [
        ipv4Target("127.0.0.1", servicePort),
        domainTarget("localhost", servicePort),
        domainTarget("127.0.0.1", servicePort),
      ]) {
        const { code, socket } = yield* connectThrough(port, target);
        socket.destroy();
        expect(code).toBe(2);
      }
      expect(accepted).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses every address this machine holds, even a public one", () =>
    Effect.gen(function* () {
      const port = yield* publicProxy;
      const own = Object.values(NodeOS.networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .filter((entry) => !entry.internal && !entry.address.startsWith("fe80"));
      expect(own.map((entry) => entry.address)).toContain(OWN_PUBLIC_IPV4);
      // IPv4 also as IPv4-mapped IPv6, which names the same host.
      const targets = own.flatMap((entry) =>
        entry.family === "IPv6"
          ? [ipv6Target(entry.address, 80)]
          : [
              ipv4Target(entry.address, 80),
              ipv6Target(`::ffff:${toHexPair(entry.address)}`, 80),
              ipv6Target(`64:ff9b::${toHexPair(entry.address)}`, 80),
            ],
      );
      for (const target of targets) {
        const { code, socket } = yield* connectThrough(port, target);
        socket.destroy();
        expect(code).toBe(2);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a request with a wrong version byte or another command", () =>
    Effect.gen(function* () {
      const port = yield* publicProxy;
      const wrongVersion = yield* connectThrough(port, ipv4Target("1.1.1.1", 443), 4);
      wrongVersion.socket.destroy();
      expect(wrongVersion.code).toBe(7);
      // BIND (2) instead of CONNECT.
      const bind = yield* Effect.callback<number>((resume) => {
        const socket = NodeNet.connect(port, "127.0.0.1", () => {
          socket.write(Buffer.from([5, 1, 0]));
          socket.write(Buffer.concat([Buffer.from([5, 2, 0]), ipv4Target("1.1.1.1", 443)]));
        });
        socket.on("error", () => {});
        let received = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          received = Buffer.concat([received, chunk]);
          if (received.length >= 12) {
            socket.destroy();
            resume(Effect.succeed(received[3]!));
          }
        });
      });
      expect(bind).toBe(7);
    }).pipe(Effect.scoped),
  );

  it.effect("fails instead of crashing when it cannot listen", () =>
    Effect.gen(function* () {
      const exhausted = Object.assign(new Error("too many open files"), { code: "EMFILE" });
      const listen = vi
        .spyOn(NodeNet.Server.prototype, "listen")
        .mockImplementationOnce(function (this: NodeNet.Server) {
          process.nextTick(() => this.emit("error", exhausted));
          return this;
        });
      const error = yield* publicProxy.pipe(Effect.flip, Effect.scoped);
      listen.mockRestore();
      expect(error).toBe(exhausted);
    }),
  );

  it.effect("resolves names with its own resolver and refuses any local answer", () =>
    Effect.gen(function* () {
      const dns = yield* fakeDnsServer(
        {
          "loopback.test": { a: "127.0.0.1" },
          "metadata.test": { a: "169.254.169.254" },
          // One public address does not make up for a local one.
          "mixed.test": { a: "8.8.8.8", aaaa: "::1" },
        },
        () => false,
      );
      const port = yield* makePublicProxy({ dnsServers: [dns.server] });
      for (const name of ["loopback.test", "metadata.test", "mixed.test", "missing.test"]) {
        const { code, socket } = yield* connectThrough(port, domainTarget(name, 80));
        socket.destroy();
        expect(code, name).toBe(2);
      }
      // Asked over DNS rather than the system's getaddrinfo, both families.
      expect(dns.questions).toEqual(
        expect.arrayContaining(["loopback.test A", "loopback.test AAAA", "mixed.test AAAA"]),
      );
    }).pipe(Effect.scoped),
  );

  it.live("refuses names that never resolve in time, many at once, off the thread pool", () =>
    Effect.gen(function* () {
      const dns = yield* fakeDnsServer({}, () => true);
      const port = yield* makePublicProxy({ dnsServers: [dns.server], lookupTimeoutMs: 300 });
      const started = Date.now();
      // getaddrinfo would resolve these a few at a time on libuv's thread pool,
      // holding up every other lookup in this process; on macOS each .local
      // name takes it five seconds of multicast DNS.
      const codes = yield* Effect.forEach(
        Array.from({ length: 24 }, (_, index) => `ryco-slow-${index}-${started}.local`),
        (name) =>
          connectThrough(port, domainTarget(name, 80)).pipe(
            Effect.map(({ code, socket }) => {
              socket.destroy();
              return code;
            }),
          ),
        { concurrency: "unbounded" },
      );
      expect(codes).toEqual(Array.from({ length: 24 }, () => 2));
      expect(Date.now() - started).toBeLessThan(2_000);
      const lookupStarted = Date.now();
      yield* Effect.promise(() => NodeDnsPromises.lookup("localhost"));
      expect(Date.now() - lookupStarted).toBeLessThan(500);
    }).pipe(Effect.scoped),
  );

  it.live("stops resolving once its scope closes", () =>
    Effect.gen(function* () {
      const dns = yield* fakeDnsServer({}, () => true);
      const scope = yield* Scope.make();
      const port = yield* makePublicProxy({ dnsServers: [dns.server] }).pipe(Scope.provide(scope));
      // Unanswered, so the resolver would ask again and again for seconds.
      const client = NodeNet.connect(port, "127.0.0.1", () => {
        client.write(Buffer.from([5, 1, 0]));
        client.write(Buffer.concat([Buffer.from([5, 1, 0]), domainTarget("stuck.test", 80)]));
      });
      client.on("error", () => {});
      yield* Effect.sleep("150 millis");
      expect(dns.questions.length).toBeGreaterThan(0);
      yield* Scope.close(scope, Exit.void);
      const asked = dns.questions.length;
      yield* Effect.sleep("2500 millis");
      client.destroy();
      expect(dns.questions.length).toBe(asked);
    }).pipe(Effect.scoped),
  );

  it.effect("closes every connection when its scope closes", () =>
    Effect.gen(function* () {
      const socket = yield* Effect.scoped(
        Effect.gen(function* () {
          const port = yield* publicProxy;
          return yield* Effect.callback<NodeNet.Socket>((resume) => {
            // A client mid-handshake, which the proxy must not wait on; closing
            // resets it.
            const client = NodeNet.connect(port, "127.0.0.1", () => {
              client.write(Buffer.from([5, 1, 0]));
              resume(Effect.succeed(client));
            });
            client.on("error", () => {});
          });
        }),
      );
      yield* Effect.callback<void>((resume) => {
        if (socket.closed) return resume(Effect.void);
        socket.once("close", () => resume(Effect.void));
      });
      expect(socket.closed).toBe(true);
    }),
  );
});
