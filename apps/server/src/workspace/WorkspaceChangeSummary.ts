import { createHash } from "node:crypto";

import { Context, Duration, Effect, Layer, Option } from "effect";
import {
  type WorkspaceChangesSummaryInput,
  type WorkspaceChangesSummaryResult,
  WorkspaceLifecycleError,
} from "@ryco/contracts";

import {
  ProjectionSnapshotQuery,
  readWorkspacePlacement,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import {
  TextGeneration,
  type TextGenerationShape,
  type WorkspaceChangesSummaryGenerationInput,
} from "../textGeneration/TextGeneration.ts";
import { GitVcsDriver, type GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import {
  CheckoutInspectionError,
  inspectCheckout,
  makeCheckoutReadCache,
  samePath,
} from "./checkoutInspection.ts";
import {
  WorkspaceAccessPolicy,
  type WorkspaceAccessPolicyShape,
} from "./Services/WorkspaceAccessPolicy.ts";

const OPERATION = "lifecycle.summarizeChanges";
/** A summary is kept this long for the same worktree and the same change data. */
const SUMMARY_TTL = Duration.minutes(5);
const SUMMARY_CACHE_CAPACITY = 256;
/** Backstop over every provider: no summary is better than a stalled dialog. */
const SUMMARY_TIMEOUT = Duration.seconds(60);
const GIT_TIMEOUT_MS = 10_000;
/** Bound on each Git read; the prompt bounds each section again. */
const GIT_MAX_OUTPUT_BYTES = 256 * 1024;
const PATCH_MAX_CHARS = 40_000;
const UNMERGED_LOG_MAX_COMMITS = 50;

export interface WorkspaceChangeSummaryShape {
  /**
   * A short AI description of the work only this checkout holds (uncommitted and
   * untracked files, unmerged commits). Null when there is nothing to describe,
   * the checkout cannot be read, or no model produced one: model failures never
   * reach the client.
   */
  readonly summarize: (
    input: WorkspaceChangesSummaryInput,
  ) => Effect.Effect<WorkspaceChangesSummaryResult, WorkspaceLifecycleError>;
}

export class WorkspaceChangeSummary extends Context.Service<
  WorkspaceChangeSummary,
  WorkspaceChangeSummaryShape
>()("ryco/workspace/WorkspaceChangeSummary") {}

export interface WorkspaceChangeSummaryDeps {
  readonly snapshots: Pick<
    ProjectionSnapshotQueryShape,
    "getShellSnapshot" | "getWorkspacePlacement"
  >;
  readonly policy: WorkspaceAccessPolicyShape;
  readonly gitDriver: GitVcsDriverShape;
  readonly textGeneration: Pick<TextGenerationShape, "summarizeWorkspaceChanges">;
  readonly settings: Pick<ServerSettingsShape, "getSettings">;
}

type ChangeContext = Omit<WorkspaceChangesSummaryGenerationInput, "modelSelection">;

const NO_SUMMARY: WorkspaceChangesSummaryResult = { summary: null };
const lifecycleError = (detail: string) => new WorkspaceLifecycleError({ detail });

export function makeWorkspaceChangeSummary(
  deps: WorkspaceChangeSummaryDeps,
): WorkspaceChangeSummaryShape {
  // One slot per worktree, versioned by the change data and model: concurrent
  // identical requests join one model call, and failures are never kept.
  const cache = makeCheckoutReadCache({ ttl: SUMMARY_TTL, capacity: SUMMARY_CACHE_CAPACITY });

  /** Read-only, lock-free, bounded Git; output over the bound is cut, not failed. */
  const readGit = (cwd: string, args: ReadonlyArray<string>) =>
    deps.gitDriver
      .execute({
        operation: OPERATION,
        cwd,
        args: ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
        readOnly: true,
      })
      .pipe(
        Effect.map((result) =>
          result.stdoutTruncated ? `${result.stdout}\n[truncated]` : result.stdout.trimEnd(),
        ),
      );

  const gatherChanges = (input: {
    readonly directory: string;
    readonly branch: string | null;
    readonly baseHead: string;
    readonly unmerged: boolean;
  }) =>
    Effect.gen(function* () {
      const { directory } = input;
      const [status, diffStat, diffPatch, untrackedFiles] = yield* Effect.all(
        [
          readGit(directory, ["status", "--porcelain=v1", "-uall"]),
          readGit(directory, ["diff", "HEAD", "--no-ext-diff", "--no-color", "--stat"]),
          readGit(directory, [
            "diff",
            "HEAD",
            "--no-ext-diff",
            "--no-color",
            "--patch",
            "--minimal",
          ]),
          readGit(directory, ["ls-files", "--others", "--exclude-standard"]),
        ],
        { concurrency: "unbounded" },
      );
      const unmergedLog = input.unmerged
        ? (yield* Effect.all(
            [
              readGit(directory, [
                "log",
                "--oneline",
                "--no-decorate",
                "--no-color",
                `--max-count=${UNMERGED_LOG_MAX_COMMITS}`,
                `${input.baseHead}..HEAD`,
              ]),
              readGit(directory, [
                "diff",
                "--no-ext-diff",
                "--no-color",
                "--stat",
                `${input.baseHead}...HEAD`,
              ]),
            ],
            { concurrency: "unbounded" },
          ))
            .filter((section) => section.length > 0)
            .join("\n\n")
        : "";
      return {
        cwd: directory,
        branch: input.branch,
        statusSummary: [status, diffStat].filter((section) => section.length > 0).join("\n\n"),
        diffPatch:
          diffPatch.length > PATCH_MAX_CHARS
            ? `${diffPatch.slice(0, PATCH_MAX_CHARS)}\n[truncated]`
            : diffPatch,
        untrackedFiles,
        unmergedLog,
      } satisfies ChangeContext;
    });

  const generate = (input: WorkspaceChangesSummaryGenerationInput) =>
    deps.textGeneration.summarizeWorkspaceChanges(input).pipe(
      Effect.timeoutOption(SUMMARY_TIMEOUT),
      Effect.mapError((error) => new CheckoutInspectionError({ detail: error.detail })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new CheckoutInspectionError({ detail: "Summary generation timed out." })),
          onSome: (result) => Effect.succeed(result.summary.trim() || null),
        }),
      ),
    );

  const summarize: WorkspaceChangeSummaryShape["summarize"] = ({ worktreeId }) =>
    Effect.gen(function* () {
      const placement = yield* readWorkspacePlacement(deps.snapshots).pipe(
        Effect.mapError(() => lifecycleError("Workspace state is unavailable.")),
      );
      const worktree = placement.worktrees.find((row) => row.worktreeId === worktreeId);
      if (!worktree) return yield* lifecycleError("The workspace no longer exists.");
      const project = placement.projects.find((row) => row.id === worktree.projectId);
      if (!project) return yield* lifecycleError("The workspace's project is unavailable.");
      const directory = worktree.worktreePath;
      // The main checkout is never deleted; a removed checkout holds nothing.
      if (
        worktree.origin === "main" ||
        directory === null ||
        samePath(directory, project.workspaceRoot) ||
        worktree.checkoutRemovedAt != null
      )
        return NO_SUMMARY;

      // The same checks every lifecycle read applies: access policy, exact path,
      // no overlap, registered worktree, branch matching its record.
      const facts = yield* inspectCheckout(
        { policy: deps.policy, git: deps.gitDriver },
        {
          snapshot: placement,
          project,
          directory,
          rowWorktreeId: worktree.worktreeId,
          branch: worktree.branch,
          operation: OPERATION,
        },
      ).pipe(
        Effect.tapError((error) =>
          Effect.logDebug("workspace change summary: checkout not inspectable", {
            worktreeId,
            detail: error.detail,
          }),
        ),
        Effect.option,
      );
      if (Option.isNone(facts)) return NO_SUMMARY;
      const { status, unmerged, baseHead, checkout } = facts.value;
      if (checkout !== "present" || status === null) return NO_SUMMARY;
      const hasLocalChanges = status.truncated || status.modified > 0 || status.untracked > 0;
      if (!hasLocalChanges && unmerged !== true) return NO_SUMMARY;

      const changes = yield* gatherChanges({
        directory,
        branch: worktree.branch,
        baseHead,
        unmerged: unmerged === true,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("workspace change summary: git read failed", {
            worktreeId,
            detail: error.message,
          }),
        ),
        Effect.option,
      );
      if (Option.isNone(changes)) return NO_SUMMARY;
      const { statusSummary, diffPatch, untrackedFiles, unmergedLog } = changes.value;
      if (
        statusSummary.length === 0 &&
        diffPatch.length === 0 &&
        untrackedFiles.length === 0 &&
        unmergedLog.length === 0
      )
        return NO_SUMMARY;

      const modelSelection = yield* deps.settings.getSettings.pipe(
        Effect.map((settings) => Option.fromNullishOr(settings.textGenerationModelSelection)),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(modelSelection)) return NO_SUMMARY;

      const version = createHash("sha256")
        .update(
          JSON.stringify([
            modelSelection.value,
            worktree.branch,
            statusSummary,
            diffPatch,
            untrackedFiles,
            unmergedLog,
          ]),
        )
        .digest("hex");
      const summary = yield* cache
        .through(
          worktreeId,
          version,
          generate({ ...changes.value, modelSelection: modelSelection.value }),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("workspace change summary: generation failed", {
              worktreeId,
              detail: error.detail,
            }).pipe(Effect.as(null)),
          ),
        );
      return { summary } satisfies WorkspaceChangesSummaryResult;
    });

  return { summarize };
}

export const WorkspaceChangeSummaryLive = Layer.effect(
  WorkspaceChangeSummary,
  Effect.gen(function* () {
    return makeWorkspaceChangeSummary({
      snapshots: yield* ProjectionSnapshotQuery,
      policy: yield* WorkspaceAccessPolicy,
      gitDriver: yield* GitVcsDriver,
      textGeneration: yield* TextGeneration,
      settings: yield* ServerSettingsService,
    });
  }),
);
