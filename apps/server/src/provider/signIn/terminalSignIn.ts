/**
 * Sign-in in a terminal: the CLI's own login command (`signInCommands.ts`) runs in a PTY on the
 * node, with the environment the instance's driver gives that CLI, in a private working directory,
 * and without a shell. Its output is handed to the flow in batches; the flow keeps a tail and sends
 * it only to the owners following it, and what they type comes back through `respond`. Neither is
 * logged.
 *
 * The login exiting with code 0 ends the method; the flow then checks the instance itself. Cancel,
 * expiry and shutdown end the process: a hangup, as closing a terminal sends, then a kill if it
 * lingers.
 *
 * @module terminalSignIn
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSignInInteraction,
  ProviderSignInError,
  type ServerSettings,
} from "@ryco/contracts";
import { resolveCommandPathAsync } from "@ryco/shared/shell";
import {
  type Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  type FileSystem,
  Option,
  type Path,
  Queue,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { PtyAdapter, type PtyExitEvent, type PtyProcess } from "../../terminal/Services/PTY.ts";
import { createTerminalSpawnEnv } from "../../terminal/terminalSpawnEnv.ts";
import { resolveCursorAgentCommand } from "../acp/CursorAgentCommand.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { codexRuntimeBinding } from "../codexRuntimeBinding.ts";
import { assertSupportedOpenCodeBinary } from "../opencodeRuntime.ts";
import { parseProviderSourcePaths } from "../ProviderSourcePaths.ts";
import { providerInstanceConfigFor } from "../providerInstanceConfig.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import { ensurePrivateDirectory } from "./privateDirectory.ts";
import { planTerminalSignIn, type TerminalSignInLaunch } from "./signInCommands.ts";

/** The size the login starts with; followers resize it to their terminal. */
const TERMINAL_SIGN_IN_COLS = 100;
const TERMINAL_SIGN_IN_ROWS = 30;
/** Output that arrives within this long goes out as one batch. */
const TERMINAL_SIGN_IN_FLUSH_INTERVAL = Duration.millis(50);
/** The longest piece of output one event carries. */
const TERMINAL_SIGN_IN_OUTPUT_PIECE = 16 * 1024;
/** How long a hung-up login may take to exit before it is killed. */
const KILL_GRACE = Duration.seconds(1);

/** The login's terminal, for the flow to pass followers' input and size on. */
export interface SignInTerminal {
  /** `false` once the login's process is gone. */
  readonly write: (data: string) => Effect.Effect<boolean>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<boolean>;
}

export interface TerminalSignInHooks {
  /** Publishes the terminal and, from then on, takes followers' input for it. */
  readonly waiting: (
    interaction: ProviderSignInInteraction,
    terminal?: SignInTerminal,
  ) => Effect.Effect<void>;
  /** Appends output to the flow's transcript. */
  readonly output: (data: string) => Effect.Effect<void>;
}

const failure = (message: string) => new ProviderSignInError({ message });

/**
 * The store the login writes, as far as Ryco knows it. Claude keeps its login in its config
 * directory (on macOS, in a Keychain entry named after that directory); OpenCode in its data
 * directory; Grok in `GROK_HOME`, by default `~/.grok` (as Ryco's Grok MCP management reads it);
 * Cursor under the home. One sign-in runs per store at a time.
 */
const credentialStore = (
  launch: Pick<TerminalSignInLaunch, "driver" | "homePath">,
  environment: NodeJS.ProcessEnv,
) => {
  if (launch.driver === "claudeAgent") {
    return `claude:${parseProviderSourcePaths("claudeAgent", { homePath: launch.homePath }, environment).root}`;
  }
  const home = NodePath.resolve(
    environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir(),
  );
  switch (launch.driver) {
    case "opencode":
      return `opencode:${NodePath.resolve(environment.XDG_DATA_HOME?.trim() || NodePath.join(home, ".local", "share"))}`;
    case "grok":
      return `grok:${NodePath.resolve(environment.GROK_HOME?.trim() || NodePath.join(home, ".grok"))}`;
    default:
      return `${launch.driver}:${home}`;
  }
};

/**
 * What the login runs with: the driver's environment for its CLI, its store, and the binding a
 * finished login is checked against (command, arguments, store and the whole environment).
 */
const resolveLaunch = (launch: TerminalSignInLaunch, instanceId: ProviderInstanceId) =>
  Effect.gen(function* () {
    const environment =
      launch.driver === "claudeAgent"
        ? yield* makeClaudeEnvironment({ homePath: launch.homePath }, launch.environment)
        : launch.environment;
    const credentialKey = credentialStore(launch, environment);
    return {
      environment,
      credentialKey,
      binding: codexRuntimeBinding({
        instanceId,
        binaryPath: [launch.command, ...launch.args].join("\0"),
        homePath: credentialKey,
        environment,
      }),
    };
  });

/** The binding of the instance as the settings define it now; `undefined` once it cannot sign in. */
const currentBinding = (settings: ServerSettings, instanceId: ProviderInstanceId) => {
  const instance = providerInstanceConfigFor(settings, instanceId);
  const plan = instance === undefined ? undefined : planTerminalSignIn(instance);
  return plan?._tag === "ready"
    ? resolveLaunch(plan, instanceId).pipe(Effect.map((resolved) => resolved.binding))
    : Effect.succeed(undefined);
};

/** Resolves the login for one instance and returns the flow's parts. */
export const prepareTerminalSignIn = (
  launch: TerminalSignInLaunch,
  instanceId: ProviderInstanceId,
  cwd: string,
) =>
  resolveLaunch(launch, instanceId).pipe(
    Effect.map((resolved) => ({
      method: "terminal" as const,
      credentialKey: resolved.credentialKey,
      binding: resolved.binding,
      currentBinding: (settings: ServerSettings) => currentBinding(settings, instanceId),
      run: (hooks: TerminalSignInHooks) =>
        runTerminalSignIn(launch, resolved.environment, cwd, hooks),
    })),
  );

/** Where the configured command resolves on the instance's `PATH`, as its driver resolves it. */
const resolveExecutable = (launch: TerminalSignInLaunch, environment: NodeJS.ProcessEnv) =>
  launch.driver === "cursor"
    ? resolveCursorAgentCommand(launch.command, environment, { fresh: true }).pipe(
        Effect.map((command) => command.resolvedPath),
      )
    : Effect.promise(() => resolveCommandPathAsync(launch.command, { env: environment }));

/**
 * OpenCode's own gate before anything runs: a 2.x binary converts the shared OpenCode database, so
 * a binary the node does not run as a server does not log in either.
 */
const checkOpenCodeVersion = (executable: string, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* assertSupportedOpenCodeBinary(
      (input) =>
        spawnAndCollect(
          input.binaryPath,
          ChildProcess.make(input.binaryPath, [...input.args], {
            env: input.environment ?? environment,
            shell: process.platform === "win32",
          }),
        ).pipe(
          // Reads as an unknown version, which the gate refuses.
          Effect.orElseSucceed(() => ({ stdout: "", stderr: "", code: 1 })),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      { binaryPath: executable, environment },
    ).pipe(Effect.mapError((error) => failure(error.detail)));
  });

/** Pieces of at most `TERMINAL_SIGN_IN_OUTPUT_PIECE` characters, never splitting a surrogate pair. */
const outputPieces = (text: string): ReadonlyArray<string> => {
  const pieces: Array<string> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + TERMINAL_SIGN_IN_OUTPUT_PIECE, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
};

/**
 * Hands output on in batches: what arrived within one flush interval, in bounded pieces. Ends once
 * the queue is ended and drained.
 */
const pumpOutput = (
  chunks: Queue.Dequeue<string, Cause.Done>,
  output: TerminalSignInHooks["output"],
) =>
  Effect.gen(function* () {
    while (true) {
      const batch: Array<string> = yield* Queue.takeAll(chunks);
      yield* Effect.sleep(TERMINAL_SIGN_IN_FLUSH_INTERVAL);
      let next = yield* Queue.poll(chunks);
      while (Option.isSome(next)) {
        batch.push(next.value);
        next = yield* Queue.poll(chunks);
      }
      for (const piece of outputPieces(batch.join(""))) yield* output(piece);
    }
  }).pipe(Effect.catchTag("Done", () => Effect.void));

const attempt = (action: () => void) => {
  try {
    action();
    return true;
  } catch {
    return false;
  }
};

/** Hangs the login's terminal up and kills it if it does not exit within the grace period. */
const stopLogin = (pty: PtyProcess, exited: Deferred.Deferred<PtyExitEvent>) =>
  Effect.gen(function* () {
    if (Deferred.isDoneUnsafe(exited)) return;
    attempt(() => pty.kill());
    const gone = yield* Deferred.await(exited).pipe(Effect.timeoutOption(KILL_GRACE));
    if (Option.isNone(gone)) attempt(() => pty.kill("SIGKILL"));
  });

const runTerminalSignIn = (
  launch: TerminalSignInLaunch,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  hooks: TerminalSignInHooks,
): Effect.Effect<
  { readonly message: string | null },
  ProviderSignInError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | PtyAdapter
> =>
  Effect.gen(function* () {
    const name = PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(launch.driver)] ?? launch.driver;
    yield* ensurePrivateDirectory(cwd).pipe(
      Effect.mapError(() => failure("Could not prepare a working directory for the sign-in.")),
    );
    const executable = yield* resolveExecutable(launch, environment);
    if (executable === null) {
      return yield* failure(
        `\`${launch.command}\` was not found on the node. Install ${name} there or set its binary path.`,
      );
    }
    if (launch.driver === "opencode") yield* checkOpenCodeVersion(executable, environment);

    const adapter = yield* PtyAdapter;
    const exited = yield* Deferred.make<PtyExitEvent>();
    const chunks = yield* Queue.unbounded<string, Cause.Done>();
    let open = true;
    const { pty } = yield* Effect.acquireRelease(
      adapter
        .spawn({
          shell: executable,
          args: [...launch.args],
          cwd,
          cols: TERMINAL_SIGN_IN_COLS,
          rows: TERMINAL_SIGN_IN_ROWS,
          env: createTerminalSpawnEnv(environment, { TERM: "xterm-256color" }),
        })
        .pipe(
          Effect.map((pty) => ({
            pty,
            unsubscribe: [
              pty.onData((data) => {
                Queue.offerUnsafe(chunks, data);
              }),
              pty.onExit((event) => {
                Deferred.doneUnsafe(exited, Effect.succeed(event));
              }),
            ],
          })),
        ),
      ({ pty, unsubscribe }) =>
        Effect.sync(() => {
          open = false;
        }).pipe(
          Effect.andThen(stopLogin(pty, exited)),
          Effect.ensuring(Effect.sync(() => unsubscribe.forEach((stop) => stop()))),
        ),
    ).pipe(Effect.mapError(() => failure(`Could not start ${name}'s login on the node.`)));

    const pump = yield* pumpOutput(chunks, hooks.output).pipe(Effect.forkScoped);
    const live = () => open && !Deferred.isDoneUnsafe(exited);
    yield* hooks.waiting(
      { type: "terminal", cols: TERMINAL_SIGN_IN_COLS, rows: TERMINAL_SIGN_IN_ROWS },
      {
        write: (data) => Effect.sync(() => live() && attempt(() => pty.write(data))),
        resize: (cols, rows) => Effect.sync(() => live() && attempt(() => pty.resize(cols, rows))),
      },
    );

    const { exitCode, signal } = yield* Deferred.await(exited);
    // Output can trail the exit; what arrives within one more batch still reaches the transcript.
    yield* Effect.sleep(TERMINAL_SIGN_IN_FLUSH_INTERVAL);
    yield* Queue.end(chunks);
    yield* Fiber.join(pump);
    if (exitCode !== 0) return yield* failure(`The login command exited with code ${exitCode}.`);
    if (signal) return yield* failure(`The login command was stopped by signal ${signal}.`);
    return { message: null };
  }).pipe(Effect.scoped);
