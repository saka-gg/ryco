import {
  PROJECT_PREFERENCE_VALUES,
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
