import type {
  GitWritingStyle,
  ServerSettings,
  ServerSettingsPatch,
} from "@ryco/contracts/settings";

/** Options in display order; the first is the default. Shared by every settings surface. */
export const GIT_WRITING_STYLE_OPTIONS = [
  {
    value: "repository",
    label: "Repository style",
    description: "Follow the style of recent commits and merged pull requests.",
  },
  {
    value: "conventional",
    label: "Conventional Commits",
    description: "Start commit subjects and pull request titles with a type, such as feat or fix.",
  },
  {
    value: "default",
    label: "Standard",
    description: "Short imperative subjects, and descriptions with Summary and Testing.",
  },
] as const satisfies ReadonlyArray<{
  readonly value: GitWritingStyle;
  readonly label: string;
  readonly description: string;
}>;

/** The node default when nothing is set (matches the settings schema's decoding default). */
export const DEFAULT_GIT_WRITING_STYLE: GitWritingStyle = "repository";

/** A project's own style wins; a missing or null entry inherits the node default. */
export function selectGitWritingStyle(input: {
  readonly settings: Pick<ServerSettings, "gitWritingStyle" | "projectGitWritingStyle">;
  readonly projectId?: string | null | undefined;
}): { readonly style: GitWritingStyle; readonly source: "project" | "node" } {
  const override =
    input.projectId && Object.hasOwn(input.settings.projectGitWritingStyle, input.projectId)
      ? input.settings.projectGitWritingStyle[input.projectId]
      : null;
  return override != null
    ? { style: override, source: "project" }
    : { style: input.settings.gitWritingStyle, source: "node" };
}

/** Sets the node default, or one project's override (null inherits again). */
export function gitWritingStylePatch(
  projectId: string | null,
  style: GitWritingStyle | null,
): ServerSettingsPatch {
  return projectId
    ? { projectGitWritingStyle: { [projectId]: style } }
    : { gitWritingStyle: style ?? DEFAULT_GIT_WRITING_STYLE };
}
