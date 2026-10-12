import * as FS from "node:fs";
import * as Net from "node:net";
import * as Path from "node:path";

/**
 * Ryco's own default backend port ("RYCO" on a phone keypad). The renderer's
 * origin is the backend URL, so the port decides where localStorage (drafts, UI
 * state) and the HTTP and V8 code caches live. 3773 is also T3 Code's default,
 * and whichever app started first used to take it.
 */
export const DEFAULT_DESKTOP_BACKEND_PORT = 7926;
/**
 * The default before {@link DEFAULT_DESKTOP_BACKEND_PORT}. An installation that
 * already has renderer state starts there, so upgrading never moves its origin.
 */
export const LEGACY_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;

export interface ResolveDesktopBackendPortOptions {
  readonly host: string;
  readonly startPort?: number;
  readonly maxPort?: number;
  readonly requiredHosts?: ReadonlyArray<string>;
  readonly canListenOnHost?: (port: number, host: string) => Promise<boolean>;
}

/**
 * Whether a TCP server can bind {host, port}. `EADDRNOTAVAIL` counts as
 * available so a host without IPv6 does not fail the `::` probe.
 */
export function canListenOnHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = Net.createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRNOTAVAIL");
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}

const isValidPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= MAX_TCP_PORT;

export function normalizeDesktopBackendPort(value: unknown): number | null {
  return typeof value === "number" && isValidPort(value) ? value : null;
}

/** Whether an earlier launch already stored renderer state (under the legacy origin). */
export function hasPriorDesktopRendererState(userDataPath: string): boolean {
  return FS.existsSync(Path.join(userDataPath, "Local Storage"));
}

/** Where the upward scan starts: the last served port, else a per-install default. */
export function resolveDesktopBackendStartPort(input: {
  readonly persistedPort: number | null;
  readonly hasPriorRendererState: boolean;
}): number {
  if (input.persistedPort !== null) return input.persistedPort;
  return input.hasPriorRendererState ? LEGACY_DESKTOP_BACKEND_PORT : DEFAULT_DESKTOP_BACKEND_PORT;
}

/**
 * Whether the port a launch serves on may be remembered as the preferred one.
 *
 * The renderer origin follows the port, so moving it strands localStorage
 * (composer drafts, UI state), saved LAN endpoints and the caches of the old
 * origin. Only two cases are persisted:
 * - the preferred port served (the persisted one, or the per-install default),
 * - a fresh install (no persisted port and no renderer state yet) took a
 *   fallback: there is nothing to strand, and remembering it keeps it stable.
 *
 * A fallback taken because the preferred port was busy for one launch (T3 Code
 * started first, an orphaned backend) is used for that launch only; the next
 * launch tries the preferred port again.
 */
export function shouldPersistDesktopBackendPort(input: {
  readonly servedPort: number;
  readonly preferredPort: number;
  readonly persistedPort: number | null;
  readonly hasPriorRendererState: boolean;
}): boolean {
  if (input.servedPort === input.preferredPort) return true;
  return input.persistedPort === null && !input.hasPriorRendererState;
}

const normalizeHosts = (
  host: string,
  requiredHosts: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  Array.from(
    new Set(
      [host, ...requiredHosts]
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0),
    ),
  );

async function canListenOnAllHosts(
  port: number,
  hosts: ReadonlyArray<string>,
  probe: (port: number, host: string) => Promise<boolean>,
): Promise<boolean> {
  for (const candidateHost of hosts) {
    if (!(await probe(port, candidateHost))) {
      return false;
    }
  }

  return true;
}

export async function resolveDesktopBackendPort({
  host,
  startPort = DEFAULT_DESKTOP_BACKEND_PORT,
  maxPort = MAX_TCP_PORT,
  requiredHosts = [],
  canListenOnHost: probe = canListenOnHost,
}: ResolveDesktopBackendPortOptions): Promise<number> {
  if (!isValidPort(startPort)) {
    throw new Error(`Invalid desktop backend start port: ${startPort}`);
  }

  if (!isValidPort(maxPort)) {
    throw new Error(`Invalid desktop backend max port: ${maxPort}`);
  }

  if (maxPort < startPort) {
    throw new Error(`Desktop backend max port ${maxPort} is below start port ${startPort}`);
  }

  const hostsToCheck = normalizeHosts(host, requiredHosts);

  // Keep the renderer origin stable across restarts by probing upward from the
  // same preferred port instead of picking a fresh ephemeral port.
  for (let port = startPort; port <= maxPort; port += 1) {
    if (await canListenOnAllHosts(port, hostsToCheck, probe)) {
      return port;
    }
  }

  throw new Error(
    `No desktop backend port is available on hosts ${hostsToCheck.join(", ")} between ${startPort} and ${maxPort}`,
  );
}
