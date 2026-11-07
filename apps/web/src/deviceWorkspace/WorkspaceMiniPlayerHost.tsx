import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { RefObject } from "react";

import { preloadableLazy, useLazyComponentReady } from "../lib/preloadableLazy";
import { notifySurfaceLoadFailure } from "../components/ui/surfaceLoadFailure";
import { deviceWorkspaceThreadKey } from "./deviceWorkspaceActions";
import { useWorkspaceMiniPlayerStore } from "./workspaceMiniPlayerStore";

// From the device panel's chunk; see `SimulatorPanel.tsx`.
const WorkspaceMiniPlayer = preloadableLazy(() =>
  import("../components/device/SimulatorPanel").then((module) => module.WorkspaceMiniPlayer),
);

/**
 * Where a thread's mini-player mounts in the chat column. Costs a store read
 * until something floats; the window and its content load then.
 */
export function WorkspaceMiniPlayerHost(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly composerRef?: RefObject<HTMLElement | null>;
  readonly onOpenDevicePanel: () => void;
}) {
  const threadKey = deviceWorkspaceThreadKey(props);
  const state = useWorkspaceMiniPlayerStore((store) => store.byThreadKey[threadKey]);
  const ready = useLazyComponentReady(WorkspaceMiniPlayer, state !== undefined, {
    onLoadError: (error, retry) => notifySurfaceLoadFailure("floating device", error, retry),
  });
  if (!state || !ready) return null;
  return (
    <WorkspaceMiniPlayer
      environmentId={props.environmentId}
      threadId={props.threadId}
      state={state}
      containerRef={props.containerRef}
      {...(props.composerRef ? { composerRef: props.composerRef } : {})}
      onOpenDevicePanel={props.onOpenDevicePanel}
    />
  );
}
