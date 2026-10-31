import { MVP_ROOT_ROUTES } from "../../navigation/mvpRouteConfig";
import {
  parseActiveThreadPath,
  THREAD_JUMP_COMMANDS,
  threadJumpIndex,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

/** What the command palette's own key-command view offers while it is open. */
export const COMMAND_PALETTE_KEYBOARD_COMMANDS: ReadonlyArray<HardwareKeyboardCommand> = [
  "commandPalette",
  "paletteDismiss",
  "paletteNext",
  "palettePrevious",
  ...THREAD_JUMP_COMMANDS,
];

const NEW_TASK_PATHNAME = `/${MVP_ROOT_ROUTES.NewTask.linking}`;
/** Opened from a thread's own screen, and only while no sheet covers it. */
const THREAD_SCREEN_COMMANDS: ReadonlySet<HardwareKeyboardCommand> = new Set([
  "files",
  "terminal",
  "review",
]);
/** Only the palette's view sends these; the app-wide view never offers them. */
const PALETTE_ONLY_COMMANDS: ReadonlySet<HardwareKeyboardCommand> = new Set([
  "paletteDismiss",
  "paletteNext",
  "palettePrevious",
]);

function isThreadListLocation(workspacePathname: string): boolean {
  return workspacePathname === "/" || parseActiveThreadPath(workspacePathname) !== null;
}

/**
 * The commands the app-wide key-command view offers for where the app is.
 *
 * `pathname` is the full location, sheets included; `workspacePathname` is the
 * screen beneath any sheets. Screens register what they handle (Home's search
 * and new task while it is focused, a thread's files, terminal and review while
 * they apply, the inbox's thread jumps while it lists threads); this decides
 * which of those apply here:
 *
 * - Thread jumps work over Home and thread screens, sheets included, as a jump
 *   closes the sheets. Elsewhere (a project, a pull request) the inbox is not
 *   what the user is looking at.
 * - A thread's files, terminal and review work only with no sheet over it.
 * - The palette and New Task always work, except New Task while it is open.
 *
 * While the palette is open its own view offers its commands instead.
 */
export function resolveEnabledHardwareKeyboardCommands(input: {
  readonly pathname: string;
  readonly workspacePathname: string;
  readonly canGoBack: boolean;
  readonly registered: ReadonlySet<HardwareKeyboardCommand>;
}): HardwareKeyboardCommand[] {
  const onThreadScreen =
    input.pathname === input.workspacePathname && parseActiveThreadPath(input.pathname) !== null;
  const jumpsApply = isThreadListLocation(input.workspacePathname);
  const commands = new Set<HardwareKeyboardCommand>();
  for (const command of input.registered) {
    if (PALETTE_ONLY_COMMANDS.has(command)) continue;
    if (THREAD_SCREEN_COMMANDS.has(command) && !onThreadScreen) continue;
    if (threadJumpIndex(command) >= 0 && !jumpsApply) continue;
    commands.add(command);
  }
  commands.add("commandPalette");
  if (input.pathname === NEW_TASK_PATHNAME) commands.delete("newTask");
  else commands.add("newTask");
  if (input.pathname !== "/" || input.canGoBack) commands.add("back");
  return [...commands];
}
