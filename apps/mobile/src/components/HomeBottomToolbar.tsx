import { useRef, useState } from "react";
import { MenuView } from "@react-native-menu/menu";
import { Keyboard, Pressable, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EnvironmentId } from "@ryco/contracts";

import { HOME_TOOLBAR_HEIGHT, HOME_TOOLBAR_INSET } from "../features/home/homeChromeModel";
import { useThemeColor } from "../lib/useThemeColor";
import { SymbolView } from "./AppSymbol";
import { GlassSurface } from "./GlassSurface";
import type { NodeScopeOption } from "./NodeScopeControl";

export function HomeBottomToolbar(props: {
  readonly query: string;
  readonly searchLabel: string;
  readonly onQueryChange: (query: string) => void;
  readonly machines: ReadonlyArray<NodeScopeOption>;
  readonly selectedMachine: EnvironmentId | null;
  readonly onSelectMachine: (environmentId: EnvironmentId | null) => void;
  readonly onNewTask: () => void;
}) {
  const searchRef = useRef<TextInput>(null);
  const [searchActive, setSearchActive] = useState(false);
  const searching = searchActive || props.query.length > 0;
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const iconColor = useThemeColor("--color-icon");
  const textColor = useThemeColor("--color-foreground");
  const placeholderColor = useThemeColor("--color-foreground-muted");
  const accentColor = useThemeColor("--color-accent-strong");
  const selectedLabel = props.machines.find(
    (machine) => machine.environmentId === props.selectedMachine,
  )?.label;
  const circleStyle = {
    height: HOME_TOOLBAR_HEIGHT,
    width: HOME_TOOLBAR_HEIGHT,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom: keyboardVisible ? 8 : insets.bottom + HOME_TOOLBAR_INSET,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      {!searching ? (
        <MenuView
          title="Filter by machine"
          actions={[
            {
              id: "all",
              title: "All machines",
              state: props.selectedMachine === null ? "on" : "off",
            },
            ...props.machines.map((machine) => ({
              id: `machine:${machine.environmentId}`,
              title: machine.label,
              state:
                props.selectedMachine === machine.environmentId
                  ? ("on" as const)
                  : ("off" as const),
            })),
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "all") props.onSelectMachine(null);
            else {
              const machine = props.machines.find(
                (candidate) => `machine:${candidate.environmentId}` === nativeEvent.event,
              );
              if (machine) props.onSelectMachine(machine.environmentId);
            }
          }}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={
              props.selectedMachine
                ? `Filter machines, ${selectedLabel ?? "one machine"} selected`
                : "Filter machines, all machines"
            }
            accessibilityState={{ selected: props.selectedMachine !== null }}
          >
            <GlassSurface radius={HOME_TOOLBAR_HEIGHT / 2} style={circleStyle}>
              <SymbolView
                name="line.3.horizontal.decrease"
                size={25}
                tintColor={props.selectedMachine ? accentColor : iconColor}
                type="monochrome"
              />
              {props.selectedMachine ? (
                <View className="absolute bottom-2 h-1 w-1 rounded-full bg-accent" />
              ) : null}
            </GlassSurface>
          </View>
        </MenuView>
      ) : null}
      <GlassSurface
        radius={HOME_TOOLBAR_HEIGHT / 2}
        style={{
          height: HOME_TOOLBAR_HEIGHT,
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: props.query ? 0 : 14,
        }}
      >
        <SymbolView
          name="magnifyingglass"
          size={22}
          tintColor={placeholderColor}
          type="monochrome"
        />
        <TextInput
          ref={searchRef}
          onFocus={() => setSearchActive(true)}
          accessibilityLabel={props.searchLabel}
          placeholder="Search"
          placeholderTextColor={placeholderColor as string}
          value={props.query}
          onChangeText={props.onQueryChange}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={() => Keyboard.dismiss()}
          className="min-w-0 flex-1 px-2 font-sans text-[17px]"
          style={{ height: HOME_TOOLBAR_HEIGHT, color: textColor as string }}
        />
        {props.query ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            onPress={() => props.onQueryChange("")}
            className="h-11 w-11 items-center justify-center active:opacity-70"
          >
            <SymbolView
              name="xmark.circle.fill"
              size={18}
              tintColor={placeholderColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </GlassSurface>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={searching ? "Close search" : "New Task"}
        onPress={() => {
          Keyboard.dismiss();
          if (searching) {
            searchRef.current?.blur();
            props.onQueryChange("");
            setSearchActive(false);
          } else props.onNewTask();
        }}
        className="active:opacity-70"
      >
        <GlassSurface radius={HOME_TOOLBAR_HEIGHT / 2} style={circleStyle}>
          <SymbolView
            name={searching ? "xmark" : "square.and.pencil"}
            size={searching ? 27 : 25}
            tintColor={iconColor}
            type="monochrome"
          />
        </GlassSurface>
      </Pressable>
    </View>
  );
}
