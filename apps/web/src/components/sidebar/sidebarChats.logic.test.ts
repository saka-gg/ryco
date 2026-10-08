import { scopedProjectKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftThreadState } from "../../composerDraftStore";
import type { SidebarThreadSummary } from "../../types";
import {
  buildSidebarChatRows,
  chatsTurnedIntoProjects,
  collectChatProjectKeys,
  NEW_CHAT_DRAFT_TITLE,
} from "./sidebarChats.logic";

const ENV = EnvironmentId.make("environment-local");
const PROJECT = ProjectId.make("project-1");
const CHAT_A = ProjectId.make("chat-a");
const CHAT_B = ProjectId.make("chat-b");
const PENDING_CHAT = ProjectId.make("chat-pending");

const projects = [
  { id: PROJECT, environmentId: ENV, kind: "project" as const },
  { id: CHAT_A, environmentId: ENV, kind: "chat" as const },
  { id: CHAT_B, environmentId: ENV, kind: "chat" as const },
];

function thread(
  id: string,
  projectId: ProjectId,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: ENV,
    projectId,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function chatDraft(threadId: string, overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    threadId: ThreadId.make(threadId),
    environmentId: ENV,
    projectId: PENDING_CHAT,
    logicalProjectKey: `chat:${PENDING_CHAT}`,
    createdAt: "2026-10-08T12:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    pendingChat: true,
    ...overrides,
  };
}

describe("buildSidebarChatRows", () => {
  it("lists unsent chat drafts first, then chat threads newest first, never project threads", () => {
    const rows = buildSidebarChatRows({
      projects,
      threads: [
        thread("older-chat", CHAT_A, { latestUserMessageAt: "2026-10-08T09:00:00.000Z" }),
        thread("newer-chat", CHAT_B, { latestUserMessageAt: "2026-10-08T11:00:00.000Z" }),
        thread("project-thread", PROJECT),
        thread("archived-chat", CHAT_A, { archivedAt: "2026-10-08T11:30:00.000Z" }),
      ],
      draftThreadsByThreadKey: {
        "draft-chat": chatDraft("draft-thread"),
        "draft-project": chatDraft("project-draft-thread", {
          projectId: PROJECT,
          logicalProjectKey: "environment-local:project-1",
          pendingChat: false,
        }),
      },
      sortOrder: "updated_at",
      pinnedThreadKeys: new Set(),
    });

    expect(rows.map((row) => row.title)).toEqual([
      NEW_CHAT_DRAFT_TITLE,
      "newer-chat",
      "older-chat",
    ]);
    expect(rows[0]?.draftId).toBe("draft-chat");
  });

  it("keeps extra threads of one chat project as separate rows and pins first", () => {
    const pinned = thread("pinned", CHAT_A, { latestUserMessageAt: "2026-10-08T08:00:00.000Z" });
    const rows = buildSidebarChatRows({
      projects,
      threads: [
        thread("second", CHAT_A, { latestUserMessageAt: "2026-10-08T11:00:00.000Z" }),
        pinned,
      ],
      draftThreadsByThreadKey: {},
      sortOrder: "updated_at",
      pinnedThreadKeys: new Set([scopedThreadKey(scopeThreadRef(ENV, pinned.id))]),
    });
    expect(rows.map((row) => row.title)).toEqual(["pinned", "second"]);
  });

  it("drops a draft once its thread exists or while it is being promoted", () => {
    const rows = buildSidebarChatRows({
      projects,
      threads: [thread("sent", CHAT_A)],
      draftThreadsByThreadKey: {
        sent: chatDraft("sent", { projectId: CHAT_A }),
        promoting: chatDraft("promoting", {
          promotedTo: scopeThreadRef(ENV, ThreadId.make("promoting")),
        }),
      },
      sortOrder: "updated_at",
      pinnedThreadKeys: new Set(),
    });
    expect(rows.map((row) => row.title)).toEqual(["sent"]);
  });
});

describe("chats turned into projects", () => {
  const key = (projectId: ProjectId) => scopedProjectKey({ environmentId: ENV, projectId });

  it("collects the chat projects' keys", () => {
    expect([...collectChatProjectKeys(projects)]).toEqual([key(CHAT_A), key(CHAT_B)]);
  });

  it("names a chat whose project now is a project, and nothing else", () => {
    const before = collectChatProjectKeys(projects);
    const after = [
      { id: PROJECT, environmentId: ENV, kind: "project" as const },
      // Turned into a project: the same project id, now of kind "project".
      { id: CHAT_A, environmentId: ENV, kind: "project" as const },
      { id: CHAT_B, environmentId: ENV, kind: "chat" as const },
    ];
    expect(chatsTurnedIntoProjects(before, after)).toEqual([key(CHAT_A)]);
    // A deleted chat did not become anything; an unchanged list names nothing.
    expect(chatsTurnedIntoProjects(before, [projects[0]!])).toEqual([]);
    expect(chatsTurnedIntoProjects(before, projects)).toEqual([]);
    expect(chatsTurnedIntoProjects(new Set(), after)).toEqual([]);
  });
});
