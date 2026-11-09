/**
 * Release notes for GitHub releases and the release-notes automation.
 *
 * The editorial notes live in `@ryco/shared/releaseNotes` (also the marketing
 * site's changelog and the app's What's new). A GitHub release opens with the
 * same entry, between markers, above the install notes and GitHub's generated
 * pull-request list; `docs/release-notes.md` describes the whole flow.
 */
import {
  CHANGELOG_PAGE_URL,
  CHANGELOG_RELEASES,
  type ChangelogRelease,
} from "@ryco/shared/releaseNotes";

export const RELEASE_NOTES_START_MARKER = "<!-- ryco-release-notes:start -->";
export const RELEASE_NOTES_END_MARKER = "<!-- ryco-release-notes:end -->";

/** "v0.1.44" and "0.1.44" both name release 0.1.44. */
export function normalizeReleaseVersion(version: string): string {
  return version.trim().replace(/^v/u, "");
}

export function findReleaseNotes(
  version: string,
  releases: ReadonlyArray<ChangelogRelease> = CHANGELOG_RELEASES,
): ChangelogRelease | undefined {
  const normalized = normalizeReleaseVersion(version);
  return releases.find((release) => release.version === normalized);
}

/** The release's notes as the top section of its GitHub release, markers included. */
export function renderReleaseNotesMarkdown(release: ChangelogRelease): string {
  const highlights = release.highlights.map(
    (highlight) => `- **${highlight.title}.** ${highlight.summary}`,
  );
  return [
    RELEASE_NOTES_START_MARKER,
    `## What's new in Ryco ${release.version}`,
    "",
    release.summary,
    "",
    ...highlights,
    "",
    `[All release notes](${CHANGELOG_PAGE_URL})`,
    RELEASE_NOTES_END_MARKER,
  ].join("\n");
}

/**
 * Puts `section` at the top of a release body: in place of an earlier section
 * between the markers, or above everything else. Running it again with the same
 * section changes nothing.
 */
export function mergeReleaseNotesIntoBody(body: string, section: string): string {
  const start = body.indexOf(RELEASE_NOTES_START_MARKER);
  const end = body.indexOf(RELEASE_NOTES_END_MARKER);
  if (start !== -1 && end > start) {
    return `${body.slice(0, start)}${section}${body.slice(end + RELEASE_NOTES_END_MARKER.length)}`;
  }
  const rest = body.trim();
  return rest.length === 0 ? `${section}\n` : `${section}\n\n${rest}\n`;
}

export interface ReleaseCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface ReleaseNotesPullRequest {
  readonly number: number | null;
  readonly title: string;
  readonly sha: string;
}

/** What the release-notes automation receives (`docs/release-notes.md`). */
export interface ReleaseNotesRequest {
  readonly kind: "ryco.release-notes.request";
  readonly version: string;
  readonly previousTag: string | null;
  readonly headSha: string;
  readonly repository: string;
  readonly compareUrl: string | null;
  /** Where the entry goes; the automation follows `docs/release-notes.md`. */
  readonly notesFile: "packages/shared/src/releaseNotes.ts";
  readonly instructions: "docs/release-notes.md";
  readonly changes: ReadonlyArray<ReleaseNotesPullRequest>;
}

const RELEASE_PREPARE_SUBJECT = /^chore\(release\): prepare v/u;
const PULL_REQUEST_SUFFIX = /\s+\(#(\d+)\)$/u;

/** One change per commit, newest first, without the release workflow's own version bumps. */
export function releaseChangesFromCommits(
  commits: ReadonlyArray<ReleaseCommit>,
): ReleaseNotesPullRequest[] {
  return commits
    .filter((commit) => !RELEASE_PREPARE_SUBJECT.test(commit.subject))
    .map((commit) => {
      const match = PULL_REQUEST_SUFFIX.exec(commit.subject);
      return {
        number: match ? Number(match[1]) : null,
        title: match ? commit.subject.slice(0, match.index) : commit.subject,
        sha: commit.sha,
      };
    });
}

export function buildReleaseNotesRequest(input: {
  readonly version: string;
  readonly previousTag: string | null;
  readonly headSha: string;
  readonly repository: string;
  readonly commits: ReadonlyArray<ReleaseCommit>;
}): ReleaseNotesRequest {
  const version = normalizeReleaseVersion(input.version);
  return {
    kind: "ryco.release-notes.request",
    version,
    previousTag: input.previousTag,
    headSha: input.headSha,
    repository: input.repository,
    compareUrl: input.previousTag
      ? `https://github.com/${input.repository}/compare/${input.previousTag}...${input.headSha}`
      : null,
    notesFile: "packages/shared/src/releaseNotes.ts",
    instructions: "docs/release-notes.md",
    changes: releaseChangesFromCommits(input.commits),
  };
}

/** Parses `git log --format=%H%x1f%s` output. */
export function parseGitLogSubjects(output: string): ReleaseCommit[] {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("\u001f");
      return separator === -1
        ? { sha: line, subject: "" }
        : { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
    });
}
