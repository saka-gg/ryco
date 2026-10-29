import type { StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useCallback, useEffect, useMemo } from "react";

import { useHomeWorkspaceData } from "../../state/homeData";
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
  const cwd = useThreadWorkspaceRoot({ thread, worktree, project });
  const worktreePath = worktree?.worktreePath ?? thread?.worktreePath ?? null;
  const { inspector } = useThreadWorkspaceLayout();

  const renderInspector = useCallback(
    () => (
      <ThreadTerminalScreen
        environmentId={environmentId}
        threadId={threadId}
        cwd={cwd}
        worktreePath={worktreePath}
      />
    ),
    [cwd, environmentId, threadId, worktreePath],
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
    />
  );
}
