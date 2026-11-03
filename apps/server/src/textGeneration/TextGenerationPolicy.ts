import { Schema } from "effect";

export const TextGenerationPolicyKind = Schema.Literals([
  "default",
  "conventional_commits",
  "repo_conventions",
  "custom",
]);
export type TextGenerationPolicyKind = typeof TextGenerationPolicyKind.Type;

/**
 * Style references read from the repository: recent commit subjects and the titles of merged
 * pull requests. Untrusted text; the prompts quote it as JSON and never follow it.
 */
export const RepositoryWritingExamples = Schema.Struct({
  commitSubjects: Schema.Array(Schema.String),
  pullRequestTitles: Schema.Array(Schema.String),
});
export type RepositoryWritingExamples = typeof RepositoryWritingExamples.Type;

/** The repository's pull request template, read from the base branch, and how to fill it. */
export const ChangeRequestTemplatePolicy = Schema.Struct({
  path: Schema.String,
  /** The template as the model sees it (untrusted repository text); a shortened one says so. */
  body: Schema.String,
  /** The preset's body rules, which replace Summary and Testing (Ryco's own guidance). */
  rules: Schema.Array(Schema.String),
});
export type ChangeRequestTemplatePolicy = typeof ChangeRequestTemplatePolicy.Type;

export const TextGenerationPolicy = Schema.Struct({
  kind: TextGenerationPolicyKind,
  /** The user's own instructions; they rank above the style below. */
  commitInstructions: Schema.optional(Schema.String),
  changeRequestInstructions: Schema.optional(Schema.String),
  branchInstructions: Schema.optional(Schema.String),
  threadTitleInstructions: Schema.optional(Schema.String),
  issueInstructions: Schema.optional(Schema.String),
  /** The style preset's own guidance; ranks below the user's instructions. */
  commitStyle: Schema.optional(Schema.String),
  changeRequestStyle: Schema.optional(Schema.String),
  /**
   * Only for text generation that runs without tools (`TextGenerationShape.gitWritingToolFree`):
   * the text generation router drops it for every other provider instance.
   */
  repositoryExamples: Schema.optional(RepositoryWritingExamples),
  /** The structure of generated pull request bodies; tool-free providers only, as above. */
  changeRequestTemplate: Schema.optional(ChangeRequestTemplatePolicy),
  inferRepositoryConventions: Schema.Boolean,
});
export type TextGenerationPolicy = typeof TextGenerationPolicy.Type;
