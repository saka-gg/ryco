/**
 * `ryco_terminal`: agents use their thread's terminals, the same ones the user sees in the
 * terminal drawer, through one tool with actions (run, read, wait, send, interrupt, create, list,
 * close). Results are written for a model: what happened, the rendered output cut on purpose
 * (with the exact call that reads the rest), what the terminal is doing now, and what to call
 * next.
 *
 * Every wait is bounded ({@link MAX_WAIT_SECONDS}, under the 60 s every Agent Control call is
 * cut at): a command still running is reported with its activity, and keeps running.
 *
 * Access (`terminal/agent/access.ts`): the caller's own thread only; terminals the agent opened
 * are its own; typing into one the user opened needs the user's consent for the task (a
 * `terminalControlConsent` card), except in a Full access thread.
 *
 * Private provider sessions only, with exact active-turn authority and the `terminals.control`
 * grant. Loaded on first use (`withLazyAgentControlTools`); it imports nothing at runtime from
 * the boot-loaded tool catalogue.
 *
 * @module agentControl/Mcp/terminalTools
 */
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_TERMINAL_MCP_TOOL,
  AgentControlRequestId,
  TerminalBusyError,
  type AgentControlProposalId,
  type TerminalRef,
  type TerminalSessionSnapshot,
} from "@ryco/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@ryco/shared/projectScripts";
import { encodeTerminalPaste } from "@ryco/shared/terminalPaste";
import { Effect, Option, Schema } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  TerminalAgentWriteChecks,
  TerminalAgentWriteRefused,
  TerminalManagerShape,
} from "../../terminal/Services/Manager.ts";
import {
  CONSENT_REFUSAL_COOLDOWN_MS,
  decideTerminalAccess,
  isAgentTerminalId,
  AGENT_TERMINAL_ID_PREFIX,
  type ConsentStatus,
  type TerminalUse,
} from "../../terminal/agent/access.ts";
import type { Activity } from "../../terminal/agent/activity.ts";
import {
  MAX_MIRRORS,
  MIRROR_SCROLLBACK,
  MirrorLimitError,
  makeAgentTerminals,
  type AgentTerminals,
  type Execution,
  type TrackedTerminal,
} from "../../terminal/agent/AgentTerminals.ts";
import { describeInput, encodeKeys, KeyError } from "../../terminal/agent/keys.ts";
import {
  clampMaxChars,
  clipLines,
  DEFAULT_MAX_CHARS,
  formatClip,
  formatDuration,
  MAX_MAX_CHARS,
  MIN_MAX_CHARS,
  shortCommand,
} from "../../terminal/agent/render.ts";
import {
  askForTaskConsent,
  TaskConsents,
  taskConsentRequestId,
  type TaskConsentKey,
} from "../taskConsent.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type { AgentControlProposalServiceShape } from "../Services/AgentControlProposalService.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import { ToolFailure } from "./toolFailure.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
  submitAgentControlMutation,
} from "./tools.ts";

const TOOL = AGENT_CONTROL_TERMINAL_MCP_TOOL;

/** The longest any action waits: every Agent Control call is cut at 60 s. */
export const MAX_WAIT_SECONDS = 45;
const DEFAULT_RUN_TIMEOUT_SECONDS = 30;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 30;
const DEFAULT_SEND_WAIT_SECONDS = 2;
const MAX_SEND_WAIT_SECONDS = 10;
const INTERRUPT_WAIT_MS = 5_000;
/** A new shell gets this long to draw its first prompt. */
const SHELL_READY_MS = 10_000;
/** How long `run` waits for a shell that just finished a command to draw its prompt. */
const PROMPT_SETTLE_MS = 2_000;
/** Activity checks (which may read the tty) during a wait, at most this often. */
const ACTIVITY_CHECK_MS = 1_000;
const MAX_COMMAND_CHARS = 16_000;
const MAX_SEND_TEXT_CHARS = 4_000;
const MAX_TERMINALS_PER_THREAD = 8;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

const ACTIONS = ["run", "read", "wait", "send", "interrupt", "create", "list", "close"] as const;
type Action = (typeof ACTIONS)[number];

export const TERMINAL_TOOL_DESCRIPTOR: AgentControlMcpToolDescriptor = {
  name: TOOL,
  description: [
    "Use this thread's terminals: real shells the user sees in Ryco's terminal panel and can type in too.",
    'Actions: run (a shell command; returns its output and exit code, or, if it still runs after timeout_seconds, what it is doing; it keeps running), read (what: "new" output since your last look, "command" the last command\'s whole output, paged with from_line, "screen" what is on screen now), wait (until the command ends or for_text appears), send (type text and/or press keys: answer a prompt, drive a menu or full-screen program), interrupt (Ctrl+C), create (open another terminal), list, close (only terminals you opened).',
    'Without `terminal`, actions use your current terminal; run opens one when you have none. For servers and watchers use a short timeout_seconds, then wait with for_text (e.g. "ready").',
    `Waits are bounded (at most ${MAX_WAIT_SECONDS} s); results say what the terminal is doing (working, waiting-for-input, full-screen, silent) and the exact next call. Output is what the screen shows, cut to max_chars (default ${DEFAULT_MAX_CHARS}) keeping the end; a cut names the call that reads the rest.`,
    "Secrets: never type a password, token or code you were not given, and never ask for one in chat. When a result says the terminal waits for hidden input or a sign-in, tell the user in chat which terminal needs them, let them type it there, and wait. What anyone types at a hidden prompt never reaches you; text the terminal displays does.",
    "Terminals the user opened can be read; typing into them asks the user once per task.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      terminal: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Terminal id from list (e.g. agent-1). Default: your current terminal.",
      },
      command: {
        type: "string",
        minLength: 1,
        maxLength: MAX_COMMAND_CHARS,
        description: "run: as typed at the shell's prompt.",
      },
      timeout_seconds: {
        type: "number",
        minimum: 0,
        maximum: MAX_WAIT_SECONDS,
        description: `run, wait: longest wait. Default ${DEFAULT_RUN_TIMEOUT_SECONDS}.`,
      },
      what: {
        type: "string",
        enum: ["new", "command", "screen"],
        description: "read. Default new.",
      },
      from_line: {
        type: "integer",
        minimum: 1,
        description: 'read with what "command": first line (1-based), for paging.',
      },
      for_text: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "wait: regex or plain text (case-insensitive) to wait for in new output.",
      },
      text: {
        type: "string",
        maxLength: MAX_SEND_TEXT_CHARS,
        description: 'send: typed as is; add keys ["Enter"] to submit.',
      },
      keys: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 32 },
        maxItems: 32,
        description:
          'send: pressed after text, e.g. ["Enter"], ["Down","Enter"], ["Ctrl+C"], ["Escape"], ["q"].',
      },
      wait_seconds: {
        type: "number",
        minimum: 0,
        maximum: MAX_SEND_WAIT_SECONDS,
        description: `send: longest wait for output to settle. Default ${DEFAULT_SEND_WAIT_SECONDS}.`,
      },
      max_chars: {
        type: "integer",
        minimum: MIN_MAX_CHARS,
        maximum: MAX_MAX_CHARS,
        description: `Output size. Default ${DEFAULT_MAX_CHARS}.`,
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

const Input = Schema.Struct({
  action: Schema.Literals(ACTIONS),
  terminal: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  command: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_COMMAND_CHARS)),
  ),
  timeout_seconds: Schema.optional(
    Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(MAX_WAIT_SECONDS),
    ),
  ),
  what: Schema.optional(Schema.Literals(["new", "command", "screen"])),
  from_line: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  for_text: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_SEND_TEXT_CHARS))),
  keys: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))).check(
      Schema.isMaxLength(32),
    ),
  ),
  wait_seconds: Schema.optional(
    Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(MAX_SEND_WAIT_SECONDS),
    ),
  ),
  max_chars: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(MIN_MAX_CHARS),
      Schema.isLessThanOrEqualTo(MAX_MAX_CHARS),
    ),
  ),
});
type Input = typeof Input.Type;

export const TERMINAL_CONSENT_PENDING_TEXT =
  'Nothing was typed. Typing into a terminal the user opened needs their permission for this task; Ryco asked them in the chat. Call ryco_wait_for_control_request with this proposalId (waitFor "terminal"), then repeat this exact call. Or use a terminal of your own (omit `terminal`).';
export const TERMINAL_CONSENT_DECLINED_TEXT =
  "Nothing was typed. The user declined letting you type in their terminal. Do not ask again; use a terminal of your own (omit `terminal`), or ask the user in chat.";
export const TERMINAL_CONSENT_UNANSWERED_TEXT =
  "Nothing was typed. Permission to type in the user's terminal was not given in time. Do not retry; use a terminal of your own (omit `terminal`).";

export interface TerminalToolDeps {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly proposals: Pick<AgentControlProposalServiceShape, "getProposal">;
  readonly submitMutation: (
    input: Parameters<typeof submitAgentControlMutation>[1],
  ) => ReturnType<typeof submitAgentControlMutation>;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getThreadCheckpointContext"
  >;
  readonly terminals: TerminalManagerShape;
  /** Tests pass their own clock. */
  readonly now?: () => number;
}

interface TerminalConsentKey extends TaskConsentKey {
  readonly terminalId: string;
}

const text = (body: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text: body }],
});
const errorText = (body: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text: body }],
  isError: true,
});

const join = (parts: ReadonlyArray<string | undefined>) =>
  parts.filter((part): part is string => part !== undefined && part !== "").join("\n");

const call = (args: Record<string, unknown>) => `${TOOL} ${JSON.stringify(args)}`;

function toPattern(value: string): RegExp {
  try {
    return new RegExp(value, "i");
  } catch {
    return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

const isBusyError = Schema.is(TerminalBusyError);

const waitMs = (seconds: number | undefined, fallback: number) =>
  Math.round(Math.min(MAX_WAIT_SECONDS, Math.max(0, seconds ?? fallback)) * 1000);

export function withTerminalTools(
  base: AgentControlMcpTools,
  deps: TerminalToolDeps,
): AgentControlMcpTools {
  const now = deps.now ?? Date.now;
  const consents = new TaskConsents<TerminalConsentKey>((key) => key.terminalId);
  /** Until when a decline in an earlier task still refuses, per thread and terminal. */
  const refusedUntil = new Map<string, number>();
  /** Each thread's current terminal: the one it last used. */
  const currentByThread = new Map<string, string>();
  let runtime: AgentTerminals | undefined;
  const getRuntime = Effect.suspend(() =>
    runtime !== undefined
      ? Effect.succeed(runtime)
      : makeAgentTerminals({ terminals: deps.terminals, now }).pipe(
          Effect.map((made) => {
            if (runtime !== undefined) {
              made.close();
              return runtime;
            }
            runtime = made;
            return made;
          }),
        ),
  );

  const visibleTo = (session: AgentControlSessionRecord) =>
    deps.terminals.inspect !== undefined &&
    session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.controlTerminals);

  const requireAuthority = (session: AgentControlSessionRecord) =>
    deps.registry.getTurnAuthority(session.sessionId).pipe(
      Effect.map(
        Option.filter(
          (authority) =>
            authority.sessionId === session.sessionId && authority.threadId === session.threadId,
        ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new ToolFailure("Exact active-turn terminal authority is unavailable.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const authorize = (session: AgentControlSessionRecord, authority: AgentControlTurnAuthority) =>
    deps.policy
      .authorize({
        principal: {
          kind: "provider-session",
          threadId: session.threadId,
          providerInstanceId: session.providerInstanceId,
          runtimeSessionId: session.runtimeSessionId,
          turnId: authority.turnId,
        },
        grantedCapabilities: session.grantedCapabilities,
        requiredCapability: AGENT_CONTROL_CAPABILITIES.controlTerminals,
        operation: `mcp:${TOOL}`,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "AgentControlDisabledError"
            ? new ToolFailure("Agent Control is disabled.")
            : new ToolFailure("Capability denied."),
        ),
      );

  const threadShell = (session: AgentControlSessionRecord) =>
    deps.projections.getThreadShellById(session.threadId).pipe(
      Effect.mapError(() => new ToolFailure("The thread could not be read.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ToolFailure("The thread no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** Where every client opens this thread's terminals, so opening one never relaunches it. */
  const launchFor = (session: AgentControlSessionRecord) =>
    deps.projections.getThreadCheckpointContext(session.threadId).pipe(
      Effect.mapError(() => new ToolFailure("The thread's checkout could not be read.")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new ToolFailure("This thread has no checkout to open a terminal in.")),
          onSome: (context) => {
            const project = { cwd: context.workspaceRoot };
            return Effect.succeed({
              cwd: projectScriptCwd({ project, worktreePath: context.worktreePath }),
              worktreePath: context.worktreePath,
              env: projectScriptRuntimeEnv({ project, worktreePath: context.worktreePath }),
            });
          },
        }),
      ),
    );

  const threadSessions = (session: AgentControlSessionRecord) =>
    deps.terminals.listSessions.pipe(
      Effect.map((sessions) => sessions.filter((entry) => entry.threadId === session.threadId)),
    );

  const owner = (terminalId: string) => (isAgentTerminalId(terminalId) ? "you" : "the user");

  // ── consent ─────────────────────────────────────────────────────────

  const consentFor = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    terminalId: string,
    use: TerminalUse,
  ): Effect.Effect<void, ToolFailure> =>
    Effect.gen(function* () {
      const thread = yield* threadShell(session);
      const key: TerminalConsentKey = {
        threadId: session.threadId,
        turnId: authority.taskTurnId ?? authority.turnId,
        runtimeSessionId: session.runtimeSessionId,
        terminalId,
      };
      const entry = consents.lookup(key);
      const indexStatus: ConsentStatus =
        entry?.outcome === "granted"
          ? "granted"
          : entry?.outcome === "denied" || entry?.outcome === "unanswered"
            ? "declined"
            : entry !== undefined
              ? "pending"
              : "none";
      const refusalKey = `${session.threadId}\u0000${terminalId}`;
      const decision = decideTerminalAccess(
        {
          callerThreadId: session.threadId,
          terminalThreadId: session.threadId,
          terminalId,
          fullAccess: thread.runtimeMode === "full-access",
          consent: indexStatus,
          refusedUntil: refusedUntil.get(refusalKey),
          now: now(),
        },
        use,
      );
      if (decision.kind === "allowed") return;
      if (decision.kind === "denied") {
        return yield* Effect.fail(
          new ToolFailure(
            decision.reason === "user-terminal-close"
              ? `${terminalId} is the user's terminal; only the user closes it.`
              : decision.reason === "cooldown"
                ? "The user recently declined letting you type in this terminal. Do not ask again yet; use a terminal of your own (omit `terminal`), or ask the user in chat."
                : TERMINAL_CONSENT_DECLINED_TEXT,
          ),
        );
      }
      const answer = yield* askForTaskConsent({
        consents,
        key,
        proposalStatus: (proposalId) =>
          deps.proposals.getProposal(proposalId).pipe(
            Effect.mapError(() => new ToolFailure("Terminal consent state is unavailable.")),
            Effect.map((proposal) => (Option.isSome(proposal) ? proposal.value.status : undefined)),
          ),
        submit: (attempt) =>
          deps
            .submitMutation({
              session,
              authority,
              requestId: AgentControlRequestId.make(
                taskConsentRequestId("terminal-consent", key, terminalId, attempt),
              ),
              plan: {
                kind: "terminalControlConsent",
                threadId: session.threadId,
                projectId: thread.projectId,
                providerInstanceId: session.providerInstanceId,
                terminalId,
              },
            })
            .pipe(
              Effect.mapError(() => new ToolFailure("The permission request could not be sent.")),
              Effect.map((submitted) => ({
                proposalId: submitted.receipt.proposalId as AgentControlProposalId,
                status: submitted.receipt.status,
              })),
            ),
      });
      switch (answer.kind) {
        case "granted":
          return;
        case "pending":
          return yield* Effect.fail(
            new ToolFailure(
              `${JSON.stringify({ consent: "pending", proposalId: answer.proposalId })}\n${TERMINAL_CONSENT_PENDING_TEXT}`,
            ),
          );
        case "declined":
        case "unanswered":
          refusedUntil.set(refusalKey, now() + CONSENT_REFUSAL_COOLDOWN_MS);
          return yield* Effect.fail(
            new ToolFailure(
              answer.kind === "declined"
                ? TERMINAL_CONSENT_DECLINED_TEXT
                : TERMINAL_CONSENT_UNANSWERED_TEXT,
            ),
          );
      }
    });

  // ── descriptions ───────────────────────────────────────────────────

  const doing = (rt: AgentTerminals, t: TrackedTerminal): string => {
    const current = t.current;
    if (current !== undefined && !current.ended) {
      return `running ${current.commandLine === undefined ? "a command the user started" : `\`${shortCommand(current.commandLine)}\``} for ${formatDuration(now() - current.startedAt)}`;
    }
    return rt.isRunning(t) ? "running a command" : "idle at the prompt";
  };

  const activityLine = (t: TrackedTerminal, activity: Activity): string => {
    const id = t.ref.terminalId;
    const quiet = `${activity.quietSeconds.toFixed(1)} s`;
    switch (activity.kind) {
      case "idle":
        return "Activity: idle.";
      case "working":
        return "Activity: working (output is still arriving).";
      case "full-screen":
        return `Activity: full-screen (a full-screen program owns the screen, quiet ${quiet}). Read it with ${call({ action: "read", terminal: id, what: "screen" })}, drive it with send keys (q quits most pagers), or interrupt it.`;
      case "silent":
        return `Activity: silent (no output for ${quiet} and no prompt on screen: probably still working, or waiting without a prompt).`;
      case "waiting-for-input": {
        const prompt = activity.prompt === undefined ? "" : ` at "${activity.prompt}"`;
        if (activity.secret) {
          return `Activity: waiting-for-input, secret${prompt}${activity.evidence === "tty" ? " (the terminal's echo is off: hidden input)" : ""}. Do not type it and never ask for it in chat: tell the user in chat that terminal ${id} needs them to type it there, then ${call({ action: "wait", terminal: id })}. What they type there never reaches you.`;
        }
        if (activity.signIn !== undefined) {
          const parts = [
            ...activity.signIn.urls.map((url) => `link ${url}`),
            ...activity.signIn.codes.map((code) => `code ${code}`),
          ].join(", ");
          return `Activity: waiting-for-input, sign-in${prompt}: the command waits for a sign-in (${parts}). Tell the user in chat to finish it (in the terminal and their browser), then ${call({ action: "wait", terminal: id })}.`;
        }
        return `Activity: waiting-for-input${prompt} (no output for ${quiet}). Answer with ${call({ action: "send", terminal: id, text: "…", keys: ["Enter"] })} only if you know the answer; otherwise ask the user in chat.`;
      }
    }
  };

  const statusOf = (rt: AgentTerminals, t: TrackedTerminal, activity: Activity | undefined) => {
    const id = t.ref.terminalId;
    if (t.exited) {
      return isAgentTerminalId(id)
        ? `${id} has exited; run starts a new shell in it.`
        : `The user's terminal ${id} has exited; use a terminal of your own.`;
    }
    if (rt.isRunning(t)) {
      return join([
        `${id} is ${doing(rt, t)}.`,
        activity === undefined ? undefined : activityLine(t, activity),
      ]);
    }
    const last = t.last;
    const lastLine =
      last === undefined
        ? ""
        : ` Last command ${last.commandLine === undefined ? "" : `\`${shortCommand(last.commandLine)}\` `}${exitWords(last)}.`;
    return `${id} is idle at the prompt.${lastLine}`;
  };

  const exitWords = (execution: Execution) =>
    execution.exitCode !== undefined
      ? `exited with code ${execution.exitCode}`
      : execution.endedBy === "exit"
        ? "ended with its shell"
        : execution.endedBy === "guess"
          ? "finished (exit code unknown: this shell does not report it)"
          : "finished";

  const finishedLine = (t: TrackedTerminal, execution: Execution) =>
    `${execution.commandLine === undefined ? "The command" : `\`${shortCommand(execution.commandLine)}\``} ${exitWords(execution)} after ${formatDuration((execution.endedAt ?? now()) - execution.startedAt)} in ${t.ref.terminalId}.`;

  const readCall = (t: TrackedTerminal, fromLine: number) =>
    call({ action: "read", terminal: t.ref.terminalId, what: "command", from_line: fromLine });

  const outputBlock = (
    rt: AgentTerminals,
    t: TrackedTerminal,
    execution: Execution,
    maxChars: number | undefined,
    fromLine?: number,
  ) => {
    const { lines, startLost } = rt.outputOf(t, execution);
    return formatClip(clipLines(lines, { maxChars, fromLine }), (from) => readCall(t, from), {
      startLost,
      historyLines: MIRROR_SCROLLBACK,
    });
  };

  const newOutputBlock = (
    rt: AgentTerminals,
    t: TrackedTerminal,
    threadId: string,
    maxChars: number | undefined,
  ) => {
    const { lines, startLost } = rt.readNew(t, threadId);
    if (lines.length === 0) return "(no new output)";
    const more =
      (t.current ?? t.last)
        ? readCall(t, 1)
        : call({ action: "read", terminal: t.ref.terminalId, what: "screen" });
    return formatClip(clipLines(lines, { maxChars }), () => more, { startLost });
  };

  // ── terminal resolution ────────────────────────────────────────────

  /** Starts the shell of a terminal the agent owns (new, or exited) where clients open it. */
  const startOwnTerminal = (session: AgentControlSessionRecord, terminalId: string) =>
    Effect.gen(function* () {
      const launch = yield* launchFor(session);
      yield* deps.terminals
        .open({
          threadId: session.threadId,
          terminalId,
          cwd: launch.cwd,
          worktreePath: launch.worktreePath,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          env: launch.env,
        })
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure(`The terminal could not start: ${error.message}`),
          ),
        );
    });

  const nextAgentTerminalId = (sessions: ReadonlyArray<TerminalSessionSnapshot>) => {
    let highest = 0;
    for (const entry of sessions) {
      const match = new RegExp(`^${AGENT_TERMINAL_ID_PREFIX}(\\d+)$`).exec(entry.terminalId);
      if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
    return `${AGENT_TERMINAL_ID_PREFIX}${highest + 1}`;
  };

  /** Opens a new terminal of the agent's and waits (bounded) for its first prompt. */
  const createTerminal = (rt: AgentTerminals, session: AgentControlSessionRecord) =>
    Effect.gen(function* () {
      const sessions = yield* threadSessions(session);
      const live = sessions.filter(
        (entry) => entry.status === "running" || entry.status === "starting",
      );
      if (
        live.filter((entry) => isAgentTerminalId(entry.terminalId)).length >=
        MAX_TERMINALS_PER_THREAD
      ) {
        return yield* Effect.fail(
          new ToolFailure(
            `You already have ${MAX_TERMINALS_PER_THREAD} terminals open in this thread. Close one you no longer need (action close) first.`,
          ),
        );
      }
      const terminalId = nextAgentTerminalId(sessions);
      yield* startOwnTerminal(session, terminalId);
      const t = yield* trackOrFail(rt, { threadId: session.threadId, terminalId });
      yield* waitForShell(rt, t);
      currentByThread.set(session.threadId, terminalId);
      return t;
    });

  /** Until the shell drew its first prompt (with marks: its prompt mark, nothing else). */
  const waitForShell = (rt: AgentTerminals, t: TrackedTerminal) =>
    rt.waitUntil(
      t,
      Effect.gen(function* () {
        if (t.mirror.lastPromptAt > 0) return true;
        const inspection = yield* rt.inspect(t.ref);
        const shell = Option.isSome(inspection) ? inspection.value.shell : undefined;
        if (shell !== undefined) return shell.promptSeen;
        if (t.mirror.received === 0 || rt.quietMs(t) < 700) return false;
        const { beforeCursor } = t.mirror.cursorLine();
        return beforeCursor.trim() !== "";
      }),
      SHELL_READY_MS,
    );

  /**
   * With marks: until the shell draws its prompt (after a command, or once its startup files
   * are done); bounded, and the write checks again.
   */
  const waitForPrompt = (rt: AgentTerminals, t: TrackedTerminal) =>
    rt.waitUntil(
      t,
      rt.inspect(t.ref).pipe(
        Effect.map((inspection) => {
          const shell = Option.isSome(inspection) ? inspection.value.shell : undefined;
          return shell === undefined || (shell.promptSeen && shell.atPrompt);
        }),
      ),
      PROMPT_SETTLE_MS,
    );

  const trackOrFail = (rt: AgentTerminals, ref: TerminalRef) =>
    rt.track(ref).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => unknownTerminal(ref),
          onSome: Effect.succeed,
        }),
      ),
    );

  const unknownTerminal = (ref: TerminalRef) =>
    Effect.gen(function* () {
      const sessions = yield* deps.terminals.listSessions;
      const ids = sessions
        .filter((entry) => entry.threadId === ref.threadId)
        .map((entry) => entry.terminalId);
      return yield* Effect.fail(
        new ToolFailure(
          `This thread has no terminal "${ref.terminalId}". Its terminals: ${ids.join(", ") || "none"}. ${call({ action: "list" })} lists them.`,
        ),
      );
    });

  /** The terminal a reading or input action uses: the given one, or the current one. */
  const existing = (
    rt: AgentTerminals,
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    terminalId: string | undefined,
    use: TerminalUse,
  ) =>
    Effect.gen(function* () {
      const id = terminalId ?? currentByThread.get(session.threadId);
      if (id === undefined) {
        return yield* Effect.fail(
          new ToolFailure(
            `You have no current terminal yet. run opens one with your first command (or ${call({ action: "create" })}); ${call({ action: "list" })} shows the user's.`,
          ),
        );
      }
      yield* consentFor(session, authority, id, use);
      const t = yield* trackOrFail(rt, { threadId: session.threadId, terminalId: id });
      if (terminalId !== undefined) currentByThread.set(session.threadId, id);
      return t;
    });

  const isBusy = (rt: AgentTerminals, t: TrackedTerminal) => !t.exited && rt.isRunning(t);

  const busyFailure = (rt: AgentTerminals, t: TrackedTerminal) =>
    new ToolFailure(
      `${t.ref.terminalId} is busy: ${doing(rt, t)}. Wait for it (${call({ action: "wait", terminal: t.ref.terminalId })}), give it input (send), stop it (interrupt), or omit \`terminal\` to run in a free terminal of your own.`,
    );

  /** The terminal a new command goes to: the given one, or a free one of the agent's own. */
  const forCommand = (
    rt: AgentTerminals,
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    terminalId: string | undefined,
  ) =>
    Effect.gen(function* () {
      if (terminalId !== undefined) {
        yield* consentFor(session, authority, terminalId, "control");
        const known = yield* rt.inspect({ threadId: session.threadId, terminalId });
        if (Option.isNone(known)) {
          if (!isAgentTerminalId(terminalId)) {
            return yield* unknownTerminal({ threadId: session.threadId, terminalId });
          }
          return yield* unknownTerminal({ threadId: session.threadId, terminalId });
        }
        const status = known.value.snapshot.status;
        if (status === "exited" || status === "error") {
          if (!isAgentTerminalId(terminalId)) {
            return yield* Effect.fail(
              new ToolFailure(
                `The user's terminal ${terminalId} has exited; use a terminal of your own (omit \`terminal\`).`,
              ),
            );
          }
          yield* startOwnTerminal(session, terminalId);
        }
        const t = yield* trackOrFail(rt, { threadId: session.threadId, terminalId });
        // A shell that has not drawn its first prompt yet (just opened, or restarted): bounded.
        yield* waitForShell(rt, t);
        if (isBusy(rt, t)) return yield* Effect.fail(busyFailure(rt, t));
        currentByThread.set(session.threadId, terminalId);
        return { t, note: undefined as string | undefined };
      }
      const currentId = currentByThread.get(session.threadId);
      const candidates = (yield* threadSessions(session))
        .filter((entry) => isAgentTerminalId(entry.terminalId))
        .toSorted((a, b) =>
          a.terminalId === currentId
            ? -1
            : b.terminalId === currentId
              ? 1
              : a.terminalId.localeCompare(b.terminalId, undefined, { numeric: true }),
        );
      let busyCurrent: TrackedTerminal | undefined;
      for (const candidate of candidates) {
        if (candidate.status !== "running") continue;
        const tracked = yield* rt.track({
          threadId: session.threadId,
          terminalId: candidate.terminalId,
        });
        if (Option.isNone(tracked)) continue;
        if (!isBusy(rt, tracked.value)) {
          currentByThread.set(session.threadId, candidate.terminalId);
          return {
            t: tracked.value,
            note:
              busyCurrent === undefined
                ? undefined
                : `${busyCurrent.ref.terminalId} is busy (${doing(rt, busyCurrent)}), so this runs in ${candidate.terminalId}.`,
          };
        }
        if (candidate.terminalId === currentId) busyCurrent = tracked.value;
      }
      const created = yield* createTerminal(rt, session);
      return {
        t: created,
        note:
          busyCurrent === undefined
            ? `Opened terminal ${created.ref.terminalId} for you; the user sees it in the terminal panel.`
            : `${busyCurrent.ref.terminalId} is busy (${doing(rt, busyCurrent)}), so I opened ${created.ref.terminalId} for this.`,
      };
    });

  // ── writing ────────────────────────────────────────────────────────

  const write = (t: TrackedTerminal, data: string, requireIdle: boolean) =>
    deps.terminals.write({
      threadId: t.ref.threadId,
      terminalId: t.ref.terminalId,
      data,
      ...(requireIdle ? { requireIdle: true as const } : {}),
    });

  const refusalText = (id: string, reason: TerminalAgentWriteRefused["reason"]) => {
    switch (reason) {
      case "running":
        return `Nothing was typed: ${id} is running a command. Wait for it (${call({ action: "wait", terminal: id })}), or omit \`terminal\` to run in a free terminal of your own.`;
      case "input-raced":
      case "unverified":
        return `Nothing was typed: whether ${id} is idle could not be told just now (someone typed a moment ago, or its processes could not be read). Try again in a moment, or omit \`terminal\` to use a terminal of your own.`;
      case "starting":
        return `Nothing was typed: ${id}'s shell has not drawn its prompt yet; its startup files still run or wait for input (a key passphrase, a question). Read it (${call({ action: "read", terminal: id, what: "screen" })}); if it asks for something only the user knows, tell them in chat.`;
      case "user-typing":
        return `Nothing was typed: someone typed at ${id}'s prompt and has not run it, so your command would be added to their line. Ask the user in chat, or omit \`terminal\` to use a terminal of your own.`;
      case "hidden-input":
        return `Nothing was typed: ${id} waits for hidden input (echo is off: a password or passphrase prompt). Never type a password, token or code you were not given, and never ask for one in chat; tell the user in chat that terminal ${id} needs them to type it there, then ${call({ action: "wait", terminal: id })}. Keys such as Ctrl+C or Escape still go through.`;
      case "input-mode-unknown":
        return `Nothing was typed: whether ${id} hides input right now (its tty's echo flag) could not be read, so Ryco typed nothing. Try again in a moment.`;
      case "not-running":
        return `Nothing was typed: ${id}'s shell is not running.`;
    }
  };

  /**
   * An agent's input through the terminal manager's guarded write: the checks and the write
   * share the thread's lock. Retried once when idleness could not be told.
   */
  const guardedWrite = (t: TrackedTerminal, data: string, checks: TerminalAgentWriteChecks) => {
    const agentWrite = deps.terminals.agentWrite;
    if (agentWrite === undefined) {
      return write(t, data, checks.idle === true).pipe(
        Effect.as({ inputModeChecked: false }),
        Effect.mapError((error) => new ToolFailure(`Nothing was typed: ${error.message}`)),
      );
    }
    const once = agentWrite({ ref: t.ref, data, checks });
    return once.pipe(
      Effect.catch((refused) =>
        refused.reason === "input-raced" || refused.reason === "unverified"
          ? Effect.sleep(600).pipe(Effect.andThen(once))
          : Effect.fail(refused),
      ),
      Effect.mapError((refused) => new ToolFailure(refusalText(t.ref.terminalId, refused.reason))),
    );
  };

  /** The bytes that run `command` at the prompt as one command line. */
  const commandBytes = (t: TrackedTerminal, command: string) => {
    if (!command.includes("\n")) return `${command}\r`;
    // One paste, run once; a shell without bracketed paste reads a group as one command.
    if (t.mirror.bracketedPaste) return `${encodeTerminalPaste(command, true)}\r`;
    return `{\r${command.replace(/\r?\n/g, "\r")}\r}\r`;
  };

  /**
   * Waits until `execution` ends, or `timeoutMs` passes. With `stopEarlyAfter`, also stops when
   * output printed after that moment leaves the command needing someone (waiting for input, a
   * full-screen program); what was on screen before never counts, so a prompt the agent already
   * reported does not end the next wait at once. Returns the activity it stopped at.
   */
  const awaitExecution = (
    rt: AgentTerminals,
    t: TrackedTerminal,
    execution: Execution,
    timeoutMs: number,
    stopEarlyAfter: number | undefined,
  ) =>
    Effect.gen(function* () {
      let lastActivityAt = 0;
      let stoppedAt: Activity | undefined;
      yield* rt.waitUntil(
        t,
        Effect.gen(function* () {
          if (execution.ended || t.exited) return true;
          if (yield* rt.fallbackEnded(t, execution)) return true;
          if (stopEarlyAfter === undefined || t.mirror.lastWriteAt <= stopEarlyAfter) return false;
          if (rt.quietMs(t) < 300 || now() - lastActivityAt < ACTIVITY_CHECK_MS) return false;
          lastActivityAt = now();
          const activity = yield* rt.activityOf(t);
          if (activity.kind === "waiting-for-input" || activity.kind === "full-screen") {
            stoppedAt = activity;
            return true;
          }
          return false;
        }),
        timeoutMs,
      );
      return stoppedAt;
    });

  // ── actions ────────────────────────────────────────────────────────

  const runAction = (
    rt: AgentTerminals,
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    input: Input,
  ) =>
    Effect.gen(function* () {
      if (input.command === undefined)
        return yield* Effect.fail(new ToolFailure("run needs `command`."));
      const command = input.command;
      const { t, note } = yield* forCommand(rt, session, authority, input.terminal);
      const execution = rt.beginExecution(t, command);
      const data = commandBytes(t, command);
      // A command that just ended: its shell draws the prompt a moment later.
      yield* waitForPrompt(rt, t);
      // Typed only at an idle prompt nobody is typing at, never into hidden input.
      yield* guardedWrite(t, data, { idle: true, prompt: true, visibleInput: true }).pipe(
        Effect.tapError(() => Effect.sync(() => rt.abandonExecution(t, execution))),
      );
      const timeoutMs = waitMs(input.timeout_seconds, DEFAULT_RUN_TIMEOUT_SECONDS);
      const stoppedAt = yield* awaitExecution(rt, t, execution, timeoutMs, execution.startedAt);
      const block = outputBlock(rt, t, execution, input.max_chars);
      rt.markRead(t, session.threadId, execution);
      if (execution.ended) {
        rt.noteReported(t, session.threadId, execution);
        return text(join([note, finishedLine(t, execution), block]));
      }
      const activity = stoppedAt ?? (yield* rt.activityOf(t));
      const id = t.ref.terminalId;
      return text(
        join([
          note,
          `\`${shortCommand(command)}\` is still running in ${id} after ${formatDuration(now() - execution.startedAt)}; it keeps running.`,
          activityLine(t, activity),
          "Output so far:",
          block,
          `Next: ${call({ action: "wait", terminal: id })} (until it ends, or with for_text), read for new output, send to type, interrupt to stop it.`,
        ]),
      );
    });

  const readAction = (
    rt: AgentTerminals,
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    input: Input,
  ) =>
    Effect.gen(function* () {
      const t = yield* existing(rt, session, authority, input.terminal, "read");
      const what = input.what ?? "new";
      const activity = yield* rt.activityOf(t);
      if (what === "screen") {
        const screen = t.mirror.screen();
        const lines = screen.lines.map((line) =>
          line.length > 400 ? `${line.slice(0, 400)}…` : line,
        );
        return text(
          join([
            `Screen of ${t.ref.terminalId} (${screen.cols}x${screen.rows}${screen.alternate ? ", full-screen program" : ""}; cursor at row ${screen.cursor.row + 1}, column ${screen.cursor.col + 1}):`,
            lines.length > 0 ? lines.join("\n") : "(empty)",
            statusOf(rt, t, activity),
          ]),
        );
      }
      if (what === "command") {
        const execution = t.current ?? t.last;
        if (execution === undefined) {
          return text(
            join([
              `No command was seen in ${t.ref.terminalId} since Ryco started following it. Use what "new" or "screen".`,
              statusOf(rt, t, activity),
            ]),
          );
        }
        const block = outputBlock(rt, t, execution, input.max_chars, input.from_line);
        rt.markRead(t, session.threadId, execution);
        rt.noteReported(t, session.threadId, execution);
        return text(
          join([
            `Output of ${execution.commandLine === undefined ? "the last command" : `\`${shortCommand(execution.commandLine)}\``} in ${t.ref.terminalId}:`,
            block,
            statusOf(rt, t, activity),
          ]),
        );
      }
      return text(
        join([
          `New output in ${t.ref.terminalId}:`,
          newOutputBlock(rt, t, session.threadId, input.max_chars),
          statusOf(rt, t, activity),
        ]),
      );
    });

  const waitAction = (
    rt: AgentTerminals,
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    input: Input,
  ) =>
    Effect.gen(function* () {
      const t = yield* existing(rt, session, authority, input.terminal, "read");
      const pattern = input.for_text === undefined ? undefined : toPattern(input.for_text);
      const started = now();
      const timeoutMs = waitMs(input.timeout_seconds, DEFAULT_WAIT_TIMEOUT_SECONDS);
      const execution = t.current;
      if (
        pattern === undefined &&
        (execution === undefined || execution.ended) &&
        !rt.isRunning(t)
      ) {
        const ended = rt.takeUnreportedEnd(t, session.threadId);
        const activity = yield* rt.activityOf(t);
        return text(
          join([
            ended === undefined
              ? `Nothing is running in ${t.ref.terminalId}.`
              : `Nothing is running in ${t.ref.terminalId} any more: ${finishedLine(t, ended)}`,
            "New output:",
            newOutputBlock(rt, t, session.threadId, input.max_chars),
            statusOf(rt, t, activity),
          ]),
        );
      }
      const mark = t.marks.get(session.threadId);
      let found = false;
      let stoppedAt: Activity | undefined;
      if (pattern !== undefined) {
        found = yield* rt.waitUntil(
          t,
          Effect.sync(() => pattern.test(t.mirror.linesSince(mark).lines.join("\n"))),
          timeoutMs,
        );
      } else if (execution !== undefined) {
        stoppedAt = yield* awaitExecution(rt, t, execution, timeoutMs, started);
      } else {
        yield* rt.waitUntil(
          t,
          Effect.sync(() => !rt.isRunning(t)),
          timeoutMs,
        );
      }
      const took = formatDuration(now() - started);
      let headline: string;
      if (found) headline = `"${input.for_text}" appeared in ${t.ref.terminalId} after ${took}.`;
      else if (t.exited) headline = `${t.ref.terminalId} exited while waiting.`;
      else if (pattern === undefined && execution !== undefined && execution.ended) {
        rt.noteReported(t, session.threadId, execution);
        headline = finishedLine(t, execution);
      } else if (pattern !== undefined) {
        headline = `"${input.for_text}" did not appear within ${took}.${rt.isRunning(t) ? "" : " (Nothing is running in the terminal.)"}`;
      } else if (stoppedAt !== undefined)
        headline = `Stopped waiting after ${took}: the command needs attention.`;
      else headline = `Still running after waiting ${took}.`;
      const activity = stoppedAt ?? (yield* rt.activityOf(t));
      return text(
        join([
          headline,
          "New output:",
          newOutputBlock(rt, t, session.threadId, input.max_chars),
          statusOf(rt, t, activity),
        ]),
      );
    });

  const sendAction = (
    rt: AgentTerminals,
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    input: Input,
  ) =>
    Effect.gen(function* () {
      const t = yield* existing(rt, session, authority, input.terminal, "control");
      if (t.exited) return yield* Effect.fail(new ToolFailure(statusOf(rt, t, undefined)));
      const keys = yield* Effect.try({
        try: () =>
          encodeKeys(input.keys ?? [], { applicationCursor: t.mirror.applicationCursorKeys }),
        catch: (error) =>
          new ToolFailure(error instanceof KeyError ? error.message : "Invalid keys."),
      });
      const typed = input.text ?? "";
      const data = typed + keys.map((key) => key.bytes).join("");
      if (data.length === 0) {
        return yield* Effect.fail(new ToolFailure("Nothing to send: pass `text`, `keys` or both."));
      }
      // Never type into a prompt for a secret: only keys that cancel or confirm nothing typed.
      // The tty's flags are read on every send, whatever the screen shows and whether a command
      // seems to run: a prompt that just appeared, or a sudo the user started in a shell without
      // marks, turns echo off before any quiet period or process poll would tell.
      // The tty is read in the guarded write below (inside the terminal's lock); the screen is
      // the only sign where the platform cannot read it.
      const types = typed.length > 0 || keys.some((key) => key.printable);
      const activity = yield* rt.activityOf(t);
      if (activity.secret && types) {
        return yield* Effect.fail(
          new ToolFailure(
            `Nothing was sent: ${t.ref.terminalId} waits for hidden input${activity.prompt === undefined ? "" : ` ("${activity.prompt}")`}. Never type a password, token or code you were not given, and never ask for one in chat. Tell the user in chat that terminal ${t.ref.terminalId} needs them to type it there, then ${call({ action: "wait", terminal: t.ref.terminalId })}. Keys such as Ctrl+C or Escape still go through.`,
          ),
        );
      }
      if (!t.marks.has(session.threadId)) t.marks.set(session.threadId, t.mirror.mark());
      const before = t.mirror.received;
      const sentAt = now();
      const written = yield* guardedWrite(t, data, types ? { visibleInput: true } : {});
      const limitMs = Math.round(
        Math.min(MAX_SEND_WAIT_SECONDS, input.wait_seconds ?? DEFAULT_SEND_WAIT_SECONDS) * 1000,
      );
      // The response: some output, then a short quiet period (or the limit).
      yield* rt.waitUntil(
        t,
        Effect.sync(
          () =>
            t.mirror.received > before && t.mirror.lastWriteAt >= sentAt && rt.quietMs(t) >= 500,
        ),
        limitMs,
      );
      const after = yield* rt.activityOf(t);
      return text(
        join([
          `Sent ${describeInput(input.text, input.keys)} to ${t.ref.terminalId}.${
            types && !written.inputModeChecked
              ? " (This platform cannot tell whether the terminal hides input; only the screen was checked.)"
              : ""
          }`,
          "Output since your last look:",
          newOutputBlock(rt, t, session.threadId, input.max_chars),
          statusOf(rt, t, after),
        ]),
      );
    });

  const interruptAction = (
    rt: AgentTerminals,
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    input: Input,
  ) =>
    Effect.gen(function* () {
      const t = yield* existing(rt, session, authority, input.terminal, "control");
      if (t.exited) return yield* Effect.fail(new ToolFailure(statusOf(rt, t, undefined)));
      const execution = t.current;
      const wasRunning = rt.isRunning(t);
      yield* guardedWrite(t, "\u0003", {});
      const interruptedAt = now();
      if (execution !== undefined) {
        yield* awaitExecution(rt, t, execution, INTERRUPT_WAIT_MS, undefined);
      } else
        yield* rt.waitUntil(
          t,
          Effect.sync(() => !rt.isRunning(t)),
          wasRunning ? INTERRUPT_WAIT_MS : 300,
        );
      let headline: string;
      if (!wasRunning) headline = `Pressed Ctrl+C in ${t.ref.terminalId}; no command was running.`;
      else if (execution?.ended === true) {
        rt.noteReported(t, session.threadId, execution);
        headline = `Interrupted. ${finishedLine(t, execution)}`;
      } else if (!rt.isRunning(t))
        headline = `Interrupted; ${t.ref.terminalId} is back at its prompt.`;
      else
        headline = `Pressed Ctrl+C, but ${t.ref.terminalId} is still running after ${formatDuration(now() - interruptedAt)}. Try again, send keys ["Ctrl+\\\\"], or close the terminal if it is yours.`;
      const activity = yield* rt.activityOf(t);
      return text(
        join([
          headline,
          "Output since your last look:",
          newOutputBlock(rt, t, session.threadId, input.max_chars),
          statusOf(rt, t, activity),
        ]),
      );
    });

  const listAction = (rt: AgentTerminals, session: AgentControlSessionRecord) =>
    Effect.gen(function* () {
      const sessions = yield* threadSessions(session);
      if (sessions.length === 0)
        return text("This thread has no terminals. run opens one for you.");
      const thread = yield* threadShell(session);
      const current = currentByThread.get(session.threadId);
      const rows = sessions.map((entry) => {
        const t = rt.find({ threadId: session.threadId, terminalId: entry.terminalId });
        const running = t !== undefined ? rt.isRunning(t) && !t.exited : false;
        const command =
          t?.current !== undefined && !t.current.ended ? t.current.commandLine : undefined;
        const last = t?.last;
        const mine = isAgentTerminalId(entry.terminalId);
        return {
          id: entry.terminalId,
          owner: owner(entry.terminalId),
          ...(entry.terminalId === current ? { current: true } : {}),
          status:
            entry.status === "running"
              ? running
                ? "running a command"
                : t === undefined
                  ? "running"
                  : "idle"
              : entry.status,
          ...(command === undefined ? {} : { command: shortCommand(command, 200) }),
          ...(last?.exitCode === undefined ? {} : { lastExitCode: last.exitCode }),
          cwd: entry.cwd,
          typing:
            mine || thread.runtimeMode === "full-access" ? "yes" : "asks the user once per task",
          ...(t !== undefined && !t.mirror.shellIntegration
            ? { exitCodes: "not reported by this shell" }
            : {}),
        };
      });
      return text(JSON.stringify(rows, null, 1));
    });

  const closeAction = (
    rt: AgentTerminals,
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    input: Input,
  ) =>
    Effect.gen(function* () {
      const terminalId = input.terminal;
      if (terminalId === undefined) {
        return yield* Effect.fail(new ToolFailure("close needs `terminal` (one you opened)."));
      }
      yield* consentFor(session, authority, terminalId, "close");
      const ref = { threadId: session.threadId, terminalId };
      const known = yield* rt.inspect(ref);
      if (Option.isNone(known)) return yield* unknownTerminal(ref);
      const t = rt.find(ref);
      const running =
        t !== undefined && rt.isRunning(t) && t.current?.commandLine !== undefined
          ? t.current.commandLine
          : undefined;
      yield* deps.terminals
        .close({ threadId: session.threadId, terminalId })
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure(`The terminal could not be closed: ${error.message}`),
          ),
        );
      rt.forget(ref);
      if (currentByThread.get(session.threadId) === terminalId)
        currentByThread.delete(session.threadId);
      return text(
        `Closed ${terminalId}.${running === undefined ? "" : ` It was running \`${shortCommand(running)}\`, which was stopped.`}`,
      );
    });

  const createAction = (rt: AgentTerminals, session: AgentControlSessionRecord) =>
    Effect.gen(function* () {
      const t = yield* createTerminal(rt, session);
      return text(
        `Opened ${t.ref.terminalId}; it is now your current terminal and the user sees it in the terminal panel.${t.mirror.shellIntegration ? " Its shell reports where commands end and their exit codes." : ""}`,
      );
    });

  const handle = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const authority = yield* requireAuthority(session);
      yield* authorize(session, authority);
      if (!visibleTo(session))
        return yield* Effect.fail(new ToolFailure("Terminal tools are unavailable."));
      const input = yield* Schema.decodeUnknownEffect(Input)(args ?? {}).pipe(
        Effect.mapError(() => new ToolFailure("Invalid tool arguments.")),
      );
      const rt = yield* getRuntime;
      const action: Action = input.action;
      switch (action) {
        case "run":
          return yield* runAction(rt, session, authority, input);
        case "read":
          return yield* readAction(rt, session, authority, input);
        case "wait":
          return yield* waitAction(rt, session, authority, input);
        case "send":
          return yield* sendAction(rt, session, authority, input);
        case "interrupt":
          return yield* interruptAction(rt, session, authority, input);
        case "create":
          return yield* createAction(rt, session);
        case "list":
          return yield* listAction(rt, session);
        case "close":
          return yield* closeAction(rt, session, authority, input);
      }
    });

  return {
    ...base,
    descriptors: [...base.descriptors, TERMINAL_TOOL_DESCRIPTOR],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled)) return tools;
        return visibleTo(session) ? [...tools, TERMINAL_TOOL_DESCRIPTOR] : tools;
      }),
    hasTool: (name) => name === TOOL || base.hasTool(name),
    isWriteTool: (name) => name === TOOL || base.isWriteTool(name),
    callTool: (session, name, args) =>
      name === TOOL
        ? handle(session, args).pipe(
            Effect.catch((error) =>
              Effect.succeed(
                errorText(
                  error instanceof ToolFailure
                    ? error.reason
                    : error instanceof MirrorLimitError
                      ? `Ryco follows at most ${MAX_MIRRORS} terminals for agents at once, and every one is held by a wait or a hand-off (${error.held.join(", ")}). Let one finish (or cancel a hand-off), or close a terminal you no longer need, then try again.`
                      : "The terminal action failed.",
                ),
              ),
            ),
          )
        : base.callTool(session, name, args),
  };
}

export { clampMaxChars };
