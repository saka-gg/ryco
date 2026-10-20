import type { ServerSettings } from "@ryco/contracts";

import type { TextGenerationPolicy, TextGenerationPolicyKind } from "./TextGenerationPolicy.ts";

export const defaultTextGenerationPolicy: TextGenerationPolicy = {
  kind: "default",
  inferRepositoryConventions: false,
};

export const conventionalCommitsTextGenerationPolicy: TextGenerationPolicy = {
  kind: "conventional_commits",
  commitInstructions:
    "Use Conventional Commits when generating commit subjects. Prefer the narrowest accurate type and include a scope only when it is obvious from the diff.",
  changeRequestInstructions:
    "Keep the change request title concise. Do not force Conventional Commit syntax into the title unless the repository already uses it.",
  inferRepositoryConventions: false,
};

export const repositoryConventionsTextGenerationPolicy: TextGenerationPolicy = {
  kind: "repo_conventions",
  commitInstructions:
    "Follow the repository's established commit message style when examples are available.",
  changeRequestInstructions:
    "Follow the repository's established change request title and body style when examples are available.",
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

/** The user's Git writing instructions from settings, or nothing when none are set. */
export const gitWritingPolicyFromSettings = (
  settings: Pick<ServerSettings, "commitMessageInstructions" | "pullRequestInstructions">,
): TextGenerationPolicy | undefined => {
  const commitInstructions = settings.commitMessageInstructions.trim();
  const changeRequestInstructions = settings.pullRequestInstructions.trim();
  if (!commitInstructions && !changeRequestInstructions) return undefined;
  return customTextGenerationPolicy({
    ...(commitInstructions ? { commitInstructions } : {}),
    ...(changeRequestInstructions ? { changeRequestInstructions } : {}),
  });
};
