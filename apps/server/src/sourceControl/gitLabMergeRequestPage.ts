import { Effect, Exit, Option, Result, Schema, SchemaIssue } from "effect";
import {
  CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES,
  SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES,
  type ChangeRequest,
  type ChangeRequestActivity,
  type ChangeRequestFileContents,
  type ChangeRequestFileContentsInput,
  type ChangeRequestInvolvement,
  type ChangeRequestReviewThread,
  type ChangeRequestSetThreadResolvedResult,
  type ChangeRequestSubmitReviewInput,
  type ChangeRequestSubmitReviewResult,
  type ChangeRequestUpdateAction,
  type ChangeRequestUpdateCommentInput,
  type ChangeRequestUpdateCommentResult,
  type SourceControlAssigneeCandidate,
  type SourceControlChangeRequestCommit,
  type SourceControlChangeRequestDetail,
  type SourceControlCheckRollupItem,
  type SourceControlLabel,
  type SourceControlMergeChangeRequestInput,
  type SourceControlMergeChangeRequestResult,
  type SourceControlWorkflowJobLogResult,
  type SourceControlWorkflowRerunInput,
  type SourceControlWorkflowRerunResult,
  type SourceControlWorkflowRunJobsResult,
  type SourceControlWorkflowRunListResult,
} from "@ryco/contracts";

import {
  CURRENT_GITLAB_PROJECT,
  GITLAB_API_PAGE_SIZE,
  gitLabGet,
  gitLabMergeRequestEndpoint,
  gitLabProjectEndpoint,
  gitLabWrite,
  isGitLabDiscussionId,
  isGitLabNumericId,
  isGitSha,
  isLastGitLabPage,
  parseGitLabMergeRequestReference,
  withGitLabQuery,
  type GitLabApiRequest,
  type GitLabMergeRequestRef,
  type GitLabProjectRef,
} from "./gitLabApi.ts";
import { GitLabCliError, type GitLabApiOutput } from "./GitLabCli.ts";
import {
  GITLAB_ACTIVITY_DISCUSSION_PAGES,
  GITLAB_ACTIVITY_EVENT_PAGES,
  GITLAB_ACTIVITY_NOTE_PAGES,
  GitLabCommitSchema,
  GitLabCurrentUserSchema,
  GitLabDiscussionSchema,
  GitLabDraftNoteSchema,
  GitLabLabelEventSchema,
  GitLabNoteSchema,
  GitLabStateEventSchema,
  GitLabVersionSchema,
  assembleGitLabChangeRequestActivity,
  gitLabReviewThread,
  gitLabViewerCapabilities,
  type GitLabCurrentUser,
  type GitLabDiscussion,
  type GitLabPagedItems,
} from "./gitLabMergeRequestActivity.ts";
import {
  GitLabDiffEntrySchema,
  buildGitLabDraftNoteBody,
  buildGitLabUnifiedDiff,
  type GitLabDiffEntry,
} from "./gitLabMergeRequestDiffs.ts";
import {
  GITLAB_DEVELOPER_ACCESS,
  GitLabApprovalStateSchema,
  GitLabMergeRequestDetailSchema,
  GitLabProjectSchema,
  GitLabReviewerSchema,
  decodeGitLabMergeRequestListJson,
  gitLabAccessLevel,
  gitLabAutoMerge,
  gitLabDraftTitle,
  gitLabMergeCapabilities,
  gitLabMergeRequestFacts,
  gitLabMergeStateStatus,
  gitLabReviewDecision,
  gitLabReviewerStates,
  type GitLabMergeRequestFacts,
  type GitLabProject,
  type NormalizedGitLabMergeRequestRecord,
} from "./gitLabMergeRequests.ts";
import {
  GitLabCommitStatusSchema,
  GitLabJobSchema,
  GitLabPipelineSchema,
  gitLabCheckRollup,
  gitLabJobLogTail,
  gitLabListRowRollup,
  gitLabPipelineRunName,
  gitLabWorkflowJob,
  gitLabWorkflowRun,
  selectGitLabHeadPipelines,
  type GitLabPipeline,
} from "./gitLabPipelines.ts";

/**
 * The pull request page's GitLab operations, composed from REST v4 calls
 * (`GitLabCli.api`). Each function takes the `call` runner so tests can
 * replay official example payloads per endpoint. Reads are bounded (page
 * caps); writes never act on a moved head where GitLab takes a `sha`
 * precondition (approve, merge), and check the head first everywhere else.
 */

export type GitLabCall = (
  operation: string,
  request: GitLabApiRequest,
  options?: {
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly truncateOutputAtMaxBytes?: boolean;
    /** Keep the last `maxOutputBytes` (job logs end where they fail). */
    readonly keepOutputTail?: boolean;
  },
) => Effect.Effect<GitLabApiOutput, GitLabCliError>;

/** List pages can carry long bodies; the process default (1 MB) is too small. */
const LIST_PAGE_MAX_BYTES = 16 * 1024 * 1024;
const DIFF_PAGE_MAX_BYTES = 32 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;
/** Files read for a whole merge request diff (100 per page). */
const DIFF_MAX_PAGES = 30;
/** Files read to anchor review comments / excerpt thread hunks. */
const ACTIVITY_DIFF_MAX_PAGES = 3;
const COMMIT_PAGES = 3;
/**
 * Raw bytes kept from the end of a job log: room for the shown tail
 * (`SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES`) once colours and section markers
 * are stripped. Longer logs stream through and only their end is kept.
 */
const JOB_LOG_TAIL_BYTES = 8 * SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES;
/** First GitLab release whose `bulk_publish` records `reviewer_state` (verify). */
const REQUEST_CHANGES_MIN_VERSION = { major: 19, minor: 2 } as const;

function fail(operation: string, detail: string, status?: number): GitLabCliError {
  return new GitLabCliError({ operation, detail, ...(status !== undefined ? { status } : {}) });
}

export function gitLabStaleHeadError(operation: string): GitLabCliError {
  return fail(
    operation,
    "The merge request's head changed since it was loaded. Refresh and review the new commits, then try again.",
    409,
  );
}

function isStatus(status: number) {
  return (error: GitLabCliError) => error.status === status;
}

export function requireGitLabMergeRequestRef(
  operation: string,
  reference: string,
): Effect.Effect<GitLabMergeRequestRef, GitLabCliError> {
  const ref = parseGitLabMergeRequestReference(reference);
  return ref
    ? Effect.succeed(ref)
    : Effect.fail(
        fail(operation, `"${reference}" is not a merge request number or merge request URL.`),
      );
}

// ── Decoding ──────────────────────────────────────────────────────────

function decodeJson<S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
  raw: string,
): Effect.Effect<S["Type"], GitLabCliError> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw.trim()).pipe(
    Effect.mapError((error) =>
      fail(
        operation,
        `GitLab returned an unexpected response: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
      ),
    ),
  );
}

const decodeUnknownArray = Schema.fromJsonString(Schema.Array(Schema.Unknown));

/** A JSON array, keeping the entries `item` decodes (one odd entry must not hide the rest). */
function decodeList<S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  item: S,
  raw: string,
): Effect.Effect<ReadonlyArray<S["Type"]>, GitLabCliError> {
  const decodeItem = Schema.decodeUnknownExit(item);
  return Schema.decodeEffect(decodeUnknownArray)(raw.trim() || "[]").pipe(
    Effect.mapError((error) =>
      fail(
        operation,
        `GitLab returned an unexpected list: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
      ),
    ),
    Effect.map((entries) =>
      entries.flatMap((entry) => {
        const decoded = decodeItem(entry);
        return Exit.isSuccess(decoded) ? [decoded.value] : [];
      }),
    ),
  );
}

function getJson<S extends Schema.Codec<unknown, unknown, never, never>>(
  call: GitLabCall,
  operation: string,
  request: GitLabApiRequest,
  schema: S,
): Effect.Effect<S["Type"], GitLabCliError> {
  return call(operation, request, { maxOutputBytes: LIST_PAGE_MAX_BYTES }).pipe(
    Effect.flatMap((output) => decodeJson(operation, schema, output.stdout)),
  );
}

/**
 * Read up to `maxPages` pages of a list endpoint. A short page ends the
 * list; a full last page means more exist (`truncated`).
 */
export function getGitLabPages<S extends Schema.Codec<unknown, unknown, never, never>>(
  call: GitLabCall,
  operation: string,
  input: {
    readonly ref: GitLabProjectRef | null;
    readonly endpoint: string;
    readonly item: S;
    readonly maxPages: number;
    readonly perPage?: number;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
  },
): Effect.Effect<GitLabPagedItems<S["Type"]>, GitLabCliError> {
  const perPage = input.perPage ?? GITLAB_API_PAGE_SIZE;
  return Effect.gen(function* () {
    const items: S["Type"][] = [];
    for (let page = 1; page <= input.maxPages; page += 1) {
      const output = yield* call(
        operation,
        gitLabGet(input.ref, withGitLabQuery(input.endpoint, { per_page: perPage, page })),
        {
          maxOutputBytes: input.maxOutputBytes ?? LIST_PAGE_MAX_BYTES,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
      );
      const raw = output.stdout.trim() || "[]";
      const count = yield* Schema.decodeEffect(decodeUnknownArray)(raw).pipe(
        Effect.map((entries) => entries.length),
        Effect.mapError(() => fail(operation, "GitLab returned an unexpected list.")),
      );
      items.push(...(yield* decodeList(operation, input.item, raw)));
      if (isLastGitLabPage(count, perPage)) return { items, truncated: false };
    }
    return { items, truncated: true };
  });
}

// ── Shared reads ──────────────────────────────────────────────────────

export function getGitLabMergeRequestFacts(
  call: GitLabCall,
  operation: string,
  ref: GitLabMergeRequestRef,
): Effect.Effect<GitLabMergeRequestFacts, GitLabCliError> {
  return getJson(
    call,
    operation,
    gitLabGet(ref, gitLabMergeRequestEndpoint(ref)),
    GitLabMergeRequestDetailSchema,
  ).pipe(Effect.map(gitLabMergeRequestFacts));
}

function getCurrentUser(call: GitLabCall, operation: string, ref: GitLabProjectRef | null) {
  return getJson(call, operation, gitLabGet(ref, "user"), GitLabCurrentUserSchema);
}

function getProject(call: GitLabCall, operation: string, ref: GitLabProjectRef) {
  return getJson(call, operation, gitLabGet(ref, gitLabProjectEndpoint(ref)), GitLabProjectSchema);
}

/** A best-effort read: a failure is logged and reads as `fallback`. */
function optional<A>(
  effect: Effect.Effect<A, GitLabCliError>,
  fallback: A,
): Effect.Effect<A, never> {
  return effect.pipe(
    Effect.catch((error) =>
      Effect.logWarning("GitLab read failed; continuing without it.", {
        operation: error.operation,
        detail: error.detail,
      }).pipe(Effect.as(fallback)),
    ),
  );
}

function getDiffEntries(
  call: GitLabCall,
  operation: string,
  ref: GitLabMergeRequestRef,
  maxPages: number,
) {
  return getGitLabPages(call, operation, {
    ref,
    endpoint: gitLabMergeRequestEndpoint(ref, "/diffs"),
    item: GitLabDiffEntrySchema,
    maxPages,
    maxOutputBytes: DIFF_PAGE_MAX_BYTES,
    timeoutMs: DIFF_TIMEOUT_MS,
  });
}

function hasActiveLineThread(discussions: ReadonlyArray<GitLabDiscussion>, headSha: string | null) {
  return discussions.some((discussion) => {
    const position = discussion.notes.find((note) => note.system !== true)?.position;
    return (
      position?.position_type !== "file" &&
      position !== undefined &&
      position !== null &&
      (headSha === null || position.head_sha === headSha)
    );
  });
}

// ── Activity ──────────────────────────────────────────────────────────

export function fetchGitLabChangeRequestActivity(
  call: GitLabCall,
  reference: string,
): Effect.Effect<ChangeRequestActivity, GitLabCliError> {
  const operation = "getChangeRequestActivity";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, reference);
    const pages = <S extends Schema.Codec<unknown, unknown, never, never>>(
      suffix: string,
      item: S,
      maxPages: number,
    ) =>
      getGitLabPages(call, operation, {
        ref,
        endpoint: gitLabMergeRequestEndpoint(ref, suffix),
        item,
        maxPages,
      });
    const read = yield* Effect.all(
      {
        facts: getGitLabMergeRequestFacts(call, operation, ref),
        user: optional(getCurrentUser(call, operation, ref), null),
        project: optional(getProject(call, operation, ref), null),
        // Newest first, so a cut drops the oldest notes.
        notes: pages(
          withGitLabQuery("/notes", { sort: "desc", order_by: "created_at" }),
          GitLabNoteSchema,
          GITLAB_ACTIVITY_NOTE_PAGES,
        ),
        discussions: pages(
          "/discussions",
          GitLabDiscussionSchema,
          GITLAB_ACTIVITY_DISCUSSION_PAGES,
        ),
        stateEvents: optional(
          pages("/resource_state_events", GitLabStateEventSchema, GITLAB_ACTIVITY_EVENT_PAGES),
          { items: [], truncated: false },
        ),
        labelEvents: optional(
          pages("/resource_label_events", GitLabLabelEventSchema, GITLAB_ACTIVITY_EVENT_PAGES),
          { items: [], truncated: false },
        ),
        commits: optional(pages("/commits", GitLabCommitSchema, 1), {
          items: [],
          truncated: false,
        }),
        versions: optional(pages("/versions", GitLabVersionSchema, 1), {
          items: [],
          truncated: false,
        }),
        // The draft notes API (GitLab 15.10+) lists only the viewer's drafts.
        draftNotes: optional(
          pages("/draft_notes", GitLabDraftNoteSchema, 1).pipe(Effect.map((page) => page.items)),
          null,
        ),
      },
      { concurrency: 6 },
    );
    const diffEntries = hasActiveLineThread(read.discussions.items, read.facts.headSha)
      ? yield* optional(
          getDiffEntries(call, operation, ref, ACTIVITY_DIFF_MAX_PAGES).pipe(
            Effect.map((page) => page.items),
          ),
          null,
        )
      : null;
    return assembleGitLabChangeRequestActivity({
      facts: read.facts,
      user: read.user,
      project: read.project,
      notes: read.notes,
      discussions: read.discussions,
      stateEvents: read.stateEvents.items,
      labelEvents: read.labelEvents.items,
      commits: read.commits,
      versions: read.versions.items,
      draftNotes: read.draftNotes,
      diffEntries,
    });
  });
}

/** One discussion re-read as a review thread (after a reply). */
function fetchGitLabReviewThread(
  call: GitLabCall,
  operation: string,
  ref: GitLabMergeRequestRef,
  discussionId: string,
): Effect.Effect<ChangeRequestReviewThread, GitLabCliError> {
  return Effect.gen(function* () {
    const read = yield* Effect.all(
      {
        discussion: getJson(
          call,
          operation,
          gitLabGet(ref, gitLabMergeRequestEndpoint(ref, `/discussions/${discussionId}`)),
          GitLabDiscussionSchema,
        ),
        facts: getGitLabMergeRequestFacts(call, operation, ref),
        user: optional(getCurrentUser(call, operation, ref), null),
        project: optional(getProject(call, operation, ref), null),
      },
      { concurrency: 4 },
    );
    const diffEntries = hasActiveLineThread([read.discussion], read.facts.headSha)
      ? yield* optional(
          getDiffEntries(call, operation, ref, ACTIVITY_DIFF_MAX_PAGES).pipe(
            Effect.map((page) => page.items),
          ),
          null,
        )
      : null;
    const viewer = gitLabViewerCapabilities(read);
    const entry = gitLabReviewThread(read.discussion, {
      mergeRequestUrl: read.facts.webUrl,
      headSha: read.facts.headSha,
      viewerId: read.user?.id ?? null,
      viewerCanReply: viewer !== null && viewer.canReview,
      viewerCanResolve:
        viewer !== null &&
        (viewer.isAuthor || gitLabAccessLevel(read.project) >= GITLAB_DEVELOPER_ACCESS),
      diffEntries,
    });
    if (!entry) {
      return yield* fail(operation, "This discussion is not a review thread on the diff.");
    }
    return entry.thread;
  });
}

// ── Diffs and file contents ───────────────────────────────────────────

/** The merge request's commit SHAs (newest first), bounded. */
function listCommitShas(call: GitLabCall, operation: string, ref: GitLabMergeRequestRef) {
  return getGitLabPages(call, operation, {
    ref,
    endpoint: gitLabMergeRequestEndpoint(ref, "/commits"),
    item: GitLabCommitSchema,
    maxPages: COMMIT_PAGES,
  });
}

/**
 * The whole merge request diff (merge base → head, as GitLab shows it) or
 * one of its commits against its parent, as a unified diff. With
 * `expectedHeadSha`, a head that moves before or during the read fails.
 */
export function fetchGitLabChangeRequestDiff(
  call: GitLabCall,
  input: {
    readonly reference: string;
    readonly expectedHeadSha?: string | undefined;
    readonly commitSha?: string | undefined;
  },
): Effect.Effect<string, GitLabCliError> {
  const operation = "getChangeRequestDiff";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, input.reference);
    const verifyHead = () =>
      getGitLabMergeRequestFacts(call, operation, ref).pipe(
        Effect.flatMap((facts) =>
          facts.headSha === input.expectedHeadSha
            ? Effect.void
            : Effect.fail(gitLabStaleHeadError(operation)),
        ),
      );
    if (input.expectedHeadSha) yield* verifyHead();
    const commitSha = input.commitSha?.trim();
    let entries: GitLabPagedItems<GitLabDiffEntry>;
    if (commitSha) {
      const commits = yield* listCommitShas(call, operation, ref);
      const wanted = commitSha.toLowerCase();
      const matches = commits.items.filter((commit) =>
        wanted.length >= 7
          ? commit.id.toLowerCase().startsWith(wanted)
          : commit.id.toLowerCase() === wanted,
      );
      const commit = matches.length === 1 ? matches[0] : undefined;
      if (!commit || !isGitSha(commit.id)) {
        return yield* fail(
          operation,
          `Commit ${commitSha} is not part of merge request !${ref.iid}.`,
        );
      }
      entries = yield* getGitLabPages(call, operation, {
        ref,
        endpoint: gitLabProjectEndpoint(ref, `/repository/commits/${commit.id}/diff`),
        item: GitLabDiffEntrySchema,
        maxPages: DIFF_MAX_PAGES,
        maxOutputBytes: DIFF_PAGE_MAX_BYTES,
        timeoutMs: DIFF_TIMEOUT_MS,
      });
    } else {
      entries = yield* getDiffEntries(call, operation, ref, DIFF_MAX_PAGES);
    }
    if (entries.truncated) {
      return yield* fail(operation, "This diff has too many files to display.");
    }
    if (input.expectedHeadSha) yield* verifyHead();
    return buildGitLabUnifiedDiff(entries.items);
  });
}

function isRepositoryFilePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function fetchFileAtRevision(
  call: GitLabCall,
  operation: string,
  ref: GitLabProjectRef,
  path: string,
  revision: string,
): Effect.Effect<
  { readonly contents: string | null; readonly truncated: boolean },
  GitLabCliError
> {
  return call(
    operation,
    gitLabGet(
      ref,
      withGitLabQuery(
        gitLabProjectEndpoint(ref, `/repository/files/${encodeURIComponent(path)}/raw`),
        { ref: revision },
      ),
    ),
    { maxOutputBytes: CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES, truncateOutputAtMaxBytes: true },
  ).pipe(
    Effect.map((output) =>
      // Binary files cannot be expanded as text.
      output.stdout.includes("\u0000")
        ? { contents: null, truncated: false }
        : { contents: output.stdout, truncated: output.stdoutTruncated },
    ),
    // Absent on this side: the change added or deleted the file.
    Effect.catchIf(isStatus(404), () => Effect.succeed({ contents: null, truncated: false })),
  );
}

export function fetchGitLabFileContents(
  call: GitLabCall,
  input: ChangeRequestFileContentsInput,
): Effect.Effect<ChangeRequestFileContents, GitLabCliError> {
  const operation = "getChangeRequestFileContents";
  return Effect.gen(function* () {
    for (const path of [input.path, input.previousPath]) {
      if (path !== undefined && !isRepositoryFilePath(path)) {
        return yield* fail(operation, `Invalid repository file path: ${path}`);
      }
    }
    for (const sha of [input.headSha, input.baseSha]) {
      if (sha !== undefined && !isGitSha(sha)) {
        return yield* fail(operation, `Invalid commit SHA: ${sha}`);
      }
    }
    const ref = yield* requireGitLabMergeRequestRef(operation, input.reference);
    let baseSha = input.baseSha;
    if (!baseSha) {
      const facts = yield* getGitLabMergeRequestFacts(call, operation, ref);
      // `diff_refs.base_sha` is the merge base GitLab diffed against; another
      // head needs its own merge base with the target branch.
      baseSha =
        facts.diffRefs && facts.diffRefs.head_sha === input.headSha
          ? facts.diffRefs.base_sha
          : (yield* getJson(
              call,
              operation,
              gitLabGet(
                ref,
                withGitLabQuery(gitLabProjectEndpoint(ref, "/repository/merge_base"), {
                  refs: [facts.targetBranch, input.headSha],
                }),
              ),
              GitLabCommitSchema,
            )).id;
    }
    const [oldSide, newSide] = yield* Effect.all(
      [
        fetchFileAtRevision(call, operation, ref, input.previousPath ?? input.path, baseSha),
        fetchFileAtRevision(call, operation, ref, input.path, input.headSha),
      ],
      { concurrency: 2 },
    );
    return {
      path: input.path,
      oldContents: oldSide.contents,
      newContents: newSide.contents,
      truncated: oldSide.truncated || newSide.truncated,
    };
  });
}

// ── Reviews ───────────────────────────────────────────────────────────

function parseGitLabVersion(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)/u.exec(version.trim());
  return match?.[1] && match[2] ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

export function gitLabSupportsReviewerState(version: string): boolean {
  const parsed = parseGitLabVersion(version);
  if (!parsed) return false;
  return (
    parsed.major > REQUEST_CHANGES_MIN_VERSION.major ||
    (parsed.major === REQUEST_CHANGES_MIN_VERSION.major &&
      parsed.minor >= REQUEST_CHANGES_MIN_VERSION.minor)
  );
}

const GitLabVersionInfoSchema = Schema.Struct({ version: Schema.String });
const GitLabCreatedIdSchema = Schema.Struct({ id: Schema.Number });

/**
 * A review is GitLab's pending-draft flow: each comment (and the summary) is
 * created as a draft note on the reviewed head, then `bulk_publish` publishes
 * them together with any drafts the viewer started on the web. An approval
 * carries `sha`, so GitLab refuses it (409) when the head moved.
 */
export function submitGitLabReview(
  call: GitLabCall,
  input: ChangeRequestSubmitReviewInput,
): Effect.Effect<ChangeRequestSubmitReviewResult, GitLabCliError> {
  const operation = "submitChangeRequestReview";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, input.reference);
    const facts = yield* getGitLabMergeRequestFacts(call, operation, ref);
    if (facts.headSha !== input.expectedHeadSha) {
      return yield* gitLabStaleHeadError(operation);
    }
    if (input.event === "request_changes") {
      const version = yield* getJson(
        call,
        operation,
        gitLabGet(ref, "version"),
        GitLabVersionInfoSchema,
      );
      if (!gitLabSupportsReviewerState(version.version)) {
        return yield* fail(
          operation,
          `This GitLab instance (${version.version}) cannot record "request changes" through its API; it needs GitLab ${REQUEST_CHANGES_MIN_VERSION.major}.${REQUEST_CHANGES_MIN_VERSION.minor} or later.`,
        );
      }
    }

    const bodies: Record<string, unknown>[] = [];
    if (input.comments.length > 0) {
      const diffRefs = facts.diffRefs;
      if (!diffRefs) {
        return yield* fail(operation, "GitLab has not computed this merge request's diff yet.");
      }
      const entries = yield* getDiffEntries(call, operation, ref, DIFF_MAX_PAGES);
      for (const comment of input.comments) {
        const built = buildGitLabDraftNoteBody({ comment, diffRefs, entries: entries.items });
        if (Result.isFailure(built)) return yield* fail(operation, built.failure);
        bodies.push(built.success);
      }
    }
    const summary = input.body?.trim() ?? "";
    if (summary.length > 0) bodies.push({ note: input.body });

    const existing = yield* getGitLabPages(call, operation, {
      ref,
      endpoint: gitLabMergeRequestEndpoint(ref, "/draft_notes"),
      item: GitLabDraftNoteSchema,
      maxPages: 1,
    }).pipe(Effect.map((page) => page.items.length));
    if (input.event === "comment" && bodies.length === 0 && existing === 0) {
      return yield* fail(operation, "Add a comment before submitting a review.");
    }

    const created: number[] = [];
    const discardCreated = Effect.suspend(() =>
      Effect.forEach(
        [...created],
        (id) =>
          call(
            operation,
            gitLabWrite(ref, "DELETE", gitLabMergeRequestEndpoint(ref, `/draft_notes/${id}`)),
          ).pipe(Effect.ignore),
        { discard: true },
      ),
    );
    const createDrafts = Effect.forEach(
      bodies,
      (body) =>
        call(
          operation,
          gitLabWrite(ref, "POST", gitLabMergeRequestEndpoint(ref, "/draft_notes"), body),
        ).pipe(
          Effect.flatMap((output) => decodeJson(operation, GitLabCreatedIdSchema, output.stdout)),
          Effect.tap((draft) => Effect.sync(() => created.push(draft.id))),
        ),
      { discard: true },
    );
    yield* createDrafts.pipe(Effect.tapError(() => discardCreated));

    if (input.event === "approve") {
      yield* call(
        operation,
        gitLabWrite(ref, "POST", gitLabMergeRequestEndpoint(ref, "/approve"), {
          sha: input.expectedHeadSha,
        }),
      ).pipe(
        Effect.mapError((error) =>
          error.status === 409
            ? gitLabStaleHeadError(operation)
            : error.status === 401 || error.status === 403
              ? fail(
                  operation,
                  "GitLab did not accept your approval: you are not an eligible approver for this merge request.",
                  error.status,
                )
              : error,
        ),
        Effect.tapError(() => discardCreated),
      );
    }

    if (created.length + existing > 0 || input.event === "request_changes") {
      yield* call(
        operation,
        gitLabWrite(
          ref,
          "POST",
          gitLabMergeRequestEndpoint(ref, "/draft_notes/bulk_publish"),
          input.event === "request_changes" ? { reviewer_state: "requested_changes" } : undefined,
        ),
      ).pipe(
        Effect.mapError((error) =>
          input.event === "approve"
            ? fail(
                operation,
                `Approved, but publishing the review comments failed; they are kept as pending drafts. ${error.detail}`,
                error.status,
              )
            : error,
        ),
      );
    }

    if (input.event === "request_changes") {
      yield* verifyGitLabChangesRequested(call, operation, ref);
    }

    const lastId = created.at(-1);
    return {
      reviewId:
        lastId !== undefined
          ? `draft-note:${lastId}`
          : input.event === "approve"
            ? `approval:${input.expectedHeadSha}`
            : "draft-notes",
      state:
        input.event === "approve"
          ? "approved"
          : input.event === "request_changes"
            ? "changes_requested"
            : "commented",
      url: facts.webUrl,
    };
  });
}

/**
 * `bulk_publish` answers 204 even when GitLab's `UpdateReviewerStateService`
 * refused the state: the viewer cannot update the merge request (a Reporter,
 * an external contributor), or is not a reviewer and cannot be added (Free
 * allows one reviewer). The reviewers are re-read so a refused change request
 * is reported instead of claimed. When that read fails the outcome is unknown
 * and the submission stands; the next activity read shows what GitLab kept.
 */
function verifyGitLabChangesRequested(
  call: GitLabCall,
  operation: string,
  ref: GitLabMergeRequestRef,
): Effect.Effect<void, GitLabCliError> {
  return Effect.gen(function* () {
    const read = yield* Effect.all(
      {
        viewer: getCurrentUser(call, operation, ref),
        reviewers: getJson(
          call,
          operation,
          gitLabGet(ref, gitLabMergeRequestEndpoint(ref, "/reviewers")),
          Schema.Array(GitLabReviewerSchema),
        ),
      },
      { concurrency: 2 },
    ).pipe(Effect.option);
    if (Option.isNone(read)) return;
    const { viewer, reviewers } = read.value;
    const mine = reviewers.find(
      (reviewer) =>
        reviewer.user.id === viewer.id ||
        reviewer.user.username?.toLowerCase() === viewer.username.toLowerCase(),
    );
    if (mine?.state?.trim().toLowerCase() === "requested_changes") return;
    return yield* fail(
      operation,
      "Your review was published, but GitLab did not record your change request: you need to be a reviewer of this merge request with permission to update it.",
    );
  });
}

export function replyToGitLabThread(
  call: GitLabCall,
  input: { readonly reference: string; readonly threadId: string; readonly body: string },
): Effect.Effect<ChangeRequestReviewThread, GitLabCliError> {
  const operation = "replyToReviewThread";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, input.reference);
    if (!isGitLabDiscussionId(input.threadId)) {
      return yield* fail(operation, `Unknown review thread: ${input.threadId}`);
    }
    yield* call(
      operation,
      gitLabWrite(
        ref,
        "POST",
        gitLabMergeRequestEndpoint(ref, `/discussions/${input.threadId}/notes`),
        { body: input.body },
      ),
    );
    return yield* fetchGitLabReviewThread(call, operation, ref, input.threadId);
  });
}

export function setGitLabThreadResolved(
  call: GitLabCall,
  input: { readonly reference: string; readonly threadId: string; readonly resolved: boolean },
): Effect.Effect<ChangeRequestSetThreadResolvedResult, GitLabCliError> {
  const operation = "setReviewThreadResolved";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, input.reference);
    if (!isGitLabDiscussionId(input.threadId)) {
      return yield* fail(operation, `Unknown review thread: ${input.threadId}`);
    }
    const output = yield* call(
      operation,
      gitLabWrite(
        ref,
        "PUT",
        withGitLabQuery(gitLabMergeRequestEndpoint(ref, `/discussions/${input.threadId}`), {
          resolved: input.resolved,
        }),
      ),
    );
    const discussion = yield* decodeJson(operation, GitLabDiscussionSchema, output.stdout);
    const resolvable = discussion.notes.filter((note) => note.resolvable === true);
    const isResolved =
      resolvable.length > 0
        ? resolvable.every((note) => note.resolved === true)
        : discussion.resolved === true;
    const resolvedBy = isResolved
      ? resolvable.map((note) => note.resolved_by?.username?.trim()).findLast(Boolean)
      : undefined;
    return {
      threadId: discussion.id,
      isResolved,
      ...(resolvedBy ? { resolvedBy } : {}),
    };
  });
}

/** Top-level notes, diff notes, and review summaries are all notes on GitLab. */
export function updateGitLabComment(
  call: GitLabCall,
  input: ChangeRequestUpdateCommentInput,
): Effect.Effect<ChangeRequestUpdateCommentResult, GitLabCliError> {
  const operation = "updateChangeRequestComment";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, input.reference);
    if (!isGitLabNumericId(input.commentId)) {
      return yield* fail(operation, `Unknown comment: ${input.commentId}`);
    }
    const endpoint = gitLabMergeRequestEndpoint(ref, `/notes/${input.commentId}`);
    if (input.action === "delete") {
      yield* call(operation, gitLabWrite(ref, "DELETE", endpoint));
      return { commentId: input.commentId, deleted: true };
    }
    yield* call(operation, gitLabWrite(ref, "PUT", endpoint, { body: input.body }));
    return { commentId: input.commentId, deleted: false };
  });
}

export function addGitLabComment(
  call: GitLabCall,
  input: { readonly reference: string; readonly body: string },
): Effect.Effect<void, GitLabCliError> {
  const operation = "addChangeRequestComment";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, input.reference);
    yield* call(
      operation,
      gitLabWrite(ref, "POST", gitLabMergeRequestEndpoint(ref, "/notes"), { body: input.body }),
    );
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────

const GitLabUserLookupSchema = Schema.Struct({ id: Schema.Number, username: Schema.String });

function resolveUserIds(
  call: GitLabCall,
  operation: string,
  ref: GitLabProjectRef,
  logins: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<number>, GitLabCliError> {
  return Effect.forEach(
    logins,
    (login) =>
      getJson(
        call,
        operation,
        gitLabGet(ref, withGitLabQuery("users", { username: login })),
        Schema.Array(GitLabUserLookupSchema),
      ).pipe(
        Effect.flatMap((users) => {
          const match = users.find(
            (user) => user.username.toLowerCase() === login.trim().toLowerCase(),
          );
          return match
            ? Effect.succeed(match.id)
            : Effect.fail(fail(operation, `No GitLab user named @${login}.`));
        }),
      ),
    { concurrency: 4 },
  );
}

/** The full id list GitLab's update takes: current minus removed plus added. */
export function nextGitLabUserIds(input: {
  readonly current: ReadonlyArray<{
    readonly id?: number | null | undefined;
    readonly username?: string | null | undefined;
  }>;
  readonly removeLogins: ReadonlyArray<string>;
  readonly addIds: ReadonlyArray<number>;
}): ReadonlyArray<number> {
  const removed = new Set(input.removeLogins.map((login) => login.trim().toLowerCase()));
  const ids = input.current.flatMap((user) =>
    typeof user.id === "number" && !removed.has(user.username?.trim().toLowerCase() ?? "")
      ? [user.id]
      : [],
  );
  for (const id of input.addIds) if (!ids.includes(id)) ids.push(id);
  // Docs: "Set the value to 0 … to unset all."
  return ids.length > 0 ? ids : [0];
}

const GitLabCancelAutoMergeSchema = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
});

function deleteSourceBranch(
  call: GitLabCall,
  operation: string,
  ref: GitLabMergeRequestRef,
  facts: GitLabMergeRequestFacts,
): Effect.Effect<void, GitLabCliError> {
  if (facts.isCrossRepository) {
    return Effect.fail(
      fail(operation, "The source branch lives in a fork, which Ryco does not delete."),
    );
  }
  return call(
    operation,
    gitLabWrite(
      ref,
      "DELETE",
      gitLabProjectEndpoint(ref, `/repository/branches/${encodeURIComponent(facts.sourceBranch)}`),
    ),
  ).pipe(Effect.asVoid);
}

/** Apply one lifecycle action; the provider re-reads the detail afterwards. */
export function updateGitLabMergeRequest(
  call: GitLabCall,
  input: { readonly reference: string; readonly action: ChangeRequestUpdateAction },
): Effect.Effect<void, GitLabCliError> {
  const operation = "updateChangeRequest";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, input.reference);
    const endpoint = gitLabMergeRequestEndpoint(ref);
    const update = (body: Readonly<Record<string, unknown>>) =>
      call(operation, gitLabWrite(ref, "PUT", endpoint, body)).pipe(Effect.asVoid);
    const action = input.action;
    switch (action.kind) {
      case "edit": {
        const body = {
          ...(action.title !== undefined ? { title: action.title } : {}),
          ...(action.body !== undefined ? { description: action.body } : {}),
          ...(action.baseRefName !== undefined ? { target_branch: action.baseRefName } : {}),
        };
        if (Object.keys(body).length === 0) return yield* fail(operation, "Nothing to update.");
        return yield* update(body);
      }
      case "set-draft": {
        const facts = yield* getGitLabMergeRequestFacts(call, operation, ref);
        if (facts.isDraft === action.draft) return;
        return yield* update({ title: gitLabDraftTitle(facts.title, action.draft) });
      }
      case "close": {
        yield* update({ state_event: "close" });
        if (action.deleteBranch === true) {
          const facts = yield* getGitLabMergeRequestFacts(call, operation, ref);
          yield* deleteSourceBranch(call, operation, ref, facts);
        }
        return;
      }
      case "reopen":
        return yield* update({ state_event: "reopen" });
      case "labels": {
        const body = {
          ...(action.add.length > 0 ? { add_labels: action.add.join(",") } : {}),
          ...(action.remove.length > 0 ? { remove_labels: action.remove.join(",") } : {}),
        };
        if (Object.keys(body).length === 0) return;
        return yield* update(body);
      }
      case "reviewers":
      case "assignees": {
        if (action.add.length === 0 && action.remove.length === 0) return;
        const facts = yield* getGitLabMergeRequestFacts(call, operation, ref);
        const addIds = yield* resolveUserIds(call, operation, ref, action.add);
        const ids = nextGitLabUserIds({
          current: action.kind === "reviewers" ? facts.reviewers : facts.assignees,
          removeLogins: action.remove,
          addIds,
        });
        return yield* update(
          action.kind === "reviewers" ? { reviewer_ids: ids } : { assignee_ids: ids },
        );
      }
      case "update-branch": {
        if (action.method !== "rebase") {
          return yield* fail(
            operation,
            "GitLab updates a merge request's branch by rebasing it; merging the target branch in is not available.",
          );
        }
        const facts = yield* getGitLabMergeRequestFacts(call, operation, ref);
        if (facts.headSha !== action.expectedHeadSha) return yield* gitLabStaleHeadError(operation);
        yield* call(operation, gitLabWrite(ref, "PUT", gitLabMergeRequestEndpoint(ref, "/rebase")));
        return;
      }
      case "auto-merge": {
        if (!action.enabled) {
          const output = yield* call(
            operation,
            gitLabWrite(
              ref,
              "POST",
              gitLabMergeRequestEndpoint(ref, "/cancel_merge_when_pipeline_succeeds"),
            ),
          );
          const result = yield* decodeJson(operation, GitLabCancelAutoMergeSchema, output.stdout);
          // 201 with `status: "error"` when auto-merge was not set.
          if (result.status?.trim().toLowerCase() === "error") {
            return yield* fail(
              operation,
              result.message?.trim() || "GitLab could not cancel the automatic merge.",
            );
          }
          return;
        }
        const [facts, project] = yield* Effect.all(
          [getGitLabMergeRequestFacts(call, operation, ref), getProject(call, operation, ref)],
          { concurrency: 2 },
        );
        if (action.expectedHeadSha && facts.headSha !== action.expectedHeadSha) {
          return yield* gitLabStaleHeadError(operation);
        }
        if (action.mergeMethod && !gitLabMergeCapabilities(project)[action.mergeMethod]) {
          return yield* fail(
            operation,
            `The ${action.mergeMethod} merge method is not available for this project.`,
          );
        }
        const sha = action.expectedHeadSha ?? facts.headSha;
        yield* call(
          operation,
          gitLabWrite(ref, "PUT", gitLabMergeRequestEndpoint(ref, "/merge"), {
            // `auto_merge` (17.11+) and its deprecated predecessor; older
            // releases ignore the parameter they do not know.
            auto_merge: true,
            merge_when_pipeline_succeeds: true,
            ...(sha ? { sha } : {}),
            ...(action.mergeMethod ? { squash: action.mergeMethod === "squash" } : {}),
          }),
        ).pipe(Effect.mapError((error) => mergeError(operation, error)));
        return;
      }
      case "delete-branch": {
        const facts = yield* getGitLabMergeRequestFacts(call, operation, ref);
        return yield* deleteSourceBranch(call, operation, ref, facts);
      }
    }
  });
}

function mergeError(operation: string, error: GitLabCliError): GitLabCliError {
  switch (error.status) {
    case 409:
      return gitLabStaleHeadError(operation);
    case 401:
      return fail(operation, "You do not have permission to merge this merge request.", 401);
    case 405:
      return fail(
        operation,
        "GitLab cannot merge this merge request right now (HTTP 405). Check its pipeline, approvals, open threads, conflicts and draft status.",
        405,
      );
    case 422:
      return fail(operation, `GitLab could not merge the branch (HTTP 422). ${error.detail}`, 422);
    default:
      return error;
  }
}

const GitLabMergeResultSchema = Schema.Struct({
  state: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * `PUT .../merge` with `sha` (GitLab refuses a moved head with 409). The
 * merge method is the project's (merge commit or fast-forward), so only it
 * and squash are accepted. A merge request GitLab queues (merge train,
 * pending pipeline) reports `enqueued`.
 */
export function mergeGitLabMergeRequest(
  call: GitLabCall,
  input: SourceControlMergeChangeRequestInput,
): Effect.Effect<SourceControlMergeChangeRequestResult, GitLabCliError> {
  const operation = "mergeChangeRequest";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, input.reference);
    const [facts, project] = yield* Effect.all(
      [getGitLabMergeRequestFacts(call, operation, ref), getProject(call, operation, ref)],
      { concurrency: 2 },
    );
    if (input.expectedHeadSha && facts.headSha !== input.expectedHeadSha) {
      return yield* gitLabStaleHeadError(operation);
    }
    if (!gitLabMergeCapabilities(project)[input.mergeMethod]) {
      return yield* fail(
        operation,
        `The ${input.mergeMethod} merge method is not available for this project.`,
      );
    }
    const output = yield* call(
      operation,
      gitLabWrite(ref, "PUT", gitLabMergeRequestEndpoint(ref, "/merge"), {
        squash: input.mergeMethod === "squash",
        ...(input.expectedHeadSha ? { sha: input.expectedHeadSha } : {}),
        ...(input.deleteBranch !== undefined
          ? { should_remove_source_branch: input.deleteBranch }
          : {}),
      }),
    ).pipe(Effect.mapError((error) => mergeError(operation, error)));
    const merged = yield* decodeJson(operation, GitLabMergeResultSchema, output.stdout);
    return { outcome: merged.state?.trim().toLowerCase() === "merged" ? "merged" : "enqueued" };
  });
}

// ── Detail readiness ──────────────────────────────────────────────────

export type GitLabDetailReadiness = Pick<
  SourceControlChangeRequestDetail,
  | "reviewerStates"
  | "reviewDecision"
  | "mergeStateStatus"
  | "mergeCapabilities"
  | "autoMerge"
  | "deleteBranchOnMerge"
  | "checkRollup"
  | "commits"
  | "reviewers"
  | "closedAt"
  | "mergedAt"
  | "mergedBy"
  | "changedFiles"
  | "headSha"
>;

function toDetailCommit(
  commit: typeof GitLabCommitSchema.Type,
): SourceControlChangeRequestCommit | null {
  const oid = commit.id.trim();
  if (!oid) return null;
  const author = commit.author_name?.trim();
  const committedDate = commit.committed_date?.trim();
  return {
    oid,
    shortOid: commit.short_id?.trim() || oid.slice(0, 8),
    messageHeadline: commit.title?.trim() ?? (commit.message ?? "").split("\n")[0]?.trim() ?? "",
    ...(committedDate ? { committedDate } : {}),
    ...(author ? { author } : {}),
  };
}

// https://docs.gitlab.com/api/commits/#get-a-single-commit
const GitLabCommitParentsSchema = Schema.Struct({
  id: Schema.String,
  parent_ids: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

/** The merge request's head pipeline, once it is known to verify the current head. */
export interface GitLabHeadPipeline {
  readonly id: number;
  /** The commit it ran on: the head, or a merged-results / merge-train merge of it. */
  readonly sha: string;
  /** Its name on the page (`gitLabPipelineRunName`). */
  readonly runName: string;
}

/**
 * `head_pipeline` when it verifies the current head: on the head commit, or
 * on a merged-results or merge-train commit that has the head as a parent.
 * Any other SHA is an earlier head's pipeline (GitLab keeps it after a push
 * that started none), which would show stale checks, so it is dropped; so is
 * one whose merge commit cannot be read.
 */
export function resolveGitLabHeadPipeline(
  call: GitLabCall,
  operation: string,
  ref: GitLabProjectRef,
  facts: Pick<GitLabMergeRequestFacts, "headPipeline" | "headSha">,
): Effect.Effect<GitLabHeadPipeline | null> {
  const pipeline = facts.headPipeline;
  const head = facts.headSha?.toLowerCase() ?? null;
  const sha = pipeline?.sha?.toLowerCase() ?? null;
  if (!pipeline || !sha || !head || !isGitSha(sha)) return Effect.succeed(null);
  const resolved: GitLabHeadPipeline = {
    id: pipeline.id,
    sha,
    runName: gitLabPipelineRunName(pipeline),
  };
  if (sha === head) return Effect.succeed(resolved);
  return optional(
    getJson(
      call,
      operation,
      gitLabGet(ref, gitLabProjectEndpoint(ref, `/repository/commits/${sha}`)),
      GitLabCommitParentsSchema,
    ),
    null,
  ).pipe(
    Effect.map((commit) =>
      commit?.parent_ids?.some((parent) => parent.toLowerCase() === head) === true
        ? resolved
        : null,
    ),
  );
}

/**
 * Readiness facts for the detail: reviewers' states and approvals, the merge
 * state, the project's merge methods, head pipeline statuses and commits.
 * Each read is optional; a failed one leaves its facts out (never guessed).
 */
export function fetchGitLabDetailReadiness(
  call: GitLabCall,
  facts: GitLabMergeRequestFacts,
  reference: string,
): Effect.Effect<GitLabDetailReadiness, GitLabCliError> {
  const operation = "getChangeRequestDetail";
  return Effect.gen(function* () {
    const ref = yield* requireGitLabMergeRequestRef(operation, reference);
    const headPipeline = yield* resolveGitLabHeadPipeline(call, operation, ref, facts);
    // Merged-results and merge-train pipelines report on their merge commit.
    const statusSha = headPipeline?.sha ?? facts.headSha;
    const read = yield* Effect.all(
      {
        reviewers: optional(
          getJson(
            call,
            operation,
            gitLabGet(ref, gitLabMergeRequestEndpoint(ref, "/reviewers")),
            Schema.Array(GitLabReviewerSchema),
          ),
          null,
        ),
        approvals: optional(
          getJson(
            call,
            operation,
            gitLabGet(ref, gitLabMergeRequestEndpoint(ref, "/approvals")),
            GitLabApprovalStateSchema,
          ),
          null,
        ),
        project: optional(getProject(call, operation, ref), null),
        statuses:
          statusSha && isGitSha(statusSha)
            ? optional(
                getGitLabPages(call, operation, {
                  ref,
                  endpoint: gitLabProjectEndpoint(ref, `/repository/commits/${statusSha}/statuses`),
                  item: GitLabCommitStatusSchema,
                  maxPages: 1,
                }).pipe(Effect.map((page) => page.items)),
                null,
              )
            : Effect.succeed(null),
        // Every CI job is also a commit status; the jobs say which statuses are jobs.
        headJobs: headPipeline
          ? optional(
              getGitLabPages(call, operation, {
                ref,
                endpoint: gitLabProjectEndpoint(ref, `/pipelines/${headPipeline.id}/jobs`),
                item: GitLabJobSchema,
                maxPages: 1,
              }).pipe(Effect.map((page) => page.items)),
              null,
            )
          : Effect.succeed(null),
        commits: optional(
          getGitLabPages(call, operation, {
            ref,
            endpoint: gitLabMergeRequestEndpoint(ref, "/commits"),
            item: GitLabCommitSchema,
            maxPages: 1,
          }).pipe(Effect.map((page) => page.items)),
          null,
        ),
      },
      { concurrency: 6 },
    );
    const reviewerStates =
      read.reviewers !== null
        ? gitLabReviewerStates({ reviewers: read.reviewers, approvals: read.approvals })
        : null;
    const reviewDecision =
      reviewerStates !== null && read.approvals !== null
        ? gitLabReviewDecision({ reviewerStates, approvals: read.approvals })
        : undefined;
    const mergeStateStatus = facts.isDraft
      ? "draft"
      : gitLabMergeStateStatus(facts.detailedMergeStatus);
    const reviewers = facts.reviewers.flatMap((user) =>
      user.username?.trim() ? [user.username.trim()] : [],
    );
    const commits = read.commits
      ?.flatMap((commit) => {
        const mapped = toDetailCommit(commit);
        return mapped ? [mapped] : [];
      })
      .toReversed();
    const checkRollup: SourceControlCheckRollupItem[] | null =
      read.statuses !== null
        ? gitLabCheckRollup(
            read.statuses,
            headPipeline && read.headJobs
              ? { runName: headPipeline.runName, jobs: read.headJobs }
              : null,
          )
        : null;
    return {
      ...(facts.headSha ? { headSha: facts.headSha } : {}),
      ...(reviewerStates !== null ? { reviewerStates } : {}),
      ...(reviewDecision !== undefined ? { reviewDecision } : {}),
      ...(mergeStateStatus ? { mergeStateStatus } : {}),
      ...(read.project !== null
        ? { mergeCapabilities: gitLabMergeCapabilities(read.project) }
        : {}),
      ...(facts.state === "open" && read.project !== null
        ? { autoMerge: gitLabAutoMerge({ facts, project: read.project }) }
        : {}),
      ...(facts.forceRemoveSourceBranch !== null
        ? { deleteBranchOnMerge: facts.forceRemoveSourceBranch }
        : {}),
      ...(checkRollup !== null ? { checkRollup } : {}),
      ...(commits && commits.length > 0 ? { commits } : {}),
      ...(reviewers.length > 0 ? { reviewers } : {}),
      ...(facts.closedAt && facts.state === "closed" ? { closedAt: facts.closedAt } : {}),
      ...(facts.mergedAt ? { mergedAt: facts.mergedAt } : {}),
      ...(facts.mergedBy && facts.state === "merged" ? { mergedBy: facts.mergedBy } : {}),
      ...(facts.changesCount !== null ? { changedFiles: facts.changesCount } : {}),
    };
  });
}

// ── Lists ─────────────────────────────────────────────────────────────

const STATE_QUERY = { open: "opened", closed: "closed", merged: "merged", all: "all" } as const;

/**
 * A server-side filtered list: involvement relative to the authenticated
 * user (`author_username`, `reviewer_username`, `assignee_id`), free-text
 * `search`, state, and source branch. GitLab has no "mentioned" or
 * "involved" filter, so those fail instead of returning everything.
 */
export function listGitLabMergeRequestsFiltered(
  call: GitLabCall,
  input: {
    readonly state: "open" | "closed" | "merged" | "all";
    readonly involvement?: ChangeRequestInvolvement | undefined;
    readonly query?: string | undefined;
    readonly sourceBranch?: string | undefined;
    readonly limit?: number | undefined;
  },
): Effect.Effect<ReadonlyArray<NormalizedGitLabMergeRequestRecord>, GitLabCliError> {
  const operation = "listChangeRequests";
  return Effect.gen(function* () {
    let involvementQuery: Record<string, string | number> = {};
    if (input.involvement !== undefined) {
      if (input.involvement === "mentioned" || input.involvement === "involved") {
        return yield* fail(
          operation,
          `GitLab cannot filter merge requests by "${input.involvement}"; use authored, review requested, or assigned.`,
        );
      }
      const user: GitLabCurrentUser = yield* getCurrentUser(call, operation, null);
      involvementQuery =
        input.involvement === "authored"
          ? { author_username: user.username }
          : input.involvement === "review-requested"
            ? { reviewer_username: user.username }
            : { assignee_id: user.id };
    }
    const query = input.query?.trim();
    const output = yield* call(
      operation,
      gitLabGet(
        null,
        withGitLabQuery(gitLabProjectEndpoint(CURRENT_GITLAB_PROJECT, "/merge_requests"), {
          state: STATE_QUERY[input.state],
          ...involvementQuery,
          ...(query ? { search: query } : {}),
          ...(input.sourceBranch ? { source_branch: input.sourceBranch } : {}),
          order_by: "updated_at",
          sort: "desc",
          per_page: Math.min(Math.max(input.limit ?? 20, 1), GITLAB_API_PAGE_SIZE),
        }),
      ),
      { maxOutputBytes: LIST_PAGE_MAX_BYTES },
    );
    const decoded = decodeGitLabMergeRequestListJson(output.stdout.trim() || "[]");
    return Result.isSuccess(decoded)
      ? decoded.success
      : yield* fail(operation, "GitLab returned an unexpected merge request list.");
  });
}

/** One rollup per list row from the project's recent pipelines (one request for the page). */
export function enrichGitLabListRowsWithPipelines(
  call: GitLabCall,
  rows: ReadonlyArray<ChangeRequest>,
): Effect.Effect<ReadonlyArray<ChangeRequest>, never> {
  if (!rows.some((row) => row.state === "open")) return Effect.succeed(rows);
  return optional(
    getGitLabPages(call, "listChangeRequests", {
      ref: null,
      endpoint: gitLabProjectEndpoint(CURRENT_GITLAB_PROJECT, "/pipelines"),
      item: GitLabPipelineSchema,
      maxPages: 1,
    }).pipe(Effect.map((page): ReadonlyArray<GitLabPipeline> => page.items)),
    [],
  ).pipe(
    Effect.map((pipelines) =>
      rows.map((row) => {
        if (row.state !== "open" || row.checkRollup) return row;
        const checkRollup = gitLabListRowRollup(pipelines, {
          iid: row.number,
          sourceBranch: row.headRefName,
          headSha: row.headSha ?? null,
        });
        return checkRollup ? { ...row, checkRollup } : row;
      }),
    ),
  );
}

// ── Pickers ───────────────────────────────────────────────────────────

const GitLabLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitLabMemberSchema = Schema.Struct({
  username: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});

export function listGitLabLabels(
  call: GitLabCall,
): Effect.Effect<ReadonlyArray<SourceControlLabel>, GitLabCliError> {
  return getGitLabPages(call, "listLabels", {
    ref: null,
    endpoint: gitLabProjectEndpoint(CURRENT_GITLAB_PROJECT, "/labels"),
    item: GitLabLabelSchema,
    maxPages: 3,
  }).pipe(
    Effect.map((page) =>
      page.items.flatMap((label) => {
        const name = label.name.trim();
        if (!name) return [];
        const color = label.color?.trim().replace(/^#/u, "").toLowerCase();
        const description = label.description?.trim();
        return [
          {
            name,
            ...(color && /^[0-9a-f]{3,8}$/u.test(color) ? { color } : {}),
            ...(description ? { description } : {}),
          },
        ];
      }),
    ),
  );
}

/** Active members, inherited ones included (reviewer and assignee candidates). */
export function listGitLabAssignees(
  call: GitLabCall,
): Effect.Effect<ReadonlyArray<SourceControlAssigneeCandidate>, GitLabCliError> {
  return getGitLabPages(call, "listAssignees", {
    ref: null,
    endpoint: gitLabProjectEndpoint(CURRENT_GITLAB_PROJECT, "/members/all"),
    item: GitLabMemberSchema,
    maxPages: 3,
  }).pipe(
    Effect.map((page) =>
      page.items.flatMap((member) => {
        const login = member.username.trim();
        if (!login || (member.state && member.state !== "active")) return [];
        const displayName = member.name?.trim();
        const avatarUrl = member.avatar_url?.trim();
        return [
          {
            login,
            ...(displayName ? { displayName } : {}),
            ...(avatarUrl ? { avatarUrl } : {}),
          },
        ];
      }),
    ),
  );
}

// ── CI ────────────────────────────────────────────────────────────────

function requireNumericId(operation: string, label: string, value: string) {
  return isGitLabNumericId(value)
    ? Effect.succeed(value)
    : Effect.fail(fail(operation, `Unknown ${label}: ${value}`));
}

/**
 * Pipelines for a merge request's head (`pullRequestNumber`), a commit, or a
 * branch's newest commit, newest first.
 */
export function listGitLabWorkflowRuns(
  call: GitLabCall,
  input: {
    readonly pullRequestNumber?: number | undefined;
    readonly commitSha?: string | undefined;
    readonly branch?: string | undefined;
    readonly limit?: number | undefined;
  },
): Effect.Effect<SourceControlWorkflowRunListResult, GitLabCliError> {
  const operation = "listWorkflowRuns";
  return Effect.gen(function* () {
    const perPage = Math.min(Math.max(input.limit ?? 50, 1), GITLAB_API_PAGE_SIZE);
    const project = CURRENT_GITLAB_PROJECT;
    let pipelines: ReadonlyArray<GitLabPipeline>;
    let sourceHeadOf: (pipeline: GitLabPipeline) => string | null = () => null;
    let headSha: string | null = input.commitSha?.trim() || null;
    if (headSha !== null && !isGitSha(headSha)) {
      return yield* fail(operation, `Invalid commit SHA: ${headSha}`);
    }
    if (input.pullRequestNumber !== undefined) {
      const ref = { ...project, iid: input.pullRequestNumber };
      const facts = yield* getGitLabMergeRequestFacts(call, operation, ref);
      headSha = headSha ?? facts.headSha;
      const { page, headPipeline } = yield* Effect.all(
        {
          page: getGitLabPages(call, operation, {
            ref,
            endpoint: gitLabMergeRequestEndpoint(ref, "/pipelines"),
            item: GitLabPipelineSchema,
            maxPages: 1,
            perPage,
          }),
          headPipeline: input.commitSha
            ? Effect.succeed(null)
            : resolveGitLabHeadPipeline(call, operation, ref, facts),
        },
        { concurrency: 2 },
      );
      pipelines = selectGitLabHeadPipelines(page.items, {
        headSha,
        headPipelineId: headPipeline?.id ?? null,
      });
      // The merged-results / merge-train head pipeline runs on a merge commit:
      // say which head it verifies, so clients filtering by head keep it.
      sourceHeadOf = (pipeline) => (pipeline.id === headPipeline?.id ? facts.headSha : null);
    } else if (headSha !== null) {
      pipelines = (yield* getGitLabPages(call, operation, {
        ref: null,
        endpoint: withGitLabQuery(gitLabProjectEndpoint(project, "/pipelines"), { sha: headSha }),
        item: GitLabPipelineSchema,
        maxPages: 1,
        perPage,
      })).items;
    } else if (input.branch?.trim()) {
      const page = yield* getGitLabPages(call, operation, {
        ref: null,
        endpoint: withGitLabQuery(gitLabProjectEndpoint(project, "/pipelines"), {
          ref: input.branch.trim(),
        }),
        item: GitLabPipelineSchema,
        maxPages: 1,
        perPage,
      });
      // Newest pipeline first: narrow to the branch's latest commit.
      headSha = page.items[0]?.sha ?? null;
      pipelines = page.items.filter((pipeline) => pipeline.sha === headSha);
    } else {
      pipelines = [];
    }
    return {
      provider: "gitlab",
      repository: Option.none(),
      pullRequestNumber:
        input.pullRequestNumber !== undefined
          ? Option.some(input.pullRequestNumber)
          : Option.none(),
      headSha: headSha ? Option.some(headSha) : Option.none(),
      runs: pipelines.flatMap((pipeline) => {
        const run = gitLabWorkflowRun(pipeline, sourceHeadOf(pipeline));
        return run ? [run] : [];
      }),
    };
  });
}

export function listGitLabPipelineJobs(
  call: GitLabCall,
  runId: string,
): Effect.Effect<SourceControlWorkflowRunJobsResult, GitLabCliError> {
  const operation = "getWorkflowRunJobs";
  return Effect.gen(function* () {
    yield* requireNumericId(operation, "pipeline", runId);
    const page = yield* getGitLabPages(call, operation, {
      ref: null,
      endpoint: gitLabProjectEndpoint(CURRENT_GITLAB_PROJECT, `/pipelines/${runId}/jobs`),
      item: GitLabJobSchema,
      maxPages: 3,
    });
    return {
      provider: "gitlab",
      runId,
      // GitLab lists jobs newest first; show them in pipeline order.
      jobs: page.items.toSorted((left, right) => left.id - right.id).map(gitLabWorkflowJob),
    };
  });
}

export function getGitLabJobLog(
  call: GitLabCall,
  input: { readonly runId: string; readonly jobId: string },
): Effect.Effect<SourceControlWorkflowJobLogResult, GitLabCliError> {
  const operation = "getWorkflowJobLog";
  return Effect.gen(function* () {
    yield* requireNumericId(operation, "job", input.jobId);
    const output = yield* call(
      operation,
      gitLabGet(null, gitLabProjectEndpoint(CURRENT_GITLAB_PROJECT, `/jobs/${input.jobId}/trace`)),
      { maxOutputBytes: JOB_LOG_TAIL_BYTES, keepOutputTail: true, timeoutMs: 60_000 },
    );
    const tail = gitLabJobLogTail(output.stdout, { startCut: output.stdoutTruncated });
    return {
      provider: "gitlab",
      runId: input.runId,
      jobId: input.jobId,
      log: tail.log,
      truncated: tail.truncated || output.stdoutTruncated,
    };
  });
}

/** `failed-jobs` retries a pipeline's failed and canceled jobs; `job` retries one. */
export function rerunGitLabPipeline(
  call: GitLabCall,
  input: SourceControlWorkflowRerunInput,
): Effect.Effect<SourceControlWorkflowRerunResult, GitLabCliError> {
  const operation = "rerunWorkflow";
  return Effect.gen(function* () {
    if (input.target === "job") {
      yield* requireNumericId(operation, "job", input.jobId);
      yield* call(
        operation,
        gitLabWrite(
          CURRENT_GITLAB_PROJECT,
          "POST",
          gitLabProjectEndpoint(CURRENT_GITLAB_PROJECT, `/jobs/${input.jobId}/retry`),
        ),
      );
      return { provider: "gitlab", runId: input.runId, target: "job", jobId: input.jobId };
    }
    yield* requireNumericId(operation, "pipeline", input.runId);
    yield* call(
      operation,
      gitLabWrite(
        CURRENT_GITLAB_PROJECT,
        "POST",
        gitLabProjectEndpoint(CURRENT_GITLAB_PROJECT, `/pipelines/${input.runId}/retry`),
      ),
    );
    return { provider: "gitlab", runId: input.runId, target: "failed-jobs" };
  });
}

export type { GitLabProject };
