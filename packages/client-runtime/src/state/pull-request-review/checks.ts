/**
 * Check classification lives in `@ryco/shared/changeRequestChecks` so the
 * server's pull request watch shares it; this module keeps the Checks tab's
 * job links and re-exports the rest for existing import sites.
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
