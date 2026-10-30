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
