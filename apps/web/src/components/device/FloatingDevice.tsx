import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { RefObject } from "react";

import { selectThreadDeviceTabs, useDeviceTabsStore } from "../../deviceWorkspace/deviceTabsStore";
import {
  closeFloatingDevice,
  deviceWorkspaceThreadKey,
  dockFloatingDevice,
} from "../../deviceWorkspace/deviceWorkspaceActions";
import { CloseGlyph, DockGlyph } from "../../deviceWorkspace/miniPlayerGlyphs";
import { WorkspaceMiniPlayerFrame } from "../../deviceWorkspace/WorkspaceMiniPlayerFrame";
import {
  useWorkspaceMiniPlayerStore,
  workspaceMiniPlayerSourceKey,
  type WorkspaceMiniPlayerState,
} from "../../deviceWorkspace/workspaceMiniPlayerStore";
import { Button } from "../ui/button";
import { deviceFrameMetrics } from "./deviceFrameMetrics";
import { DeviceViewer } from "./DeviceViewer";
import { threadAttachments } from "./threadAttachments";
import { useDeviceRuntime } from "./useDeviceRuntime";

/** The floating viewer's rail plus its padding: what does not scale with the window. */
const FLOATING_BODY_CHROME = 36 + 16;

/** A device floating over the chat: live and interactive, in the workspace mini-player. */
export function FloatingDevice(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly state: WorkspaceMiniPlayerState & { readonly source: { readonly kind: "device" } };
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly composerRef?: RefObject<HTMLElement | null>;
  /** Open the workspace panel on the device tabs. */
  readonly onOpenInPanel: () => void;
}) {
  const { environmentId, threadId, state } = props;
  const thread = { environmentId, threadId };
  const threadKey = deviceWorkspaceThreadKey(thread);
  const udid = state.source.udid;
  useDeviceRuntime(environmentId);
  const environmentState = useDeviceStateStore((store) => store.environmentById[environmentId]);
  const threadState = useDeviceStateStore((store) => store.threadByKey[threadKey]);
  const tabTitle = useDeviceTabsStore(
    (store) =>
      selectThreadDeviceTabs(store.byThreadKey, threadKey).tabs.find((tab) => tab.udid === udid)
        ?.title ?? null,
  );
  const device =
    (environmentState?.devices ?? threadState?.devices ?? []).find(
      (candidate) => candidate.udid === udid,
    ) ?? null;
  const attachment = threadAttachments(threadState).find((entry) => entry.udid === udid) ?? null;
  const sourceKey = workspaceMiniPlayerSourceKey(state.source);
  const title = tabTitle ?? device?.name ?? "Device";

  return (
    <WorkspaceMiniPlayerFrame
      containerRef={props.containerRef}
      {...(props.composerRef ? { composerRef: props.composerRef } : {})}
      title={title}
      label={`${title}, floating over the chat`}
      aspect={device ? deviceFrameMetrics(device).drawnAspect : 0.48}
      bodyChrome={FLOATING_BODY_CHROME}
      position={state.position}
      width={state.width}
      onPlace={(frame) => useWorkspaceMiniPlayerStore.getState().place(threadKey, sourceKey, frame)}
      actions={
        <>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open in right panel"
            title="Open in right panel"
            onClick={() => {
              if (dockFloatingDevice(thread) !== null) props.onOpenInPanel();
            }}
          >
            <DockGlyph className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Close floating device"
            title="Close"
            onClick={() => closeFloatingDevice(thread)}
          >
            <CloseGlyph className="size-3.5" />
          </Button>
        </>
      }
    >
      {device && device.state !== "shutdown" ? (
        <DeviceViewer
          environmentId={environmentId}
          threadKey={threadKey}
          device={device}
          attachment={attachment}
          variant="floating"
          generation={environmentState?.generation ?? 0}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
          {device ? `${device.name} is stopped.` : "Looking for the device…"}
        </div>
      )}
    </WorkspaceMiniPlayerFrame>
  );
}
