import { normalizeGitRemoteUrl, parseChangeRequestUrl } from "@ryco/shared/git";

import { parsePullRequestReference } from "../../../pullRequestReference";
import type { ProjectCheckoutOption } from "../../../projectCheckouts.logic";

/**
 * What the list's search field does with a pasted link or `#123`: open that
 * pull request here, switch to the repository it belongs to, or hand the link
 * to the host when Ryco does not know the repository.
 */

/** Shortest query that falls back to the host's search when nothing loaded matches. */
export const PULL_REQUEST_SERVER_SEARCH_MIN_LENGTH = 2;
export const PULL_REQUEST_SEARCH_DEBOUNCE_MS = 150;

export type PullRequestLinkTarget =
  | { readonly kind: "number"; readonly number: number }
  | {
      readonly kind: "url";
      readonly number: number;
      readonly url: string;
      /** `host/owner/repo`, comparable with `ProjectCheckoutOption.repositoryKey`. */
      readonly repositoryKey: string;
    };

/**
 * A pasted link, `#123` or `123`; null for anything else (plain search text).
 * Links are read on every host Ryco knows (Bitbucket and self-hosted ones
 * included), not only the shapes a checkout command accepts.
 */
export function parsePullRequestLinkTarget(text: string): PullRequestLinkTarget | null {
  const reference = parsePullRequestReference(text) ?? text.trim();
  if (/^\d+$/u.test(reference)) {
    const number = Number(reference);
    return Number.isSafeInteger(number) && number > 0 ? { kind: "number", number } : null;
  }
  const link = parseChangeRequestUrl(reference);
  if (link === null) return null;
  return {
    kind: "url",
    number: link.number,
    url: reference,
    repositoryKey: normalizeGitRemoteUrl(link.repositoryUrl),
  };
}

export type PullRequestLinkResolution =
  /** The current repository: select the number. */
  | { readonly kind: "current"; readonly number: number }
  /** Another repository Ryco knows: switch to it, then select. */
  | {
      readonly kind: "switch";
      readonly number: number;
      readonly repository: ProjectCheckoutOption;
    }
  /** A repository Ryco does not know: offer to open the link on the host. */
  | { readonly kind: "external"; readonly number: number; readonly url: string };

function repositoryKeyMatches(option: ProjectCheckoutOption, key: string): boolean {
  const optionKey = option.repositoryKey.toLowerCase();
  return optionKey === key || optionKey.startsWith(`${key}::`);
}

/**
 * Where a parsed link points. A URL belongs to the current repository when its
 * repository key matches the current checkout's, or when it matches a loaded
 * row's own URL (checkouts grouped "separately" carry path keys, not remotes).
 */
export function resolvePullRequestLink(input: {
  readonly target: PullRequestLinkTarget;
  readonly current: ProjectCheckoutOption | null;
  readonly repositories: ReadonlyArray<ProjectCheckoutOption>;
  /** URLs of loaded rows in the current repository. */
  readonly knownUrls: Iterable<string>;
}): PullRequestLinkResolution {
  const { target } = input;
  if (target.kind === "number") return { kind: "current", number: target.number };
  const key = target.repositoryKey.toLowerCase();
  if (input.current && repositoryKeyMatches(input.current, key)) {
    return { kind: "current", number: target.number };
  }
  for (const url of input.knownUrls) {
    const known = parsePullRequestLinkTarget(url);
    if (known?.kind === "url" && known.repositoryKey.toLowerCase() === key) {
      return { kind: "current", number: target.number };
    }
  }
  const matches = input.repositories.filter((option) => repositoryKeyMatches(option, key));
  const repository = matches.find((option) => option.isRepresentative) ?? matches[0];
  return repository
    ? { kind: "switch", number: target.number, repository }
    : { kind: "external", number: target.number, url: target.url };
}
