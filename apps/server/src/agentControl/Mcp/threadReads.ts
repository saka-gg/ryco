/**
 * Principal-agnostic thread, review, file, and project reads shared by the
 * private session catalog and the standalone external catalog.
 *
 * Callers own authorization. Every helper that resolves a thread accepts a
 * visibility predicate: a thread the caller may not see is reported exactly
 * like a missing thread, so scope denial and absence stay indistinguishable.
 * Results are bounded projections; inspection payloads go through
 * {@link sanitizeInspection} before they cross an MCP boundary.
 *
 * @module agentControl/Mcp/threadReads
 */
import type {
  AgentControlInspectThreadInput,
  AgentControlReadDiffInput,
  AgentControlWaitThreadsInput,
} from "@ryco/contracts";
import {
  AGENT_CONTROL_MCP_LIST_LIMIT_DEFAULT,
  AGENT_CONTROL_MCP_LIST_LIMIT_MAX,
  AGENT_CONTROL_MCP_MESSAGE_LIMIT_DEFAULT,
  AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX,
  AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS,
  AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS,
  AgentControlMcpListThreadsResult,
  AgentControlMcpReadThreadResult,
  OrchestrationThreadActivity,
  OrchestrationThreadHistoryCursor,
  type AgentControlMcpListThreadsInput,
  type AgentControlMcpMessage,
  type AgentControlMcpReadThreadInput,
  type AgentControlMcpThreadSummary,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadHistoryPageInfo,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { deriveThreadSubagents } from "@ryco/client-runtime/state/session";
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import { Effect, Option, Schema } from "effect";

import type { CheckpointDiffQueryShape } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import type { WorkspaceAccessPolicyShape } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import type { WorkspaceFileSystemShape } from "../../workspace/Services/WorkspaceFileSystem.ts";
import { redactAgentControlSecrets } from "../ProviderInjection.ts";

/** Bounded, presentation-safe tool failure. Never carries internals. */
export class ToolFailure {
  readonly _tag = "ToolFailure";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

export const failTool = (reason: string) => Effect.fail(new ToolFailure(reason));

/** Decides whether the caller may see a thread; hidden threads read as not found. */
export type ThreadVisibility = (thread: OrchestrationThreadShell) => boolean;

export const allThreadsVisible: ThreadVisibility = () => true;

export const clampLimit = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(value ?? fallback, max);

// ── List cursors ──────────────────────────────────────────────────────
//
// Opaque `acp1.<base64url json>` cursors over the stable
// `(createdAt, id)` ascending ordering of the shell snapshot.

interface ListCursorOrder {
  readonly createdAt: string;
  readonly id: string;
}

type ListCursorKind = "projects" | "threads";

const LIST_CURSOR_PREFIX = "acp1.";

const encodeListCursor = (kind: ListCursorKind, after: ListCursorOrder): string =>
  `${LIST_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, kind, after }), "utf8").toString("base64url")}`;

const decodeListCursor = (kind: ListCursorKind, cursor: string): ListCursorOrder | null => {
  if (!cursor.startsWith(LIST_CURSOR_PREFIX)) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor.slice(LIST_CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    if (typeof decoded !== "object" || decoded === null) return null;
    const record = decoded as Record<string, unknown>;
    const after = record.after as Record<string, unknown> | undefined;
    if (
      record.v !== 1 ||
      record.kind !== kind ||
      typeof after?.createdAt !== "string" ||
      typeof after?.id !== "string"
    ) {
      return null;
    }
    return { createdAt: after.createdAt, id: after.id };
  } catch {
    return null;
  }
};

const compareOrder = (a: ListCursorOrder, b: ListCursorOrder): number =>
  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

interface ListPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | null;
}

export const paginate = <T>(input: {
  readonly kind: ListCursorKind;
  readonly rows: ReadonlyArray<T>;
  readonly order: (row: T) => ListCursorOrder;
  readonly limit: number;
  readonly cursor: string | undefined;
}): ListPage<T> | null => {
  let after: ListCursorOrder | null = null;
  if (input.cursor !== undefined) {
    after = decodeListCursor(input.kind, input.cursor);
    if (after === null) return null;
  }
  const sorted = input.rows.toSorted((a, b) => compareOrder(input.order(a), input.order(b)));
  const startFrom = after;
  const filtered =
    startFrom === null
      ? sorted
      : sorted.filter((row) => compareOrder(input.order(row), startFrom) > 0);
  const items = filtered.slice(0, input.limit);
  const last = items.at(-1);
  const nextCursor =
    filtered.length > input.limit && last !== undefined
      ? encodeListCursor(input.kind, input.order(last))
      : null;
  return { items, nextCursor };
};

// ── Result mapping ────────────────────────────────────────────────────

export const toThreadSummary = (shell: OrchestrationThreadShell): AgentControlMcpThreadSummary => ({
  threadId: shell.id,
  projectId: shell.projectId,
  title: shell.title,
  status: shell.session?.status ?? "idle",
  activeTurnId: shell.session?.activeTurnId ?? null,
  providerInstanceId: shell.session?.providerInstanceId ?? null,
  archived: shell.archivedAt !== null,
  createdAt: shell.createdAt,
  updatedAt: shell.updatedAt,
});

const toMcpMessage = (message: OrchestrationMessage): AgentControlMcpMessage => {
  const truncated = message.text.length > AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS;
  return {
    messageId: message.id,
    role: message.role,
    text: truncated
      ? message.text.slice(0, AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS)
      : message.text,
    truncated,
    turnId: message.turnId,
    attachmentCount: message.attachments?.length ?? 0,
    createdAt: message.createdAt,
  };
};

/**
 * Enforce the aggregate transcript budget over an ascending-order page.
 * Newest messages keep their text; once the budget is exhausted walking
 * backwards, older messages are truncated (possibly to empty) and
 * flagged. The message set itself is untouched, so history cursors stay
 * exact, and the bounded page can never blow the listener's response cap.
 */
const applyTranscriptTextBudget = (
  messages: ReadonlyArray<AgentControlMcpMessage>,
): ReadonlyArray<AgentControlMcpMessage> => {
  let remaining = AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS;
  const bounded = [...messages];
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const message = bounded[index]!;
    if (message.text.length <= remaining) {
      remaining -= message.text.length;
      continue;
    }
    bounded[index] = { ...message, text: message.text.slice(0, remaining), truncated: true };
    remaining = 0;
  }
  return bounded;
};

// Bound both arbitrary activity payloads and the aggregate response. Never stringify
// an unbounded payload first, and never return raw connection/session credentials.
export function sanitizeInspection(
  value: unknown,
  budget = { chars: 120_000, nodes: 5000 },
  depth = 0,
): unknown {
  if (budget.chars <= 0 || --budget.nodes <= 0 || depth > 12) return "[truncated]";
  if (typeof value === "string") {
    const text = redactDiagnosticText(
      String(redactAgentControlSecrets(value.slice(0, Math.min(12_000, budget.chars)))),
    );
    budget.chars -= text.length;
    return text.length < value.length ? `${text} [truncated or redacted]` : text;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => sanitizeInspection(item, budget, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        /^(?:authorization|headers|env|environment|credential|password|secret|accessToken|refreshToken|cookie|proof|ticket)$/i.test(
          key,
        )
          ? "[redacted]"
          : sanitizeInspection(item, budget, depth + 1),
      ]),
  );
}

// ── Reads ─────────────────────────────────────────────────────────────

/** Resolve a thread the caller may see, failing identically for hidden and missing threads. */
export const findVisibleThread = (
  projections: ProjectionSnapshotQueryShape,
  threadId: OrchestrationThreadShell["id"],
  visible: ThreadVisibility,
) =>
  projections.getThreadShellById(threadId).pipe(
    Effect.mapError(() => new ToolFailure("Thread read failed.")),
    Effect.flatMap((shell) =>
      Option.isSome(shell) && visible(shell.value)
        ? Effect.succeed(shell.value)
        : failTool("Thread not found."),
    ),
  );

export const listThreadsPage = (
  projections: ProjectionSnapshotQueryShape,
  input: AgentControlMcpListThreadsInput,
  visible: ThreadVisibility = allThreadsVisible,
) =>
  Effect.gen(function* () {
    const limit = clampLimit(
      input.limit,
      AGENT_CONTROL_MCP_LIST_LIMIT_DEFAULT,
      AGENT_CONTROL_MCP_LIST_LIMIT_MAX,
    );
    const snapshot = yield* projections
      .getShellSnapshot()
      .pipe(Effect.mapError(() => new ToolFailure("Thread list read failed.")));
    const rows = snapshot.threads.filter(
      (thread) =>
        visible(thread) &&
        (input.projectId === undefined || thread.projectId === input.projectId) &&
        (input.includeArchived === true || thread.archivedAt === null),
    );
    const page = paginate({
      kind: "threads",
      rows,
      order: (thread) => ({ createdAt: thread.createdAt, id: thread.id }),
      limit,
      cursor: input.cursor,
    });
    if (page === null) return yield* failTool("Invalid cursor.");
    return Schema.encodeSync(AgentControlMcpListThreadsResult)({
      threads: page.items.map(toThreadSummary),
      nextCursor: page.nextCursor,
    });
  });

export const readThreadPage = (
  projections: ProjectionSnapshotQueryShape,
  input: AgentControlMcpReadThreadInput,
  visible: ThreadVisibility = allThreadsVisible,
) =>
  Effect.gen(function* () {
    const limit = clampLimit(
      input.messageLimit,
      AGENT_CONTROL_MCP_MESSAGE_LIMIT_DEFAULT,
      AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX,
    );
    const shell = yield* findVisibleThread(projections, input.threadId, visible);

    const getThreadWindow = projections.getThreadWindow;
    const getThreadHistoryPage = projections.getThreadHistoryPage;
    if (getThreadWindow === undefined || getThreadHistoryPage === undefined) {
      return yield* failTool("Thread history is unavailable.");
    }

    const mapHistoryError = (error: { readonly _tag: string; readonly reason?: string }) =>
      error._tag === "OrchestrationThreadHistoryError"
        ? error.reason === "thread-not-found"
          ? new ToolFailure("Thread not found.")
          : new ToolFailure("Invalid or stale cursor.")
        : new ToolFailure("Thread read failed.");

    let messages: ReadonlyArray<OrchestrationMessage>;
    let pageInfo: OrchestrationThreadHistoryPageInfo;
    if (input.cursor === undefined) {
      const window = yield* getThreadWindow({
        threadId: input.threadId,
        limits: { messages: limit, proposedPlans: 1, activities: 1, checkpoints: 1 },
      }).pipe(Effect.mapError(mapHistoryError));
      messages = window.thread.messages;
      pageInfo = window.history.messages;
    } else {
      const cursor = Schema.decodeUnknownOption(OrchestrationThreadHistoryCursor)(input.cursor);
      if (Option.isNone(cursor)) return yield* failTool("Invalid or stale cursor.");
      const historyPage = yield* getThreadHistoryPage({
        threadId: input.threadId,
        collection: "messages",
        mode: { kind: "before", cursor: cursor.value },
        limit,
      }).pipe(Effect.mapError(mapHistoryError));
      if (historyPage.collection !== "messages") {
        return yield* failTool("Thread read failed.");
      }
      messages = historyPage.items;
      pageInfo = historyPage.page;
    }

    return Schema.encodeSync(AgentControlMcpReadThreadResult)({
      thread: toThreadSummary(shell),
      messages: applyTranscriptTextBudget(messages.map(toMcpMessage)),
      hasMoreBefore: pageInfo.hasMoreBefore,
      nextCursor: pageInfo.hasMoreBefore ? pageInfo.oldestCursor : null,
    });
  });

const WAIT_THREADS_TIMEOUT_MS_DEFAULT = 30_000;
const WAIT_THREADS_TIMEOUT_MS_MAX = 45_000;

const threadSettled = (thread: OrchestrationThreadShell): boolean =>
  thread.hasPendingApprovals ||
  thread.hasPendingUserInput ||
  (thread.session?.status !== "running" &&
    thread.session?.status !== "starting" &&
    !thread.backgroundLiveness &&
    thread.latestTurn?.state !== "running");

/**
 * Wait until any requested thread settles or needs attention. `access` runs
 * before every poll and yields the caller's current visibility, so a revoked
 * grant or disabled policy ends the wait instead of leaking later state.
 */
export const waitThreads = <E>(
  projections: ProjectionSnapshotQueryShape,
  input: typeof AgentControlWaitThreadsInput.Type,
  access: Effect.Effect<ThreadVisibility, E>,
) =>
  Effect.gen(function* () {
    const deadline =
      Date.now() +
      Math.min(input.timeoutMs ?? WAIT_THREADS_TIMEOUT_MS_DEFAULT, WAIT_THREADS_TIMEOUT_MS_MAX);
    const ids = [...new Set(input.threadIds)];
    while (true) {
      const visible = yield* access;
      const states = yield* Effect.forEach(ids, (id) => projections.getThreadShellById(id), {
        concurrency: 4,
      });
      const ready = states.some(
        (state) => Option.isNone(state) || !visible(state.value) || threadSettled(state.value),
      );
      if (ready || Date.now() >= deadline) {
        const threads = yield* Effect.forEach(
          ids,
          (threadId) =>
            readThreadPage(projections, { threadId, messageLimit: 5 }, visible).pipe(
              Effect.match({
                onFailure: (failure) => ({
                  threadId,
                  error: [{ type: "text" as const, text: failure.reason }],
                }),
                onSuccess: (result) => ({ threadId, result }),
              }),
            ),
          { concurrency: 4 },
        );
        return { timedOut: !ready, threads };
      }
      yield* Effect.sleep(Math.min(500, Math.max(1, deadline - Date.now())));
    }
  });

export interface InspectThreadDeps {
  readonly projections: ProjectionSnapshotQueryShape;
  readonly terminals?: TerminalManagerShape;
}

export const inspectThread = (
  deps: InspectThreadDeps,
  input: typeof AgentControlInspectThreadInput.Type,
  visible: ThreadVisibility = allThreadsVisible,
) =>
  Effect.gen(function* () {
    const thread = yield* findVisibleThread(deps.projections, input.threadId, visible);
    if (input.section === "info")
      return {
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        tokenMode: thread.tokenMode,
        envMode: thread.worktreeId ? "worktree" : "local",
        worktreeId: thread.worktreeId,
        branch: thread.branch,
        latestTurn: thread.latestTurn,
        goal: thread.goal,
        status: thread.session?.status ?? "idle",
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
        backgroundLiveness: thread.backgroundLiveness,
        archivedAt: thread.archivedAt,
        updatedAt: thread.updatedAt,
      };
    if (input.section === "terminals") {
      if (!deps.terminals) return yield* failTool("Terminal inspection unavailable.");
      const terminals = yield* deps.terminals.listSessions;
      return {
        terminals: terminals
          .filter((t) => t.threadId === input.threadId)
          .slice(0, 10)
          .map((t) => ({
            terminalId: t.terminalId,
            status: t.status,
            history: t.history.slice(-12_000),
            truncated: t.history.length > 12_000,
            exitCode: t.exitCode,
            updatedAt: t.updatedAt,
          })),
      };
    }
    const collection =
      input.section === "plans"
        ? "proposedPlans"
        : input.section === "review"
          ? "checkpoints"
          : "activities";
    const limit = input.limit ?? 50;
    if (!deps.projections.getThreadWindow || !deps.projections.getThreadHistoryPage)
      return yield* failTool("History unavailable.");
    const page = input.cursor
      ? yield* deps.projections.getThreadHistoryPage({
          threadId: input.threadId,
          collection,
          mode: { kind: "before", cursor: input.cursor },
          limit,
        })
      : yield* deps.projections
          .getThreadWindow({
            threadId: input.threadId,
            limits: {
              messages: 1,
              proposedPlans: collection === "proposedPlans" ? limit : 1,
              checkpoints: collection === "checkpoints" ? limit : 1,
              activities: collection === "activities" ? limit : 1,
            },
          })
          .pipe(
            Effect.map((window) => ({
              collection,
              items: window.thread[collection],
              page: window.history[collection],
            })),
          );
    const items =
      input.section === "agents"
        ? deriveThreadSubagents(
            // The selected collection is always activities for agent inspection.
            Schema.decodeUnknownSync(Schema.Array(OrchestrationThreadActivity))(page.items),
            {
              sessionLive: thread.session?.status === "running",
              parentTurnState: thread.latestTurn?.state ?? null,
            },
          )
        : page.items;
    return {
      section: input.section,
      items,
      hasMoreBefore: page.page.hasMoreBefore,
      nextCursor: page.page.hasMoreBefore ? page.page.oldestCursor : null,
      partial: page.page.hasMoreBefore || input.cursor !== undefined,
    };
  });

export const readThreadDiff = (
  deps: {
    readonly projections: ProjectionSnapshotQueryShape;
    readonly diffs?: CheckpointDiffQueryShape;
  },
  input: typeof AgentControlReadDiffInput.Type,
  visible: ThreadVisibility = allThreadsVisible,
) =>
  Effect.gen(function* () {
    if (!deps.diffs) return yield* failTool("Review service unavailable.");
    yield* findVisibleThread(deps.projections, input.threadId, visible);
    return yield* deps.diffs.getFullThreadDiff(input);
  });

export const readThreadFile = (
  deps: {
    readonly projections: ProjectionSnapshotQueryShape;
    readonly files?: WorkspaceFileSystemShape;
    readonly workspaceAccess?: WorkspaceAccessPolicyShape;
  },
  input: { readonly threadId: OrchestrationThreadShell["id"]; readonly relativePath: string },
  visible: ThreadVisibility = allThreadsVisible,
) =>
  Effect.gen(function* () {
    if (!deps.files || !deps.workspaceAccess) return yield* failTool("File service unavailable.");
    const thread = yield* findVisibleThread(deps.projections, input.threadId, visible);
    const project = yield* deps.projections.getProjectShellById(thread.projectId);
    if (Option.isNone(project)) return yield* failTool("Project not found.");
    const cwd = yield* deps.workspaceAccess.assertExistingPath({
      path: thread.worktreePath ?? project.value.workspaceRoot,
      operation: "Agent Control file read",
    });
    return yield* deps.files.readFile({ cwd, relativePath: input.relativePath });
  });

/** Project preferences and revision. Workspace paths and credentials are omitted. */
export const toProjectPreferences = (project: OrchestrationProjectShell) => ({
  projectId: project.id,
  title: project.title,
  updatedAt: project.updatedAt,
  customSystemPrompt: project.customSystemPrompt,
  scripts: project.scripts,
  preferredRemoteName: project.preferredRemoteName,
});
