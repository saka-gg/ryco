/**
 * The composer's Fast mode notice: when the speed Claude Code reports differs from the one the
 * composer requests. Read from the thread's one `fast-mode.state` activity, so web and mobile say
 * the same thing.
 */
import type { OrchestrationThreadActivity } from "@ryco/contracts";
import {
  classifyClaudeFastModeReport,
  FAST_MODE_STATE_ACTIVITY_KIND,
  parseClaudeFastModeReport,
} from "@ryco/shared/claudeFastMode";

export interface FastModeNotice {
  /**
   * `cooldown`: a rate limit paused the requested Fast mode. `blocked`: Claude Code refused it.
   * `external`: Standard was requested, but Claude Code's own settings turned Fast on.
   */
  readonly kind: "cooldown" | "blocked" | "external";
  /** Short value shown where the selection would read "Fast". */
  readonly label: string;
  /** One sentence for tooltips and accessible names. */
  readonly detail: string;
}

const BLOCKED_CAUSE_BY_REASON: ReadonlyMap<string, string> = new Map([
  ["extra_usage_disabled", "Usage credits are off for this Claude account"],
  ["free", "This Claude plan does not include Fast mode"],
  ["not_first_party", "Claude Code only serves Fast mode on a direct Anthropic connection"],
  ["disabled_by_env", "Fast mode is turned off in this environment"],
  ["model_not_allowed", "This model does not support Fast mode"],
  ["network_error", "Claude Code could not check Fast mode availability"],
]);
const UNKNOWN_BLOCKED_CAUSE = "Claude Code reports Fast mode as unavailable";

const COOLDOWN_NOTICE: FastModeNotice = {
  kind: "cooldown",
  label: "Fast paused",
  detail: "A rate limit paused Fast mode for now.",
};

const EXTERNAL_NOTICE: FastModeNotice = {
  kind: "external",
  label: "Fast on",
  detail: "Claude Code's own settings turned Fast mode on.",
};

/**
 * Reads the newest Fast mode report of a thread against the composer's selection. Null when the
 * report agrees with the request, when there is none, or when it came from another instance or
 * model: such a report predates a restart, and the requested option is then the best signal.
 * The same holds for Fast mode serving in a session that Ryco asked for it, while the composer now
 * asks for Standard: only the toggle changed, and the next session has not reported yet.
 */
export function deriveClaudeFastModeNotice(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  /** The composer's selected provider instance. */
  readonly instanceId: string | null | undefined;
  /** The composer's selected model slug. */
  readonly model: string | null | undefined;
  readonly fastRequested: boolean;
}): FastModeNotice | null {
  const payload = input.activities.findLast(
    (activity) => activity.kind === FAST_MODE_STATE_ACTIVITY_KIND,
  )?.payload;
  const report = parseClaudeFastModeReport(payload);
  if (report === undefined) return null;
  const instanceId = (payload as { readonly instanceId?: unknown }).instanceId;
  if (instanceId !== undefined && instanceId !== input.instanceId) return null;
  if (report.model !== undefined && report.model !== input.model) return null;
  const reading = classifyClaudeFastModeReport(report);
  if (!input.fastRequested) {
    return reading === "serving" && report.requested !== true ? EXTERNAL_NOTICE : null;
  }
  if (reading === "cooldown") return COOLDOWN_NOTICE;
  if (reading !== "blocked") return null;
  return {
    kind: "blocked",
    label: "Fast unavailable",
    detail: `${BLOCKED_CAUSE_BY_REASON.get(report.disabledReason ?? "") ?? UNKNOWN_BLOCKED_CAUSE}.`,
  };
}
