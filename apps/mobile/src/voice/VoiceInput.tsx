import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState, Pressable, TextInput, View } from "react-native";
import { Schema } from "effect";
import { createVoiceController, VOICE_MODEL } from "@ryco/client-runtime/voice";
import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";
import { readRpcClient } from "../connection/environmentApi";
import { mobileHostedConnectionsStore } from "../connection/hostedConnectionCoordinator";
import { useHomeEnvironments } from "../features/home/useHomeEnvironments";
import { useWsConnectionStatusForEnvironment } from "../rpc/wsConnectionState";
import { newMessageId } from "../lib/ids";
import { AppText as Text } from "../components/AppText";
import { createNativeVoiceCapture } from "./capture";

export function VoiceInput(props: {
  environmentId: EnvironmentId;
  draftKey: string;
  disabled?: boolean;
  onInsert(text: string): void;
}) {
  const { environmentId, draftKey } = props;
  const generation = mobileHostedConnectionsStore
    .getState()
    .selectedNodes.find((entry) => entry.environmentId === environmentId)?.generation;
  const environments = useHomeEnvironments();
  const environment = environments.find((entry) => entry.environmentId === props.environmentId);
  const status = useWsConnectionStatusForEnvironment(props.environmentId);
  const ready = !!environment?.mutationReady && environment.role === "owner" && !props.disabled;
  const latest = useRef({ props, ready });
  useLayoutEffect(() => {
    latest.current = { props, ready };
  }, [props, ready]);
  const controller = useMemo(() => {
    return createVoiceController({
      capture: createNativeVoiceCapture(newMessageId),
      api: {
        request: (input) => {
          const api = readRpcClient(environmentId)?.speech;
          return api
            ? api.request(input)
            : Promise.reject(new Error("Voice input is unavailable on this server."));
        },
      },
      authorize: () => {
        const client = readRpcClient(environmentId);
        const statusAtStart = getWsConnectionStatusForEnvironment(environmentId);
        const hosted = mobileHostedConnectionsStore
          .getState()
          .selectedNodes.find((entry) => entry.environmentId === environmentId);
        if (!client || !latest.current.ready) return null;
        const authority = () => {
          const statusNow = getWsConnectionStatusForEnvironment(environmentId);
          const now = mobileHostedConnectionsStore
            .getState()
            .selectedNodes.find((entry) => entry.environmentId === environmentId);
          return (
            latest.current.ready &&
            readRpcClient(environmentId) === client &&
            statusNow.phase === "connected" &&
            statusNow.connectedAt === statusAtStart.connectedAt &&
            (!hosted ||
              (!!now &&
                now.generation === hosted.generation &&
                now.transportStatus === "online" &&
                now.sessionStatus === "ready"))
          );
        };
        return {
          canCancel: authority,
          isCurrent: () =>
            latest.current.props.draftKey === draftKey &&
            latest.current.props.environmentId === environmentId &&
            authority(),
        };
      },
      encode: Schema.encodeSync(Schema.Uint8ArrayFromBase64),
      id: newMessageId,
      insert: (text) => latest.current.props.onInsert(text),
    });
  }, [environmentId, draftKey]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") controller.cancel();
    });
    return () => {
      sub.remove();
      controller.cancel();
    };
  }, [controller]);
  useEffect(() => {
    controller.revalidate();
  }, [controller, ready, status.phase, status.connectedAt, generation]);
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={action}
      className="min-h-11 justify-center px-2 disabled:opacity-40"
    >
      <Text className="text-xs text-foreground">{label}</Text>
    </Pressable>
  );
  return (
    <View className="gap-1 px-2">
      <View className="flex-row items-center">
        {button(
          state.phase === "recording" ? "Stop recording" : "Voice",
          () => (state.phase === "recording" ? void controller.stop() : void controller.start()),
          !ready || ["checking", "transcribing", "installing"].includes(state.phase),
        )}
        <Text className="flex-1 text-xs text-foreground-muted">
          {state.phase === "recording"
            ? "Recording · 60 seconds max"
            : `Transcribes on ${environment?.label ?? "selected environment"}`}
        </Text>
        {state.phase !== "idle" && button("Cancel", () => controller.cancel())}
      </View>
      {state.error && (
        <Text accessibilityRole="alert" className="text-xs text-foreground-muted">
          {state.error}
        </Text>
      )}
      {state.phase === "unsupported" && (
        <Text className="text-xs text-foreground-muted">
          Voice capture or the optional inference helper is unavailable in this build.
        </Text>
      )}
      {state.phase === "transcribing" && (
        <Text className="text-xs text-foreground-muted">Transcribing…</Text>
      )}
      {state.phase === "installing" && (
        <Text className="text-xs text-foreground-muted">Downloading and verifying model…</Text>
      )}
      {state.phase === "missing-model" && (
        <View>
          <Text className="text-xs text-foreground-muted">
            {VOICE_MODEL.name}: {VOICE_MODEL.bytes.toLocaleString()} bytes from Hugging Face.{" "}
            {VOICE_MODEL.license}. Installs on {environment?.label ?? "selected environment"}. Audio
            is sent only to that machine.
          </Text>
          {button("Download model to selected environment", () => void controller.install())}
        </View>
      )}
      {state.phase === "review" && (
        <View>
          <TextInput
            accessibilityLabel="Review transcription"
            multiline
            value={state.text}
            onChangeText={controller.edit}
            className="min-h-20 rounded-xl border border-border p-3 text-foreground"
          />
          {button("Insert into draft", controller.insert, !state.text.trim())}
          {button("Remove installed model", () => void controller.remove())}
        </View>
      )}
    </View>
  );
}
