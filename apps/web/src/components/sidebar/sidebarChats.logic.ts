import { scopedProjectKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadSortOrder } from "@ryco/contracts";
import { isChatProject, type ProjectKindCarrier } from "@ryco/shared/projectKind";

import { type DraftId, type DraftThreadState, isPendingChatDraft } from "../../composerDraftStore";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_INTERACTION_MODE,
  type SidebarThreadSummary,
} from "../../types";
import { sortThreadsWithPinned } from "../Sidebar.logic";

/** Title of an unsent chat draft row. */
export const NEW_CHAT_DRAFT_TITLE = "New chat";

/** One row of the sidebar's Chats section: a chat's thread, or an unsent chat draft. */
export type SidebarChatRow = SidebarThreadSummary & { readonly draftId?: DraftId | undefined };

type ChatProjectLike = ProjectKindCarrier & {
  readonly id: SidebarThreadSummary["projectId"];
  readonly environmentId: SidebarThreadSummary["environmentId"];
};

function draftChatRow(draftId: DraftId, draft: DraftThreadState): SidebarChatRow {
  return {
    id: draft.threadId,
    environmentId: draft.environmentId,
    projectId: draft.projectId,
    title: NEW_CHAT_DRAFT_TITLE,
    interactionMode: draft.interactionMode ?? DEFAULT_INTERACTION_MODE,
    tokenMode: draft.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    session: null,
    createdAt: draft.createdAt,
    updatedAt: draft.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    draftId,
  };
}

const chatProjectKey = (project: ChatProjectLike) =>
  scopedProjectKey({ environmentId: project.environmentId, projectId: project.id });

/** Scoped keys of the chat projects among `projects`. */
export function collectChatProjectKeys(
  projects: ReadonlyArray<ChatProjectLike>,
): ReadonlySet<string> {
  return new Set(projects.filter(isChatProject).map(chatProjectKey));
}

/**
 * Keys of the chats (as of `previousChatKeys`) that are projects now: "Turn
 * into project…" re-points the same project, so its row leaves the Chats
 * section and enters the project tree in one update. A chat that went away is
 * not one of them.
 */
export function chatsTurnedIntoProjects(
  previousChatKeys: ReadonlySet<string>,
  projects: ReadonlyArray<ChatProjectLike>,
): string[] {
  if (previousChatKeys.size === 0) return [];
  return projects
    .filter((project) => !isChatProject(project))
    .map(chatProjectKey)
    .filter((key) => previousChatKeys.has(key));
}

/**
 * Rows of the Chats section: unsent chat drafts first (newest first), then the
 * unarchived threads of every chat project in the user's thread order (pinned
 * first). A chat normally has one thread, but extra threads in a chat project
 * (created elsewhere, e.g. by Agent Control) each get their own row.
 */
export function buildSidebarChatRows(input: {
  readonly projects: ReadonlyArray<ChatProjectLike>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly draftThreadsByThreadKey: Readonly<Record<string, DraftThreadState>>;
  readonly sortOrder: SidebarThreadSortOrder;
  readonly pinnedThreadKeys: ReadonlySet<string>;
}): SidebarChatRow[] {
  const chatProjectKeys = collectChatProjectKeys(input.projects);
  const threadKey = (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const chatThreads = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      chatProjectKeys.has(
        scopedProjectKey({ environmentId: thread.environmentId, projectId: thread.projectId }),
      ),
  );
  const serverThreadKeys = new Set(chatThreads.map(threadKey));
  const drafts = Object.entries(input.draftThreadsByThreadKey)
    .filter(
      ([, draft]) =>
        isPendingChatDraft(draft) &&
        draft.promotedTo == null &&
        // A draft whose thread already exists is mid-promotion; show the thread.
        !serverThreadKeys.has(
          threadKey({ environmentId: draft.environmentId, id: draft.threadId }),
        ),
    )
    .map(([draftId, draft]) => draftChatRow(draftId as DraftId, draft))
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  return [
    ...drafts,
    ...sortThreadsWithPinned({
      threads: chatThreads,
      sortOrder: input.sortOrder,
      pinnedThreadKeys: input.pinnedThreadKeys,
      getThreadKey: threadKey,
    }),
  ];
}
