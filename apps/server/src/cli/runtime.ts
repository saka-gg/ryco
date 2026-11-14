/**
 * Running a CLI command against this node: its auth control plane, or the running server as an
 * ephemeral owner session.
 */
import { Duration, Effect, Layer, Option, References, Schema } from "effect";
// oxlint-disable-next-line no-unused-vars -- TS needs the symbol in scope to name exported CLI types.
import type { NodeInspectSymbol } from "effect/Inspectable";
import { GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { AuthControlPlaneRuntimeLive } from "../auth/Layers/AuthControlPlane.ts";
import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import type { AuthControlPlaneShape } from "../auth/Services/AuthControlPlane.ts";
import {
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  adminCommandLogLevel,
  resolveCliAuthConfig,
  type CliAuthLocationFlags,
} from "./serverConfig.ts";

/**
 * `--json` OWNS STDOUT, so silence covers the WHOLE command and not part of it.
 *
 * Two leaks were shipped by suppressing logs one layer at a time, and both are
 * closed here rather than at the call sites, because both are structural:
 *
 *  1. `resolveServerConfig` logs its startup phases at Debug, and it is what
 *     COMPUTES the configured level — so no level derived from its result can
 *     ever cover it. Under `--log-level debug` a `--json` command emitted four
 *     log lines before printing its document.
 *  2. `Layer.provide(MinimumLogLevel)` hands the reference to the LAYER's
 *     construction and not to the effect that runs under it, so anything the
 *     command body itself logs — the request, the handler, a future addition —
 *     was outside the suppression by construction.
 *
 * `quietly` applies the level to the whole effect, so both are covered by one
 * rule: under `--json`, nothing this process writes below Error reaches the
 * console, whatever part of the command produced it.
 */
export const quietly = <A, E, R>(
  quiet: boolean,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  quiet ? Effect.provideService(effect, References.MinimumLogLevel, "Error") : effect;

export const runWithAuthControlPlane = <A, E, R = never>(
  flags: CliAuthLocationFlags,
  run: (
    authControlPlane: AuthControlPlaneShape,
    config: ServerConfigShape,
  ) => Effect.Effect<A, E, R>,
  options?: {
    readonly quietLogs?: boolean;
  },
) => {
  const quiet = options?.quietLogs === true;
  return quietly(
    quiet,
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const minimumLogLevel = quiet ? "Error" : adminCommandLogLevel(logLevel, config.logLevel);
      return yield* Effect.gen(function* () {
        const authControlPlane = yield* AuthControlPlane;
        return yield* run(authControlPlane, config);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(AuthControlPlaneRuntimeLive).pipe(
            Layer.provide(Layer.succeed(ServerConfig, config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );
    }),
  );
};

const PROJECT_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(1);
export const HUB_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(15);
const OrchestrationHttpErrorResponse = Schema.Struct({
  error: Schema.String,
});

export const withCliSessionToken = <A, E, R>(
  authControlPlane: AuthControlPlaneShape,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    authControlPlane.issueSession({
      role: "owner",
      label: "ryco project cli",
    }),
    (issued) => run(issued.token),
    (issued) => authControlPlane.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

export const runLiveServerRequest = <A, E extends Error, R>(
  request: HttpClientRequest.HttpClientRequest,
  handle: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
  timeout = PROJECT_CLI_LIVE_SERVER_TIMEOUT,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    return yield* handle(response);
  }).pipe(Effect.timeout(timeout));

export const readErrorMessageFromResponse = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(OrchestrationHttpErrorResponse)(response).pipe(
    Effect.map((body) => body.error),
    Effect.catch(() => Effect.succeed(null)),
    Effect.map((body) => {
      if (typeof body === "string" && body.trim().length > 0) {
        return body;
      }
      return `Server request failed with status ${response.status}.`;
    }),
  );

/**
 * Run one command against the running server, as an ephemeral owner session.
 *
 * `quietLogs` mirrors `runWithAuthControlPlane`, through the same `quietly`
 * rule: under `--json` the only thing on stdout must be the document, and this
 * command opens the auth control plane, its SQLite persistence, and an HTTP
 * client — all of which log, and the configuration resolution logs BEFORE any of
 * them. Without it a machine consumer reads log lines interleaved with the value
 * it asked for. It is passed from every command that can emit JSON rather than
 * being defaulted here, so a human run still gets the operator's configured
 * level.
 */
const runHubCommandQuiet = Effect.fn("runHubCommand")(function* <A>(
  flags: CliAuthLocationFlags,
  run: (origin: string, bearerToken: string) => Effect.Effect<A, Error, HttpClient.HttpClient>,
  quiet: boolean,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = quiet ? "Error" : adminCommandLogLevel(logLevel, config.logLevel);
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* Effect.fail(new Error("The Ryco server is not running."));
    }
    const authControlPlane = yield* AuthControlPlane;
    return yield* withCliSessionToken(authControlPlane, (token) =>
      run(runtimeState.value.origin, token),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(AuthControlPlaneRuntimeLive, FetchHttpClient.layer).pipe(
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

export const runHubCommand = <A>(
  flags: CliAuthLocationFlags,
  run: (origin: string, bearerToken: string) => Effect.Effect<A, Error, HttpClient.HttpClient>,
  options?: {
    readonly quietLogs?: boolean;
  },
) => {
  const quiet = options?.quietLogs === true;
  return quietly(quiet, runHubCommandQuiet(flags, run, quiet));
};

/** The runtime file of this home's node, when that node answers. */
export const probeLocalServerRuntime = (serverRuntimeStatePath: string) =>
  readPersistedServerRuntimeState(serverRuntimeStatePath).pipe(
    Effect.flatMap((state) =>
      Option.isNone(state)
        ? Effect.succeed<PersistedServerRuntimeState | null>(null)
        : Effect.tryPromise(async () => {
            const response = await fetch(
              new URL("/.well-known/ryco/environment", state.value.origin),
              { signal: AbortSignal.timeout(1_500) },
            );
            return response.ok ? state.value : null;
          }),
    ),
    Effect.orElseSucceed(() => null),
  );
