import { useAtomValue } from "@effect/atom-react";
import {
  getWsConnectionStatusForEnvironment,
  wsConnectionStatusForEnvironmentAtom,
} from "@ryco/client-runtime/rpc";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createVoiceController, VOICE_MODEL } from "@ryco/client-runtime/voice";
import type { EnvironmentId } from "@ryco/contracts";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import { readHostedNodeMutationLease } from "../hostedHub/hostedConnectionCoordinator";
import { readEnvironmentConnection } from "../environments/runtime";
import { isHostedHubMode } from "../env";
import { Button } from "../components/ui/button";
import { createBrowserVoiceCapture } from "./capture";

export function VoiceInput(props: {
  environmentId: EnvironmentId;
  draftKey: string;
  destination: string;
  disabled: boolean;
  onInsert(text: string): void;
}) {
  const { environmentId, draftKey } = props;
  const leaseGeneration = isHostedHubMode() ? readHostedNodeMutationLease(environmentId) : null;
  const status = useAtomValue(wsConnectionStatusForEnvironmentAtom(props.environmentId));
  const capability = useHostedRpcCapability("speech.request");
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  }, [props]);
  const allowed = useRef(capability.allowed);
  useLayoutEffect(() => {
    allowed.current = capability.allowed;
  }, [capability.allowed]);
  const controller = useMemo(() => {
    return createVoiceController({
      capture: createBrowserVoiceCapture(),
      api: {
        request: (input) => {
          const api = readEnvironmentConnection(environmentId)?.client.speech;
          return api
            ? api.request(input)
            : Promise.reject(new Error("Voice input is unavailable on this server."));
        },
      },
      authorize: () => {
        const connection = readEnvironmentConnection(environmentId);
        const statusAtStart = getWsConnectionStatusForEnvironment(environmentId);
        const lease = isHostedHubMode() ? readHostedNodeMutationLease(environmentId) : null;
        if (!connection || (isHostedHubMode() && !lease)) return null;
        const authority = () => {
          const now = isHostedHubMode() ? readHostedNodeMutationLease(environmentId) : null;
          const statusNow = getWsConnectionStatusForEnvironment(environmentId);
          return (
            statusNow.phase === "connected" &&
            statusNow.connectedAt === statusAtStart.connectedAt &&
            allowed.current &&
            readEnvironmentConnection(environmentId) === connection &&
            connection.client.isHeartbeatFresh() &&
            (!lease ||
              (!!now &&
                now.selectionGeneration === lease.selectionGeneration &&
                now.snapshotGeneration === lease.snapshotGeneration))
          );
        };
        return {
          canCancel: authority,
          isCurrent: () =>
            !latest.current.disabled &&
            latest.current.draftKey === draftKey &&
            latest.current.environmentId === environmentId &&
            authority(),
        };
      },
      encode: (bytes) => btoa(String.fromCharCode(...bytes)),
      id: () => crypto.randomUUID(),
      insert: (text) => latest.current.onInsert(text),
    });
  }, [environmentId, draftKey]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const stop = () => controller.cancel();
    const visibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", stop);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", stop);
      controller.cancel();
    };
  }, [controller]);
  useEffect(() => {
    if (props.disabled || !capability.allowed) controller.cancel();
  }, [controller, props.disabled, capability.allowed]);
  useEffect(() => {
    controller.revalidate();
  }, [
    controller,
    status.phase,
    status.connectedAt,
    leaseGeneration?.selectionGeneration,
    leaseGeneration?.snapshotGeneration,
  ]);
  return (
    <div className="space-y-2 px-4 py-2 text-xs phone:hidden" aria-label="Voice input">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={
            props.disabled ||
            !capability.allowed ||
            ["checking", "transcribing", "installing"].includes(state.phase)
          }
          onClick={() =>
            state.phase === "recording" ? void controller.stop() : void controller.start()
          }
        >
          {state.phase === "recording" ? "Stop recording" : "Voice"}
        </Button>
        <span className="text-muted-foreground">
          {state.phase === "recording"
            ? "Recording · up to 60 seconds"
            : `Transcribes on ${props.destination}`}
        </span>
        {state.phase !== "idle" && (
          <Button size="sm" variant="ghost" onClick={() => controller.cancel()}>
            Cancel
          </Button>
        )}
      </div>
      <div role="status">
        {state.phase === "transcribing"
          ? "Transcribing…"
          : state.phase === "installing"
            ? "Downloading and verifying model…"
            : state.error}
      </div>
      {state.phase === "unsupported" && (
        <p>Voice capture or the optional inference helper is unavailable on this platform.</p>
      )}
      {state.phase === "missing-model" && (
        <div className="space-y-2">
          <p>
            Install {VOICE_MODEL.name} on {props.destination}: {VOICE_MODEL.bytes.toLocaleString()}{" "}
            bytes. {VOICE_MODEL.license}. Audio is sent only to the selected environment.
          </p>
          <a className="underline" href={VOICE_MODEL.url} target="_blank" rel="noreferrer">
            Model source
          </a>
          <Button size="sm" onClick={() => void controller.install()}>
            Download model to selected environment
          </Button>
        </div>
      )}
      {state.phase === "review" && (
        <div className="space-y-2">
          <textarea
            aria-label="Review transcription"
            className="w-full rounded border bg-background p-2 text-sm"
            value={state.text}
            onChange={(event) => controller.edit(event.target.value)}
          />
          <Button size="sm" disabled={!state.text.trim()} onClick={controller.insert}>
            Insert into draft
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void controller.remove()}>
            Remove installed model
          </Button>
        </div>
      )}
    </div>
  );
}
