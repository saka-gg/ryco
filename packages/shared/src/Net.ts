import * as Net from "node:net";

import { Data, Effect, Layer, Context } from "effect";

export class NetError extends Data.TaggedError("NetError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function isErrnoExceptionWithCode(cause: unknown): cause is {
  readonly code: string;
} {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof (cause as { readonly code: unknown }).code === "string"
  );
}

const closeServer = (server: Net.Server) => {
  try {
    server.close();
  } catch {
    // Ignore close failures during cleanup.
  }
};

/** How many ports from the preferred one to try before taking an ephemeral port. */
const PREFERRED_PORT_ATTEMPTS = 10;

const tryReservePort = (port: number, host?: string): Effect.Effect<number, NetError> =>
  Effect.callback<number, NetError>((resume) => {
    const server = Net.createServer();
    let settled = false;

    const settle = (effect: Effect.Effect<number, NetError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };

    server.unref();

    server.once("error", (cause) => {
      settle(Effect.fail(new NetError({ message: "Could not find an available port.", cause })));
    });

    server.listen(host === undefined ? { port } : { port, host }, () => {
      const address = server.address();
      const resolved = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (resolved > 0) {
          settle(Effect.succeed(resolved));
          return;
        }
        settle(Effect.fail(new NetError({ message: "Could not find an available port." })));
      });
    });

    return Effect.sync(() => {
      closeServer(server);
    });
  });

export interface NetServiceShape {
  /**
   * Returns true when a TCP server can bind to {host, port}.
   */
  readonly canListenOnHost: (port: number, host: string) => Effect.Effect<boolean>;

  /**
   * Checks loopback availability on both IPv4 and IPv6 localhost addresses.
   */
  readonly isPortAvailableOnLoopback: (port: number) => Effect.Effect<boolean>;

  /**
   * Reserve an ephemeral loopback port and release it immediately.
   */
  readonly reserveLoopbackPort: (host?: string) => Effect.Effect<number, NetError>;

  /**
   * Resolve an available listening port for `host`, preferring the provided
   * port and the next few after it before falling back to an ephemeral one.
   *
   * With no host (or a wildcard) the port must also be free on 127.0.0.1: on
   * macOS a wildcard bind succeeds even while another process holds the same
   * port on loopback, which made a free-looking port fail at startup.
   */
  readonly findAvailablePort: (preferred: number, host?: string) => Effect.Effect<number, NetError>;
}

/**
 * NetService - Service tag for startup networking helpers.
 */
export class NetService extends Context.Service<NetService, NetServiceShape>()(
  "@ryco/shared/Net/NetService",
) {
  static readonly layer = Layer.sync(NetService, () => {
    /**
     * Returns true when a TCP server can bind to {host, port}.
     * `EADDRNOTAVAIL` is treated as available so IPv6-absent hosts don't fail
     * loopback availability checks.
     */
    const canListenOnHost = (port: number, host: string): Effect.Effect<boolean> =>
      Effect.callback<boolean>((resume) => {
        const server = Net.createServer();
        let settled = false;

        const settle = (value: boolean) => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(value));
        };

        server.unref();

        server.once("error", (cause) => {
          if (isErrnoExceptionWithCode(cause) && cause.code === "EADDRNOTAVAIL") {
            settle(true);
            return;
          }
          settle(false);
        });

        server.once("listening", () => {
          server.close(() => {
            settle(true);
          });
        });

        server.listen({ host, port });

        return Effect.sync(() => {
          closeServer(server);
        });
      });

    /**
     * Reserve an ephemeral loopback port and release it immediately.
     * Returns the reserved port number.
     */
    const reserveLoopbackPort = (host = "127.0.0.1"): Effect.Effect<number, NetError> =>
      Effect.callback<number, NetError>((resume) => {
        const probe = Net.createServer();
        let settled = false;

        const settle = (effect: Effect.Effect<number, NetError>) => {
          if (settled) return;
          settled = true;
          resume(effect);
        };

        probe.once("error", (cause) => {
          settle(Effect.fail(new NetError({ message: "Failed to reserve loopback port", cause })));
        });

        probe.listen(0, host, () => {
          const address = probe.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          probe.close(() => {
            if (port > 0) {
              settle(Effect.succeed(port));
              return;
            }
            settle(Effect.fail(new NetError({ message: "Failed to reserve loopback port" })));
          });
        });

        return Effect.sync(() => {
          closeServer(probe);
        });
      });

    return {
      canListenOnHost,
      isPortAvailableOnLoopback: (port) =>
        Effect.zipWith(
          canListenOnHost(port, "127.0.0.1"),
          canListenOnHost(port, "::1"),
          (ipv4, ipv6) => ipv4 && ipv6,
        ),
      reserveLoopbackPort,
      findAvailablePort: (preferred, host) => {
        const hosts =
          host === undefined || host === "0.0.0.0" || host === "::" || host === "[::]"
            ? [undefined, "127.0.0.1"]
            : [host.replace(/^\[(.*)\]$/u, "$1")];
        const tryEveryHost = (port: number): Effect.Effect<number, NetError> =>
          Effect.forEach(hosts, (candidate) => tryReservePort(port, candidate), {
            discard: true,
          }).pipe(Effect.as(port));
        const candidates =
          preferred > 0
            ? Array.from(
                { length: PREFERRED_PORT_ATTEMPTS },
                (_, index) => preferred + index,
              ).filter((port) => port <= 65_535)
            : [];
        const tryCandidates = (index: number): Effect.Effect<number, NetError> =>
          index >= candidates.length
            ? tryReservePort(0, hosts[hosts.length - 1])
            : Effect.catch(tryEveryHost(candidates[index]!), () => tryCandidates(index + 1));
        return tryCandidates(0);
      },
    } satisfies NetServiceShape;
  });
}
