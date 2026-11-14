/**
 * `ryco start` / `ryco serve`: run the Ryco server.
 */
import { Effect } from "effect";
// oxlint-disable-next-line no-unused-vars -- TS needs the symbol in scope to name exported CLI types.
import type { NodeInspectSymbol } from "effect/Inspectable";
import { Command, GlobalFlag } from "effect/cli";
import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runRequestedFlavorImport } from "../flavorImportStartup.ts";
import { runServer } from "../server.ts";
import { withDesktopParentLifetime } from "../desktopParentLifetime.ts";
import { sharedServerCommandFlags } from "./flags.ts";
import {
  refuseDesktopOwnedNode,
  resolveServerConfig,
  type CliServerFlags,
} from "./serverConfig.ts";

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly defaultAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, { ...options, useNodeConfig: true });
    yield* refuseDesktopOwnedNode(config.baseDir);
    // resolveServerConfig has started the desktop pipe watch this race reads
    // (initializeDesktopResourceTelemetry), so it must stay ahead of it. A copy of Ryco's data
    // that Ryco Nightly was asked for replaces its database before the server opens it.
    return yield* runRequestedFlavorImport(config).pipe(
      Effect.andThen(runServer),
      Effect.provideService(ServerConfig, config),
      withDesktopParentLifetime,
    );
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Ryco server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the Ryco server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      defaultAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
