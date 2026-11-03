/**
 * Claude Code's own report of whether Fast mode serves requests (`fast_mode_state` and
 * `fast_mode_disabled_reason` on its init and result frames), shared by the server's activity
 * projection and every client's composer notice. The requested option alone cannot tell that the
 * account refused Fast, that a rate limit paused it, or that Claude Code's own settings turned it
 * on while Ryco requested Standard.
 *
 * Pure and import-free: runtime ingestion parses the report on the server boot path.
 *
 * @module claudeFastMode
 */

/** The kind of the one latest-state activity per thread carrying the newest report. */
export const FAST_MODE_STATE_ACTIVITY_KIND = "fast-mode.state";

export type ClaudeFastModeState = "on" | "off" | "cooldown";

export interface ClaudeFastModeReport {
  readonly state: ClaudeFastModeState;
  /** Claude Code's snake_case reason; absent when nothing blocks Fast mode. */
  readonly disabledReason?: string;
  /** The Ryco model selection slug of the session that reported it. */
  readonly model?: string;
  /** Ryco asked the reporting session for Fast mode; absent when unknown. */
  readonly requested?: boolean;
}

/** How a report reads for the composer. */
export type ClaudeFastModeClass = "serving" | "standard" | "cooldown" | "blocked";

const DISABLED_REASON_PATTERN = /^[a-z_]{1,48}$/;
const MAX_MODEL_LENGTH = 128;

/**
 * Validates an untrusted `{ state, disabledReason?, model?, requested? }` record (a CLI frame or a
 * persisted activity payload); undefined when the state is not one Claude Code defines. An
 * optional field of the wrong shape (a reason outside `[a-z_]{1,48}`, a model over 128
 * characters, a non-boolean `requested`) is dropped, never echoed.
 */
export function parseClaudeFastModeReport(value: unknown): ClaudeFastModeReport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { state, disabledReason, model, requested } = value as Record<string, unknown>;
  if (state !== "on" && state !== "off" && state !== "cooldown") return undefined;
  return {
    state,
    ...(typeof disabledReason === "string" && DISABLED_REASON_PATTERN.test(disabledReason)
      ? { disabledReason }
      : {}),
    ...(typeof model === "string" && model.length > 0 && model.length <= MAX_MODEL_LENGTH
      ? { model }
      : {}),
    ...(typeof requested === "boolean" ? { requested } : {}),
  };
}

/**
 * `off` is Standard when Fast was not asked for: no reason, or a reason that means "not requested
 * yet" rather than "refused" (`preference`, `sdk_opt_in_required`, `pending`). Every other reason,
 * an unknown one included, means Claude Code refused it.
 */
export function classifyClaudeFastModeReport(report: ClaudeFastModeReport): ClaudeFastModeClass {
  if (report.state === "on") return "serving";
  if (report.state === "cooldown") return "cooldown";
  switch (report.disabledReason) {
    case undefined:
    case "preference":
    case "sdk_opt_in_required":
    case "pending":
      return "standard";
    default:
      return "blocked";
  }
}
