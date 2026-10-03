import { keybindingCommandScopesOverlap } from "@ryco/client-runtime/state/settings";
import type { KeybindingRule } from "@ryco/contracts";

export interface ConflictEntry {
  readonly key: string;
  readonly otherCommand: KeybindingRule["command"];
  readonly otherWhen: string | undefined;
}

/**
 * Determine whether two `when` strings describe the *same* context.
 *
 * Matches the server's `hasSameShortcutContext` heuristic: a rule's
 * "context" is exactly its `when` string (treating `undefined` as the empty
 * context). Two rules collide only when their context strings are identical.
 *
 * This means `thread.jump.1` (when=undefined) and `modelPicker.jump.1`
 * (when="modelPickerOpen") are NOT considered conflicting — the runtime's
 * last-rule-wins ordering resolves them correctly: the more specific rule
 * fires when its context is active, the default fires otherwise.
 *
 * A true conflict only exists when two commands share both the same shortcut
 * AND the same `when` string — at runtime there's no rule for which one wins
 * beyond "whichever came later in the file", which the user almost certainly
 * didn't intend.
 */
function whenContextsOverlap(left: string | undefined, right: string | undefined): boolean {
  const l = left === undefined ? "" : left.replace(/\s+/g, "");
  const r = right === undefined ? "" : right.replace(/\s+/g, "");
  return l === r;
}

/**
 * Detect conflicts between the rule at `targetIndex` in `draft` and every
 * other rule. Returns one entry per conflicting rule.
 */
export function detectConflictsAt(
  draft: ReadonlyArray<KeybindingRule>,
  targetIndex: number,
): ReadonlyArray<ConflictEntry> {
  const target = draft[targetIndex];
  if (!target) return [];
  const conflicts: ConflictEntry[] = [];
  draft.forEach((other, index) => {
    if (index === targetIndex) return;
    if (other.command === target.command) return;
    if (!keybindingCommandScopesOverlap(other.command, target.command)) return;
    if (other.key !== target.key) return;
    if (!whenContextsOverlap(other.when, target.when)) return;
    conflicts.push({
      key: target.key,
      otherCommand: other.command,
      otherWhen: other.when,
    });
  });
  return conflicts;
}

/**
 * Aggregate conflicts per row by command. The map's value is the list of
 * conflicts for any binding of that command.
 */
export function buildConflictIndex(
  draft: ReadonlyArray<KeybindingRule>,
): ReadonlyMap<KeybindingRule["command"], ReadonlyArray<ConflictEntry>> {
  const byCommand = new Map<KeybindingRule["command"], ConflictEntry[]>();
  draft.forEach((_rule, index) => {
    const conflicts = detectConflictsAt(draft, index);
    if (conflicts.length === 0) return;
    const command = draft[index]!.command;
    const existing = byCommand.get(command) ?? [];
    existing.push(...conflicts);
    byCommand.set(command, existing);
  });
  return byCommand;
}
