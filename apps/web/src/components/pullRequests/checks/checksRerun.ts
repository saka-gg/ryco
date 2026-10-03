/**
 * Re-run requests in words: what a toast says when GitHub accepts a re-run,
 * and what it says when it refuses (permissions, a run that is still going,
 * or one that cannot be re-run any more). Mirrors the classification the
 * project explorer's workflow list uses, phrased for one quiet toast line.
 */

export type ChecksRerunFailureKind = "permission-denied" | "not-rerunnable" | "error";

export interface ChecksRerunFailure {
  readonly kind: ChecksRerunFailureKind;
  readonly title: string;
  readonly description: string;
}

function rawMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "The re-run request failed.";
  // Provider errors arrive as "Source control provider github failed in rerunWorkflow: …".
  return /^Source control provider [^ ]+ failed in [^:]+:\s*(.*)$/u.exec(raw)?.[1] ?? raw;
}

export function describeChecksRerunFailure(error: unknown): ChecksRerunFailure {
  const description = rawMessage(error);
  const lower = description.toLowerCase();
  if (
    lower.includes("not accessible") ||
    lower.includes("permission") ||
    lower.includes("forbidden") ||
    lower.includes("actions write") ||
    lower.includes("token")
  ) {
    return {
      kind: "permission-denied",
      title: "GitHub refused the re-run",
      description: "The token needs Actions write access to this repository.",
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
      kind: "not-rerunnable",
      title: "Can't re-run yet",
      description: "GitHub re-runs a workflow only after every job in it has finished.",
    };
  }
  return { kind: "error", title: "Re-run failed", description };
}

/** "Re-running Test · web", "Re-running 3 failed jobs". */
export function checksRerunStartedTitle(input: {
  readonly jobName?: string | undefined;
  readonly failedJobs?: number | undefined;
}): string {
  if (input.jobName) return `Re-running ${input.jobName}`;
  const count = input.failedJobs ?? 0;
  return count === 1 ? "Re-running 1 failed job" : `Re-running ${count} failed jobs`;
}
