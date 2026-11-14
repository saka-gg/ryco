/**
 * `ryco remote`, `ryco thread` and `ryco update`: other nodes and threads, here or on a remote.
 */
import { RuntimeMode as ThreadRuntimeMode } from "@ryco/contracts";
import { Console, Duration, Effect, FileSystem, Layer, LogLevel, Option, References } from "effect";
// oxlint-disable-next-line no-unused-vars -- TS needs the symbol in scope to name exported CLI types.
import type { NodeInspectSymbol } from "effect/Inspectable";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { ServerConfig } from "../config.ts";
import { isInteractiveTerminal } from "../cliSetup/ui.ts";
import type { CliRemoteError } from "../cliRemote/remotes.ts";
import type { ThreadCliCommand } from "../cliThread/threadCommands.ts";
import { AuthControlPlaneRuntimeLive } from "../auth/Layers/AuthControlPlane.ts";
import {
  readThreadMessageLimit,
  toReadThreadResult,
} from "../agentControl/Mcp/threadTranscript.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { DurationFromString, baseDirFlag, jsonFlag } from "./flags.ts";
import { quietly } from "./runtime.ts";
import { adminCommandLogLevel, resolveCliAuthConfig } from "./serverConfig.ts";

// ─── ryco remote ──────────────────────────────────────────────────────────────

const remoteLocationFlags = { baseDir: baseDirFlag } as const;

// The remote client (client-runtime connection, RPC client and its stores)
// loads only for `ryco remote`, never on the `serve` path.
const loadCliRemote = Effect.promise(async () => {
  const [remotes, threads] = await Promise.all([
    import("../cliRemote/remotes.ts"),
    import("../cliRemote/threads.ts"),
  ]);
  return { ...remotes, ...threads };
});

const remotesFilePath = (baseDir: Option.Option<string>) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig({ baseDir }, logLevel);
    const { cliRemotesPath } = yield* loadCliRemote;
    return cliRemotesPath(config.stateDir);
  });

const remoteStep = <A>(run: () => Promise<A>): Effect.Effect<A, CliRemoteError> =>
  Effect.flatMap(loadCliRemote, (remoteModule) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        cause instanceof remoteModule.CliRemoteError
          ? cause
          : new remoteModule.CliRemoteError({
              message:
                cause instanceof Error && cause.message.length > 0
                  ? cause.message
                  : "The remote could not be reached.",
              cause,
            }),
    }),
  );

const remoteNameArgument = Argument.String("name").pipe(
  Argument.withDescription("The name you gave the remote with `ryco remote add`."),
);

const remoteAddCommand = Command.make("add", {
  ...remoteLocationFlags,
  name: Argument.String("name").pipe(
    Argument.withDescription("A short name for the remote, for example `mac-mini`."),
  ),
  pairingUrl: Argument.String("pairing-url").pipe(
    Argument.withDescription(
      "A pairing link from the remote (`ryco auth pairing create --base-url …` there), or `-` to read it from stdin.",
    ),
  ),
}).pipe(
  Command.withDescription("Pair with another Ryco node so this CLI can reach it."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const filePath = yield* remotesFilePath(flags.baseDir);
      const pairingUrl =
        flags.pairingUrl === "-"
          ? (yield* remoteStep(async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
              return Buffer.concat(chunks).toString("utf8");
            })).trim()
          : flags.pairingUrl;
      const { pairCliRemote, readCliRemotes, writeCliRemotes } = yield* loadCliRemote;
      const remote = yield* remoteStep(() => pairCliRemote({ name: flags.name, pairingUrl }));
      const existing = yield* remoteStep(() => readCliRemotes(filePath));
      yield* remoteStep(() =>
        writeCliRemotes(filePath, [
          ...existing.filter((entry) => entry.name !== remote.name),
          remote,
        ]),
      );
      yield* Console.log(
        `Added "${remote.name}": ${remote.label} at ${remote.httpBaseUrl} (${remote.role} access).\nTry \`ryco remote threads ${remote.name}\`.\n`,
      );
    }),
  ),
);

const remoteListCommand = Command.make("list", { ...remoteLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List the remotes this CLI is paired with."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const filePath = yield* remotesFilePath(flags.baseDir);
      const { readCliRemotes } = yield* loadCliRemote;
      const remotes = yield* remoteStep(() => readCliRemotes(filePath));
      if (flags.json) {
        yield* Console.log(JSON.stringify(remotes.map(({ token: _token, ...remote }) => remote)));
        return;
      }
      yield* Console.log(
        remotes.length === 0
          ? "No remotes. Add one with `ryco remote add <name> <pairing-url>`.\n"
          : `${remotes
              .map(
                (remote) =>
                  `${remote.name}  ${remote.label}  ${remote.httpBaseUrl}  (${remote.role})`,
              )
              .join("\n")}\n`,
      );
    }),
  ),
);

const remoteRemoveCommand = Command.make("remove", {
  ...remoteLocationFlags,
  name: remoteNameArgument,
}).pipe(
  Command.withDescription(
    "Forget a remote. Revoke its session on the remote from Settings → Connections.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const filePath = yield* remotesFilePath(flags.baseDir);
      const { findCliRemote, readCliRemotes, writeCliRemotes } = yield* loadCliRemote;
      const remotes = yield* remoteStep(() => readCliRemotes(filePath));
      yield* Effect.try({
        try: () => findCliRemote(remotes, flags.name),
        catch: (cause) => cause as CliRemoteError,
      });
      yield* remoteStep(() =>
        writeCliRemotes(
          filePath,
          remotes.filter((entry) => entry.name !== flags.name),
        ),
      );
      yield* Console.log(`Removed "${flags.name}".\n`);
    }),
  ),
);

const loadRemote = (baseDir: Option.Option<string>, name: string) =>
  Effect.gen(function* () {
    const filePath = yield* remotesFilePath(baseDir);
    const { findCliRemote, readCliRemotes } = yield* loadCliRemote;
    const remotes = yield* remoteStep(() => readCliRemotes(filePath));
    return yield* Effect.try({
      try: () => findCliRemote(remotes, name),
      catch: (cause) => cause as CliRemoteError,
    });
  });

const remoteThreadsCommand = Command.make("threads", {
  ...remoteLocationFlags,
  name: remoteNameArgument,
  all: Flag.Boolean("all").pipe(Flag.withDescription("Include archived threads."), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a remote's threads, most recently updated first."),
  Command.withHandler((flags) =>
    Effect.scoped(
      Effect.gen(function* () {
        const remote = yield* loadRemote(flags.baseDir, flags.name);
        const { connectCliRemote, formatRemoteThreads, loadRemoteShell } = yield* loadCliRemote;
        const client = yield* connectCliRemote(remote);
        const snapshot = yield* loadRemoteShell(client);
        if (flags.json) {
          yield* Console.log(JSON.stringify(snapshot.threads));
          return;
        }
        yield* Console.log(
          `${formatRemoteThreads(snapshot, { includeArchived: Option.getOrElse(flags.all, () => false) })}\n`,
        );
      }),
    ),
  ),
);

// ─── ryco thread ──────────────────────────────────────────────────────────────

// Loads only for `ryco thread` and `ryco remote send`, never on the `serve` path.
const loadThreadCli = Effect.promise(() => import("../cliThread/threadCommands.ts"));

/**
 * What reaching this machine's node takes (`ThreadCliLocal`): its address from the runtime file
 * and its auth control plane, which issues the short-lived owner session.
 */
const localNodeAccess = (
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  logLevel: Option.Option<LogLevel.LogLevel>,
  fileSystem: FileSystem.FileSystem,
) =>
  Effect.map(resolveCliAuthConfig(flags, logLevel), (config) => ({
    readOrigin: readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
      Effect.map((state) => (Option.isSome(state) ? state.value.origin : null)),
      Effect.orElseSucceed(() => null),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    ),
    authControlPlane: AuthControlPlaneRuntimeLive.pipe(
      Layer.provide(Layer.succeed(ServerConfig, config)),
      Layer.provide(
        Layer.succeed(
          References.MinimumLogLevel,
          flags.json ? "Error" : adminCommandLogLevel(logLevel, config.logLevel),
        ),
      ),
    ),
  }));

const runThreadCli = (
  flags: {
    readonly baseDir: Option.Option<string>;
    readonly remote: Option.Option<string>;
    readonly json: boolean;
  },
  command: ThreadCliCommand,
) =>
  quietly(
    flags.json,
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const fileSystem = yield* FileSystem.FileSystem;
      const threadCli = yield* loadThreadCli;
      yield* threadCli.runThreadCli(command, {
        json: flags.json,
        remote: flags.remote,
        loadRemote: (name) => loadRemote(flags.baseDir, name),
        local: localNodeAccess(flags, logLevel, fileSystem),
        transcript: { toReadThreadResult, readThreadMessageLimit },
      });
    }),
  );

const threadLocationFlags = {
  baseDir: baseDirFlag,
  remote: Flag.String("remote").pipe(
    Flag.withDescription("Run on a paired remote (`ryco remote add`) instead of this node."),
    Flag.optional,
  ),
  json: jsonFlag,
} as const;

const threadIdArgument = Argument.String("thread-id").pipe(
  Argument.withDescription("The thread's id."),
);

const threadPromptArgument = Argument.String("prompt").pipe(
  Argument.withDescription("The message, or - to read it from stdin."),
);

const threadWaitFlag = Flag.Boolean("wait").pipe(
  Flag.withDescription(
    "Wait for the turn to end and print its reply. Exit 1 failed or stopped, 2 needs an approval or answer (or, for send, the thread's follow-up queue is held or waits for a Retry), 3 cut off by a node restart, 5 outcome unknown.",
  ),
  Flag.withDefault(false),
);

const threadTimeoutFlag = Flag.String("timeout").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Stop waiting after this long and exit 4, for example `30m`."),
  Flag.optional,
);

const threadStartCommand = Command.make("start", {
  ...threadLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id, or a path inside the project such as `.`."),
  ),
  title: Flag.String("title").pipe(
    Flag.withDescription("Thread title. Defaults to the message's first line."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("instance/model, for example `codex/gpt-5.5`. Defaults to the project's."),
    Flag.optional,
  ),
  runtimeMode: Flag.Literals("runtime-mode", ThreadRuntimeMode.literals).pipe(
    Flag.withDescription("Defaults to the project's, and may not be above it."),
    Flag.optional,
  ),
  wait: threadWaitFlag,
  timeout: threadTimeoutFlag,
  prompt: threadPromptArgument,
}).pipe(
  Command.withDescription("Start a thread in a project and print its id."),
  Command.withHandler((flags) => runThreadCli(flags, { kind: "start", ...flags })),
);

const threadSendCommand = Command.make("send", {
  ...threadLocationFlags,
  wait: threadWaitFlag,
  timeout: threadTimeoutFlag,
  threadId: threadIdArgument,
  prompt: threadPromptArgument,
}).pipe(
  Command.withDescription(
    "Queue a message: it starts as a later turn once the running one ends, after the follow-ups queued before it. Prints the turn's id. Exits 2 while the thread's follow-up queue is held (after a Stop, a failure, a usage limit or Pause) or waits for a Retry; the message stays queued.",
  ),
  Command.withHandler((flags) => runThreadCli(flags, { kind: "send", ...flags })),
);

const threadWaitCommand = Command.make("wait", {
  ...threadLocationFlags,
  turn: Flag.String("turn").pipe(
    Flag.withDescription("The turn to wait for (`send` prints it). Defaults to the latest."),
    Flag.optional,
  ),
  timeout: threadTimeoutFlag,
  threadId: threadIdArgument,
}).pipe(
  Command.withDescription(
    "Wait for a turn to end and print its reply, with the exit codes of --wait.",
  ),
  Command.withHandler((flags) =>
    runThreadCli(flags, { kind: "wait", turnId: flags.turn, ...flags }),
  ),
);

const threadReadCommand = Command.make("read", {
  ...threadLocationFlags,
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("How many of the latest messages to print (at most 50)."),
    Flag.optional,
  ),
  full: Flag.Boolean("full").pipe(
    Flag.withDescription(
      "With --json, print every message whole instead of cutting long ones as ryco_read_thread does. The text output always prints them whole.",
    ),
    Flag.withDefault(false),
  ),
  threadId: threadIdArgument,
}).pipe(
  Command.withDescription("Print a thread's latest messages and its queued follow-ups."),
  Command.withHandler((flags) => runThreadCli(flags, { kind: "read", ...flags })),
);

const loadNodeUpdateCli = Effect.promise(() => import("../cliNodeUpdate/updateCommand.ts"));

export const updateCommand = Command.make("update", {
  baseDir: baseDirFlag,
  remote: Flag.String("remote").pipe(
    Flag.withDescription("Update a paired remote (`ryco remote add`) instead of this node."),
    Flag.optional,
  ),
  channel: Flag.Literals("channel", ["latest", "nightly"]).pipe(
    Flag.withDescription(
      "Move the node to this release channel. It never installs an older release than it runs.",
    ),
    Flag.optional,
  ),
  check: Flag.Boolean("check").pipe(
    Flag.withDescription("Only show the node's version, the newest release and the last update."),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Update without asking (needed when the output is not a terminal)."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Update this node, or a paired remote, through its own one-click update: checked against a copy of its database, restarted, and rolled back if the new release fails to start.",
  ),
  Command.withHandler((flags) =>
    quietly(
      flags.json,
      Effect.scoped(
        Effect.gen(function* () {
          const logLevel = yield* GlobalFlag.LogLevel;
          const fileSystem = yield* FileSystem.FileSystem;
          const threadCli = yield* loadThreadCli;
          const updateCli = yield* loadNodeUpdateCli;
          const target = Option.isSome(flags.remote)
            ? threadCli.remoteThreadTarget(yield* loadRemote(flags.baseDir, flags.remote.value))
            : yield* threadCli.localThreadTarget({
                local: yield* localNodeAccess(flags, logLevel, fileSystem),
                timeout: null,
                // The follow ends within 10 minutes; a session this older CLI cannot revoke
                // after the node migrated its database expires soon after.
                sessionTtl: Duration.minutes(30),
                sessionLabel: "ryco update",
              });
          const nodeLabel = Option.isSome(flags.remote) ? `"${flags.remote.value}"` : "this node";
          if (flags.check) {
            return yield* updateCli.runUpdateCheck({
              target,
              nodeLabel,
              json: flags.json,
              channel: Option.getOrNull(flags.channel),
              fetchLatestOnChannel: updateCli.fetchLatestRycoRelease,
            });
          }
          yield* updateCli.runUpdateCli({
            target,
            nodeLabel,
            channel: Option.getOrNull(flags.channel),
            yes: flags.yes,
            json: flags.json,
            interactive: isInteractiveTerminal(),
            confirm: (message) =>
              Prompt.run(Prompt.Confirm({ message, initial: false })).pipe(
                Effect.catch(() => Effect.succeed(false)),
              ),
            fetchLatestOnChannel: updateCli.fetchLatestRycoRelease,
            requestId: `cli-${crypto.randomUUID()}`,
          });
        }),
      ),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Start, message, wait for and read threads, here or on a paired remote."),
  Command.withSubcommands([
    threadStartCommand,
    threadSendCommand,
    threadWaitCommand,
    threadReadCommand,
  ]),
);

const remoteSendCommand = Command.make("send", {
  ...remoteLocationFlags,
  name: remoteNameArgument,
  threadId: Argument.String("thread-id").pipe(
    Argument.withDescription("The thread to continue (see `ryco remote threads`)."),
  ),
  message: Argument.String("message").pipe(
    Argument.withDescription("The message to send."),
    Argument.variadic({ min: 1 }),
  ),
  wait: Flag.Boolean("wait").pipe(
    Flag.withDescription(
      "Print the reply once the turn ends (default; --no-wait returns once it starts).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Send a message to a thread on a remote: `ryco thread send --remote`."),
  Command.withHandler((flags) =>
    runThreadCli(
      { baseDir: flags.baseDir, remote: Option.some(flags.name), json: false },
      {
        kind: "send",
        threadId: flags.threadId,
        prompt: flags.message.join(" "),
        literalPrompt: true,
        wait: Option.getOrElse(flags.wait, () => true),
        timeout: Option.none(),
      },
    ),
  ),
);

export const remoteCommand = Command.make("remote").pipe(
  Command.withDescription(
    "Use this CLI as a client of another Ryco node: pair with it, list its threads, and send messages.",
  ),
  Command.withSubcommands([
    remoteAddCommand,
    remoteListCommand,
    remoteRemoveCommand,
    remoteThreadsCommand,
    remoteSendCommand,
  ]),
);
