import type { AcpRegistrySettings, AcpRegistryAuthMethod } from "@ryco/contracts";
import type { AuthMethod } from "effect-acp/schema";
import { Effect, Layer, Path } from "effect";
import * as AcpErrors from "effect-acp/errors";
import { ServerConfig } from "../../config.ts";
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";
import { makeAcpRegistryCatalog } from "./AcpRegistryCatalog.ts";

export const resolveAcpRegistryInstallation = (settings: AcpRegistrySettings) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return yield* Effect.tryPromise({
      try: () =>
        makeAcpRegistryCatalog({
          installationRoot: path.join(config.stateDir, "acp-registry"),
        }).resolveInstalled(settings),
      catch: (cause) =>
        new AcpErrors.AcpTransportError({
          detail: "Install the pinned ACP agent version explicitly before starting it.",
          cause,
        }),
    });
  });

export const makeRegistryAcpRuntime = (input: {
  readonly settings: AcpRegistrySettings;
  readonly installed: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  };
  readonly environment?: NodeJS.ProcessEnv;
  readonly options: Omit<AcpSessionRuntimeOptions, "spawn" | "authMethodId">;
}) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input.options,
        mcpServers: [],
        resolveMcpServers: (initialized) =>
          Effect.succeed(
            (input.options.mcpServers ?? []).filter(
              (server) =>
                !("type" in server) ||
                (server.type === "http"
                  ? initialized.agentCapabilities?.mcpCapabilities?.http === true
                  : initialized.agentCapabilities?.mcpCapabilities?.sse === true),
            ),
          ),
        // Authentication is exclusively performed by the explicit authenticate RPC.
        negotiateAuth: true,
        requireProtocolVersion: 1,
        strictResume: true,
        preferModelConfig: true,
        spawn: {
          command: input.installed.command,
          args: input.installed.args,
          cwd: input.options.cwd,
          env: { ...input.environment, ...input.installed.env },
          shell: false,
        },
      }),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
    return {
      ...runtime,
      start: () =>
        runtime.start().pipe(
          Effect.timeoutOrElse({
            duration: 30_000,
            orElse: () =>
              Effect.fail(
                new AcpErrors.AcpTransportError({
                  detail: "ACP agent startup timed out after 30 seconds.",
                  cause: new Error("ACP startup timeout"),
                }),
              ),
          }),
        ),
    };
  });

const authenticationRuntime = (settings: AcpRegistrySettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const installed = yield* resolveAcpRegistryInstallation(settings);
    const server = yield* ServerConfig;
    return yield* makeRegistryAcpRuntime({
      settings,
      installed,
      ...(environment ? { environment } : {}),
      options: { cwd: server.stateDir, clientInfo: { name: "ryco-auth", version: "0.0.0" } },
    });
  });

export const getAcpRegistryAuthMethods = (
  settings: AcpRegistrySettings,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const runtime = yield* authenticationRuntime(settings, environment);
    const initialized = yield* runtime.initialize;
    return (initialized.authMethods ?? []).map(projectAcpRegistryAuthMethod);
  }).pipe(Effect.scoped, Effect.timeout(15_000));

export const authenticateAcpRegistry = (
  settings: AcpRegistrySettings,
  methodId: string,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const runtime = yield* authenticationRuntime(settings, environment);
    const initialized = yield* runtime.initialize;
    const method = initialized.authMethods?.find((entry) => entry.id === methodId);
    if (!method || ("type" in method && (method.type === "terminal" || method.type === "env_var")))
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage:
          "This method requires provider environment configuration or authentication outside Ryco.",
      });
    yield* runtime.authenticate(methodId);
  }).pipe(Effect.scoped, Effect.timeout(120_000));

/** Project metadata only: never forward terminal commands, environment values, or arbitrary _meta. */
export function projectAcpRegistryAuthMethod(method: AuthMethod): AcpRegistryAuthMethod {
  return {
    id: method.id,
    name: method.name,
    ...(method.description ? { description: method.description } : {}),
    type: "type" in method ? method.type : "agent",
    ...("type" in method && method.type === "env_var"
      ? {
          variables: method.vars.map((variable) => ({
            name: variable.name,
            ...(variable.label ? { label: variable.label } : {}),
            optional: variable.optional === true,
            secret: variable.secret !== false,
          })),
        }
      : {}),
  };
}
