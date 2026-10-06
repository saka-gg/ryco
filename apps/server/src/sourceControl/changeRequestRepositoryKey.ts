/**
 * Which repository a change request URL (or a checkout's remote) belongs to,
 * as one comparable key, so a pasted link to another repository's pull
 * request can be refused before it is linked to a workspace.
 */

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Azure DevOps names one repository several ways (dev.azure.com/{org} or
 * {org}.visualstudio.com, with or without the project or a DefaultCollection
 * segment): key it by organisation, project and repository, the project
 * defaulting to the repository as Azure does.
 */
function azureRepositoryKey(
  organization: string,
  beforeRepository: ReadonlyArray<string>,
  repository: string,
): string {
  const project =
    beforeRepository.findLast((segment) => segment.toLowerCase() !== "defaultcollection") ??
    repository;
  return `azure:${organization}/${project}/${repository}`.toLowerCase();
}

function azureOrganization(host: string, segments: ReadonlyArray<string>): string | undefined {
  if (host === "dev.azure.com") return segments[0];
  if (host.endsWith(".visualstudio.com")) return host.slice(0, -".visualstudio.com".length);
  return undefined;
}

/**
 * The repository a change request URL lives in: host and path before its
 * pull/merge request segment (any case) on GitHub, GitLab, Forgejo and
 * Bitbucket, `azure:{org}/{project}/{repo}` on Azure DevOps; null when the
 * URL does not name a change request.
 */
export function changeRequestRepositoryKey(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
  const organization = azureOrganization(hostname, segments);
  if (organization !== undefined && gitIndex !== -1) {
    const repository = segments[gitIndex + 1];
    if (!repository || !/^pullrequest$/iu.test(segments[gitIndex + 2] ?? "")) return null;
    return azureRepositoryKey(
      organization,
      segments.slice(hostname === "dev.azure.com" ? 1 : 0, gitIndex),
      repository,
    );
  }
  const match =
    /^(.*?)\/(?:-\/)?(?:pull|pulls|pull-requests|pullrequest|pullrequests|merge_requests)\/\d+(?:\/.*)?$/iu.exec(
      url.pathname,
    );
  return match?.[1] ? `${host}${decodeSegment(match[1])}`.toLowerCase() : null;
}

/** `user@host:path` (scp-like SSH) as an `ssh://` URL, so one parser reads every remote. */
function remoteAsUrl(remoteUrl: string): URL | null {
  const scp = /^(?:([^@\s/:]+)@)?([^@\s/:]+):(?!\/\/)(.+)$/u.exec(remoteUrl);
  const candidate = scp ? `ssh://${scp[1] ? `${scp[1]}@` : ""}${scp[2]}/${scp[3]}` : remoteUrl;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/**
 * The Azure DevOps repository a checkout's remote points at, in the
 * `changeRequestRepositoryKey` form; null for other hosts or unknown shapes.
 * Reads HTTPS (`[user@]dev.azure.com/{org}/{project}/_git/{repo}`,
 * `{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}`), SSH v3
 * (`ssh.dev.azure.com` / `vs-ssh.visualstudio.com`, scp-like or `ssh://` with
 * a port) and the legacy `_ssh` paths. Azure pull request ids are
 * organisation-wide, so this is the only way to tell the workspace's
 * repository from a sibling's.
 */
export function azureRemoteRepositoryKey(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const url = remoteAsUrl(remoteUrl.trim());
  if (url === null) return null;
  // The hostname, not the host: an SSH remote may carry a port.
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeSegment(segment).replace(/\.git$/iu, ""));
  const sshHost = hostname === "ssh.dev.azure.com" || hostname === "vs-ssh.visualstudio.com";
  if (sshHost && segments[0]?.toLowerCase() === "v3") {
    const [, organization, project, repository] = segments;
    return organization && project && repository
      ? azureRepositoryKey(organization, [project], repository)
      : null;
  }
  const repoIndex = segments.findIndex((segment) => /^_(?:git|ssh)$/iu.test(segment));
  const repository = segments[repoIndex + 1];
  if (repoIndex === -1 || !repository) return null;
  const organizationInPath = hostname === "dev.azure.com" || hostname === "ssh.dev.azure.com";
  const organization = organizationInPath
    ? segments[0]
    : hostname === "vs-ssh.visualstudio.com"
      ? decodeSegment(url.username) || undefined
      : hostname.endsWith(".visualstudio.com")
        ? hostname.slice(0, -".visualstudio.com".length)
        : undefined;
  if (!organization) return null;
  return azureRepositoryKey(
    organization,
    segments.slice(organizationInPath ? 1 : 0, repoIndex),
    repository,
  );
}
