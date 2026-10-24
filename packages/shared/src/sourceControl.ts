import type {
  SourceControlCommentAuthorRole,
  SourceControlProviderInfo,
  SourceControlProviderKind,
} from "@ryco/contracts";

export interface ChangeRequestPresentation {
  readonly icon: "github" | "gitlab" | "forgejo" | "azure-devops" | "bitbucket" | "change-request";
  readonly providerName: string;
  readonly shortName: string;
  readonly longName: string;
  readonly pluralLongName: string;
  readonly providerLongName: string;
  readonly checkoutCommandExample?: string;
  readonly urlExample: string;
}

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

export const DEFAULT_CHANGE_REQUEST_TERMINOLOGY: ChangeRequestTerminology = {
  shortLabel: "PR",
  singular: "pull request",
};

const GITHUB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "github",
  providerName: "GitHub",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "GitHub pull request",
  checkoutCommandExample: "gh pr checkout 123",
  urlExample: "https://github.com/owner/repo/pull/42",
};

const GITLAB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "gitlab",
  providerName: "GitLab",
  shortName: "MR",
  longName: "merge request",
  pluralLongName: "merge requests",
  providerLongName: "GitLab merge request",
  checkoutCommandExample: "glab mr checkout 123",
  urlExample: "https://gitlab.com/group/project/-/merge_requests/42",
};

const FORGEJO_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "forgejo",
  providerName: "Forgejo",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Forgejo pull request",
  urlExample: "https://codeberg.org/owner/repo/pulls/42",
};

const AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "azure-devops",
  providerName: "Azure DevOps",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Azure DevOps pull request",
  checkoutCommandExample: "az repos pr checkout --id 123",
  urlExample: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
};

const BITBUCKET_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "bitbucket",
  providerName: "Bitbucket",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Bitbucket pull request",
  urlExample: "https://bitbucket.org/workspace/repo/pull-requests/42",
};

const GENERIC_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "change-request",
  providerName: "source control",
  shortName: "change request",
  longName: "change request",
  pluralLongName: "change requests",
  providerLongName: "change request",
  urlExample: "#42",
};

export function resolveChangeRequestPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestPresentation {
  switch (provider?.kind) {
    case "github":
    case undefined:
      return GITHUB_CHANGE_REQUEST_PRESENTATION;
    case "gitlab":
      return GITLAB_CHANGE_REQUEST_PRESENTATION;
    case "forgejo":
      return FORGEJO_CHANGE_REQUEST_PRESENTATION;
    case "azure-devops":
      return AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION;
    case "bitbucket":
      return BITBUCKET_CHANGE_REQUEST_PRESENTATION;
    case "unknown":
      return GENERIC_CHANGE_REQUEST_PRESENTATION;
  }
}

export function resolveChangeRequestPresentationForKind(
  kind: SourceControlProviderKind,
): ChangeRequestPresentation {
  return resolveChangeRequestPresentation({ kind, name: "", baseUrl: "" });
}

export function formatChangeRequestAction(
  verb: "View" | "Create",
  presentation: ChangeRequestPresentation,
): string {
  return `${verb} ${presentation.shortName}`;
}

export function formatCreateChangeRequestPhrase(presentation: ChangeRequestPresentation): string {
  return `create ${presentation.shortName}`;
}

export function getChangeRequestTerminology(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestTerminology {
  if (!provider) {
    return DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  }

  const presentation = resolveChangeRequestPresentation(provider);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

export function getChangeRequestTerminologyForKind(
  kind: SourceControlProviderKind,
): ChangeRequestTerminology {
  const presentation = resolveChangeRequestPresentationForKind(kind);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

/**
 * Link to one commit of a change request on its host, or null where the
 * host's URL scheme for it is not known.
 */
export function changeRequestCommitUrl(
  kind: SourceControlProviderKind,
  changeRequestUrl: string | null | undefined,
  oid: string,
): string | null {
  if (!changeRequestUrl) return null;
  switch (kind) {
    case "github":
      return `${changeRequestUrl.replace(/\/+$/u, "")}/commits/${oid}`;
    case "gitlab":
    case "forgejo":
    case "azure-devops":
    case "bitbucket":
    case "unknown":
      return null;
  }
}

export interface ClassifySourceControlCommentAuthorRoleInput {
  readonly commentAuthor: string | null | undefined;
  readonly itemAuthor: string | null | undefined;
  readonly repositoryOwner: string | null | undefined;
  readonly authorAssociation?: string | null | undefined;
}

function normalizeLogin(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function normalizeAuthorAssociation(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
}

function isOwnerAssociation(association: string | null): boolean {
  return association === "OWNER";
}

function isMaintainerAssociation(association: string | null): boolean {
  return association === "MEMBER" || association === "COLLABORATOR";
}

export function classifySourceControlCommentAuthorRole(
  input: ClassifySourceControlCommentAuthorRoleInput,
): SourceControlCommentAuthorRole {
  const commentAuthor = normalizeLogin(input.commentAuthor);
  const itemAuthor = normalizeLogin(input.itemAuthor);
  const repositoryOwner = normalizeLogin(input.repositoryOwner);
  const authorAssociation = normalizeAuthorAssociation(input.authorAssociation);
  const isOriginalAuthor =
    commentAuthor !== null && itemAuthor !== null && commentAuthor === itemAuthor;
  const isRepositoryOwner =
    isOwnerAssociation(authorAssociation) ||
    (commentAuthor !== null && repositoryOwner !== null && commentAuthor === repositoryOwner);
  const isRepositoryMaintainer = isMaintainerAssociation(authorAssociation);

  return {
    primary: isOriginalAuthor
      ? "author"
      : isRepositoryOwner
        ? "owner"
        : isRepositoryMaintainer
          ? "maintainer"
          : "participant",
    isOriginalAuthor,
    isRepositoryOwner,
    isRepositoryMaintainer,
  };
}

/**
 * Best-effort parse of the owner/login segment from GitHub issue, pull request,
 * or repository URLs such as `https://github.com/owner/repo/issues/42`.
 */
export function parseGitHubRepositoryOwnerFromUrl(url: string | null | undefined): string | null {
  return parseGitHubRepositoryIdentityFromUrl(url)?.owner ?? null;
}

export interface GitHubRepositoryIdentity {
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly nameWithOwner: string;
}

/**
 * Parses the base repository identity from a GitHub repository, issue, or PR
 * URL. This intentionally uses the public item URL rather than a local remote,
 * because a pull request's head may live in a fork.
 */
export function parseGitHubRepositoryIdentityFromUrl(
  url: string | null | undefined,
): GitHubRepositoryIdentity | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;

  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const owner = segments[0]?.trim() ?? "";
    const repository = (segments[1]?.trim() ?? "").replace(/\.git$/iu, "");
    if (!owner || !repository || owner === "." || owner === "..") return null;
    if (/%2f/iu.test(owner) || /%2f/iu.test(repository)) return null;
    return {
      host: parsed.host.toLowerCase(),
      owner,
      repository,
      nameWithOwner: `${owner}/${repository}`,
    };
  } catch {
    return null;
  }
}

function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("git@")) {
    const hostWithPath = trimmed.slice("git@".length);
    const separatorIndex = hostWithPath.search(/[:/]/);
    if (separatorIndex <= 0) {
      return null;
    }
    return hostWithPath.slice(0, separatorIndex).toLowerCase();
  }

  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return null;
  }
}

function parseHostName(host: string): string {
  try {
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return host.replace(/:\d+$/u, "").toLowerCase();
  }
}

function toBaseUrl(host: string): string {
  return `https://${host}`;
}

function isGitHubHost(host: string): boolean {
  return host === "github.com" || host.includes("github");
}

function isGitLabHost(host: string): boolean {
  return host === "gitlab.com" || host.includes("gitlab");
}

function isForgejoHost(host: string): boolean {
  return host === "codeberg.org" || host === "code.forgejo.org" || host.includes("forgejo");
}

function isAzureDevOpsHost(host: string): boolean {
  return host === "dev.azure.com" || host.endsWith(".visualstudio.com");
}

function isBitbucketHost(host: string): boolean {
  return host === "bitbucket.org" || host.includes("bitbucket");
}

export function detectSourceControlProviderFromRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return null;
  }
  const hostname = parseHostName(host);

  if (isGitHubHost(hostname)) {
    return {
      kind: "github",
      name: hostname === "github.com" ? "GitHub" : "GitHub Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isGitLabHost(hostname)) {
    return {
      kind: "gitlab",
      name: hostname === "gitlab.com" ? "GitLab" : "GitLab Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isForgejoHost(hostname)) {
    return {
      kind: "forgejo",
      name: hostname === "codeberg.org" ? "Codeberg" : "Forgejo",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isAzureDevOpsHost(hostname)) {
    return {
      kind: "azure-devops",
      name: "Azure DevOps",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isBitbucketHost(hostname)) {
    return {
      kind: "bitbucket",
      name: hostname === "bitbucket.org" ? "Bitbucket" : "Bitbucket Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  return {
    kind: "unknown",
    name: host,
    baseUrl: toBaseUrl(host),
  };
}
