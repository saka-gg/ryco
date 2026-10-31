import { useNavigation } from "@react-navigation/native";
import type { CommandPaletteRow } from "@ryco/client-runtime/commandPalette/search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  TextInput,
  useWindowDimensions,
  View,
  type ModalProps,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";
import { useThemeColor } from "../../lib/useThemeColor";
import { KeyboardCommands } from "../../native/KeyboardCommands";
import { openProject, openThread } from "../../navigation/openThread";
import { useListedEnvironmentsWorkspaceData } from "../../state/homeData";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import {
  buildCommandPaletteSources,
  COMMAND_PALETTE_ITEM_ROW_HEIGHT,
  COMMAND_PALETTE_LABEL_ROW_HEIGHT,
  commandPaletteHighlightIndex,
  commandPaletteItemForKey,
  commandPaletteRowLayouts,
  searchCommandPalette,
  stepCommandPaletteHighlight,
  type CommandPaletteIntent,
  type CommandPaletteItem,
  type CommandPaletteThreadCommand,
} from "./commandPaletteModel";
import { COMMAND_PALETTE_KEYBOARD_COMMANDS } from "./hardwareKeyboardCommandScope";
import { parseActiveThreadPath, type HardwareKeyboardCommand } from "./hardwareKeyboardCommands";

type PaletteRow = CommandPaletteRow<CommandPaletteItem>;

// iOS restricts a Modal to portrait unless told otherwise, which would turn a
// landscape iPad — the device this palette is for — on open.
const MODAL_ORIENTATIONS: ModalProps["supportedOrientations"] = [
  "portrait",
  "portrait-upside-down",
  "landscape",
];
// iOS can drop a Modal's onDismiss when it closes during its fade-in or races
// another presentation; the palette finishes closing after this anyway.
const DISMISS_FALLBACK_MS = 400;

function paletteRowKey(row: PaletteRow): string {
  return row.key;
}

function PaletteItemRow(props: {
  readonly item: CommandPaletteItem;
  readonly itemIndex: number | null;
  readonly highlighted: boolean;
  readonly onSelect: (item: CommandPaletteItem) => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.highlighted }}
      onPress={() => props.onSelect(props.item)}
      className={`mx-2 flex-row items-center gap-3 rounded-xl px-3 active:bg-subtle-strong ${
        props.highlighted ? "bg-subtle" : ""
      }`}
      style={{ height: COMMAND_PALETTE_ITEM_ROW_HEIGHT }}
    >
      <View className="w-6 items-center">
        <SymbolView name={props.item.icon} size={18} tintColor={iconColor} type="monochrome" />
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base text-foreground">
          {props.item.title}
        </Text>
        {props.item.detail ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {props.item.detail}
          </Text>
        ) : null}
      </View>
      {props.itemIndex !== null && props.itemIndex < 9 ? (
        <Text className="font-mono text-xs text-foreground-tertiary">⌘{props.itemIndex + 1}</Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Command-K's palette: actions, projects and threads, searched the way the web
 * palette searches them. Mounted only while open, so nothing at the app root
 * subscribes to every project and thread.
 *
 * Arrow keys move the highlight, Return or Command-1…9 choose, Escape or
 * Command-K close, and a leading `>` shows only actions. A choice runs once the
 * modal has gone, because UIKit cannot present a sheet over a closing one.
 */
export function CommandPalette(props: {
  readonly workspacePathname: string;
  readonly threadCommands: ReadonlyArray<CommandPaletteThreadCommand>;
  readonly onClose: () => void;
  readonly onCommand: (command: HardwareKeyboardCommand) => void;
}) {
  const { onClose, onCommand } = props;
  const navigation = useNavigation();
  const { width, height } = useWindowDimensions();
  const placeholderColor = useThemeColor("--color-foreground-muted");
  const textColor = useThemeColor("--color-foreground");
  const environments = useHomeEnvironments();
  const { projects, threads } = useListedEnvironmentsWorkspaceData(environments);
  const machineLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const activeThread = useMemo(
    () => parseActiveThreadPath(props.workspacePathname),
    [props.workspacePathname],
  );
  const sources = useMemo(
    () =>
      buildCommandPaletteSources({
        projects,
        threads,
        machineLabels,
        activeThread,
        threadCommands: props.threadCommands,
      }),
    [activeThread, machineLabels, projects, props.threadCommands, threads],
  );
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchCommandPalette(sources, query), [query, sources]);
  const rowLayouts = useMemo(() => commandPaletteRowLayouts(results.rows), [results.rows]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const highlightIndex = commandPaletteHighlightIndex(results.itemValues, highlighted);
  const highlightedValue = results.itemValues[highlightIndex] ?? null;

  const [visible, setVisible] = useState(true);
  const pendingIntent = useRef<CommandPaletteIntent | null>(null);
  const closing = useRef(false);
  const finished = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<PaletteRow>>(null);

  const runIntent = useCallback(
    (intent: CommandPaletteIntent) => {
      switch (intent.type) {
        case "thread":
          openThread(navigation, intent);
          return;
        case "project":
          openProject(navigation, intent);
          return;
        case "newTask":
          navigation.navigate("NewTask", {
            environmentId: intent.environmentId,
            projectId: intent.projectId,
          });
          return;
        case "addProject":
          navigation.navigate("AddProject");
          return;
        case "machines":
          navigation.navigate("Connections");
          return;
        case "settings":
          navigation.navigate("SettingsSheet", { screen: intent.screen });
          return;
        case "command":
          onCommand(intent.command);
      }
    },
    [navigation, onCommand],
  );

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onClose();
    const intent = pendingIntent.current;
    pendingIntent.current = null;
    if (intent) runIntent(intent);
  }, [onClose, runIntent]);

  useEffect(() => {
    if (visible) return undefined;
    const fallback = setTimeout(finish, DISMISS_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [finish, visible]);

  // The first close wins: a second key press during the fade-out does nothing.
  const close = useCallback((item?: CommandPaletteItem) => {
    if (closing.current) return;
    closing.current = true;
    pendingIntent.current = item?.intent ?? null;
    setVisible(false);
  }, []);

  // Keep the highlighted row in view as the arrow keys move it.
  useEffect(() => {
    const rowIndex = results.rowIndexByItemIndex[highlightIndex];
    if (rowIndex === undefined) return;
    if (highlightIndex === 0) listRef.current?.scrollToOffset({ offset: 0, animated: false });
    else listRef.current?.scrollToIndex({ index: rowIndex, animated: false, viewPosition: 0.5 });
  }, [highlightIndex, results]);

  const onKeyCommand = useCallback(
    (command: HardwareKeyboardCommand) => {
      if (command === "commandPalette" || command === "paletteDismiss") {
        close();
      } else if (command === "paletteNext" || command === "palettePrevious") {
        setHighlighted(
          stepCommandPaletteHighlight(
            results.itemValues,
            highlightedValue,
            command === "paletteNext" ? 1 : -1,
          ),
        );
      } else {
        const item = commandPaletteItemForKey(results, highlightedValue, command);
        if (item) close(item);
      }
    },
    [close, highlightedValue, results],
  );

  const renderItem = useCallback(
    ({ item: row }: { readonly item: PaletteRow }) =>
      row.kind === "label" ? (
        <Text
          accessibilityRole="header"
          className="px-5 pt-3 text-xs font-ryco-medium text-foreground-muted"
          style={{ height: COMMAND_PALETTE_LABEL_ROW_HEIGHT }}
        >
          {row.label}
        </Text>
      ) : (
        <PaletteItemRow
          item={row.item}
          itemIndex={row.itemIndex}
          highlighted={row.item.value === highlightedValue}
          onSelect={close}
        />
      ),
    [close, highlightedValue],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      supportedOrientations={MODAL_ORIENTATIONS}
      onShow={() => inputRef.current?.focus()}
      onRequestClose={() => close()}
      onDismiss={finish}
    >
      <KeyboardCommands
        enabledCommands={COMMAND_PALETTE_KEYBOARD_COMMANDS}
        onCommand={onKeyCommand}
      >
        <View className="flex-1 items-center px-4" style={{ paddingTop: height * 0.12 }}>
          <Pressable
            accessibilityLabel="Close command palette"
            className="absolute inset-0 bg-backdrop"
            onPress={() => close()}
          />
          <GlassSurface
            accessibilityViewIsModal
            radius={20}
            style={{ width: Math.min(600, width - 32), height: Math.min(520, height * 0.7) }}
          >
            <View className="h-12 flex-row items-center gap-2 border-b border-border px-4">
              <SymbolView
                name="magnifyingglass"
                size={16}
                tintColor={placeholderColor}
                type="monochrome"
              />
              <TextInput
                ref={inputRef}
                accessibilityLabel="Search actions, projects and threads"
                placeholder="Search actions, projects and threads"
                placeholderTextColor={placeholderColor as string}
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="while-editing"
                returnKeyType="go"
                submitBehavior="submit"
                value={query}
                onChangeText={(value) => {
                  setQuery(value);
                  setHighlighted(null);
                }}
                onSubmitEditing={() => {
                  const item = commandPaletteItemForKey(results, highlightedValue, "return");
                  if (item) close(item);
                }}
                className="h-12 min-w-0 flex-1 font-sans text-base"
                style={{ color: textColor as string }}
              />
            </View>
            <FlatList
              ref={listRef}
              data={results.rows}
              extraData={highlightedValue}
              keyExtractor={paletteRowKey}
              renderItem={renderItem}
              getItemLayout={(_, index) => ({
                offset: rowLayouts[index]?.offset ?? 0,
                length: rowLayouts[index]?.length ?? COMMAND_PALETTE_ITEM_ROW_HEIGHT,
                index,
              })}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: 8 }}
              ListEmptyComponent={
                <Text className="p-5 text-center text-foreground-muted">No results</Text>
              }
            />
          </GlassSurface>
        </View>
      </KeyboardCommands>
    </Modal>
  );
}
