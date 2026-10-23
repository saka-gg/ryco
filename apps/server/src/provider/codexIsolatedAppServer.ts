/**
 * A short-lived `codex app-server` for one bounded job against a provider instance's Codex
 * store (import verification, native forks, removing a proven copy), separate from any live
 * session runtime: threads it loads are never held by a session's writer, and its process ends
 * with the job.
 *
 * Its `CODEX_HOME` is the instance's effective home (the shadow home for an auth overlay), and
 * the job only runs after Codex confirms it opened exactly that home. An auth overlay's SQLite
 * state stays in the shared home (`codexProcessEnvironment`).
 *
 * The app-server client is loaded on the first job (`loadCodexAppServerModule`), so importing this
 * module keeps the Codex protocol schema off the server's boot path.
 */
import { realpath } from "node:fs/promises";

import { Effect, Layer, Schema } from "effect";
import type * as CodexClient from "effect-codex-app-server/client";
import { ChildProcessSpawner } from "effect/process";

import { loadCodexAppServerModule } from "./codexAppServerModule.ts";
import { codexProcessEnvironment, type CodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

/** Whole job, including process start and the handshake. */
export const CODEX_ISOLATED_APP_SERVER_TIMEOUT = "45 seconds";

export class CodexIsolatedAppServerError extends Schema.TaggedError<CodexIsolatedAppServerError>()(
  "CodexIsolatedAppServerError",
  {
    reason: Schema.Literals([
      /** Codex opened another store than the instance's; the job did not run. */
      "home-mismatch",
      /** The process, its handshake or a home path failed before the job ran. */
      "unavailable",
      "timeout",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface IsolatedCodexAppServerInput {
  readonly layout: CodexHomeLayout;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly binaryPath: string;
}

const unavailable = (detail: string) => (cause: unknown) =>
  new CodexIsolatedAppServerError({ reason: "unavailable", detail, cause });

/**
 * Runs `use` against a fresh app-server for the instance's store and stops the process when it
 * finishes, fails or is interrupted. Errors from `use` pass through unchanged.
 */
export const withIsolatedCodexAppServer = <A, E, R>(
  input: IsolatedCodexAppServerInput,
  use: (client: CodexClient.CodexAppServerClientShape) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | CodexIsolatedAppServerError,
  R | ChildProcessSpawner.ChildProcessSpawner
> => {
  const home = input.layout.effectiveHomePath ?? input.layout.sharedHomePath;
  return Effect.scoped(
    Effect.gen(function* () {
      const codexAppServer = yield* loadCodexAppServerModule.pipe(
        Effect.mapError(unavailable("Codex could not start.")),
      );
      const context = yield* Layer.build(
        codexAppServer.CodexClient.layerCommand({
          command: input.binaryPath,
          args: ["app-server"],
          cwd: input.cwd,
          env: { ...codexProcessEnvironment(input.layout, input.environment), CODEX_HOME: home },
        }),
      ).pipe(Effect.mapError(unavailable("Codex could not start.")));
      const client = yield* Effect.service(codexAppServer.CodexClient.CodexAppServerClient).pipe(
        Effect.provide(context),
      );
      const initialized = yield* client
        .request("initialize", codexAppServer.buildCodexInitializeParams())
        .pipe(Effect.mapError(unavailable("Codex did not complete its handshake.")));
      const actualHome = yield* Effect.tryPromise({
        try: () => realpath(initialized.codexHome),
        catch: unavailable("Codex effective home is unavailable."),
      });
      const expectedHome = yield* Effect.tryPromise({
        try: () => realpath(home),
        catch: unavailable("Codex expected home is unavailable."),
      });
      if (actualHome !== expectedHome) {
        return yield* new CodexIsolatedAppServerError({
          reason: "home-mismatch",
          detail: "Codex started in a different provider store.",
        });
      }
      yield* client
        .notify("initialized", undefined)
        .pipe(Effect.mapError(unavailable("Codex did not complete its handshake.")));
      return yield* use(client);
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: CODEX_ISOLATED_APP_SERVER_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new CodexIsolatedAppServerError({
            reason: "timeout",
            detail: "Codex did not finish in time.",
          }),
        ),
    }),
  );
};
