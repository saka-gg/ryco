/**
 * `ryco remote`: the CLI as a client of another Ryco node.
 *
 * A remote is paired exactly the way the apps pair a saved environment — a
 * one-time pairing link is exchanged for a bearer session — and the session is
 * kept in a 0600 file beside this machine's own state. Commands then speak the
 * same WebSocket RPC the apps use, so they have exactly the rights the pairing
 * granted and nothing more.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { createRemoteEnvironmentApi } from "@ryco/client-runtime/connection";
import { resolveRemotePairingTarget } from "@ryco/client-runtime/connection";
import { WsRpcGroup } from "@ryco/contracts";
import { getPairingTokenFromUrl } from "@ryco/shared/pairingUrl";
import { Data, Effect, Layer, Schema, type Scope } from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

export const CliRemote = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  environmentId: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  role: Schema.String,
  token: Schema.String,
  addedAt: Schema.String,
});
export type CliRemote = typeof CliRemote.Type;

const CliRemotesFile = Schema.Struct({
  version: Schema.Literal(1),
  remotes: Schema.Array(CliRemote),
});

const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;

export class CliRemoteError extends Data.TaggedError("CliRemoteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The RPC client a connected remote exposes: the same surface the apps use. */
export type CliRemoteRpcClient = RpcClient.FromGroup<
  typeof WsRpcGroup,
  RpcClientError.RpcClientError
>;

export const cliRemotesPath = (stateDir: string) => path.join(stateDir, "cli-remotes.json");

export async function readCliRemotes(filePath: string): Promise<ReadonlyArray<CliRemote>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  try {
    return Schema.decodeUnknownSync(CliRemotesFile)(JSON.parse(raw)).remotes;
  } catch (cause) {
    throw new CliRemoteError({
      message: `${filePath} is unreadable; remove it and add the remotes again.`,
      cause,
    });
  }
}

/** Written whole, then renamed into place, and never readable by other users: it holds sessions. */
export async function writeCliRemotes(
  filePath: string,
  remotes: ReadonlyArray<CliRemote>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, remotes }, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
}

export function findCliRemote(remotes: ReadonlyArray<CliRemote>, name: string): CliRemote {
  const remote = remotes.find((entry) => entry.name === name);
  if (!remote) {
    throw new CliRemoteError({
      message:
        remotes.length === 0
          ? `No remote named "${name}". Add one with \`ryco remote add ${name} <pairing-url>\`.`
          : `No remote named "${name}". Known remotes: ${remotes.map((entry) => entry.name).join(", ")}.`,
    });
  }
  return remote;
}

const readHostedPairingRequest = (url: URL) => {
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  return host && token ? { host, token } : null;
};

const remoteApi = (baseOrigin: string) =>
  createRemoteEnvironmentApi(
    {
      fetch: (url, init) =>
        globalThis.fetch(
          url,
          init === undefined ? undefined : (init as RequestInit),
        ) as Promise<Response>,
    },
    baseOrigin,
  );

/** Exchange a pairing link (direct or hosted-app form) for a saved remote. */
export async function pairCliRemote(input: {
  readonly name: string;
  readonly pairingUrl: string;
}): Promise<CliRemote> {
  if (!REMOTE_NAME_PATTERN.test(input.name)) {
    throw new CliRemoteError({
      message:
        "Remote names use letters, digits, '.', '_' and '-', starting with a letter or digit.",
    });
  }
  const target = resolveRemotePairingTarget({ pairingUrl: input.pairingUrl }, "https://localhost", {
    readPairingToken: getPairingTokenFromUrl,
    readHostedPairingRequest,
  });
  const api = remoteApi(target.httpBaseUrl);
  const descriptor = await api.fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  });
  const session = await api.bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
  });
  return {
    name: input.name,
    label: descriptor.label,
    environmentId: descriptor.environmentId,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    role: session.role,
    token: session.sessionToken,
    addedAt: new Date().toISOString(),
  };
}

/**
 * An RPC client for a remote, scoped to the caller. The session token never
 * reaches the socket URL; a short-lived WebSocket token minted with it does.
 */
export const connectCliRemote = (
  remote: CliRemote,
): Effect.Effect<CliRemoteRpcClient, CliRemoteError, Scope.Scope> =>
  Effect.gen(function* () {
    const socketUrl = yield* Effect.tryPromise({
      try: () =>
        remoteApi(remote.httpBaseUrl).resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: remote.wsBaseUrl,
          httpBaseUrl: remote.httpBaseUrl,
          bearerToken: remote.token,
        }),
      catch: (cause) =>
        new CliRemoteError({
          message: `Could not reach "${remote.name}" at ${remote.httpBaseUrl}, or its pairing was revoked.`,
          cause,
        }),
    });
    const url = new URL(socketUrl);
    url.pathname = "/ws";
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(url.toString()).pipe(
          Layer.provide(NodeSocket.layerWebSocketConstructor),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );
    // Built into the caller's scope: the socket must outlive client construction.
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(context));
  });
