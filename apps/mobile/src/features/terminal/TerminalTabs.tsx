import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { TerminalTabModel } from "./terminalSessionModel";

function statusColor(tab: TerminalTabModel): string {
  if (tab.hasRunningSubprocess) return "#34d399";
  if (tab.status === "error") return "#fb7185";
  if (tab.status === "exited") return "#737985";
  return "#60a5fa";
}

function statusCopy(tab: TerminalTabModel): string {
  if (tab.status === "exited") {
    return tab.exitCode === null ? "exited" : `exited with code ${tab.exitCode}`;
  }
  if (tab.hasRunningSubprocess) return `${tab.status}, a command is running`;
  return tab.status;
}

/** One tab per session; tabs scroll, they never split the screen. */
export function TerminalTabs(props: {
  readonly tabs: readonly TerminalTabModel[];
  readonly canAdd: boolean;
  readonly onSelect: (terminalId: string) => void;
  readonly onAdd: () => void;
}) {
  return (
    <View className="h-11 flex-row border-b border-white/10 bg-[#111318]">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: "stretch" }}
        className="min-w-0 flex-1"
      >
        {props.tabs.map((tab) => (
          <Pressable
            key={tab.terminalId}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab.active }}
            accessibilityLabel={`${tab.label}. ${statusCopy(tab)}.`}
            onPress={() => props.onSelect(tab.terminalId)}
            className={`min-h-11 min-w-24 flex-row items-center gap-2 border-r border-white/10 px-3 ${
              tab.active ? "bg-white/10" : "active:bg-white/5"
            }`}
          >
            <View className="h-2 w-2 rounded-full" style={{ backgroundColor: statusColor(tab) }} />
            <Text
              numberOfLines={1}
              className={`max-w-32 text-xs font-ryco-medium ${
                tab.active ? "text-white" : "text-white/60"
              }`}
            >
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New terminal session"
        accessibilityState={{ disabled: !props.canAdd }}
        disabled={!props.canAdd}
        onPress={props.onAdd}
        className={`h-11 w-11 items-center justify-center border-l border-white/10 active:bg-white/10 ${
          props.canAdd ? "" : "opacity-30"
        }`}
      >
        <SymbolView name="plus" size={17} tintColor="#d9dde5" type="monochrome" />
      </Pressable>
    </View>
  );
}
