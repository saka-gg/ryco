import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_THREAD_DRAFT,
  type ComposerThreadDraftState,
  type DraftThreadState,
} from "../../composerDraftStore";
import { createInboxDraftsSelector, inboxDraftTitle } from "./inboxDrafts";

const ENV = EnvironmentId.make("machine-a");

function session(id: string, overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    threadId: ThreadId.make(`thread-${id}`),
    environmentId: ENV,
    projectId: ProjectId.make("project-a"),
    logicalProjectKey: "machine-a:project-a",
    createdAt: "2026-11-02T09:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    envMode: "local",
    ...overrides,
  };
}

function composer(overrides: Partial<ComposerThreadDraftState> = {}): ComposerThreadDraftState {
  return { ...EMPTY_THREAD_DRAFT, ...overrides } as ComposerThreadDraftState;
}

describe("inboxDraftTitle", () => {
  it("takes the prompt's first non-blank line, capped", () => {
    expect(inboxDraftTitle("\n  Fix the login flow  \nand the tests")).toBe("Fix the login flow");
    expect(inboxDraftTitle("x".repeat(200))).toHaveLength(80);
  });

  it("falls back when the prompt has no text", () => {
    expect(inboxDraftTitle("")).toBe("New thread");
    expect(inboxDraftTitle(" \n\t")).toBe("New thread");
  });
});

describe("createInboxDraftsSelector", () => {
  it("lists drafts holding text, files or pull requests, skipping empty and sent ones", () => {
    const select = createInboxDraftsSelector();
    const drafts = select({
      draftThreadsByThreadKey: {
        text: session("text"),
        files: session("files"),
        pr: session("pr"),
        empty: session("empty"),
        settingsOnly: session("settings-only"),
        sent: session("sent", {
          promotedTo: { environmentId: ENV, threadId: ThreadId.make("thread-sent") },
        }),
        chat: session("chat", { pendingChat: true }),
      },
      draftsByThreadKey: {
        text: composer({ prompt: "Hello" }),
        files: composer({ fileReferences: [{} as never] }),
        pr: composer({ sourceControlContexts: [{} as never] }),
        empty: composer(),
        sent: composer({ prompt: "Sent already" }),
        chat: composer({ prompt: "A question" }),
      },
    });
    expect(drafts.map((draft) => [draft.draftId, draft.title, draft.isChat])).toEqual([
      ["text", "Hello", false],
      ["files", "New thread", false],
      ["pr", "New thread", false],
      ["chat", "A question", true],
    ]);
  });

  it("keeps its result while typing leaves every title as it was", () => {
    const select = createInboxDraftsSelector();
    const draftThreadsByThreadKey = { a: session("a") };
    const first = select({
      draftThreadsByThreadKey,
      draftsByThreadKey: { a: composer({ prompt: "Title\nbody" }) },
    });
    const typed = select({
      draftThreadsByThreadKey,
      draftsByThreadKey: { a: composer({ prompt: "Title\nbody, longer" }) },
    });
    expect(typed).toBe(first);
    const retitled = select({
      draftThreadsByThreadKey,
      draftsByThreadKey: { a: composer({ prompt: "Title 2\nbody, longer" }) },
    });
    expect(retitled).not.toBe(first);
    expect(retitled[0]?.title).toBe("Title 2");
    const cleared = select({ draftThreadsByThreadKey, draftsByThreadKey: { a: composer() } });
    expect(cleared).toEqual([]);
  });
});
