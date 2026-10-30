import type { ArchivedThreadStub, SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { LOCAL_ENV, RYCO_LOCAL, fixtureThread } from "../../projects/testing/projectFixtures";
import {
  heartbeatChatChoices,
  heartbeatChatMatches,
  heartbeatChatWords,
} from "./heartbeatChats.logic";

const chat = (id: string, title: string, at: string, archivedAt: string | null = null) =>
  fixtureThread({
    id,
    environmentId: LOCAL_ENV,
    projectId: RYCO_LOCAL,
    title,
    updatedAt: at,
    overrides: { archivedAt },
  });

const stub = (id: string, title: string): ArchivedThreadStub => ({
  shellDetail: "archived-stub",
  id: id as ThreadId,
  environmentId: "env" as EnvironmentId,
  projectId: "project" as ProjectId,
  title,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
  archivedAt: "2026-10-02T09:00:00.000Z",
  branch: null,
  worktreePath: null,
  worktreeId: null,
  latestUserMessageAt: null,
  lineage: null,
});

const threads: SidebarThreadOrStub[] = [
  chat("thread-old", "Old idea", "2026-10-01T09:00:00.000Z"),
  chat("thread-ci", "Fix CI flakes", "2026-10-03T09:00:00.000Z"),
  chat("thread-gone", "Shelved", "2026-10-04T09:00:00.000Z", "2026-10-05T09:00:00.000Z"),
  chat("thread-blank", "  ", "2026-10-02T09:00:00.000Z"),
  stub("thread-stub", "Archived long ago"),
];

describe("a heartbeat's chat", () => {
  it("offers the project's open chats, the most recently active first", () => {
    expect(heartbeatChatChoices(threads)).toEqual([
      { threadId: "thread-ci", title: "Fix CI flakes" },
      { threadId: "thread-blank", title: "Untitled chat" },
      { threadId: "thread-old", title: "Old idea" },
    ]);
  });

  it("names the chosen chat, an archived one as archived, and one it can't find", () => {
    expect(heartbeatChatWords(threads, "thread-ci" as ThreadId)).toBe("Fix CI flakes");
    expect(heartbeatChatWords(threads, "thread-gone" as ThreadId)).toBe("Shelved (archived)");
    expect(heartbeatChatWords(threads, "thread-stub" as ThreadId)).toBe(
      "Archived long ago (archived)",
    );
    expect(heartbeatChatWords(threads, "thread-deleted" as ThreadId)).toBe("an unavailable chat");
  });

  it("finds a chat by the words of its title, in any case and order", () => {
    const ci = { threadId: "thread-ci" as ThreadId, title: "Fix CI flakes" };
    expect(heartbeatChatMatches(ci, "flakes")).toBe(true);
    expect(heartbeatChatMatches(ci, "FLAKES fix")).toBe(true);
    expect(heartbeatChatMatches(ci, "fix relay")).toBe(false);
  });
});
