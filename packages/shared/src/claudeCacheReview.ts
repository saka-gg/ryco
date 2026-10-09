/**
 * The Claude prompt-cache resume review heuristic, shared by the composer (web and
 * mobile) and the server's restart continuation, so every surface applies the same
 * cost guard before resuming a large Claude conversation.
 *
 * Pure: contracts plus `effect/Schema`.
 *
 * @module claudeCacheReview
 */
import { Schema } from "effect";
import {
  ClaudeCacheObservation,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";

export interface ClaudeCacheReview {
  readonly observation: ClaudeCacheObservation;
  readonly reason: string;
  readonly promptTokens: number;
  /**
   * Null when native `/compact` can run before the send. Otherwise why it cannot: surfaces
   * then offer only continuing with full context.
   */
  readonly compactUnavailableReason: string | null;
}

export interface ClaudeCacheResumeContext {
  /**
   * The directory the next turn runs in (`OrchestrationThreadWindowSnapshot.workspaceCwd`).
   * Unknown leaves the review as if the directory did not move.
   */
  readonly workspaceCwd?: string | undefined;
}

const decodeObservation = Schema.decodeUnknownOption(ClaudeCacheObservation);
export function latestClaudeCacheObservation(
  activities: readonly OrchestrationThreadActivity[],
): ClaudeCacheObservation | undefined {
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i]!;
    if (activity.kind === "context-compaction") return undefined;
    if (activity.kind !== "context-window.updated") continue;
    const payload = activity.payload as Record<string, unknown> | null;
    const decoded = decodeObservation(payload?.claudeCache);
    return decoded._tag === "Some" ? decoded.value : undefined;
  }
  return undefined;
}

const sameSelection = (left: ModelSelection, right: ModelSelection) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Why native `/compact` cannot run before a send to `target`, or null when it can. Compaction
 * is a turn of the live runtime on the thread's current model, so it needs a ready, idle
 * session with a runtime; a stopped session has nothing to compact until a new one starts.
 */
export function claudeCompactUnavailableReason(
  thread: OrchestrationThread,
  target: ModelSelection,
): string | null {
  const session = thread.session;
  if (!session || session.status === "stopped")
    return "Claude's session is stopped, so it cannot compact first.";
  if (session.runtimeSessionId === undefined)
    return "Claude has no running session to compact first.";
  if (session.status !== "ready" || session.activeTurnId !== null)
    return "Claude must be ready before compacting.";
  if (!sameSelection(thread.modelSelection, target))
    return "Apply the model or context change before compacting, or continue with full context.";
  return null;
}

/** An idle-time review heuristic, never a prediction of cache expiry or price. */
export function assessClaudeCacheResume(
  thread: OrchestrationThread,
  target: ModelSelection,
  now: number,
  context: ClaudeCacheResumeContext = {},
): ClaudeCacheReview | undefined {
  if (thread.session?.providerName !== "claudeAgent") return undefined;
  const observation = latestClaudeCacheObservation(thread.activities);
  if (!observation) return undefined;
  // Claude keeps native conversations per directory. Once the thread's directory moved
  // (a chat turned into a project, a new workspace root), the next turn continues in a
  // fresh session there by a context handoff: there is no native resume to review.
  if (
    observation.cwd !== undefined &&
    context.workspaceCwd !== undefined &&
    observation.cwd !== context.workspaceCwd
  )
    return undefined;
  const promptTokens =
    observation.directInputTokens +
    observation.cacheReadInputTokens +
    observation.cacheWriteInputTokens;
  if (promptTokens < 32_000) return undefined;
  const age = now - Date.parse(observation.observedAt);
  if (!Number.isFinite(age) || age < 0) return undefined;
  const settingsChanged =
    observation.providerInstanceId !== target.instanceId ||
    (observation.modelSelection !== undefined &&
      JSON.stringify(observation.modelSelection) !== JSON.stringify(target)) ||
    target.model !== thread.modelSelection.model ||
    JSON.stringify(target.options ?? {}) !== JSON.stringify(thread.modelSelection.options ?? {});
  const runtimeChanged = thread.session.runtimeSessionId !== observation.runtimeSessionId;
  const idle = age >= 30 * 60_000;
  const elapsedObservedLifetime =
    observation.observedTtlSeconds !== undefined && age >= observation.observedTtlSeconds * 1000;
  if (!settingsChanged && !runtimeChanged && !idle && !elapsedObservedLifetime) return undefined;
  return {
    observation,
    promptTokens,
    reason:
      !settingsChanged && runtimeChanged && thread.session.status === "stopped"
        ? "Claude's session stopped since this observation. Continuing starts a new session that resumes the full conversation."
        : settingsChanged || runtimeChanged
          ? "The runtime, model, or context settings have changed since this observation."
          : elapsedObservedLifetime
            ? "The lifetime reported for the observed cache write has elapsed."
            : "This large conversation has been idle for at least 30 minutes. This is a review threshold, not a cache lifetime.",
    compactUnavailableReason: claudeCompactUnavailableReason(thread, target),
  };
}
