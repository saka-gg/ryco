/**
 * `ryco_watch_command`, `ryco_unwatch_command`, `ryco_list_command_watches`: private-session
 * tools for command watches (T3 Code's `watch_command` and `unwatch_command`, see
 * `docs/command-watch.md`). Never installed on the external endpoint; loaded on first use
 * (`withLazyAgentControlTools`).
 *
 * Trust boundary: the node runs a watched command later, unattended, with its own privileges,
 * so starting one is limited to what the agent could run itself right now, in its own chat:
 * - the target is always the caller's own chat (the tools take no thread id);
 * - changes need exact active-turn authority and the `commands.watch` grant (listing needs the
 *   grant), with Agent Control on;
 * - the chat must be in Full access and default mode, live, unarchived and unsettled (the
 *   decider checks these again atomically, plus 5 per chat and 50 per node);
 * - a delegated chat whose result is still awaited cannot watch (it reports instead), failing
 *   closed when the completion-return ledger cannot be read.
 * Starting is routine (no approval): it never grants more than the agent already has in that
 * state, and the user sees and stops the watch (Stop, settle, archive, `thread.command-watch.stop`).
 *
 * @module agentControl/Mcp/commandWatchTools
 */
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_COMMAND_WATCH_MCP_TOOLS as TOOLS,
  COMMAND_WATCHES_PER_THREAD,
  CommandWatchCommand,
  CommandWatchEveryMinutes,
  CommandWatchLabel,
  TrimmedNonEmptyString,
  rejectExcessProperties,
  type ThreadCommandWatches,
  type TurnId,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";

import type { CommandWatchServiceShape } from "../../commandWatch/CommandWatchService.ts";
import type {
  CompletionReturnRepository,
  isPendingCompletionReturn,
} from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
} from "../Services/AgentControlSessionRegistry.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
} from "./tools.ts";

/** T3 Code's default interval. */
const DEFAULT_EVERY_MINUTES = 10;

const watchDescriptor: AgentControlMcpToolDescriptor = {
  name: TOOLS.watch,
  description: `Have Ryco run a shell command for this chat on an interval, with no model involved, and wake you when it prints something new. Use it to wait on anything that is not a pull request (ryco_watch_pull_request covers those): a discussion or issue reply, another repository's CI, a deploy, a release. Write a read-only check whose output changes only when there is news, for example the last few comments from other accounts plus the item's state, or JSON filtered with curl -s ... | jq -e .... The first run only records what the check prints at that moment, so a state that already holds never wakes you: run the check yourself first if you need the current state. After that, a run that exits 0 with output that differs from what you last saw wakes you with that output. Exit 0 with no output, or exit 1 with nothing on stderr, is quiet, so grep and jq -e gates work. Any other exit, including exit 1 with anything on stderr, or a 60 second timeout is a failure, and 8 in a row stop the watch, so silence stages that write progress or warnings to stderr (curl -s, 2>/dev/null). Output over 4 KB stops it too, so keep the output small. The same output does not wake you twice, and the watch stops after 10 wakes or 7 days. It runs in this chat's checkout with the node's environment (without Ryco's own variables), not yours, and with no input: rely on tools already logged in on the node, and keep secrets out of the command, since the user sees it. While Ryco watches, the chat does not settle on its own. When you hand the work back to the user, call ryco_unwatch_command first. Watching also ends when the user stops this chat, when it settles, is archived, or leaves Full access or default mode. Needs this chat in Full access and default mode; at most ${COMMAND_WATCHES_PER_THREAD} per chat. A chat delegated with returnToOrigin cannot watch: report what to watch in your result. Watching the same command again returns the existing watch unchanged: to change its interval or label, call ryco_unwatch_command first.`,
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
        description:
          "Shell command to run, for example a gh or curl query filtered with jq or grep. It runs in this chat's checkout.",
      },
      label: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description:
          "Short name the user sees for this watch, for example 'Maintainer reply on #123'.",
      },
      everyMinutes: {
        type: "integer",
        minimum: 1,
        maximum: 1440,
        description: `Minutes between runs, 1 to 1440. Defaults to ${DEFAULT_EVERY_MINUTES}.`,
      },
    },
    required: ["command", "label"],
    additionalProperties: false,
  },
};

const unwatchDescriptor: AgentControlMcpToolDescriptor = {
  name: TOOLS.unwatch,
  description:
    "Stop a command watch on this chat, or every command watch when watchId is omitted. Stopping a watch that already ended changes nothing.",
  inputSchema: {
    type: "object",
    properties: { watchId: { type: "string", maxLength: 256 } },
    additionalProperties: false,
  },
};

const listDescriptor: AgentControlMcpToolDescriptor = {
  name: TOOLS.list,
  description:
    "List this chat's command watches: active ones with their command, label, interval and wakes so far, and the last few that ended with why.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

// Unknown keys are refused, so a `threadId` never silently falls back to the caller's chat.
const WatchInput = Schema.Struct({
  command: CommandWatchCommand,
  label: CommandWatchLabel,
  everyMinutes: Schema.optional(CommandWatchEveryMinutes),
}).pipe(rejectExcessProperties);
const UnwatchInput = Schema.Struct({ watchId: Schema.optional(TrimmedNonEmptyString) }).pipe(
  rejectExcessProperties,
);
const ListInput = Schema.Struct({}).pipe(rejectExcessProperties);

const NO_AUTHORITY = "Exact active-turn write authority is unavailable.";

const textResult = (value: unknown): AgentControlMcpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const errorResult = (text: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

class ToolFailure {
  readonly _tag = "ToolFailure";
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export interface CommandWatchToolDeps {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly projections: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">;
  readonly watches: CommandWatchServiceShape;
  /** The delegation ledger (absent when the node keeps none) and its "still owes a result" rule. */
  readonly completionReturns: Pick<CompletionReturnRepository["Service"], "get"> | undefined;
  readonly isPendingCompletionReturn: typeof isPendingCompletionReturn;
}

/** What the agent reads of its own chat's watches (the commands are its own). */
const view = (watches: ThreadCommandWatches) => ({
  active: watches.active.map((watch) => ({
    watchId: watch.watchId,
    label: watch.label,
    command: watch.command,
    everyMinutes: watch.everyMinutes,
    startedAt: watch.startedAt,
    wakes: watch.wakes,
    lastChangeAt: watch.lastChangeAt,
    baselineRecorded: watch.lastOutputHash !== null,
  })),
  ended: watches.ended,
});

/** Private, provider-session tools only. Same wrapper pattern as the queue tools. */
export function withCommandWatchTools(
  base: AgentControlMcpTools,
  deps: CommandWatchToolDeps,
): AgentControlMcpTools {
  const owned = [watchDescriptor, unwatchDescriptor, listDescriptor];
  const owns = (name: string) => owned.some((tool) => tool.name === name);
  const granted = (session: AgentControlSessionRecord) =>
    session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.watchCommands);

  const authorize = (session: AgentControlSessionRecord, name: string, turnId?: TurnId) =>
    deps.policy
      .authorize({
        principal: {
          kind: "provider-session",
          threadId: session.threadId,
          providerInstanceId: session.providerInstanceId,
          runtimeSessionId: session.runtimeSessionId,
          ...(turnId === undefined ? {} : { turnId }),
        },
        grantedCapabilities: session.grantedCapabilities,
        requiredCapability: AGENT_CONTROL_CAPABILITIES.watchCommands,
        operation: `mcp:${name}`,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "AgentControlDisabledError"
            ? new ToolFailure("Agent Control is disabled.")
            : new ToolFailure("Capability denied."),
        ),
      );

  const writeAuthority = (session: AgentControlSessionRecord, name: string) =>
    Effect.gen(function* () {
      const authority = Option.filter(
        yield* deps.registry.getTurnAuthority(session.sessionId),
        (value) => value.sessionId === session.sessionId && value.threadId === session.threadId,
      );
      if (Option.isNone(authority)) return yield* Effect.fail(new ToolFailure(NO_AUTHORITY));
      yield* authorize(session, name, authority.value.turnId);
    });

  const decode = <S extends Schema.Top>(schema: S, args: unknown) =>
    Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
      Effect.mapError(() => new ToolFailure("Invalid tool arguments.")),
    ) as Effect.Effect<S["Type"], ToolFailure>;

  const failed = Effect.mapError(
    (error: { readonly detail: string }) => new ToolFailure(error.detail),
  );

  const watch = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* writeAuthority(session, watchDescriptor.name);
      const input = yield* decode(WatchInput, args);
      const shell = Option.getOrNull(
        yield* deps.projections
          .getThreadShellById(session.threadId)
          .pipe(Effect.mapError(() => new ToolFailure("Could not read this chat. Try again."))),
      );
      if (shell === null) return yield* Effect.fail(new ToolFailure("Thread not found."));
      // The node runs it later without asking, so it may run only what this chat runs freely.
      if (shell.runtimeMode !== "full-access" || shell.interactionMode !== "default") {
        return yield* Effect.fail(
          new ToolFailure(
            "Watching a command needs this chat in Full access and default mode, because Ryco runs it later without asking. Ask the user to switch the chat to Full access, or check yourself instead.",
          ),
        );
      }
      if (deps.completionReturns !== undefined) {
        const pending = yield* deps.completionReturns.get(session.threadId).pipe(
          Effect.map((record) => record !== undefined && deps.isPendingCompletionReturn(record)),
          Effect.orElseSucceed(() => null),
        );
        // Fails closed: a watch never starts on a chat that may owe its result.
        if (pending === null) {
          return yield* Effect.fail(
            new ToolFailure("Could not check whether this chat was delegated. Try again."),
          );
        }
        if (pending) {
          return yield* Effect.fail(
            new ToolFailure(
              "This chat was delegated by another chat that waits for its result, so it cannot watch commands. Finish your task and report what to watch; the delegating chat can watch it.",
            ),
          );
        }
      }
      const runtime = yield* deps.watches.runtime;
      const started = yield* runtime
        .start({
          threadId: session.threadId,
          command: input.command,
          label: input.label,
          everyMinutes: input.everyMinutes ?? DEFAULT_EVERY_MINUTES,
        })
        .pipe(failed);
      return textResult({
        watchId: started.watchId,
        started: started.started,
        note: started.started
          ? "Watching. The first run records the baseline; Ryco wakes this chat when the output changes, so end your turn when you are done."
          : "This chat already watches that command; the watch is unchanged.",
        watches: view(started.watches),
      });
    });

  const unwatch = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* writeAuthority(session, unwatchDescriptor.name);
      const input = yield* decode(UnwatchInput, args);
      const runtime = yield* deps.watches.runtime;
      const result = yield* runtime
        .stop({ threadId: session.threadId, watchId: input.watchId })
        .pipe(failed);
      return textResult({
        stopped: result.stopped,
        watches: view(yield* runtime.list(session.threadId)),
      });
    });

  const list = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* authorize(session, listDescriptor.name);
      yield* decode(ListInput, args);
      const runtime = yield* deps.watches.runtime;
      return textResult(view(yield* runtime.list(session.threadId)));
    });

  const run = (effect: Effect.Effect<AgentControlMcpToolResult, ToolFailure>, fallback: string) =>
    effect.pipe(
      Effect.catch((error) => Effect.succeed(errorResult(error.text))),
      Effect.catchCause(() => Effect.succeed(errorResult(fallback))),
    );

  return {
    ...base,
    descriptors: [...base.descriptors, ...owned],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled) || !granted(session)) return tools;
        return [...tools, ...owned];
      }),
    hasTool: (name) => owns(name) || base.hasTool(name),
    isWriteTool: (name) =>
      name === watchDescriptor.name || name === unwatchDescriptor.name || base.isWriteTool(name),
    callTool: (session, name, args) => {
      if (name === watchDescriptor.name) return run(watch(session, args), "Watching failed.");
      if (name === unwatchDescriptor.name) return run(unwatch(session, args), "Stopping failed.");
      if (name === listDescriptor.name) return run(list(session, args), "Listing failed.");
      return base.callTool(session, name, args);
    },
  };
}
