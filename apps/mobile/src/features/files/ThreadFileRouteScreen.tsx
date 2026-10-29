import type { StaticScreenProps } from "@react-navigation/native";
import { useCallback } from "react";

import { routeFilePathParam, routeLineParam } from "@ryco/client-runtime/state/files";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";

import {
  useRegisterThreadWorkspaceInspector,
  useThreadWorkspaceLayout,
} from "../workspace/ThreadWorkspaceLayout";
import { ThreadFileScreen } from "./ThreadFileScreen";
import { ThreadFilesScreen } from "./ThreadFilesScreen";

/**
 * `path` arrives as the `:path*` segment array (already percent-decoded) on a
 * deep link and as the array the browser pushed on an in-app navigation, so it
 * is rejoined and re-normalized rather than trusted. `line` is a query param and
 * only means anything as a positive integer.
 */
type ThreadFileRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly path: string | readonly string[];
  readonly line?: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function ThreadFileRouteScreen(props: ThreadFileRouteScreenProps) {
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const threadIdRaw = firstParam(props.route.params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = threadIdRaw ? ThreadId.make(threadIdRaw) : null;
  const path = routeFilePathParam(props.route.params.path);
  const line = routeLineParam(props.route.params.line);
  const { inspector } = useThreadWorkspaceLayout();
  const renderInspector = useCallback(
    () =>
      environmentId !== null && threadId !== null ? (
        <ThreadFilesScreen
          environmentId={environmentId}
          threadId={threadId}
          presentation="inspector"
          selectedPath={path}
        />
      ) : null,
    [environmentId, path, threadId],
  );
  useRegisterThreadWorkspaceInspector(
    "files",
    inspector.supported ? renderInspector : undefined,
    "Workspace files",
  );

  if (environmentId === null || threadId === null) return null;

  return (
    <ThreadFileScreen environmentId={environmentId} threadId={threadId} path={path} line={line} />
  );
}
