import type { StaticScreenProps } from "@react-navigation/native";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { resolveThreadTerminalLaunch } from "@ryco/client-runtime/state/terminal";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useCallback, useEffect, useMemo } from "react";

import { useHomeWorkspaceData } from "../../state/homeData";
import { useTerminalStateStore } from "../../state/terminalStateStore";
import {
  selectEnvironmentState,
  selectProjectByRef,
  selectThreadByRef,
  useStore,
} from "../../state/threadsRuntime";
import { useThreadWorkspaceRoot } from "../files/useThreadWorkspaceRoot";
import { ThreadDetailScreen } from "../threads/ThreadDetailScreen";
import { findThreadWorktree } from "../threads/threadHeaderModel";
import {
  useRegisterThreadWorkspaceInspector,
  useThreadWorkspaceLayout,
} from "../workspace/ThreadWorkspaceLayout";
import { parseTerminalRouteParams } from "./terminalRouteParams";
import { ThreadTerminalScreen } from "./ThreadTerminalScreen";

type ThreadTerminalRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/**
 * `threads/:environmentId/:threadId/terminal`. A phone pushes the terminal as
 * its own screen; a regular-width window shows it in the workspace inspector
 * beside the conversation.
 */
export function ThreadTerminalRouteScreen(props: ThreadTerminalRouteScreenProps) {
  const params = parseTerminalRouteParams(props.route.params);
  if (params === null) return null;
  return (
    <ResolvedThreadTerminalRoute
      key={`${params.environmentId}\u0000${params.threadId}`}
      environmentId={params.environmentId}
      threadId={params.threadId}
    />
  );
}

function ResolvedThreadTerminalRoute(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  // A cold deep link drives the supervisor onto this node, as the thread screen does.
  useEffect(() => {
    useStore.getState().setActiveEnvironmentId(environmentId);
  }, [environmentId]);

  const thread = useStore((state) =>
    selectThreadByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  const project = useStore((state) =>
    thread
      ? (selectProjectByRef(state, scopeProjectRef(environmentId, thread.projectId)) ?? null)
      : null,
  );
  const bootstrapComplete = useStore(
    (state) => selectEnvironmentState(state, environmentId).bootstrapComplete,
  );
  const { worktrees } = useHomeWorkspaceData();
  const worktree = useMemo(
    () => (thread ? findThreadWorktree(thread, worktrees) : null),
    [thread, worktrees],
  );
  const workspaceRoot = useThreadWorkspaceRoot({ thread, worktree, project });
  const threadWorktreePath = worktree?.worktreePath ?? thread?.worktreePath ?? null;
  const projectCwd = project?.cwd ?? null;
  // Where the thread's shells start, resolved exactly like the desktop: the node relaunches a
  // live shell (and wipes its history) when an open names another cwd or environment, and a
  // shell's reported launch context wins over the thread's current worktree.
  const launchContext = useTerminalStateStore(
    (state) =>
      state.terminalLaunchContextByThreadKey[
        scopedThreadKey(scopeThreadRef(environmentId, threadId))
      ] ?? null,
  );
  const launch = useMemo(
    () => resolveThreadTerminalLaunch({ projectCwd, threadWorktreePath, launchContext }),
    [launchContext, projectCwd, threadWorktreePath],
  );
  const cwd = launch ? launch.cwd : workspaceRoot;
  const worktreePath = launch ? launch.worktreePath : threadWorktreePath;
  const runtimeEnv = launch ? launch.runtimeEnv : null;
  const { inspector } = useThreadWorkspaceLayout();

  const renderInspector = useCallback(
    () => (
      <ThreadTerminalScreen
        environmentId={environmentId}
        threadId={threadId}
        cwd={cwd}
        worktreePath={worktreePath}
        runtimeEnv={runtimeEnv}
      />
    ),
    [cwd, environmentId, runtimeEnv, threadId, worktreePath],
  );
  useRegisterThreadWorkspaceInspector(
    "terminal",
    inspector.supported ? renderInspector : undefined,
    "Terminal",
  );

  // Until the shell lists the thread, its workspace is unknown, not missing.
  if (!thread && !bootstrapComplete) return null;
  if (inspector.supported) {
    return <ThreadDetailScreen environmentId={environmentId} threadId={threadId} />;
  }
  return (
    <ThreadTerminalScreen
      environmentId={environmentId}
      threadId={threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
    />
  );
}
