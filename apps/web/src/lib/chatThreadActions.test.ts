import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveThreadActionProjectRef,
  startNewChatFromContext,
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    defaultThreadEnvMode: "local",
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("prefers the active draft thread project when resolving thread actions", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
          envMode: "worktree",
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the default project ref when there is no active thread context", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("starts a contextual new thread from the active draft thread", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
          envMode: "worktree",
        },
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: "feature/refactor",
      worktreePath: "/tmp/worktree",
      envMode: "worktree",
    });
  });

  it("lets the target node resolve project defaults for a plain new thread", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewLocalThreadFromContext(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        defaultThreadEnvMode: "worktree",
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {});
  });

  it("inherits the project's defaults when the contextual action has no active thread", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    await startNewThreadFromContext(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        handleNewThread,
      }),
    );
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {});
  });

  it("does not start a thread when there is no project context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
  });

  it("falls back to a chat draft when there is no project at all", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    const handleNewChat = vi.fn(async (_environmentId: EnvironmentId) => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
        handleNewChat,
        chatTarget: { environmentId: ENVIRONMENT_ID },
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewChat).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect(handleNewThread).not.toHaveBeenCalled();
  });

  it("starts another chat instead of a second thread in the active chat", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    const handleNewChat = vi.fn(async (_environmentId: EnvironmentId) => {});
    const context = createContext({
      activeThread: {
        environmentId: ENVIRONMENT_ID,
        projectId: ProjectId.make("chat-project"),
        branch: null,
        worktreePath: null,
      },
      activeContextIsChat: true,
      handleNewThread,
      handleNewChat,
      chatTarget: { environmentId: ENVIRONMENT_ID },
    });

    expect(await startNewLocalThreadFromContext(context)).toBe(true);
    expect(handleNewChat).toHaveBeenCalledTimes(1);
    expect(handleNewThread).not.toHaveBeenCalled();
    // Without chats the default project takes over, never the chat's own project.
    expect(resolveThreadActionProjectRef(context)).toEqual(
      scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    );
  });

  it("starts a chat only when chats are available", async () => {
    const handleNewChat = vi.fn(async (_environmentId: EnvironmentId) => {});
    expect(await startNewChatFromContext(createContext({ handleNewChat, chatTarget: null }))).toBe(
      false,
    );
    expect(handleNewChat).not.toHaveBeenCalled();
  });
});
