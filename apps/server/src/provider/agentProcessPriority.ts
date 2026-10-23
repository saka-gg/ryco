/**
 * AgentProcessPriority — runs agent CLIs (and so everything they start: tests, builds,
 * browsers, MCP servers) at a lower CPU priority than the server, per the node setting
 * `lowerAgentProcessPriority`.
 *
 * The pure policy lives in `@ryco/shared/processPriority`; this module adds the platform facts,
 * reads the setting at every launch (so a change applies to the next agent started) and wraps
 * Effect spawns. Every agent driver requires this service, so a missing layer fails
 * `bun typecheck` instead of silently running agents at normal priority. Constructors that take
 * it as an option treat `undefined` as "off" (direct unit-test construction only).
 *
 * Fail-open by construction: `plan` never fails, the argv only changes when an absolute `nice`
 * exists and the command was verified to resolve, and post-spawn lowering never throws.
 *
 * @module provider/agentProcessPriority
 */
import {
  AGENT_LAUNCH_OFF,
  type AgentLaunchPlan,
  agentCommandResolves,
  applyAgentLaunchPlan,
  hasDyldEnvironment,
  type LowerPriorityResult,
  lowerChildProcessPriority,
  planAgentLaunch,
  resolveNiceExecutable,
} from "@ryco/shared/processPriority";
import { Context, Effect, Layer, type PlatformError, type Scope } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import { ServerSettingsService } from "../serverSettings.ts";

export interface AgentLaunchRequest {
  readonly command: string;
  /** The child's environment; `undefined` inherits `process.env`. */
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly cwd: string | undefined;
  /** The command runs through a shell. */
  readonly shell: boolean;
}

export interface AgentProcessPriorityShape {
  /** Plans one agent launch with the setting as it is NOW (read per call). Never fails. */
  readonly plan: (request: AgentLaunchRequest) => Effect.Effect<AgentLaunchPlan>;
  /** Post-spawn half of an "after-spawn" plan. Never fails; logs at Debug when it could not. */
  readonly lowerAfterSpawn: (pid: number) => Effect.Effect<void>;
}

export class AgentProcessPriority extends Context.Service<
  AgentProcessPriority,
  AgentProcessPriorityShape
>()("ryco/provider/AgentProcessPriority") {}

export interface AgentProcessPriorityDeps {
  readonly enabled: Effect.Effect<boolean>;
  readonly platform: NodeJS.Platform;
  readonly niceExecutable: () => string | null;
  readonly commandResolves: (
    command: string,
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly cwd: string | undefined;
      readonly platform: NodeJS.Platform;
    },
  ) => Promise<boolean>;
  readonly lowerChild: (pid: number) => LowerPriorityResult;
}

/** Exported for tests (inject platform facts) and used by the live layer. */
export const makeAgentProcessPriority = (
  deps: AgentProcessPriorityDeps,
): AgentProcessPriorityShape => {
  let missingNiceReported = false;

  const plan: AgentProcessPriorityShape["plan"] = (request) =>
    Effect.gen(function* () {
      if (!(yield* deps.enabled)) {
        yield* Effect.annotateCurrentSpan("agent.process_priority", AGENT_LAUNCH_OFF.mode);
        return AGENT_LAUNCH_OFF;
      }
      const env = request.env ?? process.env;
      const niceExecutable = deps.platform === "win32" ? null : deps.niceExecutable();
      if (deps.platform !== "win32" && niceExecutable === null && !missingNiceReported) {
        missingNiceReported = true;
        yield* Effect.logWarning(
          "No nice executable found; agent priority is lowered after spawn (main thread only on Linux).",
        );
      }
      const dyldEnvironment = deps.platform === "darwin" && hasDyldEnvironment(env);
      // Resolve the command only when a wrap is possible: Windows, shell launches, a missing
      // `nice` and macOS DYLD environments all lower after spawn without changing the argv.
      const canWrap =
        deps.platform !== "win32" && !request.shell && niceExecutable !== null && !dyldEnvironment;
      const commandResolves = canWrap
        ? yield* Effect.promise(() =>
            deps
              .commandResolves(request.command, {
                env,
                cwd: request.cwd,
                platform: deps.platform,
              })
              .catch(() => false),
          )
        : false;
      const launchPlan = planAgentLaunch({
        enabled: true,
        platform: deps.platform,
        shell: request.shell,
        niceExecutable,
        commandResolves,
        dyldEnvironment,
      });
      yield* Effect.annotateCurrentSpan("agent.process_priority", launchPlan.mode);
      return launchPlan;
    });

  const lowerAfterSpawn: AgentProcessPriorityShape["lowerAfterSpawn"] = (pid) =>
    Effect.sync(() => deps.lowerChild(pid)).pipe(
      Effect.flatMap((result) =>
        result === "failed"
          ? Effect.logDebug("Could not lower the agent process priority", { pid })
          : Effect.void,
      ),
      Effect.catchCause(() => Effect.void),
    );

  return { plan, lowerAfterSpawn };
};

/** Agent priority that never changes anything; for tests and stripped-down stacks. */
export const AgentProcessPriorityOff: AgentProcessPriorityShape = {
  plan: () => Effect.succeed(AGENT_LAUNCH_OFF),
  lowerAfterSpawn: () => Effect.void,
};

/** {@link AgentProcessPriorityOff} as a layer, for test stacks that build agent drivers. */
export const AgentProcessPriorityOffLive = Layer.succeed(
  AgentProcessPriority,
  AgentProcessPriorityOff,
);

export const AgentProcessPriorityLive: Layer.Layer<
  AgentProcessPriority,
  never,
  ServerSettingsService
> = Layer.effect(
  AgentProcessPriority,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    return makeAgentProcessPriority({
      enabled: settings.getSettings.pipe(
        Effect.map((current) => current.lowerAgentProcessPriority),
        Effect.catch((cause) =>
          Effect.logWarning(
            "Could not read the agent priority setting; using the default (on)",
            cause,
          ).pipe(Effect.as(true)),
        ),
      ),
      platform: process.platform,
      niceExecutable: resolveNiceExecutable,
      commandResolves: agentCommandResolves,
      lowerChild: (pid) => lowerChildProcessPriority(pid),
    });
  }),
);

/**
 * `spawner.spawn(command)` for an agent process, lowered per the current plan. Identical to it
 * when `priority` is undefined or the plan is "off". Errors are the spawner's own, so callers
 * keep their error mapping (and user-facing command text) unchanged.
 */
export const spawnAgentProcess = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  priority: AgentProcessPriorityShape | undefined,
  command: ChildProcess.StandardCommand,
): Effect.Effect<
  ChildProcessSpawner.ChildProcessHandle,
  PlatformError.PlatformError,
  Scope.Scope
> => {
  if (priority === undefined) return spawner.spawn(command);
  return Effect.gen(function* () {
    const options = command.options;
    // Mirrors the spawner's own environment resolution, so the lookup sees the child's PATH.
    const env = options.extendEnv
      ? { ...process.env, ...options.env }
      : (options.env ?? process.env);
    const plan = yield* priority.plan({
      command: command.command,
      env,
      cwd: options.cwd,
      shell: Boolean(options.shell),
    });
    if (plan.mode === "exec-nice") {
      const argv = applyAgentLaunchPlan(plan, command.command, command.args);
      // The same options object: cwd, env, extendEnv, detached, shell, stdio and kill options.
      return yield* spawner.spawn(ChildProcess.make(argv.command, [...argv.args], options));
    }
    const handle = yield* spawner.spawn(command);
    if (plan.mode === "after-spawn") yield* priority.lowerAfterSpawn(handle.pid);
    return handle;
  });
};
