import type {
  ChangeRequest,
  SourceControlCheckRollupItem,
  SourceControlWorkflowRun,
} from "@ryco/contracts";
import { Option } from "effect";

export type PrCheckStatusKind =
  | "loading"
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "unavailable"
  | "api-error";

export type PrCheckStatusTone =
  | "neutral"
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "cancelled"
  | "error";

export type PrCheckStatusIconKey =
  | "check"
  | "clock"
  | "error"
  | "loader"
  | "pause"
  | "skip"
  | "unavailable"
  | "x";

export interface FailedCheckDetail {
  readonly name: string;
  readonly workflowName?: string | undefined;
  readonly url?: string | undefined;
}

export interface PrCheckStatusView {
  readonly kind: PrCheckStatusKind;
  readonly tone: PrCheckStatusTone;
  readonly icon: PrCheckStatusIconKey;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly ariaLabel: string;
  readonly className: string;
  readonly iconClassName: string;
  readonly dotClassName: string;
  readonly isTerminal: boolean;
  readonly isRefreshable: boolean;
  readonly failedChecks: ReadonlyArray<FailedCheckDetail>;
  readonly headSha?: string | undefined;
}

type CheckLike = {
  readonly name: string;
  readonly workflowName?: string | undefined;
  readonly status?: string | null | undefined;
  readonly conclusion?: string | null | undefined;
  readonly url?: string | null | undefined;
};

const STATUS_STYLES: Record<
  PrCheckStatusTone,
  Pick<PrCheckStatusView, "className" | "dotClassName" | "iconClassName">
> = {
  neutral: {
    className: "border-border bg-muted/30 text-muted-foreground",
    dotClassName: "bg-muted-foreground/55",
    iconClassName: "text-muted-foreground",
  },
  pending: {
    className: "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300",
    dotClassName: "bg-amber-500",
    iconClassName: "text-amber-600 dark:text-amber-300",
  },
  running: {
    className: "border-sky-500/30 bg-sky-500/8 text-sky-700 dark:text-sky-300",
    dotClassName: "bg-sky-500",
    iconClassName: "text-sky-600 dark:text-sky-300",
  },
  success: {
    className: "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
    dotClassName: "bg-emerald-500",
    iconClassName: "text-emerald-600 dark:text-emerald-300",
  },
  failure: {
    className: "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    dotClassName: "bg-rose-500",
    iconClassName: "text-rose-600 dark:text-rose-300",
  },
  cancelled: {
    className: "border-zinc-500/30 bg-zinc-500/8 text-zinc-700 dark:text-zinc-300",
    dotClassName: "bg-zinc-500",
    iconClassName: "text-zinc-600 dark:text-zinc-300",
  },
  error: {
    className: "border-destructive/30 bg-destructive/8 text-destructive",
    dotClassName: "bg-destructive",
    iconClassName: "text-destructive",
  },
};

function optionValue<T>(value: Option.Option<T> | T | null | undefined): T | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value._tag === "Some" || value._tag === "None")
  ) {
    return Option.getOrNull(value as Option.Option<T>);
  }
  return value ?? null;
}

export function sourceControlOptionValue<T>(
  value: Option.Option<T> | T | null | undefined,
): T | null {
  return optionValue(value);
}

export function normalizeCheckToken(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ") ?? "";
}

function isFailureToken(value: string): boolean {
  return [
    "action required",
    "error",
    "failure",
    "failed",
    "startup failure",
    "timed out",
    "timeout",
  ].includes(value);
}

function isCancelledToken(value: string): boolean {
  return ["cancelled", "canceled", "stale"].includes(value);
}

function isPendingToken(value: string): boolean {
  return ["expected", "pending", "queued", "requested", "waiting"].includes(value);
}

function isRunningToken(value: string): boolean {
  return ["in progress", "running"].includes(value);
}

function isPassedToken(value: string): boolean {
  return [
    "completed successfully",
    "neutral",
    "passed",
    "skipped",
    "success",
    "successful",
  ].includes(value);
}

function statusKindForCheck(input: {
  readonly status?: string | null | undefined;
  readonly conclusion?: string | null | undefined;
}): PrCheckStatusKind {
  const conclusion = normalizeCheckToken(input.conclusion);
  const status = normalizeCheckToken(input.status);

  if (isFailureToken(conclusion) || isFailureToken(status)) return "failed";
  if (isCancelledToken(conclusion) || isCancelledToken(status)) return "cancelled";
  if (isRunningToken(status)) return "running";
  if (isPendingToken(status)) return "pending";
  if (isPassedToken(conclusion) || isPassedToken(status)) return "passed";

  return "unavailable";
}

function viewBase(
  kind: PrCheckStatusKind,
): Omit<PrCheckStatusView, "ariaLabel" | "failedChecks" | "headSha"> {
  switch (kind) {
    case "loading":
      return {
        kind,
        tone: "running",
        icon: "loader",
        label: "Loading checks",
        shortLabel: "loading",
        description: "Check status is loading.",
        ...STATUS_STYLES.running,
        isTerminal: false,
        isRefreshable: true,
      };
    case "pending":
      return {
        kind,
        tone: "pending",
        icon: "clock",
        label: "Checks pending",
        shortLabel: "pending",
        description: "Checks are queued or waiting to start.",
        ...STATUS_STYLES.pending,
        isTerminal: false,
        isRefreshable: true,
      };
    case "running":
      return {
        kind,
        tone: "running",
        icon: "loader",
        label: "Checks running",
        shortLabel: "running",
        description: "Checks are currently running.",
        ...STATUS_STYLES.running,
        isTerminal: false,
        isRefreshable: true,
      };
    case "passed":
      return {
        kind,
        tone: "success",
        icon: "check",
        label: "All checks passed",
        shortLabel: "passed",
        description: "Every reported check passed.",
        ...STATUS_STYLES.success,
        isTerminal: true,
        isRefreshable: false,
      };
    case "failed":
      return {
        kind,
        tone: "failure",
        icon: "x",
        label: "Checks failed",
        shortLabel: "failed",
        description: "One or more checks failed.",
        ...STATUS_STYLES.failure,
        isTerminal: true,
        isRefreshable: false,
      };
    case "cancelled":
      return {
        kind,
        tone: "cancelled",
        icon: "skip",
        label: "Checks cancelled/skipped",
        shortLabel: "cancelled",
        description: "Checks completed without all required jobs passing.",
        ...STATUS_STYLES.cancelled,
        isTerminal: true,
        isRefreshable: false,
      };
    case "api-error":
      return {
        kind,
        tone: "error",
        icon: "error",
        label: "Checks unavailable",
        shortLabel: "API error",
        description: "Ryco could not load check status from the provider.",
        ...STATUS_STYLES.error,
        isTerminal: false,
        isRefreshable: true,
      };
    case "unavailable":
      return {
        kind,
        tone: "neutral",
        icon: "unavailable",
        label: "Checks unavailable",
        shortLabel: "unavailable",
        description: "No check status is available for this pull request.",
        ...STATUS_STYLES.neutral,
        isTerminal: false,
        isRefreshable: false,
      };
  }
}

function buildView(input: {
  readonly kind: PrCheckStatusKind;
  readonly failedChecks?: ReadonlyArray<FailedCheckDetail>;
  readonly headSha?: string | null | undefined;
  readonly description?: string | undefined;
}): PrCheckStatusView {
  const failedChecks = input.failedChecks ?? [];
  const base = viewBase(input.kind);
  const failedDetail =
    failedChecks.length > 0
      ? ` Failed: ${failedChecks
          .slice(0, 3)
          .map((check) =>
            check.workflowName ? `${check.workflowName} / ${check.name}` : check.name,
          )
          .join(", ")}${failedChecks.length > 3 ? ", ..." : ""}.`
      : "";
  const description = input.description ?? `${base.description}${failedDetail}`;
  return {
    ...base,
    description,
    ariaLabel: `${base.label}. ${description}`,
    failedChecks,
    ...(input.headSha ? { headSha: input.headSha } : {}),
  };
}

function failedCheckDetails(checks: ReadonlyArray<CheckLike>): ReadonlyArray<FailedCheckDetail> {
  return checks
    .filter(
      (check) =>
        statusKindForCheck({ status: check.status, conclusion: check.conclusion }) === "failed",
    )
    .map((check) => {
      const detail: { name: string; workflowName?: string; url?: string } = { name: check.name };
      if (check.workflowName) {
        detail.workflowName = check.workflowName;
      }
      if (check.url) {
        detail.url = check.url;
      }
      return detail;
    });
}

function aggregateChecks(input: {
  readonly checks: ReadonlyArray<CheckLike> | null | undefined;
  readonly headSha?: string | null | undefined;
  readonly unavailableDescription?: string | undefined;
}): PrCheckStatusView {
  if (!input.checks || input.checks.length === 0) {
    return buildView({
      kind: "unavailable",
      headSha: input.headSha,
      description: input.unavailableDescription,
    });
  }

  const kinds = input.checks.map((check) =>
    statusKindForCheck({ status: check.status, conclusion: check.conclusion }),
  );
  const failedChecks = failedCheckDetails(input.checks);
  if (kinds.includes("failed")) {
    return buildView({ kind: "failed", failedChecks, headSha: input.headSha });
  }
  if (kinds.includes("running")) {
    return buildView({ kind: "running", headSha: input.headSha });
  }
  if (kinds.includes("pending")) {
    return buildView({ kind: "pending", headSha: input.headSha });
  }
  if (kinds.includes("cancelled")) {
    return buildView({ kind: "cancelled", headSha: input.headSha });
  }
  if (kinds.every((kind) => kind === "passed")) {
    return buildView({ kind: "passed", headSha: input.headSha });
  }
  return buildView({ kind: "unavailable", headSha: input.headSha });
}

export function getPrCheckStatusFromRollup(input: {
  readonly rollup: ReadonlyArray<SourceControlCheckRollupItem> | null | undefined;
  readonly headSha?: string | null | undefined;
}): PrCheckStatusView {
  return aggregateChecks({
    headSha: input.headSha,
    checks: input.rollup?.map((item) => ({
      name: item.name,
      workflowName: item.workflowName,
      status: optionValue(item.status),
      conclusion: optionValue(item.conclusion),
      url: optionValue(item.url),
    })),
    unavailableDescription:
      input.rollup && input.rollup.length === 0
        ? "No checks have been reported for this pull request head commit."
        : undefined,
  });
}

export function getPrCheckStatusFromChangeRequest(
  pr: Pick<ChangeRequest, "checkRollup" | "headSha">,
): PrCheckStatusView {
  return getPrCheckStatusFromRollup({
    rollup: pr.checkRollup,
    headSha: pr.headSha,
  });
}

/** Per-check states plus the aggregate verdict, for compact check strips. */
export interface CheckRollupSummary {
  readonly view: PrCheckStatusView;
  /** One entry per reported check, in rollup order; `id` is unique. */
  readonly items: ReadonlyArray<{ readonly id: string; readonly kind: PrCheckStatusKind }>;
  readonly passed: number;
  readonly failed: number;
  readonly active: number;
  readonly total: number;
}

export function summarizeCheckRollup(
  pr: Pick<ChangeRequest, "checkRollup" | "headSha">,
): CheckRollupSummary | null {
  const rollup = pr.checkRollup;
  if (!rollup || rollup.length === 0) return null;
  const seen = new Map<string, number>();
  const items = rollup.map((item) => {
    const name = `${item.workflowName ?? ""}/${item.name}`;
    const occurrence = (seen.get(name) ?? 0) + 1;
    seen.set(name, occurrence);
    return {
      id: `${name}#${occurrence}`,
      kind: statusKindForCheck({
        status: optionValue(item.status),
        conclusion: optionValue(item.conclusion),
      }),
    };
  });
  const kinds = items.map((item) => item.kind);
  const count = (match: (kind: PrCheckStatusKind) => boolean) => kinds.filter(match).length;
  return {
    view: getPrCheckStatusFromChangeRequest(pr),
    items,
    passed: count((kind) => kind === "passed"),
    failed: count((kind) => kind === "failed"),
    active: count((kind) => kind === "running" || kind === "pending"),
    total: kinds.length,
  };
}

export function getCheckStatusFromWorkflowRun(run: SourceControlWorkflowRun): PrCheckStatusView {
  return getCheckStatusFromRaw({
    headSha: run.commit.oid,
    name: run.workflowName,
    workflowName: run.workflowName,
    status: run.status,
    conclusion: optionValue(run.conclusion),
    url: run.url,
  });
}

export function getCheckStatusFromRaw(
  input: CheckLike & {
    readonly headSha?: string | null | undefined;
  },
): PrCheckStatusView {
  return aggregateChecks({
    headSha: input.headSha,
    checks: [
      {
        name: input.name,
        workflowName: input.workflowName,
        status: input.status,
        conclusion: input.conclusion,
        url: input.url,
      },
    ],
  });
}

export function getPrCheckStatusFromWorkflowRuns(input: {
  readonly runs: ReadonlyArray<SourceControlWorkflowRun> | null | undefined;
  readonly headSha?: string | null | undefined;
}): PrCheckStatusView {
  return aggregateChecks({
    headSha: input.headSha,
    checks: input.runs?.map((run) => ({
      name: run.workflowName,
      workflowName: run.workflowName,
      status: run.status,
      conclusion: optionValue(run.conclusion),
      url: run.url,
    })),
    unavailableDescription:
      input.runs && input.runs.length === 0
        ? "No workflow runs were found for this pull request head commit."
        : undefined,
  });
}

export function getPrCheckStatusForQuery(input: {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly status: PrCheckStatusView | null;
}): PrCheckStatusView {
  if (input.error) {
    return buildView({ kind: "api-error" });
  }
  if (input.isLoading && input.status === null) {
    return buildView({ kind: "loading" });
  }
  return input.status ?? buildView({ kind: "unavailable" });
}

export function shouldRefreshPrCheckStatus(view: PrCheckStatusView): boolean {
  return view.isRefreshable && view.kind !== "api-error";
}

export function primaryFailedCheckUrl(view: PrCheckStatusView): string | null {
  return view.failedChecks.find((check) => check.url)?.url ?? null;
}
