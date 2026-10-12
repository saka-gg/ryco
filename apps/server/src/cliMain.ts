/**
 * cliMain - Runs the `ryco` command line (serve, auth, hub, remote, ...).
 * Loaded on demand by `bin.ts`.
 *
 * @module cliMain
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { CliError, Command } from "effect/cli";

import { NetService } from "@ryco/shared/Net";
import { cli } from "./cli.ts";
import packageJson from "../package.json" with { type: "json" };
import {
  classifyFatalStartupError,
  failureMessage,
  reportFatalStartupFailure,
} from "./startupFailure.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

/** Stack traces for expected command failures only when asked for. */
const verboseErrors =
  process.env.RYCO_DEBUG === "1" ||
  process.argv.some((argument, index) =>
    argument.startsWith("--log-level")
      ? /^(?:--log-level=)?(?:all|trace|debug)$/u.test(
          argument.includes("=") ? argument : (process.argv[index + 1] ?? ""),
        )
      : false,
  );

const program = Command.run(cli, { version: packageJson.version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayer),
  Effect.catchCause((cause) => {
    const error = Cause.findErrorOption(cause);
    // A failure that repeats on every start (a database from a newer binary,
    // invalid configuration) exits with EX_CONFIG so supervisors stop
    // restarting, and tells the desktop why.
    const fatalCode = Option.isSome(error) ? classifyFatalStartupError(error.value) : null;
    if (fatalCode !== null && Option.isSome(error) && !Cause.hasDies(cause)) {
      return Effect.sync(() => {
        process.stderr.write(
          verboseErrors ? `${Cause.pretty(cause)}\n` : `Error: ${failureMessage(error.value)}\n`,
        );
        process.exitCode = reportFatalStartupFailure(fatalCode, error.value);
      });
    }
    // A command that fails for an expected reason — the server is not running,
    // the Hub refused a sign-in — prints one line, not a stack trace. Defects and
    // the CLI framework's own usage errors keep their normal reporting.
    if (
      verboseErrors ||
      Cause.hasDies(cause) ||
      Option.isNone(error) ||
      !(error.value instanceof Error) ||
      CliError.isCliError(error.value)
    ) {
      return Effect.failCause(cause);
    }
    const message = error.value.message;
    return Effect.sync(() => {
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    });
  }),
);

export function runCli(): void {
  NodeRuntime.runMain(program as Effect.Effect<void, never, never>);
}
