import type { StaticScreenProps } from "@react-navigation/native";
import { useCallback } from "react";

import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";

import { ThreadDetailScreen } from "../threads/ThreadDetailScreen";
import {
  useRegisterThreadWorkspaceInspector,
  useThreadWorkspaceLayout,
} from "../workspace/ThreadWorkspaceLayout";
import { ThreadFilesScreen } from "./ThreadFilesScreen";

type ThreadFilesRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function ThreadFilesRouteScreen(props: ThreadFilesRouteScreenProps) {
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const threadIdRaw = firstParam(props.route.params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = threadIdRaw ? ThreadId.make(threadIdRaw) : null;
  const { inspector } = useThreadWorkspaceLayout();
  const renderInspector = useCallback(
    () =>
      environmentId !== null && threadId !== null ? (
        <ThreadFilesScreen
          environmentId={environmentId}
          threadId={threadId}
          presentation="inspector"
        />
      ) : null,
    [environmentId, threadId],
  );
  useRegisterThreadWorkspaceInspector(
    "files",
    inspector.supported ? renderInspector : undefined,
    "Workspace files",
  );

  if (environmentId === null || threadId === null) return null;

  // Opening Files on a regular-width window reveals the browser beside the
  // task. Compact windows keep the original full-screen drill-in route.
  if (inspector.supported) {
    return <ThreadDetailScreen environmentId={environmentId} threadId={threadId} />;
  }

  return <ThreadFilesScreen environmentId={environmentId} threadId={threadId} />;
}
