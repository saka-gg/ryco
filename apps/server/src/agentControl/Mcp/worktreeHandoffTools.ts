/**
 * `ryco_worktree_handoff`, `ryco_worktree_status`: an agent working in the project's shared
 * checkout moves its own chat into a new worktree on a new branch and continues there (T3 Code's
 * `t3_worktree_handoff` and `t3_worktree_status`). Private sessions only: never installed on the
 * external endpoint; loaded on first use (`withLazyAgentControlTools`).
 *
 * Trust boundary:
 * - the target is always the caller's own chat (the tools take no thread id), and only an
 *   unarchived chat without a worktree of its own moves (checked by the tool, the validator and
 *   again by the executor right before the move);
 * - a handoff needs exact active-turn authority and the `workspaces.manage` grant (the status
 *   needs the grant), with Agent Control on;
 * - it is a routine Agent Control request (`worktreeHandoff` plan), executed durably by the
 *   executor like a delegated worktree, so retries, restarts and rollback behave the same. It
 *   grants nothing new: the chat leaves the shared checkout for an isolated one, under the same
 *   runtime mode, and the setup script is the project's own (skipped when the user turned setup
 *   scripts off);
 * - a delegated chat whose result is still awaited cannot move (the validator).
 *
 * @module agentControl/Mcp/worktreeHandoffTools
 */
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_PROMPT_MAX_CHARS,
  AGENT_CONTROL_WORKTREE_MCP_TOOLS as TOOLS,
  AgentControlRequestId,
  AgentControlWorktreeHandoffPlan,
  rejectExcessProperties,
  type AgentControlMcpControlRequestResult,
  type AgentControlMcpMutationResult,
  type AgentControlProposalId,
  type TurnId,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
} from "../Services/AgentControlSessionRegistry.ts";
import {
  worksInOwnCheckout,
  worktreeHandoffBlocker,
  worktreeHandoffBranchProblem,
} from "../worktreeHandoffRuns.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
  submitAgentControlMutation,
} from "./tools.ts";

const handoffDescriptor: AgentControlMcpToolDescriptor = {
  name: TOOLS.handoff,
  description:
    "Move THIS chat out of the project's shared checkout into a new Git worktree on a new branch, made like every Ryco worktree (the project's setup script runs unless runSetupScript is false or the user turned setup scripts off). For a separate agent in a worktree, use ryco_create_threads with envMode worktree instead. Uncommitted changes in the shared checkout stay there: commit what the new branch needs first, or start it from a branch that has it. Call it last in your turn and end the turn right after: the rest of this turn still runs in the shared checkout, and the chat works in the worktree from its next turn. continuationPrompt (your next step, in your own words) is queued as that next turn, with this conversation carried over; without it the chat waits there for the next message. Fails when this chat already has its own worktree, the branch exists, or the project is not a Git repository. The worktree stays when the chat is deleted.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string", maxLength: 128 },
      branch: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description:
          "The new branch, a plain ASCII name such as feature/my-change that no branch, tag or remote branch has yet in any letter case.",
      },
      baseRef: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description: "Branch to start from. Default: the branch the shared checkout is on.",
      },
      startFromOrigin: {
        type: "boolean",
        description: "Fetch the base from origin and start from it. Default false.",
      },
      runSetupScript: { type: "boolean", description: "Default true." },
      continuationPrompt: {
        type: "string",
        minLength: 1,
        maxLength: AGENT_CONTROL_PROMPT_MAX_CHARS,
        description: "The next turn, in the worktree. Omitted: the chat waits there.",
      },
    },
    required: ["requestId", "branch"],
    additionalProperties: false,
  },
};

const statusDescriptor: AgentControlMcpToolDescriptor = {
  name: TOOLS.status,
  description:
    "Whether this chat works in its own worktree (with its path and branch) or in the project's shared checkout, and whether ryco_worktree_handoff can move it. Check before a handoff.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

// Unknown keys are refused, so a `threadId` never silently falls back to the caller's chat.
const HandoffInput = Schema.Struct({
  requestId: AgentControlRequestId,
  branch: AgentControlWorktreeHandoffPlan.fields.branch,
  baseRef: AgentControlWorktreeHandoffPlan.fields.baseRef,
  startFromOrigin: Schema.optional(Schema.Boolean),
  runSetupScript: Schema.optional(Schema.Boolean),
  continuationPrompt: AgentControlWorktreeHandoffPlan.fields.continuationPrompt,
}).pipe(rejectExcessProperties);
const StatusInput = Schema.Struct({}).pipe(rejectExcessProperties);

const NO_AUTHORITY = "Exact active-turn write authority is unavailable.";
/** What the agent reads when the outcome is not in yet: the request goes on without it. */
const TIMED_OUT_NOTE =
  "The handoff is still running. End your turn now: once it completes, this chat continues in the new worktree from its next turn. Its outcome: ryco_wait_for_control_request with this receipt's proposalId.";

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

export interface WorktreeHandoffToolDeps {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getProjectShellById"
  >;
  readonly submitMutation: (
    input: Parameters<typeof submitAgentControlMutation>[1],
  ) => Effect.Effect<typeof AgentControlMcpMutationResult.Encoded, { readonly reason: string }>;
  /** Waits (bounded) until the caller's own request is terminal. */
  readonly waitForTerminal: (
    session: AgentControlSessionRecord,
    proposalId: AgentControlProposalId,
  ) => Effect.Effect<
    typeof AgentControlMcpControlRequestResult.Encoded,
    { readonly reason: string }
  >;
  /**
   * The caller's own earlier request of an id, so a replay answers with its receipt
   * (`replayedAgentControlMutation`; handed in, as this lazily loaded module imports no boot
   * values: a shared one would split into a chunk of its own that boot then loads too).
   */
  readonly replay?: (
    session: AgentControlSessionRecord,
    requestId: AgentControlRequestId,
    plan: AgentControlWorktreeHandoffPlan,
  ) => Effect.Effect<
    Option.Option<typeof AgentControlMcpMutationResult.Encoded>,
    { readonly reason: string }
  >;
  /** The branch the shared checkout is on (null: detached), when Git can be read here. */
  readonly checkoutBranch?: (
    cwd: string,
  ) => Effect.Effect<{ readonly isRepo: boolean; readonly refName: string | null }, Error>;
}

/** Private, provider-session tools only. Same wrapper pattern as the command watch tools. */
export function withWorktreeHandoffTools(
  base: AgentControlMcpTools,
  deps: WorktreeHandoffToolDeps,
): AgentControlMcpTools {
  const owned = [handoffDescriptor, statusDescriptor];
  const owns = (name: string) => owned.some((tool) => tool.name === name);
  const granted = (session: AgentControlSessionRecord) =>
    session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.manageWorkspaces);
  // The chats whose handoff this node is submitting or waiting on right now.
  const inFlight = new Set<string>();

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
        requiredCapability: AGENT_CONTROL_CAPABILITIES.manageWorkspaces,
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
      return authority.value;
    });

  const decode = <S extends Schema.Top>(schema: S, args: unknown) =>
    Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
      Effect.mapError(() => new ToolFailure("Invalid tool arguments.")),
    ) as Effect.Effect<S["Type"], ToolFailure>;

  /** The caller's chat, its project, and why it cannot move now (null: it can). */
  const ownThread = (session: AgentControlSessionRecord) =>
    Effect.gen(function* () {
      const thread = Option.getOrNull(
        yield* deps.projections
          .getThreadShellById(session.threadId)
          .pipe(Effect.mapError(() => new ToolFailure("Could not read this chat. Try again."))),
      );
      if (thread === null) return yield* Effect.fail(new ToolFailure("Thread not found."));
      const project = Option.getOrUndefined(
        yield* deps.projections
          .getProjectShellById(thread.projectId)
          .pipe(Effect.mapError(() => new ToolFailure("Could not read this chat. Try again."))),
      );
      return { thread, project, blocker: worktreeHandoffBlocker(thread, project) };
    });

  const planOf = (session: AgentControlSessionRecord, input: typeof HandoffInput.Type) =>
    ({
      kind: "worktreeHandoff",
      threadId: session.threadId,
      branch: input.branch,
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      startFromOrigin: input.startFromOrigin ?? false,
      runSetupScript: input.runSetupScript ?? true,
      ...(input.continuationPrompt === undefined
        ? {}
        : { continuationPrompt: input.continuationPrompt }),
    }) satisfies AgentControlWorktreeHandoffPlan;

  /** The caller's earlier request of this id, when it is one: its receipt, not a new request. */
  const replayOf = (session: AgentControlSessionRecord, input: typeof HandoffInput.Type) =>
    deps.replay === undefined
      ? Effect.succeed(Option.none<typeof AgentControlMcpMutationResult.Encoded>())
      : deps
          .replay(session, input.requestId, planOf(session, input))
          .pipe(Effect.mapError((error) => new ToolFailure(error.reason)));

  /** Waits (bounded) for the request's outcome and answers with it. */
  const settle = (
    session: AgentControlSessionRecord,
    submitted: typeof AgentControlMcpMutationResult.Encoded,
  ) =>
    Effect.gen(function* () {
      // The request stands either way: an unreadable outcome is followed up like a slow one.
      const settled = yield* deps
        .waitForTerminal(session, submitted.receipt.proposalId as AgentControlProposalId)
        .pipe(Effect.orElseSucceed(() => ({ receipt: submitted.receipt, timedOut: true })));
      const timedOut = settled.timedOut ?? false;
      const completed =
        settled.receipt.result?.outcome === "completed" ? settled.receipt.result : undefined;
      const outcome = completed?.execution?.worktreeHandoff;
      // The chat's own new checkout: its cwd from the next turn on.
      const worktreePath =
        outcome === undefined
          ? null
          : Option.getOrNull(
              yield* deps.projections
                .getThreadShellById(session.threadId)
                .pipe(Effect.orElseSucceed(() => Option.none())),
            )?.worktreePath;
      return {
        receipt: settled.receipt,
        replayed: submitted.replayed,
        timedOut,
        ...(outcome === undefined
          ? timedOut
            ? { note: TIMED_OUT_NOTE }
            : {}
          : {
              worktreePath: worktreePath ?? null,
              ...outcome,
              ...(completed?.detail === undefined ? {} : { note: completed.detail }),
            }),
      };
    });

  const handoff = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const authority = yield* writeAuthority(session, handoffDescriptor.name);
      const input = yield* decode(HandoffInput, args);
      // A replay answers with the request's receipt, even once the chat has moved.
      const replay = yield* replayOf(session, input);
      if (Option.isSome(replay)) return textResult(yield* settle(session, replay.value));
      const branchProblem = worktreeHandoffBranchProblem(input.branch);
      if (branchProblem !== null) return yield* Effect.fail(new ToolFailure(branchProblem));
      const { blocker } = yield* ownThread(session);
      if (blocker !== null) return yield* Effect.fail(new ToolFailure(blocker));
      if (inFlight.has(session.threadId)) {
        return yield* Effect.fail(
          new ToolFailure("A worktree handoff is already in progress for this chat."),
        );
      }
      inFlight.add(session.threadId);
      return textResult(
        yield* deps
          .submitMutation({
            session,
            authority,
            requestId: input.requestId,
            plan: planOf(session, input),
          })
          .pipe(
            Effect.mapError((error) => new ToolFailure(error.reason)),
            Effect.flatMap((submitted) => settle(session, submitted)),
            Effect.ensuring(Effect.sync(() => inFlight.delete(session.threadId))),
          ),
      );
    });

  const status = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* authorize(session, statusDescriptor.name);
      yield* decode(StatusInput, args);
      const own = yield* ownThread(session);
      const { thread, project } = own;
      let blocker = own.blocker;
      let defaultBaseRef: string | null = null;
      if (blocker === null && project !== undefined && deps.checkoutBranch !== undefined) {
        const checkout = yield* deps
          .checkoutBranch(project.workspaceRoot)
          .pipe(Effect.orElseSucceed(() => null));
        if (checkout !== null && !checkout.isRepo) {
          blocker = "This chat's project is not a Git repository, so it has no worktrees.";
        }
        defaultBaseRef = checkout?.refName ?? null;
      }
      return textResult({
        inWorktree: worksInOwnCheckout(thread, project),
        worktreePath: thread.worktreePath,
        branch: thread.branch,
        canHandOff: blocker === null,
        ...(blocker === null ? { defaultBaseRef } : { reason: blocker }),
      });
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
    isWriteTool: (name) => name === handoffDescriptor.name || base.isWriteTool(name),
    callTool: (session, name, args) => {
      if (name === handoffDescriptor.name)
        return run(handoff(session, args), "The handoff failed.");
      if (name === statusDescriptor.name) return run(status(session, args), "Reading failed.");
      return base.callTool(session, name, args);
    },
  };
}
