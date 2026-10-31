import {
  PROJECT_PREFERENCE_VALUES,
  type PreferenceSource,
  type ProjectPreferenceValueKey,
  type ServerSettings,
} from "@ryco/contracts/settings";
import * as Schema from "effect/Schema";

interface ProjectPreferenceFieldCopy {
  readonly title: string;
  readonly description: string;
  /** The control's accessible name. */
  readonly controlLabel: string;
  /** How a reset action names the setting, e.g. "Use device default for worktree setup". */
  readonly resetLabel: string;
  /**
   * The node default keeps the row it had before project overrides existed, which older nodes
   * still answer, so the list of node defaults skips it. A project overrides it in its own list.
   */
  readonly nodeDefaultRow?: "separate";
}

/** A choice among fixed values; a boolean shows as two named choices. */
export interface ProjectPreferenceSelectField<
  K extends ProjectPreferenceValueKey,
> extends ProjectPreferenceFieldCopy {
  readonly kind: "select";
  /** In display order; the first stands in while the effective value loads. */
  readonly options: ReadonlyArray<{ readonly value: ServerSettings[K]; readonly label: string }>;
}

/** Free text, trimmed and checked against the setting's schema before it is saved. */
export interface ProjectPreferenceTextField extends ProjectPreferenceFieldCopy {
  readonly kind: "text";
  readonly placeholder: string;
  readonly invalidMessage: string;
}

export type ProjectPreferenceField<K extends ProjectPreferenceValueKey> =
  ServerSettings[K] extends string
    ? ProjectPreferenceSelectField<K> | ProjectPreferenceTextField
    : ProjectPreferenceSelectField<K>;

/**
 * How every settings surface presents each node setting a project may override. A key added to
 * the registry in contracts fails typecheck here until it has a row.
 */
export const PROJECT_PREFERENCE_FIELDS: {
  readonly [K in ProjectPreferenceValueKey]: ProjectPreferenceField<K>;
} = {
  defaultThreadEnvMode: {
    kind: "select",
    title: "New threads",
    description: "Whether new threads work in the project folder or a fresh worktree.",
    controlLabel: "Default thread mode",
    resetLabel: "new threads",
    options: [
      { value: "local", label: "Local" },
      { value: "worktree", label: "New worktree" },
    ],
  },
  worktreeBranchPrefix: {
    kind: "text",
    title: "Worktree branch prefix",
    description:
      "A Git namespace for generated branches. Empty means no prefix; existing branches keep their names.",
    controlLabel: "Worktree branch prefix",
    resetLabel: "worktree branch prefix",
    placeholder: "No prefix",
    invalidMessage: "Use a valid Git namespace of up to 128 characters without a trailing slash.",
  },
  runSetupScript: {
    kind: "select",
    title: "Worktree setup",
    description: "Run the project's setup script after creating a worktree.",
    controlLabel: "Worktree setup",
    resetLabel: "worktree setup",
    options: [
      { value: true, label: "Run setup" },
      { value: false, label: "Skip setup" },
    ],
  },
  worktreeBranchChangeTypes: {
    kind: "select",
    title: "Generated branch names",
    description:
      "Whether generated worktree branches start with the kind of change, such as fix/ or feat/, or with the branch prefix.",
    controlLabel: "Generated branch names",
    resetLabel: "generated branch names",
    nodeDefaultRow: "separate",
    options: [
      { value: true, label: "By change type" },
      { value: false, label: "By prefix" },
    ],
  },
  pullRequestTemplates: {
    kind: "select",
    title: "Pull request template",
    description: "Whether generated pull request descriptions follow the repository's template.",
    controlLabel: "Pull request template",
    resetLabel: "pull request template",
    nodeDefaultRow: "separate",
    options: [
      { value: true, label: "Follow template" },
      { value: false, label: "No template" },
    ],
  },
};

/** The trimmed value a text field saves, or null when the setting's schema rejects it. */
export function readProjectPreferenceText<K extends ProjectPreferenceValueKey>(
  key: K,
  input: string,
): ServerSettings[K] | null {
  const value = input.trim();
  return Schema.is(PROJECT_PREFERENCE_VALUES.fields[key])(value)
    ? (value as ServerSettings[K])
    : null;
}

/** How a value of the setting reads: its option's label, or the text itself (empty shows the placeholder). */
export function projectPreferenceValueLabel(
  key: ProjectPreferenceValueKey,
  value: unknown,
): string {
  const field = PROJECT_PREFERENCE_FIELDS[key];
  if (field.kind === "text") return typeof value === "string" && value ? value : field.placeholder;
  return field.options.find((option) => option.value === value)?.label ?? String(value);
}

/**
 * Where a preference's value comes from, in the words every settings surface uses: a project's
 * own override, or the defaults it inherits. `nodeNoun` names the node those defaults belong to
 * the way the surface does: "device" in the web and desktop app, "node" on the phone, which is a
 * device itself. Undefined while the node's answer loads.
 */
export function projectPreferenceSourceLabel(
  source: PreferenceSource | undefined,
  scope: { readonly projectId?: string | null | undefined; readonly nodeNoun: "device" | "node" },
): string {
  if (source === undefined) return "Loading…";
  if (source === "project" || source === "legacy-project") return "Overridden for this project";
  if (scope.projectId)
    return `Inherited from ${source === "builtin" ? "Ryco" : scope.nodeNoun} defaults`;
  if (source === "builtin") return "Ryco default";
  return scope.nodeNoun === "device" ? "Device default" : "Node default";
}

/** Why an edit made for a project went nowhere: the project was removed meanwhile. */
export const PROJECT_PREFERENCE_PROJECT_GONE = "Project no longer exists.";
