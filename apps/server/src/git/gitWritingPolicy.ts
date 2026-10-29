/**
 * The writing policy for one git action's generated commit message and pull request text:
 * the style the project or node chose, its preset, the user's instructions, and, for the
 * repository style, examples read from the repository.
 *
 * GitManager imports this module on the first generated text, so boot never loads it, the
 * presets, or the example reader (guarded in `serverBundleBoundaries.test.ts`).
 */
import { Effect } from "effect";
import type { ServerSettings } from "@ryco/contracts";
import { selectGitWritingStyle } from "@ryco/shared/gitWritingStyle";

import type { PullRequestIndexListing } from "../sourceControl/pullRequestIndex.ts";
import type { TextGenerationPolicy } from "../textGeneration/TextGenerationPolicy.ts";
import {
  GIT_WRITING_STYLE_PRESETS,
  gitWritingPolicy,
} from "../textGeneration/TextGenerationPresets.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import {
  readRecentCommitSubjects,
  readRepositoryWritingExamples,
} from "./repositoryWritingExamples.ts";

export const resolveGitWritingPolicy = (input: {
  readonly cwd: string;
  readonly settings: Pick<
    ServerSettings,
    | "gitWritingStyle"
    | "projectGitWritingStyle"
    | "commitMessageInstructions"
    | "pullRequestInstructions"
  >;
  /** The checkout's project as the server resolved it; null uses the node style. */
  readonly projectId: Effect.Effect<string | null>;
  readonly git: Pick<GitVcsDriverShape, "execute" | "resolvePrimaryRemoteName">;
  /** The repository's already-loaded change request listings (no forge call). */
  readonly peekChangeRequestListings: Effect.Effect<ReadonlyArray<PullRequestIndexListing>>;
}): Effect.Effect<TextGenerationPolicy | undefined> =>
  Effect.gen(function* () {
    const projectId = yield* input.projectId;
    const { style } = selectGitWritingStyle({ settings: input.settings, projectId });
    const repositoryExamples = GIT_WRITING_STYLE_PRESETS[style].inferRepositoryConventions
      ? yield* readRepositoryWritingExamples({
          readCommitSubjects: readRecentCommitSubjects(input.git, input.cwd),
          peekChangeRequestListings: input.peekChangeRequestListings,
        })
      : undefined;
    return gitWritingPolicy({ style, settings: input.settings, repositoryExamples });
  });
