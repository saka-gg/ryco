import * as NodeNet from "node:net";

import { Effect, FileSystem, Option, Schema } from "effect";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { type ServerConfigShape } from "./config.ts";
import { defaultProcessAlive } from "./processLock/processIdentity.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

const PersistedServerRuntimeStateJson = Schema.fromJsonString(PersistedServerRuntimeState);

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  PersistedServerRuntimeStateJson,
);

/** The runtime-state file's contents, for readers outside Effect. */
export const parsePersistedServerRuntimeState = (
  contents: string,
): Option.Option<PersistedServerRuntimeState> =>
  Schema.decodeUnknownOption(PersistedServerRuntimeStateJson)(contents.trim());

const runtimeOriginForConfig = (
  config: Pick<ServerConfigShape, "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<ServerConfigShape, "host">;
  readonly port: number;
}): PersistedServerRuntimeState => ({
  version: 1,
  pid: process.pid,
  ...(input.config.host ? { host: input.config.host } : {}),
  port: input.port,
  origin: runtimeOriginForConfig(input.config, input.port),
  startedAt: new Date().toISOString(),
});

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  });

export const clearPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, { force: true }).pipe(Effect.ignore({ log: true }));
  });

/** The host the server a runtime-state file names accepts connections on. */
export function persistedServerHost(state: Pick<PersistedServerRuntimeState, "origin">): string {
  try {
    const hostname = new URL(state.origin).hostname;
    if (hostname.length > 0) return hostname.replace(/^\[(.*)\]$/u, "$1");
  } catch {
    // Not a URL: the server's own loopback default.
  }
  return "127.0.0.1";
}

/** Whether something accepts TCP connections at `host:port` within `timeoutMs`. */
export const isAcceptingConnections = (host: string, port: number, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.connect({ host, port });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

export interface PersistedServerProbe {
  readonly processAlive: (pid: number) => boolean;
  readonly isListening: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

const defaultPersistedServerProbe: PersistedServerProbe = {
  processAlive: defaultProcessAlive,
  isListening: isAcceptingConnections,
};

/** A busy server's kernel still accepts the connection; only a closed port is refused. */
const SERVER_LISTEN_TIMEOUT_MS = 300;

/**
 * Whether the server a runtime-state file names still runs: its pid is alive
 * and something accepts connections on its port, which rules out a reused pid.
 * A busy server (still hydrating, stalled) passes: its kernel accepts the
 * connection although the server would not answer a request in time.
 */
export const isPersistedServerRunning = async (
  state: Pick<PersistedServerRuntimeState, "pid" | "port" | "origin">,
  probe: PersistedServerProbe = defaultPersistedServerProbe,
): Promise<boolean> =>
  state.pid > 0 &&
  state.port > 0 &&
  state.port <= 65_535 &&
  probe.processAlive(state.pid) &&
  (await probe.isListening(persistedServerHost(state), state.port, SERVER_LISTEN_TIMEOUT_MS));

/**
 * Clear a runtime-state file whose server is gone. A live server that merely
 * did not answer in time (busy, still hydrating) keeps its file: the database
 * owner check recognizes servers from before the owner lock by it.
 */
export const clearPersistedServerRuntimeStateIfStale = (
  path: string,
  state: Pick<PersistedServerRuntimeState, "pid" | "port" | "origin">,
  probe?: PersistedServerProbe,
) =>
  Effect.promise(() => isPersistedServerRunning(state, probe)).pipe(
    Effect.flatMap((running) => (running ? Effect.void : clearPersistedServerRuntimeState(path))),
  );

export const readPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(Effect.option);
  });
