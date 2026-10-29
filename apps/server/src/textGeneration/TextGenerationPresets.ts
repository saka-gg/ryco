import type { GitWritingStyle, ServerSettings } from "@ryco/contracts";

import type {
  RepositoryWritingExamples,
  TextGenerationPolicy,
  TextGenerationPolicyKind,
} from "./TextGenerationPolicy.ts";

export const defaultTextGenerationPolicy: TextGenerationPolicy = {
  kind: "default",
  inferRepositoryConventions: false,
};

export const conventionalCommitsTextGenerationPolicy: TextGenerationPolicy = {
  kind: "conventional_commits",
  commitStyle:
    "Use Conventional Commits for the subject: type(scope): description or type: description, with a standard type (feat, fix, refactor, perf, docs, test, build, ci, chore, style or revert). Add a short scope only when the diff makes it obvious.",
  // A squash merge turns the pull request title into the commit subject.
  changeRequestStyle:
    "Write the title as a Conventional Commit subject too, since a squash merge turns it into the commit subject. Keep the description concise.",
  inferRepositoryConventions: false,
};

export const repositoryConventionsTextGenerationPolicy: TextGenerationPolicy = {
  kind: "repo_conventions",
  commitStyle:
    "Match the tone, capitalization, length and any prefixes of the repository's example commit subjects.",
  changeRequestStyle:
    "Match the tone, capitalization and prefixes of the repository's example pull request titles.",
  inferRepositoryConventions: true,
};

export const customTextGenerationPolicy = (
  overrides: Omit<Partial<TextGenerationPolicy>, "kind">,
): TextGenerationPolicy => ({
  kind: "custom",
  inferRepositoryConventions: false,
  ...overrides,
});

export const textGenerationPresets: Record<
  Exclude<TextGenerationPolicyKind, "custom">,
  TextGenerationPolicy
> = {
  default: defaultTextGenerationPolicy,
  conventional_commits: conventionalCommitsTextGenerationPolicy,
  repo_conventions: repositoryConventionsTextGenerationPolicy,
};

/** The preset behind each Git writing style setting. */
export const GIT_WRITING_STYLE_PRESETS: Record<GitWritingStyle, TextGenerationPolicy> = {
  default: defaultTextGenerationPolicy,
  repository: repositoryConventionsTextGenerationPolicy,
  conventional: conventionalCommitsTextGenerationPolicy,
};

/**
 * The style's preset, the user's commit and pull request instructions on top, and the
 * repository examples when the style reads them. Undefined when nothing would change the
 * standard prompts (the standard style without instructions).
 */
export function gitWritingPolicy(input: {
  readonly style: GitWritingStyle;
  readonly settings: Pick<ServerSettings, "commitMessageInstructions" | "pullRequestInstructions">;
  readonly repositoryExamples?: RepositoryWritingExamples | undefined;
}): TextGenerationPolicy | undefined {
  const preset = GIT_WRITING_STYLE_PRESETS[input.style];
  const commitInstructions = input.settings.commitMessageInstructions.trim();
  const changeRequestInstructions = input.settings.pullRequestInstructions.trim();
  const instructions = {
    ...(commitInstructions ? { commitInstructions } : {}),
    ...(changeRequestInstructions ? { changeRequestInstructions } : {}),
  };
  if (preset.kind === "default") {
    return commitInstructions || changeRequestInstructions
      ? customTextGenerationPolicy(instructions)
      : undefined;
  }
  return {
    ...preset,
    ...instructions,
    ...(preset.inferRepositoryConventions && input.repositoryExamples
      ? { repositoryExamples: input.repositoryExamples }
      : {}),
  };
}
