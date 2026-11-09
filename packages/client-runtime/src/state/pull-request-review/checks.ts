import type {
  ChangeRequestCheckState,
  ChangeRequestChecksOverall,
} from "@ryco/shared/changeRequestChecks";

/**
 * Check classification lives in `@ryco/shared/changeRequestChecks` so the
 * server's pull request watch shares it; this module keeps the Checks tab's
 * job links and the checks display vocabulary every client shares, and
 * re-exports the rest for existing import sites.
 */
export {
  checkStateGroup,
  classifyCheckState,
  summarizeChangeRequestChecks,
  type ChangeRequestCheck,
  type ChangeRequestCheckGroup,
  type ChangeRequestCheckState,
  type ChangeRequestChecksOverall,
  type ChangeRequestChecksSegment,
  type ChangeRequestChecksSummary,
} from "@ryco/shared/changeRequestChecks";

const WORKFLOW_JOB_URL_PATTERNS: ReadonlyArray<RegExp> = [
  // GitHub Actions: `…/actions/runs/<run>/job/<id>` (also `/jobs/<id>`).
  /\/actions\/runs\/\d+\/jobs?\/(\d+)/u,
  // GitLab CI: `…/<project>/-/jobs/<id>`.
  /\/-\/jobs\/(\d+)(?:[/?#]|$)/u,
];

/**
 * The host's job id in a check's link, for hosts whose checks are workflow
 * jobs the page lists (GitHub Actions, GitLab CI); null for any other link.
 */
export function workflowJobIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  for (const pattern of WORKFLOW_JOB_URL_PATTERNS) {
    const id = pattern.exec(url)?.[1];
    if (id) return id;
  }
  return null;
}

/**
 * The Checks tab's `job` URL value that opens a rollup check: the host's job
 * id when the check links to one (Actions, GitLab CI), otherwise
 * `workflow/name` (or the bare name without a workflow).
 */
export function pullRequestCheckJobParam(check: {
  readonly name: string;
  readonly workflowName: string | null;
  readonly url: string | null;
}): string {
  const jobId = workflowJobIdFromUrl(check.url);
  if (jobId) return jobId;
  return check.workflowName ? `${check.workflowName}/${check.name}` : check.name;
}

// ── Display vocabulary ───────────────────────────────────────────────

/**
 * One job's or step's state as the page's four-way checks glyph. Only work
 * that is actually running spins; queued and skipped work is a quiet dot.
 */
export function checkStateOverall(state: ChangeRequestCheckState): ChangeRequestChecksOverall {
  switch (state) {
    case "failure":
    case "cancelled":
    case "action-required":
      return "failing";
    case "running":
      return "pending";
    case "success":
    case "neutral":
      return "passing";
    case "pending":
    case "unknown":
    case "skipped":
      return "none";
  }
}

export const CHECK_STATE_LABEL: Record<ChangeRequestCheckState, string> = {
  failure: "Failed",
  cancelled: "Cancelled",
  "action-required": "Awaiting action",
  running: "Running",
  pending: "Queued",
  unknown: "Waiting",
  success: "Passed",
  neutral: "Neutral",
  skipped: "Skipped",
};

// ── Durations ────────────────────────────────────────────────────────

/** "48s", "2m 11s", "1h 4m". */
export function formatWorkflowDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60)
    return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

// ── Workflow errors ──────────────────────────────────────────────────

const PROVIDER_FAILURE_PREFIX = /^Source control provider [^ ]+ failed in [^:]+:\s*(.*)$/u;

/**
 * A source-control read or change's failure as the reader sees it: the host's
 * own words without the server's "Source control provider … failed in …:"
 * prefix, or `fallback` when the failure carries no message.
 */
export function describeSourceControlError(error: unknown, fallback: string): string {
  const raw = error instanceof Error && error.message.trim() ? error.message : fallback;
  return PROVIDER_FAILURE_PREFIX.exec(raw)?.[1] ?? raw;
}

export type WorkflowRerunFeedbackTone =
  | "success"
  | "permission-denied"
  | "not-rerunnable"
  | "error";

export interface WorkflowRerunFeedback {
  readonly tone: WorkflowRerunFeedbackTone;
  readonly message: string;
}

/** Why the host refused a workflow re-run, in the reader's terms. */
export function describeWorkflowRerunError(error: unknown): WorkflowRerunFeedback {
  const message = describeSourceControlError(error, "Failed to request workflow rerun.");
  const lower = message.toLowerCase();

  if (
    lower.includes("not accessible") ||
    lower.includes("permission") ||
    lower.includes("forbidden") ||
    lower.includes("actions write") ||
    lower.includes("token")
  ) {
    return {
      tone: "permission-denied",
      message:
        "GitHub refused the rerun. Check repository permissions and that the token has Actions write access.",
    };
  }

  if (
    lower.includes("cannot rerun") ||
    lower.includes("cannot re-run") ||
    lower.includes("current state") ||
    lower.includes("no failed jobs") ||
    lower.includes("unprocessable") ||
    lower.includes("422")
  ) {
    return {
      tone: "not-rerunnable",
      message: "GitHub says this workflow run or job is not rerunnable in its current state.",
    };
  }

  return { tone: "error", message };
}
