import {
  CHAT_PROJECT_TITLE_MAX_CHARS,
  type EnvironmentId,
  type OrchestrationDispatchCommandErrorReason,
  type ProjectId,
  type ScopedProjectRef,
  type ServerChatsCapability,
  type ServerChatsUnavailableReason,
} from "@ryco/contracts";
import { isChatProject, type ProjectKindCarrier } from "@ryco/shared/projectKind";

/**
 * "No project" chats: a thread whose project is a Ryco-managed folder the
 * server allocates on first send. Until then the draft targets a
 * client-generated project id that does not exist anywhere yet (`pendingChat`).
 * These helpers are platform-neutral so web and mobile share one model.
 */

/** Label shown wherever a chat stands in for a project (headline, pickers, inbox). */
export const CHAT_PROJECT_LABEL = "No project";

/** The workspace a chat thread works in: one plain folder, never a worktree or branch. */
export const CHAT_WORKSPACE_LABEL = "Chat folder";

/**
 * How a thread's project is named where it says where the thread lives
 * (inbox, archive, Trash): a chat's project is its folder, not something to
 * name, so it reads "No project" instead of `projectTitle`.
 */
export function projectPlaceLabel(
  project: ProjectKindCarrier | null | undefined,
  projectTitle: string,
): string {
  return isChatProject(project) ? CHAT_PROJECT_LABEL : projectTitle;
}

/**
 * The project name shown for a thread (inbox rows, thread headers): "No
 * project" for a chat, else the project's name. `fallback` covers an unknown
 * project or an empty name.
 */
export function projectDisplayLabel(
  project: (ProjectKindCarrier & { readonly name: string }) | null | undefined,
  fallback: string,
): string {
  return projectPlaceLabel(project, project?.name.trim() || fallback);
}

/** Prefix of a chat draft's logical-project key; never a scoped project key. */
export const CHAT_DRAFT_LOGICAL_PROJECT_KEY_PREFIX = "chat:";

/** Each chat is its own logical project, keyed by its (client-generated) project id. */
export function chatDraftLogicalProjectKey(projectId: ProjectId): string {
  return `${CHAT_DRAFT_LOGICAL_PROJECT_KEY_PREFIX}${projectId}`;
}

export function isChatDraftLogicalProjectKey(logicalProjectKey: string): boolean {
  return logicalProjectKey.trim().startsWith(CHAT_DRAFT_LOGICAL_PROJECT_KEY_PREFIX);
}

/** Retarget input that turns a draft into a "No project" chat draft. */
export interface ChatDraftTarget {
  readonly projectRef: ScopedProjectRef;
  readonly logicalProjectKey: string;
  readonly pendingChat: true;
}

export function buildChatDraftTarget(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ChatDraftTarget {
  return {
    projectRef: { environmentId, projectId },
    logicalProjectKey: chatDraftLogicalProjectKey(projectId),
    pendingChat: true,
  };
}

/**
 * Whether a first send failed because the node retired the chat draft's
 * project id (`chat-project-retired`), for example after startup cleanup
 * removed an unused chat. Nothing was created and that id can never be used
 * again, so the draft needs a fresh one. Reads the error's tag and reason only,
 * never its message; nodes that predate the reason fail with a plain message.
 */
export function isChatProjectRetiredError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { _tag, reason } = error as { readonly _tag?: unknown; readonly reason?: unknown };
  return (
    _tag === "OrchestrationDispatchCommandError" &&
    reason === ("chat-project-retired" satisfies OrchestrationDispatchCommandErrorReason)
  );
}

export type ChatsAvailability =
  | { readonly available: true; readonly root: string | null }
  | {
      readonly available: false;
      readonly reason: ServerChatsUnavailableReason | "unsupported";
      /** Short, user-facing explanation suitable for a tooltip or settings status. */
      readonly message: string;
    };

const CHATS_UNAVAILABLE_COPY: Record<ServerChatsUnavailableReason | "unsupported", string> = {
  unsupported: "This device does not support chats without a project yet.",
  "inside-git-repository":
    "The chats folder is inside a Git repository. Choose a chats folder outside any repository in Settings.",
  "root-unavailable": "The chats folder cannot be created. Check the chats folder in Settings.",
  restricted: "This device only allows work inside its workspace folder.",
};

export function describeChatsUnavailableReason(
  reason: ServerChatsUnavailableReason | "unsupported" | undefined,
): string {
  return CHATS_UNAVAILABLE_COPY[reason ?? "unsupported"];
}

/**
 * Reads a node's chat capability. Absence means the node predates chats, so
 * every chat entry point stays hidden; an unavailable node keeps its reason.
 */
export function resolveChatsAvailability(
  config: { readonly chats?: ServerChatsCapability | undefined } | null | undefined,
): ChatsAvailability {
  const chats = config?.chats;
  if (!chats) {
    return {
      available: false,
      reason: "unsupported",
      message: describeChatsUnavailableReason("unsupported"),
    };
  }
  if (chats.available) return { available: true, root: chats.root ?? null };
  const reason = chats.unavailableReason ?? "root-unavailable";
  return { available: false, reason, message: describeChatsUnavailableReason(reason) };
}

/**
 * The server's chat title (and folder name) seed: the first message's title,
 * trimmed and bounded like the contract. Null when nothing usable remains.
 */
export function resolveChatProjectTitleSeed(text: string): string | null {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= CHAT_PROJECT_TITLE_MAX_CHARS) return collapsed;
  let end = CHAT_PROJECT_TITLE_MAX_CHARS;
  // Never split a surrogate pair at the cut.
  const lastCode = collapsed.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  return collapsed.slice(0, end).trimEnd();
}
