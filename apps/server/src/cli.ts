import { Effect, Option } from "effect";
// oxlint-disable-next-line no-unused-vars -- TS needs the symbol in scope to name exported CLI types.
import type { NodeInspectSymbol } from "effect/Inspectable";
import { Command, Prompt } from "effect/cli";
import { readNodeConfig } from "./cliSetup/nodeConfig.ts";
import { makeDoctorCommand } from "./doctor/doctorCommand.ts";
import {
  cliPreferencesPath,
  readCliPreferences,
  writeCliPreferences,
} from "./cliSetup/preferences.ts";
import { isInteractiveTerminal } from "./cliSetup/ui.ts";
import { makeDbCommand } from "./cliDb/dbCommand.ts";
import { makeTraceCommand } from "./cliTrace/traceCommand.ts";
import { readNodeServiceStatus } from "./service/nodeService.ts";
import { authCommand } from "./cli/authCommand.ts";
import { e2eeCommand } from "./cli/e2eeCommand.ts";
import {
  DurationFromString,
  emitJson,
  jsonFlag,
  sharedServerCommandFlags,
  sharedServerLocationFlags,
} from "./cli/flags.ts";
import { hubCommand } from "./cli/hubCommand.ts";
import { projectCommand } from "./cli/projectCommand.ts";
import { remoteCommand, threadCommand, updateCommand } from "./cli/remoteCommand.ts";
import { quietly } from "./cli/runtime.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/serverCommand.ts";
import {
  adminCommandLogLevel,
  refuseDesktopOwnedNode,
  resolveCliAuthConfig,
  resolveTraceLocation,
  type CliServerFlags,
} from "./cli/serverConfig.ts";
import { serviceCommand } from "./cli/serviceCommand.ts";
import {
  configCommand,
  loadSetupFlow,
  makeSetupOperations,
  resolveSetupContext,
  setupClosed,
  setupCommand,
} from "./cli/setupCommand.ts";

/**
 * A bare `ryco` / `npx ryco-cli` in a terminal is where a first-time user
 * starts, so it offers the setup guide once — unless dismissed for good — and on
 * a machine that already runs a node, opens the manager instead of starting a
 * second server beside it. Anything scripted, desktop-spawned, or given
 * arguments starts the server exactly as before.
 */
const runBareCommand = (flags: CliServerFlags) =>
  Effect.gen(function* () {
    const offerSetup =
      process.argv.length <= 2 &&
      isInteractiveTerminal() &&
      process.env.CI === undefined &&
      process.env.RYCO_NO_SETUP_PROMPT !== "1";
    if (!offerSetup) return yield* runServerCommand(flags);

    const { config, context } = yield* resolveSetupContext(Option.none());
    yield* refuseDesktopOwnedNode(config.baseDir);
    const operations = yield* makeSetupOperations(
      { baseDir: Option.none() },
      config.serverRuntimeStatePath,
    );
    const saved = yield* Effect.tryPromise(() => readNodeConfig(context.configPath)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (saved !== null) {
      const running = (yield* operations.serverOrigin) !== null;
      const service =
        context.platform === null
          ? null
          : yield* Effect.tryPromise(() =>
              readNodeServiceStatus(context.platform!, context.serviceLabel),
            ).pipe(Effect.orElseSucceed(() => null));
      if (running || service?.installed) {
        return yield* setupClosed(
          Effect.flatMap(loadSetupFlow, (flow) => flow.runNodeManager(context, operations)),
        );
      }
      return yield* runServerCommand(flags);
    }

    const preferencesPath = cliPreferencesPath(config.stateDir);
    const preferences = yield* Effect.promise(() => readCliPreferences(preferencesPath));
    if (preferences.skipLaunchChooser) return yield* runServerCommand(flags);

    const choice = yield* Prompt.run(
      Prompt.Select<"open" | "setup" | "always-open">({
        message: "Welcome to Ryco",
        choices: [
          {
            title: "Open Ryco on this computer",
            description: "Starts Ryco here and opens it in your browser",
            value: "open",
          },
          {
            title: "Set up this computer for your other devices",
            description: "Runs in the background; reach it from your laptop, phone, or anywhere",
            value: "setup",
          },
          { title: "Open Ryco here, and don't ask again", value: "always-open" },
        ],
      }),
    ).pipe(Effect.catchTag("QuitError", () => Effect.succeed("quit" as const)));
    if (choice === "quit") return;
    if (choice === "setup") {
      return yield* setupClosed(
        Effect.flatMap(loadSetupFlow, (flow) => flow.runFirstTimeSetup(context, operations)),
      );
    }
    if (choice === "always-open") {
      yield* Effect.promise(() =>
        writeCliPreferences(preferencesPath, { ...preferences, skipLaunchChooser: true }),
      );
    }
    return yield* runServerCommand(flags);
  });

export const cli = Command.make("ryco", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the Ryco server. In a terminal with no arguments, first offers `ryco setup`.",
  ),
  Command.withHandler((flags) => runBareCommand(flags)),
  Command.withSubcommands([
    startCommand,
    serveCommand,
    authCommand,
    hubCommand,
    e2eeCommand,
    projectCommand,
    setupCommand,
    configCommand,
    serviceCommand,
    remoteCommand,
    threadCommand,
    updateCommand,
    makeDbCommand({
      locationFlags: sharedServerLocationFlags,
      jsonFlag,
      emitJson,
      resolveConfig: resolveCliAuthConfig,
      quietly,
      adminCommandLogLevel,
    }),
    makeDoctorCommand({
      locationFlags: sharedServerLocationFlags,
      jsonFlag,
      emitJson,
      resolveConfig: resolveCliAuthConfig,
      quietly,
      adminCommandLogLevel,
    }),
    makeTraceCommand({
      locationFlags: sharedServerLocationFlags,
      jsonFlag,
      emitJson,
      durationSchema: DurationFromString,
      resolveTraceLocation,
      quietly,
    }),
  ]),
);
