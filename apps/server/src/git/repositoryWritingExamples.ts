/**
 * Style references for the repository writing style: recent commit subjects from the default
 * branch's first-parent history, and the titles of merged pull requests the change request
 * index already holds (never a forge call). Untrusted text: the prompts quote it as JSON.
 *
 * Loaded on first use through `gitWritingPolicy.ts`, never at boot.
 */
import { Effect, Option } from "effect";
import { timeoutWhileResponsiveOption } from "@ryco/shared/responsiveDeadline";
import { truncateUnicodeSafe } from "@ryco/shared/String";

import type { PullRequestIndexListing } from "../sourceControl/pullRequestIndex.ts";
import type { RepositoryWritingExamples } from "../textGeneration/TextGenerationPolicy.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import { DEFAULT_BASE_BRANCH_CANDIDATES } from "../vcs/GitVcsDriverCore.ts";

/** Synara's limits: ten examples of each kind, each at most 300 characters. */
export const REPOSITORY_WRITING_EXAMPLE_LIMIT = 10;
export const REPOSITORY_WRITING_EXAMPLE_MAX_CHARS = 300;
/** First-parent commits read before merge commits are dropped. */
const FIRST_PARENT_SCAN = 30;
/** Fewer non-merge subjects than this: a merge-commit workflow, so read `--no-merges` too. */
const MIN_FIRST_PARENT_SUBJECTS = 3;
/**
 * Per git process, and for the whole read (Synara: a 3 second `timeoutOption`). Like the git
 * driver's own deadline, a server stall or machine sleep does not count toward it.
 */
const EXAMPLE_READ_TIMEOUT_MS = 3_000;
const EXAMPLE_READ_MAX_BYTES = 64 * 1024;
const FIELD_SEPARATOR = "\u001f";

// C0 and C1 control characters and DEL; a subject is one line of plain text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/gu;

/** Trimmed, control characters removed, deduplicated, at most ten of at most 300 characters. */
export function boundWritingExamples(values: Iterable<string>): ReadonlyArray<string> {
  const examples: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = truncateUnicodeSafe(
      value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim(),
      REPOSITORY_WRITING_EXAMPLE_MAX_CHARS,
    ).trimEnd();
    if (cleaned.length === 0 || seen.has(cleaned)) continue;
    seen.add(cleaned);
    examples.push(cleaned);
    if (examples.length === REPOSITORY_WRITING_EXAMPLE_LIMIT) break;
  }
  return examples;
}

/**
 * Subjects of `git log --format=%P%x1f%s` records that are not merges (two or more parents).
 * A last record without its newline (output cut at the byte cap) is ignored.
 */
export function parseFirstParentSubjects(stdout: string): ReadonlyArray<string> {
  const records = stdout.split("\n");
  records.pop();
  return records.flatMap((record) => {
    const separator = record.indexOf(FIELD_SEPARATOR);
    if (separator < 0) return [];
    const parents = record.slice(0, separator).trim();
    const isMerge = parents.split(/\s+/u).length > 1;
    return isMerge ? [] : [record.slice(separator + 1)];
  });
}

/** Titles of merged change requests in index order (newest first), once each. */
export function mergedChangeRequestTitles(
  listings: ReadonlyArray<PullRequestIndexListing>,
): ReadonlyArray<string> {
  const seen = new Set<number>();
  const titles: string[] = [];
  for (const listing of listings) {
    for (const item of listing.items) {
      if (item.state !== "merged" || seen.has(item.number)) continue;
      seen.add(item.number);
      titles.push(item.title);
    }
  }
  return titles;
}

type ExampleGit = Pick<GitVcsDriverShape, "execute" | "resolvePrimaryRemoteName">;

const readGit = (git: ExampleGit, cwd: string, operation: string, args: ReadonlyArray<string>) =>
  git.execute({
    operation: `repositoryWritingExamples.${operation}`,
    cwd,
    args,
    readOnly: true,
    allowNonZeroExit: true,
    timeoutMs: EXAMPLE_READ_TIMEOUT_MS,
    maxOutputBytes: EXAMPLE_READ_MAX_BYTES,
    truncateOutputAtMaxBytes: true,
  });

/**
 * The ref whose history is the repository's accepted style, without the checkout's own work in
 * progress: the primary remote's default branch (its recorded HEAD, else its main or master),
 * else local main or master, else HEAD.
 */
export const resolveAcceptedHistoryRef = Effect.fn("resolveAcceptedHistoryRef")(function* (
  git: ExampleGit,
  cwd: string,
) {
  const remoteName = yield* git
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  const candidates = [
    ...(remoteName === null
      ? []
      : [
          `refs/remotes/${remoteName}/HEAD`,
          ...DEFAULT_BASE_BRANCH_CANDIDATES.map((name) => `refs/remotes/${remoteName}/${name}`),
        ]),
    ...DEFAULT_BASE_BRANCH_CANDIDATES.map((name) => `refs/heads/${name}`),
  ];
  // One process lists whichever candidates exist; a dangling remote HEAD is not listed.
  const result = yield* readGit(git, cwd, "refs", [
    "for-each-ref",
    "--format=%(refname)",
    ...candidates,
  ]);
  const existing = new Set(result.exitCode === 0 ? result.stdout.split(/\r?\n/u) : []);
  return candidates.find((ref) => existing.has(ref)) ?? "HEAD";
});

const LOG_ARGS = ["log", "--no-show-signature", "--no-color", "--encoding=UTF-8"] as const;

/**
 * Up to ten recent commit subjects of the accepted history. Squash and rebase workflows give
 * first-parent subjects; a merge-commit workflow, where first-parent history is mostly merges,
 * also reads non-merge commits. Never fails: errors, timeouts and empty repositories give none.
 */
export const readRecentCommitSubjects = (
  git: ExampleGit,
  cwd: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const ref = yield* resolveAcceptedHistoryRef(git, cwd);
    const firstParent = yield* readGit(git, cwd, "firstParentLog", [
      ...LOG_ARGS,
      "--first-parent",
      "-n",
      String(FIRST_PARENT_SCAN),
      "--format=%P%x1f%s",
      ref,
      "--",
    ]);
    if (firstParent.exitCode !== 0) return [];
    const subjects = boundWritingExamples(parseFirstParentSubjects(firstParent.stdout));
    if (subjects.length >= MIN_FIRST_PARENT_SUBJECTS) return subjects;
    const nonMerge = yield* readGit(git, cwd, "nonMergeLog", [
      ...LOG_ARGS,
      "--no-merges",
      "-n",
      String(REPOSITORY_WRITING_EXAMPLE_LIMIT),
      "--format=%s",
      ref,
      "--",
    ]);
    if (nonMerge.exitCode !== 0) return subjects;
    const lines = nonMerge.stdout.split("\n");
    // Without the last newline the output was cut mid-subject.
    if (!nonMerge.stdout.endsWith("\n")) lines.pop();
    return boundWritingExamples([...subjects, ...lines]);
  }).pipe(
    timeoutWhileResponsiveOption(EXAMPLE_READ_TIMEOUT_MS),
    Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
    Effect.catch((error) =>
      Effect.logDebug("repository writing examples: commit subjects unavailable", {
        cwd,
        detail: error.message,
      }).pipe(Effect.as([])),
    ),
  );

/** Commit subjects and merged pull request titles, read concurrently. Never fails. */
export const readRepositoryWritingExamples = (input: {
  readonly readCommitSubjects: Effect.Effect<ReadonlyArray<string>>;
  readonly peekChangeRequestListings: Effect.Effect<ReadonlyArray<PullRequestIndexListing>>;
}): Effect.Effect<RepositoryWritingExamples> =>
  Effect.all(
    [
      input.readCommitSubjects,
      input.peekChangeRequestListings.pipe(Effect.map(mergedChangeRequestTitles)),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.map(([commitSubjects, titles]) => ({
      commitSubjects,
      pullRequestTitles: boundWritingExamples(titles),
    })),
  );
