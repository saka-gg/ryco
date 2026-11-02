import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import type { ThreadJumpKeybindingCommand } from "@ryco/contracts/keybindings";
import { useEffect, useRef } from "react";

/**
 * Commands the native key-command view can send. The identifiers match
 * `RycoKeyboardCommandsModule.swift`, which only offers a command while it is
 * in the view's `enabledCommands`.
 */
export type HardwareKeyboardCommand =
  | ThreadJumpKeybindingCommand
  | "commandPalette"
  | "paletteNext"
  | "palettePrevious"
  | "paletteDismiss"
  | "newTask"
  | "focusSearch"
  | "back"
  | "files"
  | "terminal"
  | "review"
  | "toggleSidebar";

type JumpPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
const jumpCommand = (position: JumpPosition): ThreadJumpKeybindingCommand =>
  `thread.jump.${position}`;

/**
 * Command-1 through Command-9, in order. Built here rather than imported, so the
 * launch graph does not evaluate the keybinding schemas for nine strings.
 */
export const THREAD_JUMP_COMMANDS: ReadonlyArray<ThreadJumpKeybindingCommand> = (
  [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
).map(jumpCommand);

/** The zero-based position a jump command picks, or -1 for any other command. */
export function threadJumpIndex(command: HardwareKeyboardCommand): number {
  return THREAD_JUMP_COMMANDS.indexOf(command as ThreadJumpKeybindingCommand);
}

type CommandHandler = (command: HardwareKeyboardCommand) => boolean | void;

const handlers = new Map<HardwareKeyboardCommand, Set<CommandHandler>>();
const registrationListeners = new Set<() => void>();
// Replaced, never mutated, when the set of registered commands changes, so it
// is a stable `useSyncExternalStore` snapshot in between.
let registeredCommands: ReadonlySet<HardwareKeyboardCommand> = new Set();

function publishRegistrations(): void {
  const commands = [...handlers.keys()];
  if (
    commands.length === registeredCommands.size &&
    commands.every((command) => registeredCommands.has(command))
  ) {
    return;
  }
  registeredCommands = new Set(commands);
  registrationListeners.forEach((listener) => listener());
}

/**
 * Adds a handler for a command and returns its removal. The most recently
 * registered handler gets the first chance to consume the command.
 */
export function registerHardwareKeyboardCommand(
  command: HardwareKeyboardCommand | ReadonlyArray<HardwareKeyboardCommand>,
  handler: CommandHandler,
): () => void {
  const commands: ReadonlyArray<HardwareKeyboardCommand> =
    typeof command === "string" ? [command] : command;
  for (const each of commands) {
    const commandHandlers = handlers.get(each) ?? new Set<CommandHandler>();
    commandHandlers.add(handler);
    handlers.set(each, commandHandlers);
  }
  publishRegistrations();
  return () => {
    for (const each of commands) {
      const commandHandlers = handlers.get(each);
      commandHandlers?.delete(handler);
      if (commandHandlers?.size === 0) handlers.delete(each);
    }
    publishRegistrations();
  };
}

/**
 * Registers a context-specific hardware-keyboard action. The most recently mounted handler gets
 * the first chance to consume the command, allowing focused screens to override app defaults.
 * Without a handler nothing is registered, so a screen can offer a command only while it applies.
 * A list (keep it stable) registers one handler for several commands; it receives the command.
 *
 * The latest handler runs, but the registration changes only when the command starts or stops
 * applying: a handler rebuilt for new data (the inbox's rows, on every live update) must not
 * re-send the native view its commands, which makes it give up and retake first responder.
 */
export function useHardwareKeyboardCommand(
  command: HardwareKeyboardCommand | ReadonlyArray<HardwareKeyboardCommand>,
  handler: CommandHandler | undefined,
): void {
  const latestHandler = useRef(handler);
  useEffect(() => {
    latestHandler.current = handler;
  });
  const applies = handler !== undefined;
  useEffect(() => {
    if (!applies) return undefined;
    return registerHardwareKeyboardCommand(command, (received) =>
      latestHandler.current?.(received),
    );
  }, [applies, command]);
}

/** The commands with at least one handler; the same set until a registration changes. */
export function getRegisteredHardwareKeyboardCommands(): ReadonlySet<HardwareKeyboardCommand> {
  return registeredCommands;
}

export function subscribeToHardwareKeyboardCommandRegistrations(listener: () => void): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

export function dispatchHardwareKeyboardCommand(command: HardwareKeyboardCommand): boolean {
  const commandHandlers = handlers.get(command);
  if (!commandHandlers) return false;
  for (const handler of [...commandHandlers].toReversed()) {
    if (handler(command) !== false) return true;
  }
  return false;
}

export function parseActiveThreadPath(pathname: string): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
} | null {
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      environmentId: EnvironmentId.make(decodeURIComponent(match[1])),
      threadId: ThreadId.make(decodeURIComponent(match[2])),
    };
  } catch {
    return null;
  }
}
