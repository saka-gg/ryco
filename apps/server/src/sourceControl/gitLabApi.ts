/**
 * Pure request building for GitLab REST v4 calls made through `glab api`.
 *
 * Everything here is side-effect free so the exact argv, stdin, and endpoint
 * strings can be unit-tested; `GitLabCli.api` executes them. Request bodies
 * always travel as JSON over stdin (`--input -`), never as argv: argv is
 * visible in process listings and echoed back inside process-runner failures.
 * `glab api --input` sends no Content-Type, so the JSON header is explicit
 * (GitLab only parses a JSON body declared as JSON).
 *
 * Docs: https://docs.gitlab.com/api/rest/ (pagination, namespaced paths),
 * `glab api --help` (placeholders, `--input -`, `(HTTP <status>)` failures).
 */

/** GitLab's maximum `per_page`. */
export const GITLAB_API_PAGE_SIZE = 100;

/** A project addressed either by glab's `:fullpath` placeholder or a URL-encoded path. */
export interface GitLabProjectRef {
  /** `:fullpath` (the checkout's remote) or a URL-encoded `group/subgroup/project`. */
  readonly projectPath: string;
  /** Set when the reference named another host (a full merge request URL). */
  readonly hostname?: string;
}

export interface GitLabMergeRequestRef extends GitLabProjectRef {
  readonly iid: number;
}

const CURRENT_PROJECT = ":fullpath";

const MERGE_REQUEST_URL_PATH = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/u;

function positiveSafeInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * `42`, `!42`, `#42`, or a merge request URL. A URL addresses its own project
 * (and host); bare numbers address the checkout's project via `:fullpath`.
 */
export function parseGitLabMergeRequestReference(reference: string): GitLabMergeRequestRef | null {
  const trimmed = reference.trim();
  const short = /^[!#]?(\d+)$/u.exec(trimmed);
  if (short?.[1]) {
    const iid = positiveSafeInteger(short[1]);
    return iid === null ? null : { projectPath: CURRENT_PROJECT, iid };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match = MERGE_REQUEST_URL_PATH.exec(url.pathname);
  const projectPath = match?.[1] ? decodeURIComponent(match[1]).replace(/\/+$/u, "") : "";
  const iid = match?.[2] ? positiveSafeInteger(match[2]) : null;
  if (!projectPath || iid === null) return null;
  return { projectPath: encodeURIComponent(projectPath), iid, hostname: url.host };
}

/** The checkout's own project (`:fullpath`), for calls that are not about one merge request. */
export const CURRENT_GITLAB_PROJECT: GitLabProjectRef = { projectPath: CURRENT_PROJECT };

export function gitLabProjectEndpoint(ref: GitLabProjectRef, suffix = ""): string {
  return `projects/${ref.projectPath}${suffix}`;
}

export function gitLabMergeRequestEndpoint(ref: GitLabMergeRequestRef, suffix = ""): string {
  return `projects/${ref.projectPath}/merge_requests/${ref.iid}${suffix}`;
}

export type GitLabQueryValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number>
  | null
  | undefined;

/** Append query parameters; arrays repeat as `key[]=v` (GitLab's array convention). */
export function withGitLabQuery(
  endpoint: string,
  query: Readonly<Record<string, GitLabQueryValue>>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      for (const entry of value) {
        parts.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(String(entry))}`);
      }
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (parts.length === 0) return endpoint;
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

export type GitLabApiMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface GitLabApiRequest {
  readonly method: GitLabApiMethod;
  /** Endpoint path below `/api/v4/`, query string included. */
  readonly endpoint: string;
  readonly hostname?: string | undefined;
  /** JSON body, sent over stdin. */
  readonly body?: Readonly<Record<string, unknown>> | undefined;
}

export function gitLabGet(ref: GitLabProjectRef | null, endpoint: string): GitLabApiRequest {
  return { method: "GET", endpoint, ...(ref?.hostname ? { hostname: ref.hostname } : {}) };
}

export function gitLabWrite(
  ref: GitLabProjectRef,
  method: Exclude<GitLabApiMethod, "GET">,
  endpoint: string,
  body?: Readonly<Record<string, unknown>>,
): GitLabApiRequest {
  return {
    method,
    endpoint,
    ...(ref.hostname ? { hostname: ref.hostname } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

export interface GlabApiInvocation {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
}

export function buildGlabApiInvocation(request: GitLabApiRequest): GlabApiInvocation {
  const args = [
    "api",
    ...(request.hostname ? ["--hostname", request.hostname] : []),
    "--method",
    request.method,
    request.endpoint,
  ];
  if (request.body === undefined) return { args };
  return {
    args: [...args, "--header", "Content-Type: application/json", "--input", "-"],
    stdin: JSON.stringify(request.body),
  };
}

// ── Failures ──────────────────────────────────────────────────────────

export interface GitLabApiFailure {
  /** HTTP status `glab` reported (`glab: <message> (HTTP 404)`), when it reached the API. */
  readonly status: number | null;
  readonly message: string;
}

function messageFromJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const value = record.message ?? record.error ?? record.error_description;
    if (typeof value === "string") return value.trim() || null;
    if (value !== undefined) return JSON.stringify(value);
    return null;
  } catch {
    return null;
  }
}

/** Status and message of a failed `glab api` call (stdout carries GitLab's JSON error body). */
export function parseGitLabApiFailure(output: {
  readonly stdout: string;
  readonly stderr: string;
}): GitLabApiFailure {
  const statusMatch = /\(HTTP (\d{3})\)/u.exec(output.stderr);
  const status = statusMatch?.[1] ? Number(statusMatch[1]) : null;
  const fromBody = messageFromJson(output.stdout);
  const fromStderr = output.stderr
    .replace(/^glab:\s*/u, "")
    .replace(/\s*\(HTTP \d{3}\)\s*$/u, "")
    .trim();
  return { status, message: fromBody ?? (fromStderr || "no details") };
}

export function describeGitLabApiFailure(failure: GitLabApiFailure): string {
  switch (failure.status) {
    case null:
      return `GitLab CLI command failed: ${failure.message}`;
    case 401:
      return "GitLab rejected the credentials (HTTP 401). Run `glab auth login` and retry.";
    case 403:
      return `GitLab refused the request (HTTP 403): ${failure.message}. The token needs the \`api\` scope and enough project access.`;
    case 404:
      return `GitLab could not find it (HTTP 404): ${failure.message}.`;
    default:
      return `GitLab API request failed (HTTP ${failure.status}): ${failure.message}`;
  }
}

// ── Paging ────────────────────────────────────────────────────────────

/** A page shorter than `per_page` is the last one (GitLab omits totals on large collections). */
export function isLastGitLabPage(count: number, perPage = GITLAB_API_PAGE_SIZE): boolean {
  return count < perPage;
}

/** Commit SHA shape accepted in endpoint paths. */
export function isGitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/iu.test(value);
}

/** Discussion ids are hex SHA-like strings; note ids are numbers. Both go into paths. */
export function isGitLabDiscussionId(value: string): boolean {
  return /^[0-9a-f]{8,64}$/iu.test(value);
}

export function isGitLabNumericId(value: string): boolean {
  return /^\d{1,19}$/u.test(value);
}
