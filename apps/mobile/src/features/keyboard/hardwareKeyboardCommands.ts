import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import { useEffect } from "react";

export type HardwareKeyboardCommand =
  | "newTask"
  | "focusSearch"
  | "back"
  | "files"
  | "terminal"
  | "review"
  | "toggleSidebar";

type CommandHandler = () => boolean | void;

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
  command: HardwareKeyboardCommand,
  handler: CommandHandler,
): () => void {
  const commandHandlers = handlers.get(command) ?? new Set<CommandHandler>();
  commandHandlers.add(handler);
  handlers.set(command, commandHandlers);
  publishRegistrations();
  return () => {
    commandHandlers.delete(handler);
    if (commandHandlers.size === 0) handlers.delete(command);
    publishRegistrations();
  };
}

/**
 * Registers a context-specific hardware-keyboard action. The most recently mounted handler gets
 * the first chance to consume the command, allowing focused screens to override app defaults.
 */
export function useHardwareKeyboardCommand(
  command: HardwareKeyboardCommand,
  handler: CommandHandler,
): void {
  useEffect(() => registerHardwareKeyboardCommand(command, handler), [command, handler]);
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
    if (handler() !== false) return true;
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
