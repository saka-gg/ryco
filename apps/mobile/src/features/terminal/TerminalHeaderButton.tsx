import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { selectTerminalEventEntries } from "@ryco/client-runtime/state/terminal";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { Pressable, View } from "react-native";
import { useShallow } from "zustand/react/shallow";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useTerminalStateStore } from "../../state/terminalStateStore";
import {
  buildTerminalHeaderActivity,
  knownTerminalSessionIds,
  MOBILE_DEFAULT_TERMINAL_ID,
} from "./terminalSessionModel";

/**
 * The thread header's Terminal action, with the sessions this device knows
 * of for this thread: a count when there is more than one and a dot while a
 * command runs. It reads the memory-only terminal store and nothing else;
 * rendering it never starts a session.
 */
export function TerminalHeaderButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly iconColor: string;
  readonly onPress: () => void;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const threadKey = scopedThreadKey(threadRef);
  const sessions = useTerminalStateStore(
    useShallow((state) => {
      const recorded = state.terminalStateByThreadKey[threadKey] ?? null;
      return {
        terminalIds: knownTerminalSessionIds({
          sessions: recorded,
          defaultTerminalHasEvents:
            selectTerminalEventEntries(
              state.terminalEventEntriesByKey,
              threadRef,
              MOBILE_DEFAULT_TERMINAL_ID,
            ).length > 0,
        }).join("\u0000"),
        runningTerminalIds: (recorded?.runningTerminalIds ?? []).join("\u0000"),
      };
    }),
  );
  const activity = buildTerminalHeaderActivity({
    terminalIds: sessions.terminalIds === "" ? [] : sessions.terminalIds.split("\u0000"),
    runningTerminalIds:
      sessions.runningTerminalIds === "" ? [] : sessions.runningTerminalIds.split("\u0000"),
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={activity.accessibilityLabel}
      onPress={props.onPress}
      className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle-strong"
    >
      <SymbolView name="terminal" size={21} tintColor={props.iconColor} type="monochrome" />
      {activity.badgeLabel ? (
        <View className="absolute right-0.5 top-0.5 min-w-4 items-center justify-center rounded-full bg-primary px-1">
          <Text className="text-2xs font-ryco-bold text-primary-foreground">
            {activity.badgeLabel}
          </Text>
        </View>
      ) : activity.hasRunningSubprocess ? (
        <View className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-screen bg-success" />
      ) : null}
    </Pressable>
  );
}
