import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { RefObject } from "react";

import { FloatingDevice } from "../components/device/FloatingDevice";
import type { WorkspaceMiniPlayerState } from "./workspaceMiniPlayerStore";

/**
 * The thread's mini-player, loaded only once something floats. Each source
 * kind brings its own content; a device is the only one so far.
 */
export default function WorkspaceMiniPlayer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly state: WorkspaceMiniPlayerState;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly composerRef?: RefObject<HTMLElement | null>;
  readonly onOpenDevicePanel: () => void;
}) {
  const { state } = props;
  switch (state.source.kind) {
    case "device":
      return (
        <FloatingDevice
          environmentId={props.environmentId}
          threadId={props.threadId}
          state={{ ...state, source: state.source }}
          containerRef={props.containerRef}
          {...(props.composerRef ? { composerRef: props.composerRef } : {})}
          onOpenInPanel={props.onOpenDevicePanel}
        />
      );
  }
}
