/**
 * A project's git remotes as people see them: the browser address of a remote,
 * the provider's name, and which remote is primary ("Open remote" and pull
 * requests use it). Shared by the web sidebar and projects page and the phone's
 * project settings.
 */
import type { RepositoryIdentity } from "@ryco/contracts";

export interface ProjectRemoteLink {
  readonly label: string;
  readonly provider: string | undefined;
  readonly providerLabel: string;
  readonly url: string;
}

export function formatRepositoryProviderLabel(provider: string | undefined): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "forgejo":
      return "Forgejo";
    case "azure-devops":
      return "Azure DevOps";
    case "bitbucket":
      return "Bitbucket";
    default:
      return "Remote";
  }
}

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/g, "").replace(/\.git$/i, "");
}

function rewriteAzureDevOpsBrowserUrl(host: string, pathSegments: string[]): string | null {
  // Azure DevOps SSH form: ssh://git@ssh.dev.azure.com/v3/<org>/<project>/<repo>
  // scp form:              git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
  // Both produce pathSegments starting with "v3". The browse URL is
  // https://dev.azure.com/<org>/<project>/_git/<repo>.
  if (host !== "ssh.dev.azure.com") {
    return null;
  }
  const v3Index = pathSegments.indexOf("v3");
  if (v3Index === -1 || pathSegments.length < v3Index + 4) {
    return null;
  }
  const org = pathSegments[v3Index + 1];
  const project = pathSegments[v3Index + 2];
  const repo = pathSegments[v3Index + 3];
  if (!org || !project || !repo) return null;
  return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
}

export function resolveRemoteUrlToBrowserUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      url.pathname = stripGitSuffix(url.pathname);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  if (/^(?:ssh|git):\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const segments = stripGitSuffix(url.pathname)
        .split("/")
        .filter((segment) => segment.length > 0);
      const azureBrowserUrl = rewriteAzureDevOpsBrowserUrl(url.hostname, segments);
      if (azureBrowserUrl) return azureBrowserUrl;
      const repositoryPath = segments.join("/");
      return url.hostname && repositoryPath ? `https://${url.hostname}/${repositoryPath}` : null;
    } catch {
      return null;
    }
  }

  const scpStyleRemote = /^git@([^:/\s]+)[:/]([^#?\s]+)$/i.exec(trimmed);
  if (scpStyleRemote?.[1] && scpStyleRemote[2]) {
    const host = scpStyleRemote[1];
    const path = stripGitSuffix(scpStyleRemote[2]);
    const segments = path.split("/").filter((s) => s.length > 0);
    const azureBrowserUrl = rewriteAzureDevOpsBrowserUrl(host, segments);
    if (azureBrowserUrl) return azureBrowserUrl;
    return `https://${host}/${path}`;
  }

  return null;
}

export function resolveProjectRemoteLink(
  repositoryIdentity: RepositoryIdentity | null | undefined,
  preferredRemoteName: string | null | undefined,
): ProjectRemoteLink | null {
  if (!repositoryIdentity) return null;

  const candidate = (() => {
    if (preferredRemoteName) {
      const match = (repositoryIdentity.remotes ?? []).find(
        (remote) => remote.name === preferredRemoteName,
      );
      if (match) {
        return {
          url: match.url,
          label: match.ownerRepo ?? match.url,
          provider: match.provider ?? undefined,
        };
      }
    }
    const locatorUrl = repositoryIdentity.locator.remoteUrl;
    return {
      url: locatorUrl,
      label: repositoryIdentity.displayName ?? repositoryIdentity.canonicalKey,
      provider: repositoryIdentity.provider ?? undefined,
    };
  })();

  const url = resolveRemoteUrlToBrowserUrl(candidate.url);
  if (!url) return null;
  return {
    url,
    label: candidate.label,
    provider: candidate.provider,
    providerLabel: formatRepositoryProviderLabel(candidate.provider),
  };
}

export interface ProjectRemoteChoice {
  /** The remote's name (`origin`, `upstream`). */
  readonly name: string;
  /** What to show for where it points: `owner/repo`, else the URL. */
  readonly location: string;
  readonly provider: string | undefined;
  /** Its page in a browser, when the URL names one. */
  readonly browserUrl: string | null;
  /** The reader picked it as the primary remote (rather than auto-detect). */
  readonly selected: boolean;
}

export interface ProjectRemoteChoices {
  readonly remotes: readonly ProjectRemoteChoice[];
  /** The saved choice when it still names a remote; null follows auto-detect. */
  readonly preferred: string | null;
  /** The remote auto-detect picks (upstream, then origin, then the first). */
  readonly autoRemoteName: string | null;
  /** More than one remote: the reader can pick the primary one. */
  readonly choosable: boolean;
}

/**
 * The remotes of a checkout and which one the reader made primary. A saved
 * preference that no longer names a remote falls back to auto-detect, which
 * the server resolves (`autoRemoteName`).
 */
export function projectRemoteChoices(project: {
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  readonly preferredRemoteName?: string | null | undefined;
}): ProjectRemoteChoices {
  const identity = project.repositoryIdentity ?? null;
  const remotes = identity?.remotes ?? [];
  const autoRemoteName = identity?.locator.remoteName ?? null;
  const preferred =
    project.preferredRemoteName &&
    remotes.some((remote) => remote.name === project.preferredRemoteName)
      ? project.preferredRemoteName
      : null;
  const choosable = remotes.length > 1;
  return {
    preferred,
    autoRemoteName,
    choosable,
    remotes: remotes.map((remote) => ({
      name: remote.name,
      location: remote.ownerRepo ?? remote.url,
      provider: remote.provider ?? undefined,
      browserUrl: resolveRemoteUrlToBrowserUrl(remote.url),
      selected: preferred === remote.name,
    })),
  };
}
