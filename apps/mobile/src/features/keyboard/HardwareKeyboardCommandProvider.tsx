import { StackActions, useNavigation } from "@react-navigation/native";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import { KeyboardCommands } from "../../native/KeyboardCommands";
import { lazyScreen } from "../../navigation/lazyScreen";
import type { CommandPaletteThreadCommand } from "./commandPaletteModel";
import { resolveEnabledHardwareKeyboardCommands } from "./hardwareKeyboardCommandScope";
import {
  dispatchHardwareKeyboardCommand,
  getRegisteredHardwareKeyboardCommands,
  subscribeToHardwareKeyboardCommandRegistrations,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

// Loaded the first time Command-K opens it, so launch evaluates neither the
// palette nor the thread and project search it brings.
const CommandPalette = lazyScreen(
  "CommandPalette",
  () => (require("./CommandPalette") as typeof import("./CommandPalette")).CommandPalette,
);

const NO_COMMANDS: ReadonlyArray<HardwareKeyboardCommand> = [];

function isPaletteThreadCommand(
  command: HardwareKeyboardCommand,
): command is CommandPaletteThreadCommand {
  return command === "files" || command === "terminal" || command === "review";
}

/**
 * The app-wide hardware-keyboard commands. Screens register what they handle
 * (`useHardwareKeyboardCommand`); `resolveEnabledHardwareKeyboardCommands`
 * decides which apply where the app is. Command-K opens the command palette,
 * New Task and Back fall back to the defaults below.
 */
export function HardwareKeyboardCommandProvider({
  children,
  pathname,
  workspacePathname,
}: PropsWithChildren<{
  /** The full location, sheets included. */
  readonly pathname: string;
  /** The screen beneath any sheets. */
  readonly workspacePathname: string;
}>) {
  const navigation = useNavigation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The registration set itself, not a version counter: React Compiler keys a
  // memo on what its callback reads and would drop an unread version key.
  const registered = useSyncExternalStore(
    subscribeToHardwareKeyboardCommandRegistrations,
    getRegisteredHardwareKeyboardCommands,
    getRegisteredHardwareKeyboardCommands,
  );
  // What applies here with the palette closed; the palette offers the thread tools among them.
  const availableCommands = useMemo(
    () =>
      resolveEnabledHardwareKeyboardCommands({
        pathname,
        workspacePathname,
        canGoBack: navigation.canGoBack(),
        registered,
      }),
    [pathname, registered, navigation, workspacePathname],
  );
  // The palette's own key-command view takes over while it is open.
  const enabledCommands = paletteOpen ? NO_COMMANDS : availableCommands;
  const paletteThreadCommands = useMemo(
    () => availableCommands.filter(isPaletteThreadCommand),
    [availableCommands],
  );

  const onCommand = useCallback(
    (command: HardwareKeyboardCommand) => {
      if (command === "commandPalette") {
        setPaletteOpen(true);
        return;
      }
      if (dispatchHardwareKeyboardCommand(command)) return;

      if (command === "newTask") {
        navigation.navigate("NewTask", {});
        return;
      }
      if (command === "back") {
        if (navigation.canGoBack()) {
          navigation.goBack();
        } else {
          navigation.dispatch(StackActions.replace("Home"));
        }
      }
    },
    [navigation],
  );
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  return (
    <KeyboardCommands enabledCommands={enabledCommands} onCommand={onCommand}>
      {children}
      {paletteOpen ? (
        <CommandPalette
          workspacePathname={workspacePathname}
          threadCommands={paletteThreadCommands}
          onClose={closePalette}
          onCommand={onCommand}
        />
      ) : null}
    </KeyboardCommands>
  );
}
