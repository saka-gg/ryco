import type {
  AgentTokenMode,
  ClaudeResumeGuard,
  EnvironmentApi,
  ModelSelection,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
} from "@ryco/contracts";
import { CommandId, MessageId, type ThreadId } from "@ryco/contracts/base-schemas";
import { NATIVE_COMPACTION_COMMAND } from "@ryco/shared/threadActivity";

import type { ThreadSession } from "../threads/types.ts";

/**
 * Why a thread cannot compact on request now. `unsupported`: its session's provider has no
 * compaction it can be asked for. `stopped`: there is no live session, so nothing to compact until
 * a message starts one. `busy`: a turn runs, waits on an approval or answer, or is on its way, or
 * the session is starting. `no-runtime`: the session has not started its runtime yet.
 * `not-ready`: nothing runs, but the session is not ready either (its last turn failed, say), and
 * only a new message makes it ready again.
 */
export type NativeCompactionBlocker =
  | "unsupported"
  | "stopped"
  | "busy"
  | "no-runtime"
  | "not-ready";

/** What compaction reads of a thread: its server session, as a thread window carries it. */
export interface NativeCompactionThread {
  readonly session: {
    readonly providerName: string | null;
    readonly status: OrchestrationSessionStatus;
    readonly runtimeSessionId?: string | undefined;
    readonly activeTurnId: string | null;
  } | null;
}

/**
 * Null when the thread's session can compact now. Compaction is a turn of the live runtime on the
 * thread's own model, so it needs a ready, idle session with a runtime. It is gated on the
 * session's provider, never the composer's selection: after a handoff the two differ. A stopped
 * session keeps its provider, so one that cannot compact stays `unsupported` rather than
 * offering an action that a started session would withdraw.
 */
export function nativeCompactionBlocker(
  thread: NativeCompactionThread,
): NativeCompactionBlocker | null {
  const session = thread.session;
  if (!session) return "stopped";
  if (session.providerName !== "claudeAgent") return "unsupported";
  if (session.status === "stopped") return "stopped";
  // Only these end on their own; any other state waits for the user's next message.
  if (
    session.activeTurnId !== null ||
    session.status === "running" ||
    session.status === "starting"
  ) {
    return "busy";
  }
  if (session.runtimeSessionId === undefined) return "no-runtime";
  if (session.status !== "ready") return "not-ready";
  return null;
}

/**
 * `nativeCompactionBlocker` for a thread as the client store holds it (web and mobile).
 * `turnStartPending`: this client sent the thread a turn its session has not reported yet. The
 * node accepts a second turn start in that gap, so the action stays busy until the session catches
 * up.
 */
export function nativeCompactionBlockerForSession(
  session:
    | Pick<ThreadSession, "provider" | "orchestrationStatus" | "runtimeSessionId" | "activeTurnId">
    | null
    | undefined,
  options?: { readonly turnStartPending?: boolean | undefined },
): NativeCompactionBlocker | null {
  const blocker = nativeCompactionBlocker({
    session: session
      ? {
          providerName: session.provider,
          status: session.orchestrationStatus,
          runtimeSessionId: session.runtimeSessionId,
          activeTurnId: session.activeTurnId ?? null,
        }
      : null,
  });
  return blocker === null && options?.turnStartPending === true ? "busy" : blocker;
}

export function describeNativeCompactionBlocker(blocker: NativeCompactionBlocker): string {
  switch (blocker) {
    case "unsupported":
      return "This provider cannot compact on request.";
    case "stopped":
      return "The session is stopped. Send a message to start it, then compact.";
    case "busy":
      return "Wait until the current turn finishes and the session is ready.";
    case "no-runtime":
      return "No session is running yet. Send a message first, then compact.";
    case "not-ready":
      return "The session is not ready. Send a message to resume it, then compact.";
  }
}

/**
 * Whether the thread's latest context usage says its provider compacts its own context: for
 * Claude, that its CLI lists `/compact`. Web's context meter reads the same flag off the same
 * snapshot (the latest with a valid token count), so both clients offer Compact now alike.
 */
export function nativeCompactionAdvertised(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): boolean {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== "context-window.updated") continue;
    const payload = activity.payload as {
      readonly usedTokens?: unknown;
      readonly compactsAutomatically?: unknown;
    } | null;
    const used = payload?.usedTokens;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) continue;
    return payload?.compactsAutomatically === true;
  }
  return false;
}

/**
 * The provider's own compaction as a turn: an attachment-free native command. It runs on the
 * model and modes it is given, so callers pass the thread's own, and a Claude guard fences it to
 * the runtime and latest turn the caller read.
 */
export async function dispatchNativeCompaction(input: {
  readonly api: EnvironmentApi;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode?: AgentTokenMode | undefined;
  readonly claudeResumeGuard?: ClaudeResumeGuard | undefined;
  readonly createdAt: string;
}): Promise<void> {
  await input.api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    ...(input.claudeResumeGuard ? { claudeResumeGuard: input.claudeResumeGuard } : {}),
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: NATIVE_COMPACTION_COMMAND,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    ...(input.tokenMode !== undefined ? { tokenMode: input.tokenMode } : {}),
    createdAt: input.createdAt,
  });
}

// The decider's refusal of a guard that no longer matches the thread (see `ClaudeResumeGuard`).
const STALE_GUARD_DETAIL = "Claude resume review is stale";

/**
 * Compact now: asks the thread's provider to compact its context, on the thread's own model and
 * modes as the node holds them, so nothing staged in a composer is persisted by it. It returns
 * once the node accepted the turn; the transcript and the context meter show the result.
 */
export async function requestNativeCompaction(input: {
  readonly api: EnvironmentApi;
  readonly threadId: ThreadId;
  readonly assertMutationReady?: (() => void) | undefined;
  readonly newId: () => string;
}): Promise<void> {
  input.assertMutationReady?.();
  const getWindow = input.api.orchestration.getThreadWindow;
  if (!getWindow) throw new Error("Update this node to compact on request.");
  const { thread } = await getWindow({
    threadId: input.threadId,
    limits: { messages: 1, activities: 1, checkpoints: 1, proposedPlans: 1 },
  });
  input.assertMutationReady?.();
  const blocker = nativeCompactionBlocker(thread);
  if (blocker !== null) throw new Error(describeNativeCompactionBlocker(blocker));
  const id = `compact-now:${input.newId()}`;
  try {
    await dispatchNativeCompaction({
      api: input.api,
      threadId: input.threadId,
      messageId: MessageId.make(id),
      commandId: CommandId.make(id),
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      tokenMode: thread.tokenMode,
      ...(thread.session?.providerName === "claudeAgent"
        ? {
            claudeResumeGuard: {
              requireReady: true,
              runtimeSessionId: thread.session.runtimeSessionId ?? null,
              latestTurnId: thread.latestTurn?.turnId ?? null,
              modelSelection: thread.modelSelection,
            },
          }
        : {}),
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    // Relay transports can decode the error without its class: read its message only.
    const message = (error as { readonly message?: unknown } | null)?.message;
    if (typeof message === "string" && message.includes(STALE_GUARD_DETAIL))
      throw new Error("The conversation changed. Try Compact now again.", { cause: error });
    throw error;
  }
}
