/**
 * Editing a project's actions (scripts) as one list: ids derived from names,
 * add / update / delete, and the rule that only one action sets up new
 * worktrees. Every surface (web chat header, projects page, phone project
 * settings) writes the result with one `project.meta.update`.
 */
import type { ProjectScript, ProjectScriptIcon } from "@ryco/contracts";
import { MAX_SCRIPT_ID_LENGTH } from "@ryco/contracts/keybindings";

export const PROJECT_SCRIPT_ICONS: ReadonlyArray<{
  readonly id: ProjectScriptIcon;
  readonly label: string;
}> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }

  // This last-resort fallback only triggers after exhausting thousands of suffixes.
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

/** What an editor saves for one action; the id is derived (new) or kept (edit). */
export interface ProjectScriptDraft {
  readonly name: string;
  readonly command: string;
  readonly icon: ProjectScriptIcon;
  readonly runOnWorktreeCreate: boolean;
}

/** Why a draft cannot be saved, or null when it can. Name and command are trimmed. */
export function projectScriptDraftError(draft: Pick<ProjectScriptDraft, "name" | "command">) {
  if (draft.name.trim().length === 0) return "Name is required.";
  if (draft.command.trim().length === 0) return "Command is required.";
  return null;
}

/** Only one action runs on new worktrees: turning it on for one turns it off elsewhere. */
const withoutOtherSetup = (scripts: readonly ProjectScript[]): ProjectScript[] =>
  scripts.map((script) =>
    script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
  );

/** The list with a new action appended, and the id it got. */
export function withAddedProjectScript(
  scripts: readonly ProjectScript[],
  draft: ProjectScriptDraft,
): { readonly scripts: ProjectScript[]; readonly scriptId: string } {
  const scriptId = nextProjectScriptId(
    draft.name,
    scripts.map((script) => script.id),
  );
  const script: ProjectScript = {
    id: scriptId,
    name: draft.name,
    command: draft.command,
    icon: draft.icon,
    runOnWorktreeCreate: draft.runOnWorktreeCreate,
  };
  return {
    scriptId,
    scripts: draft.runOnWorktreeCreate
      ? [...withoutOtherSetup(scripts), script]
      : [...scripts, script],
  };
}

/** The list with one action changed in place; throws when it is gone. */
export function withUpdatedProjectScript(
  scripts: readonly ProjectScript[],
  scriptId: string,
  draft: ProjectScriptDraft,
): ProjectScript[] {
  const existing = scripts.find((script) => script.id === scriptId);
  if (!existing) {
    throw new Error("Script not found.");
  }
  const updated: ProjectScript = {
    ...existing,
    name: draft.name,
    command: draft.command,
    icon: draft.icon,
    runOnWorktreeCreate: draft.runOnWorktreeCreate,
  };
  return scripts.map((script) =>
    script.id === scriptId
      ? updated
      : draft.runOnWorktreeCreate
        ? { ...script, runOnWorktreeCreate: false }
        : script,
  );
}

/** The list without one action. */
export function withoutProjectScript(
  scripts: readonly ProjectScript[],
  scriptId: string,
): ProjectScript[] {
  return scripts.filter((script) => script.id !== scriptId);
}
