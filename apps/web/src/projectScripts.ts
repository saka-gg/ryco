import { nextProjectScriptId } from "@ryco/client-runtime/projectSettings/scripts";
import {
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectScript,
} from "@ryco/contracts";
import { Schema } from "effect";

export { nextProjectScriptId };

export const commandForProjectScript = (scriptId: string): KeybindingCommand =>
  SCRIPT_RUN_COMMAND_PATTERN.make(`script.${scriptId}.run`);

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!Schema.is(SCRIPT_RUN_COMMAND_PATTERN)(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function primaryProjectScript(scripts: ProjectScript[]): ProjectScript | null {
  const regular = scripts.find((script) => !script.runOnWorktreeCreate);
  return regular ?? scripts[0] ?? null;
}
