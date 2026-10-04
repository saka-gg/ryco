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

/** An idle-time review heuristic, never a prediction of cache expiry or price. */
export function assessClaudeCacheResume(
  thread: OrchestrationThread,
  target: ModelSelection,
  now: number,
): ClaudeCacheReview | undefined {
  if (thread.session?.providerName !== "claudeAgent") return undefined;
  const observation = latestClaudeCacheObservation(thread.activities);
  if (!observation) return undefined;
  const promptTokens =
    observation.directInputTokens +
    observation.cacheReadInputTokens +
    observation.cacheWriteInputTokens;
  if (promptTokens < 32_000) return undefined;
  const age = now - Date.parse(observation.observedAt);
  if (!Number.isFinite(age) || age < 0) return undefined;
  const changed =
    observation.providerInstanceId !== target.instanceId ||
    thread.session.runtimeSessionId !== observation.runtimeSessionId ||
    (observation.modelSelection !== undefined &&
      JSON.stringify(observation.modelSelection) !== JSON.stringify(target)) ||
    target.model !== thread.modelSelection.model ||
    JSON.stringify(target.options ?? {}) !== JSON.stringify(thread.modelSelection.options ?? {});
  const idle = age >= 30 * 60_000;
  const elapsedObservedLifetime =
    observation.observedTtlSeconds !== undefined && age >= observation.observedTtlSeconds * 1000;
  if (!changed && !idle && !elapsedObservedLifetime) return undefined;
  return {
    observation,
    promptTokens,
    reason: changed
      ? "The runtime, model, or context settings have changed since this observation."
      : elapsedObservedLifetime
        ? "The lifetime reported for the observed cache write has elapsed."
        : "This large conversation has been idle for at least 30 minutes. This is a review threshold, not a cache lifetime.",
  };
}
