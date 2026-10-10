import { type EnvironmentId, MessageId, type ThreadId, type TurnId } from "@ryco/contracts";

import { stripDiffSearchParams } from "./diffRouteSearch";
import { stripPreviewSearchParams } from "./previewRouteSearch";

export type WorkspacePanelTab =
  | "review"
  | "files"
  | "terminal"
  | "simulator"
  | "browser"
  | "pullRequest"
  | "agent"
  | "agents"
  | "render";

const WORKSPACE_PANEL_TABS: ReadonlySet<string> = new Set<WorkspacePanelTab>([
  "review",
  "files",
  "terminal",
  "simulator",
  "browser",
  "pullRequest",
  "agent",
  "agents",
  "render",
]);

// A type alias, not an interface: the builders' results feed back into
// builders that take `Record<string, unknown>`, which interfaces never satisfy.
export type WorkspaceRouteSearch = {
  workspaceOpen?: "1" | undefined;
  workspaceTab?: WorkspacePanelTab | undefined;
  workspaceAgentKey?: string | undefined;
  /** Pull request tab: a specific change request; absent = the thread's own. */
  workspacePr?: number | undefined;
  /** Page tab: the HTML render it shows, as `formatWorkspaceRenderKey` writes it. */
  workspaceRender?: string | undefined;
  /**
   * Pull request tab: a one-shot reveal (`formatWorkspacePullRequestReveal`).
   * The reader acts on it once and the panel strips it, so a repeat click
   * re-triggers and history, reload and the session never replay it.
   */
  workspacePrReveal?: string | undefined;
  /** Agents tab: a one-shot focus on one workflow, consumed like `workspacePrReveal`. */
  workspaceAgentsWorkflow?: string | undefined;
};

/** Every search key the workspace panel owns, legacy diff/preview included. */
export type WorkspacePanelSearchKey =
  | "diff"
  | "diffTurnId"
  | "diffFilePath"
  | "preview"
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
  | "workspacePr"
  | "workspaceRender"
  | "workspacePrReveal"
  | "workspaceAgentsWorkflow";

type WorkspaceSearchKey =
  | "workspaceOpen"
  | "workspaceTab"
  | "workspaceAgentKey"
  | "workspacePr"
  | "workspaceRender"
  | WorkspaceRevealSearchKey;

/** The one-shot keys: consumed once, then stripped (`stripWorkspaceRevealSearch`). */
type WorkspaceRevealSearchKey = "workspacePrReveal" | "workspaceAgentsWorkflow";

/** Keys that name something in the thread that opened them. */
type ThreadScopedWorkspaceSearchKey = "workspacePr" | "workspaceRender" | WorkspaceRevealSearchKey;

/**
 * A route search with the workspace panel's keys replaced. Every key the panel
 * owns is written explicitly (undefined clears it), so a builder's result
 * never inherits a stale tab parameter from the previous search.
 */
export type WorkspacePanelSearch<T, Legacy> = Omit<T, WorkspacePanelSearchKey> &
  WorkspaceRouteSearch &
  Legacy;

type ClosedLegacySearch = { diff?: undefined; preview?: undefined };

function normalizeSearchString(value: unknown, maxLength?: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return maxLength === undefined || normalized.length <= maxLength ? normalized : undefined;
}

function normalizeWorkspaceTab(value: unknown): WorkspacePanelTab | undefined {
  return typeof value === "string" && WORKSPACE_PANEL_TABS.has(value)
    ? (value as WorkspacePanelTab)
    : undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

/** An HTML render a page tab shows: the attachment, and the message that carries it. */
export interface WorkspaceRenderTarget {
  readonly messageId: MessageId;
  readonly attachmentId: string;
}

// Attachment ids never contain a colon (`[a-z0-9_-]`); message ids may.
const RENDER_ATTACHMENT_ID = /^[a-z0-9_-]{1,128}$/i;

export function formatWorkspaceRenderKey(target: WorkspaceRenderTarget): string {
  return `${target.messageId}:${target.attachmentId}`;
}

/** The render a `workspaceRender` key names, or null when it names none. */
export function parseWorkspaceRenderKey(key: string): WorkspaceRenderTarget | null {
  const separator = key.lastIndexOf(":");
  if (separator <= 0) return null;
  const messageId = key.slice(0, separator).trim();
  const attachmentId = key.slice(separator + 1);
  if (messageId.length === 0 || !RENDER_ATTACHMENT_ID.test(attachmentId)) return null;
  return { messageId: MessageId.make(messageId), attachmentId };
}

function normalizeRenderKey(value: unknown): string | undefined {
  const key = normalizeSearchString(value);
  return key !== undefined && parseWorkspaceRenderKey(key) !== null ? key : undefined;
}

/** Where a pull request tab deep link lands: the Checks tab, or one job on it. */
export type WorkspacePullRequestReveal =
  | { readonly kind: "checks" }
  | { readonly kind: "job"; readonly job: string };

const PULL_REQUEST_REVEAL_JOB_PREFIX = "job:";
// Same bound as the pull requests page's `job` param.
const PULL_REQUEST_REVEAL_JOB_MAX_LENGTH = 128;
const AGENTS_WORKFLOW_MAX_LENGTH = 256;

export function formatWorkspacePullRequestReveal(reveal: WorkspacePullRequestReveal): string {
  return reveal.kind === "checks" ? "checks" : `${PULL_REQUEST_REVEAL_JOB_PREFIX}${reveal.job}`;
}

/** The reveal a `workspacePrReveal` key names, or null when it names none. */
export function parseWorkspacePullRequestReveal(key: string): WorkspacePullRequestReveal | null {
  if (key === "checks") return { kind: "checks" };
  if (!key.startsWith(PULL_REQUEST_REVEAL_JOB_PREFIX)) return null;
  const job = key.slice(PULL_REQUEST_REVEAL_JOB_PREFIX.length).trim();
  return job.length > 0 && job.length <= PULL_REQUEST_REVEAL_JOB_MAX_LENGTH
    ? { kind: "job", job }
    : null;
}

function normalizePullRequestRevealKey(value: unknown): string | undefined {
  const key = normalizeSearchString(value);
  const reveal = key === undefined ? null : parseWorkspacePullRequestReveal(key);
  return reveal === null ? undefined : formatWorkspacePullRequestReveal(reveal);
}

/**
 * The Agents tab row key of one runtime subagent. Idempotent: transcript-backed
 * runtime agents already carry the `subagent:` prefix.
 */
export function workspaceAgentKeyForRuntimeAgent(agentId: string): string {
  return agentId.startsWith("subagent:") ? agentId : `subagent:${agentId}`;
}

export function stripWorkspaceSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, WorkspaceSearchKey> {
  const {
    workspaceOpen: _workspaceOpen,
    workspaceTab: _workspaceTab,
    workspaceAgentKey: _workspaceAgentKey,
    workspacePr: _workspacePr,
    workspaceRender: _workspaceRender,
    workspacePrReveal: _workspacePrReveal,
    workspaceAgentsWorkflow: _workspaceAgentsWorkflow,
    ...rest
  } = params;
  return rest as Omit<T, WorkspaceSearchKey>;
}

export function stripWorkspacePanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, WorkspacePanelSearchKey> {
  return stripWorkspaceSearchParams(
    stripPreviewSearchParams(stripDiffSearchParams(params)),
  ) as Omit<T, WorkspacePanelSearchKey>;
}

/**
 * Clears the one-shot deep-link keys once their tab acted on them. Written
 * explicitly as undefined so a navigation built from the result drops them.
 */
export function stripWorkspaceRevealSearch<T extends Record<string, unknown>>(
  params: T,
): Omit<T, WorkspaceRevealSearchKey> & {
  workspacePrReveal: undefined;
  workspaceAgentsWorkflow: undefined;
} {
  const {
    workspacePrReveal: _workspacePrReveal,
    workspaceAgentsWorkflow: _workspaceAgentsWorkflow,
    ...rest
  } = params;
  return { ...rest, workspacePrReveal: undefined, workspaceAgentsWorkflow: undefined };
}

/**
 * A pinned change request (`workspacePr`), a page tab (`workspaceRender`) and
 * the one-shot reveals name things in the thread that opened them.
 * Navigation that carries the panel's search over to another thread drops
 * them: that thread's pull request tab shows its own change request, and a
 * page tab gives way to the launcher.
 */
export function stripThreadScopedWorkspaceSearch<T extends Record<string, unknown>>(
  params: T,
): Omit<T, ThreadScopedWorkspaceSearchKey> {
  const {
    workspacePr: _workspacePr,
    workspaceRender: _workspaceRender,
    workspacePrReveal: _workspacePrReveal,
    workspaceAgentsWorkflow: _workspaceAgentsWorkflow,
    ...rest
  } = params;
  return (rest.workspaceTab === "render" ? { ...rest, workspaceTab: undefined } : rest) as Omit<
    T,
    ThreadScopedWorkspaceSearchKey
  >;
}

/**
 * The panel's search on a navigation to `to` (a message hit, say): kept as it
 * is within the thread it was opened in, without the thread-scoped keys in
 * any other.
 */
export function carryWorkspaceSearchToThread<T extends Record<string, unknown>>(
  params: T,
  input: {
    readonly from: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
    readonly to: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  },
): T | Omit<T, ThreadScopedWorkspaceSearchKey> {
  const sameThread =
    input.from !== null &&
    input.from.environmentId === input.to.environmentId &&
    input.from.threadId === input.to.threadId;
  return sameThread ? params : stripThreadScopedWorkspaceSearch(params);
}

/** One builder for every tab: clears all panel keys, then applies `fields`. */
function withWorkspacePanelSearch<T extends Record<string, unknown>, Legacy>(
  params: T,
  fields: WorkspaceRouteSearch & {
    diff?: "1" | undefined;
    diffTurnId?: TurnId | undefined;
    diffFilePath?: string | undefined;
    preview?: "1" | undefined;
  },
): WorkspacePanelSearch<T, Legacy> {
  return {
    ...stripWorkspacePanelSearchParams(params),
    workspaceOpen: undefined,
    workspaceTab: undefined,
    workspaceAgentKey: undefined,
    workspacePr: undefined,
    workspaceRender: undefined,
    workspacePrReveal: undefined,
    workspaceAgentsWorkflow: undefined,
    diff: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
    preview: undefined,
    ...fields,
    // Each exported builder states the legacy diff/preview shape it writes.
  } as unknown as WorkspacePanelSearch<T, Legacy>;
}

/** Closes the workspace panel: every key it owns is cleared. */
export function buildCloseWorkspacePanelSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {});
}

export function buildOpenWorkspaceSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, { workspaceOpen: "1" });
}

export function buildOpenReviewSearch<T extends Record<string, unknown>>(
  params: T,
  input?: {
    diffTurnId?: TurnId | undefined;
    diffFilePath?: string | undefined;
  },
): WorkspacePanelSearch<T, { diff: "1"; preview?: undefined }> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "review",
    diff: "1",
    diffTurnId: input?.diffTurnId,
    diffFilePath: input?.diffTurnId ? input.diffFilePath : undefined,
  });
}

export function buildOpenFilesSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, { diff?: undefined; preview: "1" }> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "files",
    preview: "1",
  });
}

export function buildOpenTerminalSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, { workspaceOpen: "1", workspaceTab: "terminal" });
}

export function buildOpenSimulatorSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, { workspaceOpen: "1", workspaceTab: "simulator" });
}

export function buildOpenBrowserSearch<T extends Record<string, unknown>>(
  params: T,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, { workspaceOpen: "1", workspaceTab: "browser" });
}

/**
 * Pull request tab. Without a number the tab follows the thread's own change
 * request; a number pins another one (a stack layer, a linked PR). A `reveal`
 * lands on the Checks tab, or one job on it, once.
 */
export function buildOpenPullRequestSearch<T extends Record<string, unknown>>(
  params: T,
  pullRequestNumber?: number,
  reveal?: WorkspacePullRequestReveal,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "pullRequest",
    workspacePr: normalizePositiveInt(pullRequestNumber),
    workspacePrReveal:
      reveal === undefined
        ? undefined
        : normalizePullRequestRevealKey(formatWorkspacePullRequestReveal(reveal)),
  });
}

export function buildOpenAgentsSearch<T extends Record<string, unknown>>(
  params: T,
  agentKey?: string,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "agents",
    workspaceAgentKey: agentKey,
  });
}

/** Agents tab, focused once on one workflow (expanded, scrolled to and flashed). */
export function buildOpenAgentsWorkflowSearch<T extends Record<string, unknown>>(
  params: T,
  workflowId: string,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "agents",
    workspaceAgentsWorkflow: normalizeSearchString(workflowId, AGENTS_WORKFLOW_MAX_LENGTH),
  });
}

export function buildOpenAgentSearch<T extends Record<string, unknown>>(
  params: T,
  agentKey: string,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "agent",
    workspaceAgentKey: agentKey,
  });
}

/** Page tab: one HTML render of the thread, at full size. */
export function buildOpenRenderSearch<T extends Record<string, unknown>>(
  params: T,
  renderKey: string,
): WorkspacePanelSearch<T, ClosedLegacySearch> {
  return withWorkspacePanelSearch(params, {
    workspaceOpen: "1",
    workspaceTab: "render",
    workspaceRender: renderKey,
  });
}

export function parseWorkspaceRouteSearch(search: Record<string, unknown>): WorkspaceRouteSearch {
  const workspaceOpen = search.workspaceOpen === "1" ? "1" : undefined;
  const workspaceTab = normalizeWorkspaceTab(search.workspaceTab);
  if (!workspaceTab) {
    return workspaceOpen ? { workspaceOpen } : {};
  }

  const workspaceAgentKey =
    workspaceTab === "agent" || workspaceTab === "agents"
      ? normalizeSearchString(search.workspaceAgentKey)
      : undefined;
  if (workspaceTab === "agent" && !workspaceAgentKey) {
    return {};
  }
  const workspaceRender =
    workspaceTab === "render" ? normalizeRenderKey(search.workspaceRender) : undefined;
  if (workspaceTab === "render" && !workspaceRender) {
    return {};
  }
  const workspacePr =
    workspaceTab === "pullRequest" ? normalizePositiveInt(search.workspacePr) : undefined;
  const workspacePrReveal =
    workspaceTab === "pullRequest"
      ? normalizePullRequestRevealKey(search.workspacePrReveal)
      : undefined;
  const workspaceAgentsWorkflow =
    workspaceTab === "agents"
      ? normalizeSearchString(search.workspaceAgentsWorkflow, AGENTS_WORKFLOW_MAX_LENGTH)
      : undefined;

  return {
    workspaceOpen: "1",
    workspaceTab,
    ...(workspaceAgentKey ? { workspaceAgentKey } : {}),
    ...(workspacePr !== undefined ? { workspacePr } : {}),
    ...(workspaceRender ? { workspaceRender } : {}),
    ...(workspacePrReveal ? { workspacePrReveal } : {}),
    ...(workspaceAgentsWorkflow ? { workspaceAgentsWorkflow } : {}),
  };
}
