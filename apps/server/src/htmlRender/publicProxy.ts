// @effect-diagnostics nodeBuiltinImport:off - Effect has no SOCKS proxy or address block list.
/**
 * publicProxy - The SOCKS5 proxy every HTML preview browser connection goes
 * through. It only reaches public addresses, so an agent's page can never
 * reach this machine, its local network, or Ryco's own loopback services.
 *
 * @module publicProxy
 */
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { Effect } from "effect";

/** This machine and its local networks, which HTML previews must never reach. */
const LOCAL_ADDRESSES = new NodeNet.BlockList();
for (const [network, prefix] of [
  // "This network", private, carrier-grade NAT, loopback, link-local (cloud
  // metadata), private, IETF protocol assignments, private, benchmarking, and
  // multicast through the reserved and broadcast ranges.
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
// Also the IPv6 ranges that carry an IPv4 address a translator may route to
// without checking it (IPv4-compatible, local-use NAT64, Teredo), discard-only,
// unique local, link-local, deprecated site-local, and multicast.
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const NAT64 = new NodeNet.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new NodeNet.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

/** The sixteen-bit groups of an IPv6 address, which may end in dotted IPv4. */
const ipv6Groups = (address: string) => {
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted
    ? `${address.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : address;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

/**
 * The IPv4 address a NAT64 or 6to4 address stands for, which a translator
 * will route to, so it is checked as well. Public NAT64 targets stay
 * reachable, as on IPv6-only networks.
 */
const embeddedIPv4 = (address: string) => {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

/** The addresses this machine's interfaces hold right now. */
const ownAddresses = () => {
  const own = new NodeNet.BlockList();
  for (const entry of Object.values(NodeOS.networkInterfaces()).flat()) {
    if (!entry) continue;
    try {
      own.addAddress(entry.address.split("%", 1)[0]!, entry.family === "IPv6" ? "ipv6" : "ipv4");
    } catch {
      // An address Node cannot parse cannot be connected to through it either.
    }
  }
  return own;
};

/**
 * Whether `address` belongs to a local network or to this machine itself,
 * including a public address one of its interfaces holds. Both lists match
 * IPv4-mapped IPv6 against their IPv4 entries. Anything unparsable counts as
 * local.
 */
export const isLocalAddress = (address: string, family: number): boolean => {
  const bare = address.split("%", 1)[0]!;
  const type = family === 6 ? "ipv6" : "ipv4";
  // A block list matches nothing it cannot parse.
  if (NodeNet.isIP(bare) !== (family === 6 ? 6 : 4)) return true;
  try {
    if (LOCAL_ADDRESSES.check(bare, type) || ownAddresses().check(bare, type)) return true;
    const embedded = family === 6 ? embeddedIPv4(bare) : undefined;
    return embedded !== undefined && isLocalAddress(embedded, 4);
  } catch {
    return true;
  }
};

export interface PublicProxyOptions {
  /** The DNS servers to ask instead of the system's, as `host[:port]`. */
  readonly dnsServers?: ReadonlyArray<string>;
  /** How long a name may take to resolve before its connection is refused. */
  readonly lookupTimeoutMs?: number;
}

const LOOKUP_TIMEOUT_MS = 5_000;

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Every address `host` resolves to, or none. Names go to DNS through c-ares,
 * never the system's `getaddrinfo`: that runs on libuv's small thread pool,
 * where a page's slow names would hold up every other lookup in the server,
 * and it cannot be cancelled. A public-only proxy has no use for /etc/hosts.
 */
const resolveName = (resolver: NodeDnsPromises.Resolver, host: string, timeoutMs: number) => {
  const query = (family: 4 | 6) =>
    (family === 4 ? resolver.resolve4(host) : resolver.resolve6(host)).then(
      (addresses) => addresses.map((address): ResolvedAddress => ({ address, family })),
      (): Array<ResolvedAddress> => [],
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  // c-ares gives up on its own; this bounds it where its timeout is ignored.
  const deadline = new Promise<Array<ResolvedAddress>>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs);
  });
  return Promise.race([
    Promise.all([query(4), query(6)]).then(([ipv4, ipv6]) => [...ipv4, ...ipv6]),
    deadline,
  ]).finally(() => clearTimeout(timer));
};

/**
 * The addresses to connect to for `host`, or undefined when any address it
 * resolves to is local. The caller connects only to addresses checked here,
 * so a name that later resolves elsewhere (DNS rebinding) changes nothing.
 */
const publicAddresses = async (
  host: string,
  resolve: (host: string) => Promise<ReadonlyArray<ResolvedAddress>>,
) => {
  const family = NodeNet.isIP(host);
  const addresses: ReadonlyArray<ResolvedAddress> =
    family === 4 || family === 6 ? [{ address: host, family }] : await resolve(host);
  if (addresses.length === 0) return undefined;
  const local = addresses.some(({ address, family }) => isLocalAddress(address, family));
  return local ? undefined : addresses;
};

// SOCKS5 (RFC 1928) replies: success, refused by rule, host unreachable, command unsupported.
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

// What a client may send before its tunnel opens; a TLS hello fits easily.
const MAX_EARLY_BYTES = 64 * 1024;

/**
 * Answers and closes. The client is never read from again, so anything it
 * sent after its request is dropped rather than left buffered.
 */
const refuse = (client: NodeNet.Socket, code: number) => {
  client.end(reply(code), () => client.destroy());
};

/** The CONNECT target in a complete SOCKS5 request, or "short" when more bytes are needed. */
const readRequest = (data: Buffer) => {
  if (data.length < 5) return "short" as const;
  // Version 5, reserved byte 0.
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short" as const;
  const host =
    type === 1
      ? [...data.subarray(4, 8)].join(".")
      : type === 3
        ? data.subarray(5, 5 + data[4]!).toString("latin1")
        : Array.from({ length: 8 }, (_, index) =>
            data.readUInt16BE(4 + index * 2).toString(16),
          ).join(":");
  return { command: data[1], host, port: data.readUInt16BE(end - 2), rest: data.subarray(end) };
};

/**
 * Starts a SOCKS5 proxy on loopback for the life of the scope and returns its
 * port. The preview browser sends every connection through it, and it only
 * connects to public addresses. Chrome's Local Network Access misses some
 * requests, such as speculation-rules prefetches; nothing misses this. It
 * carries bytes only, so HTTP, TLS, and WebSockets pass through unchanged.
 * Closing the scope also cancels the lookups still in flight.
 */
export const makePublicProxy = (options: PublicProxyOptions = {}) =>
  Effect.acquireRelease(
    Effect.callback<
      {
        readonly server: NodeNet.Server;
        readonly sockets: Set<NodeNet.Socket>;
        readonly resolver: NodeDnsPromises.Resolver;
      },
      Error
    >((resume) => {
      const resolver = new NodeDnsPromises.Resolver({ timeout: 2_000, tries: 2 });
      if (options.dnsServers) {
        try {
          resolver.setServers([...options.dnsServers]);
        } catch (error) {
          return resume(Effect.fail(error instanceof Error ? error : new Error(String(error))));
        }
      }
      const timeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
      const resolve = (host: string) => resolveName(resolver, host, timeoutMs);
      const sockets = new Set<NodeNet.Socket>();
      const track = (socket: NodeNet.Socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        return socket;
      };
      const server = NodeNet.createServer((client) => {
        track(client);
        let data = Buffer.alloc(0);
        let greeted = false;
        const onData = (chunk: Buffer) => {
          data = Buffer.concat([data, chunk]);
          if (!greeted) {
            if (data.length < 2 || data.length < 2 + data[1]!) return;
            // Version 5, offering "no authentication".
            if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
              return void client.end(Buffer.from([5, 0xff]));
            }
            data = data.subarray(2 + data[1]!);
            greeted = true;
            client.write(Buffer.from([5, 0]));
          }
          const request = readRequest(data);
          if (request === "short") return;
          client.off("data", onData);
          if (request === undefined || request.command !== 1 || request.port === 0) {
            return refuse(client, 7);
          }
          // Keeps reading while the target resolves, so a client that leaves is
          // noticed, and holds what it sends early up to a small cap.
          const early: Array<Buffer> = [request.rest];
          let earlyBytes = request.rest.length;
          const holdEarly = (chunk: Buffer) => {
            earlyBytes += chunk.length;
            if (earlyBytes > MAX_EARLY_BYTES) return void client.destroy();
            early.push(chunk);
          };
          client.on("data", holdEarly);
          void publicAddresses(request.host, resolve).then((addresses) => {
            if (client.destroyed) return;
            client.off("data", holdEarly);
            if (addresses === undefined) return refuse(client, 2);
            client.pause();
            // Tries every checked address, IPv6 and IPv4 alike, so a host is
            // still reached on a network whose IPv6 route is broken. A name goes
            // through `lookup`, which hands back only the checked addresses; an
            // address literal connects as itself.
            const upstream = track(
              NodeNet.connect({
                host: request.host,
                port: request.port,
                autoSelectFamily: true,
                lookup: (_host, options, callback) =>
                  options.all
                    ? callback(null, [...addresses])
                    : callback(null, addresses[0]!.address, addresses[0]!.family),
              }),
            );
            upstream.once("connect", () => {
              client.write(reply(0));
              for (const chunk of early) upstream.write(chunk);
              upstream.pipe(client);
              client.pipe(upstream);
            });
            upstream.on("close", () => client.destroy());
            client.on("close", () => upstream.destroy());
          });
        };
        client.on("data", onData);
      });
      // A failure to listen fails this preview; once listening, a server error
      // must not reach Node as an unhandled event either.
      let listening = false;
      server.on("error", (error) => {
        if (!listening) resume(Effect.fail(error));
      });
      server.listen(0, "127.0.0.1", () => {
        listening = true;
        resume(Effect.succeed({ server, sockets, resolver }));
      });
    }),
    ({ server, sockets, resolver }) =>
      Effect.callback<void>((resume) => {
        resolver.cancel();
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.map(({ server }) => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : 0;
    }),
  );

/** `makePublicProxy` with the system's DNS servers. */
export const publicProxy = makePublicProxy();
