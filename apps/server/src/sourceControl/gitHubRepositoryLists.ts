/**
 * Repository-wide pull request and issue lists as one GraphQL request per page.
 *
 * `gh pr list --json comments` and `gh issue list --json comments` fetch every
 * comment body (up to 100 per row) only so the caller can count them, and the
 * page's stack summaries then cost a second sequential GraphQL round trip. These
 * lists ask GitHub for exactly the fields list rows show instead: comment counts
 * (`totalCount`), checks, review state, diff stats and, in the same request,
 * each row's stack summary. Nodes are flattened into `gh`'s `--json` shape so the
 * existing decoders normalize them exactly as before.
 *
 * Everything here is pure; `GitHubCli` sends the documents over stdin.
 */
import { Result, Schema } from "effect";
import type {
  ChangeRequestInvolvement,
  SourceControlChangeRequestStackSummary,
} from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

import { decodeGitHubIssueEntryValue, type NormalizedGitHubIssueRecord } from "./gitHubIssues.ts";
import { gitHubInvolvementQualifier } from "./gitHubPullRequestMutations.ts";
import {
  decodeGitHubPullRequestEntryValue,
  type NormalizedGitHubPullRequestRecord,
} from "./gitHubPullRequests.ts";

/** GitHub's GraphQL connection maximum; also the client's superset list size. */
export const GITHUB_REPOSITORY_LIST_PAGE_SIZE = 100;
/** Safety bound for callers asking for more than one page. */
export const GITHUB_REPOSITORY_LIST_MAX_PAGES = 10;

export interface GitHubListRepository {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

export type GitHubPullRequestListState = "open" | "closed" | "merged" | "all";

/** Optional row fields a host may refuse (permissions) or not know (older GHES). */
export interface GitHubPullRequestListFields {
  /** `statusCheckRollup` (checks), which fine-grained tokens may not be allowed to read. */
  readonly checks: boolean;
  /** `stackEntry` / `stack` (native stacks), absent on hosts without them. */
  readonly stack: boolean;
}

// Same selections (and limits) `gh pr list --json <list fields>` asks for,
// except `comments`, which is a count here instead of 100 bodies per row.
const PULL_REQUEST_ROW_FIELDS = `number title url baseRefName headRefName headRefOid mergeable state mergedAt closedAt updatedAt createdAt reviewDecision additions deletions changedFiles isCrossRepository isDraft
      author { __typename login }
      assignees(first: 100) { nodes { login } }
      labels(first: 100) { nodes { name color description } }
      comments { totalCount }
      headRepository { nameWithOwner }
      headRepositoryOwner { login }`;

const PULL_REQUEST_CHECK_FIELDS = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on StatusContext { context state targetUrl createdAt } ... on CheckRun { name checkSuite { workflowRun { workflow { name } } } status conclusion startedAt completedAt detailsUrl } } } } } } }`;

const PULL_REQUEST_STACK_FIELDS = `stackEntry { position }
      stack { number size baseRefName }`;

function pullRequestRowSelection(fields: GitHubPullRequestListFields): string {
  return [
    PULL_REQUEST_ROW_FIELDS,
    ...(fields.checks ? [PULL_REQUEST_CHECK_FIELDS] : []),
    ...(fields.stack ? [PULL_REQUEST_STACK_FIELDS] : []),
  ].join("\n      ");
}

/**
 * The page document. Without an involvement filter it reads the repository's
 * pull request connection (newest first, as `gh pr list` does); with one it is
 * a GitHub search, as `gh pr list --search` is.
 */
export function buildGitHubPullRequestListQuery(
  input: { readonly search: boolean } & GitHubPullRequestListFields,
): string {
  const selection = pullRequestRowSelection(input);
  if (input.search) {
    return `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
      ${selection}
      }
    }
  }
}`;
  }
  return `query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [PullRequestState!], $head: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: $states, headRefName: $head, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
      ${selection}
      }
    }
  }
}`;
}

/** `gh pr list --state` as GraphQL states: `closed` includes merged, as in `gh`. */
export function gitHubPullRequestListStates(
  state: GitHubPullRequestListState,
): ReadonlyArray<"OPEN" | "CLOSED" | "MERGED"> {
  switch (state) {
    case "open":
      return ["OPEN"];
    case "closed":
      return ["CLOSED", "MERGED"];
    case "merged":
      return ["MERGED"];
    case "all":
      return ["OPEN", "CLOSED", "MERGED"];
  }
}

/**
 * The search string `gh pr list --search <involvement> --state <state>` sends:
 * the involvement qualifier plus head, state, repository and type qualifiers.
 */
export function buildGitHubPullRequestInvolvementSearch(input: {
  readonly repository: GitHubListRepository;
  readonly involvement: ChangeRequestInvolvement;
  readonly state: GitHubPullRequestListState;
  readonly headSelector?: string | undefined;
}): string {
  const head = input.headSelector?.trim() ?? "";
  const state =
    input.state === "open"
      ? "state:open"
      : input.state === "closed"
        ? "state:closed"
        : input.state === "merged"
          ? "is:merged"
          : "";
  return [
    gitHubInvolvementQualifier(input.involvement),
    head.length > 0 ? `head:${head}` : "",
    state,
    `repo:${input.repository.owner}/${input.repository.name}`,
    "type:pr",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

export const GITHUB_ISSUE_LIST_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [IssueState!]) {
  repository(owner: $owner, name: $name) {
    hasIssuesEnabled
    issues(states: $states, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url state updatedAt
        author { __typename login }
        labels(first: 100) { nodes { name color description } }
        assignees(first: 100) { nodes { login } }
        comments { totalCount }
      }
    }
  }
}`;

export function gitHubIssueListStates(
  state: "open" | "closed" | "all",
): ReadonlyArray<"OPEN" | "CLOSED"> {
  return state === "open" ? ["OPEN"] : state === "closed" ? ["CLOSED"] : ["OPEN", "CLOSED"];
}

// ── Response decoding ────────────────────────────────────────────────

const RawGraphQlErrorSchema = Schema.Struct({
  message: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.Array(Schema.Union([Schema.String, Schema.Number])))),
});

const RawConnectionSchema = Schema.Struct({
  pageInfo: Schema.Struct({
    hasNextPage: Schema.Boolean,
    endCursor: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  // Rows decode one by one: a malformed row is skipped, not the page.
  nodes: Schema.Array(Schema.Unknown),
});

const RawListResponseSchema = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawGraphQlErrorSchema)))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        search: Schema.optional(Schema.NullOr(RawConnectionSchema)),
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              hasIssuesEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
              pullRequests: Schema.optional(Schema.NullOr(RawConnectionSchema)),
              issues: Schema.optional(Schema.NullOr(RawConnectionSchema)),
            }),
          ),
        ),
      }),
    ),
  ),
});

const decodeListResponse = decodeJsonResult(RawListResponseSchema);

type RawListResponse = typeof RawListResponseSchema.Type;
type RawConnection = typeof RawConnectionSchema.Type;

/** Path segments of fields a row may lack without failing the list. */
const CHECK_PATH_SEGMENTS = new Set(["commits", "statusCheckRollup"]);
const STACK_PATH_SEGMENTS = new Set(["stack", "stackEntry"]);

interface ClassifiedErrors {
  /** Errors outside the optional fields: the list cannot be trusted. */
  readonly fatal: ReadonlyArray<string>;
  /** The host refused the check rollup for at least one row. */
  readonly checksDenied: boolean;
}

function classifyGraphQlErrors(response: RawListResponse): ClassifiedErrors {
  const fatal: string[] = [];
  let checksDenied = false;
  for (const error of response.errors ?? []) {
    const path = (error?.path ?? []).filter(
      (segment): segment is string => typeof segment === "string",
    );
    const message = error?.message?.trim() || "GitHub GraphQL returned an error.";
    if (path.some((segment) => CHECK_PATH_SEGMENTS.has(segment))) {
      checksDenied = true;
      continue;
    }
    // A stack that cannot be resolved only costs that row its summary.
    if (path.some((segment) => STACK_PATH_SEGMENTS.has(segment))) continue;
    fatal.push(message);
  }
  return { fatal, checksDenied };
}

export interface GitHubListPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface GitHubPullRequestListRow {
  readonly record: NormalizedGitHubPullRequestRecord;
  readonly stackSummary: SourceControlChangeRequestStackSummary | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `gh`'s author shape: bot accounts read as `app/<login>`, as `gh pr view` reports them. */
function ghAuthor(value: unknown): { readonly login: string } | null | undefined {
  if (value === null || value === undefined) return value;
  if (!isRecord(value) || typeof value.login !== "string") return undefined;
  return { login: value.__typename === "Bot" ? `app/${value.login}` : value.login };
}

function withAuthor(value: unknown): { readonly author?: { readonly login: string } | null } {
  const author = ghAuthor(value);
  return author === undefined ? {} : { author };
}

function connectionNodes(value: unknown): ReadonlyArray<unknown> {
  return isRecord(value) && Array.isArray(value.nodes) ? value.nodes : [];
}

function totalCount(value: unknown): number | undefined {
  return isRecord(value) && typeof value.totalCount === "number" ? value.totalCount : undefined;
}

/** `gh`'s flattened `statusCheckRollup`: `null` without a head commit, else its contexts. */
function flattenCheckRollup(commits: unknown): ReadonlyArray<Record<string, unknown>> | null {
  const head = connectionNodes(commits)[0];
  if (!isRecord(head)) return null;
  const commit = isRecord(head.commit) ? head.commit : null;
  const rollup = commit && isRecord(commit.statusCheckRollup) ? commit.statusCheckRollup : null;
  const contexts = rollup ? connectionNodes(rollup.contexts) : [];
  return contexts.filter(isRecord).map((context) => {
    if (context.__typename === "CheckRun") {
      const suite = isRecord(context.checkSuite) ? context.checkSuite : null;
      const run = suite && isRecord(suite.workflowRun) ? suite.workflowRun : null;
      const workflow = run && isRecord(run.workflow) ? run.workflow : null;
      return {
        __typename: context.__typename,
        name: context.name,
        workflowName: workflow?.name ?? null,
        status: context.status,
        conclusion: context.conclusion,
        startedAt: context.startedAt,
        completedAt: context.completedAt,
        detailsUrl: context.detailsUrl,
      };
    }
    return {
      __typename: context.__typename,
      context: context.context,
      state: context.state,
      targetUrl: context.targetUrl,
      startedAt: context.createdAt,
    };
  });
}

function stackSummaryOf(
  node: Record<string, unknown>,
): SourceControlChangeRequestStackSummary | null {
  const entry = isRecord(node.stackEntry) ? node.stackEntry : null;
  const stack = isRecord(node.stack) ? node.stack : null;
  if (!entry || !stack) return null;
  const position = entry.position;
  const { number, size, baseRefName } = stack;
  if (
    typeof position !== "number" ||
    typeof number !== "number" ||
    typeof size !== "number" ||
    typeof baseRefName !== "string" ||
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(number) ||
    !Number.isSafeInteger(size) ||
    position < 1 ||
    number < 1 ||
    position > size ||
    baseRefName.trim().length === 0
  ) {
    return null;
  }
  return { number, size, position, baseRefName: baseRefName.trim() };
}

function flattenPullRequestNode(
  node: unknown,
  options: { readonly omitChecks: boolean },
): GitHubPullRequestListRow | null {
  // Search connections can hold other node types; they select no fields.
  if (!isRecord(node) || typeof node.number !== "number") return null;
  const {
    author,
    assignees,
    labels,
    comments,
    commits,
    stackEntry: _entry,
    stack: _stack,
    ...rest
  } = node;
  const checks = options.omitChecks || commits === undefined ? null : flattenCheckRollup(commits);
  const count = totalCount(comments);
  const record = decodeGitHubPullRequestEntryValue({
    ...rest,
    ...withAuthor(author),
    assignees: connectionNodes(assignees),
    labels: connectionNodes(labels),
    ...(count !== undefined ? { comments: count } : {}),
    ...(checks !== null ? { statusCheckRollup: checks } : {}),
  });
  return record ? { record, stackSummary: stackSummaryOf(node) } : null;
}

function pageOf<T>(connection: RawConnection, items: ReadonlyArray<T>): GitHubListPage<T> {
  return {
    items,
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: connection.pageInfo.endCursor?.trim() || null,
  };
}

function decodeResponse(raw: string): Result.Result<RawListResponse, string> {
  const decoded = decodeListResponse(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(`Invalid GitHub list response: ${formatSchemaError(decoded.failure)}`);
}

export function decodeGitHubPullRequestListPageJson(
  raw: string,
  input: { readonly search: boolean },
): Result.Result<GitHubListPage<GitHubPullRequestListRow>, string> {
  const decoded = decodeResponse(raw);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const errors = classifyGraphQlErrors(decoded.success);
  if (errors.fatal.length > 0) {
    return Result.fail(`GitHub GraphQL returned errors: ${errors.fatal.join("; ")}`);
  }
  const data = decoded.success.data;
  const connection = input.search ? data?.search : data?.repository?.pullRequests;
  if (!connection) {
    return Result.fail(
      input.search
        ? "GitHub returned no search results connection."
        : "GitHub returned no repository for the pull request list.",
    );
  }
  // A refused rollup drops checks from every row, as retrying without the field did.
  const rows = connection.nodes.flatMap((node) => {
    const row = flattenPullRequestNode(node, { omitChecks: errors.checksDenied });
    return row ? [row] : [];
  });
  return Result.succeed(pageOf(connection, rows));
}

function flattenIssueNode(node: unknown): NormalizedGitHubIssueRecord | null {
  if (!isRecord(node) || typeof node.number !== "number") return null;
  const { author, assignees, labels, comments, ...rest } = node;
  const count = totalCount(comments);
  return decodeGitHubIssueEntryValue({
    ...rest,
    ...withAuthor(author),
    assignees: connectionNodes(assignees),
    labels: connectionNodes(labels),
    ...(count !== undefined ? { comments: count } : {}),
  });
}

export function decodeGitHubIssueListPageJson(
  raw: string,
  repository: GitHubListRepository,
): Result.Result<GitHubListPage<NormalizedGitHubIssueRecord>, string> {
  const decoded = decodeResponse(raw);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  // Issue rows have no optional fields: any error fails the list.
  const messages = (decoded.success.errors ?? []).map(
    (error) => error?.message?.trim() || "GitHub GraphQL returned an error.",
  );
  if (messages.length > 0) {
    return Result.fail(`GitHub GraphQL returned errors: ${messages.join("; ")}`);
  }
  const found = decoded.success.data?.repository;
  if (!found) return Result.fail("GitHub returned no repository for the issue list.");
  if (found.hasIssuesEnabled === false) {
    // `gh issue list`'s wording, which callers already surface.
    return Result.fail(
      `the '${repository.owner}/${repository.name}' repository has disabled issues`,
    );
  }
  if (!found.issues) return Result.fail("GitHub returned no issues for the issue list.");
  const issues = found.issues.nodes.flatMap((node) => {
    const issue = flattenIssueNode(node);
    return issue ? [issue] : [];
  });
  return Result.succeed(pageOf(found.issues, issues));
}

/** `gh api graphql` failure text when the host's schema lacks the stack fields. */
export function isGitHubStackFieldUnsupportedDetail(detail: string): boolean {
  return /field '(?:stack|stackEntry)' doesn't exist on type/iu.test(detail);
}
