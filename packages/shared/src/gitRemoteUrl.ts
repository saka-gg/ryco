/**
 * gitRemoteUrl - the pure remote-URL rules of a cross-node project copy, shared by the nodes
 * (which enforce them) and the client (which plans with them before it asks a node): which remote
 * a repository's identity and a copy's clone come from, how a URL travels, what a node may clone
 * from and what a copy recreates as a remote, how credentials are stripped from a URL and hidden
 * in free text, the https ↔ ssh alternate, and a clone's default folder name. Nothing here runs
 * git or touches the filesystem.
 *
 * @module gitRemoteUrl
 */
import { REMOTE_URL_PASSWORD_PATTERN } from "@ryco/contracts/project-copy";

/**
 * The remote a repository's identity comes from (`RepositoryIdentity.locator`, and so its
 * canonical key): `upstream`, then `origin`, then the first by name. A fork therefore groups
 * with the repository it was forked from. Null without remotes.
 */
export function pickIdentityRemoteName(remoteNames: ReadonlyArray<string>): string | null {
  for (const name of ["upstream", "origin"] as const) {
    if (remoteNames.includes(name)) return name;
  }
  return (
    remoteNames
      .filter((name) => name.length > 0)
      .toSorted((left, right) => left.localeCompare(right))[0] ?? null
  );
}

/**
 * The remote a cross-node copy clones from, and the one the source measures its unpushed commits
 * against: the project's preferred remote when the checkout has it, else `origin`, else the
 * identity remote. Not the identity remote first: a fork's own branches live on `origin`, and a
 * clone of `upstream` would lack them. The copy recreates the other remotes, so its identity
 * (and grouping) still matches the source's. Null without remotes.
 */
export function pickCloneRemoteName(input: {
  readonly remoteNames: ReadonlyArray<string>;
  readonly preferredRemoteName: string | null | undefined;
}): string | null {
  const { remoteNames, preferredRemoteName } = input;
  if (preferredRemoteName && remoteNames.includes(preferredRemoteName)) return preferredRemoteName;
  return remoteNames.includes("origin") ? "origin" : pickIdentityRemoteName(remoteNames);
}

/** How a remote URL travels. Only https, http, ssh and scp-style remotes are recreated on a copy. */
export type GitRemoteUrlKind = "https" | "http" | "ssh" | "scp" | "file" | "local" | "other";

const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):\/\//i;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
/**
 * Where a URL's user info starts, as `REMOTE_URL_PASSWORD_PATTERN` reads it: after `scheme:` and
 * any run of slashes or backslashes, since git hands `https:///user:token@host` to curl (which
 * skips up to three slashes and sends the token) and WHATWG `URL` skips any number of either. At
 * least one: `user:password@host:path` without slashes is scp-style. The user info never starts
 * with a slash, so the slash run is taken whole and the match stays linear.
 */
const SCHEME_AND_SLASHES = String.raw`([a-z][a-z0-9+.-]*):[\\/]+`;
/** The user info runs to the authority's last `@`. */
const URL_USERINFO = new RegExp(String.raw`^${SCHEME_AND_SLASHES}([^/\\?#][^/?#]*)?@`, "i");
/** `scheme://userinfo@` anywhere in free text. */
const TEXT_URL_USERINFO = new RegExp(
  String.raw`\b${SCHEME_AND_SLASHES}([^\s/\\?#'"][^\s/?#'"]*)@`,
  "gi",
);
const REPOSITORY_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SCP_HOST = /^[A-Za-z0-9.-]+$/;

const isHttpScheme = (scheme: string) => scheme === "http" || scheme === "https";

/** `user@host:owner/repo.git`, the scp-like ssh syntax. */
export function isScpStyleGitUrl(input: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+:[^\s]+$/u.test(input);
}

/** How a remote URL travels. Only https, http, ssh and scp-style remotes are recreated on a copy. */
export function classifyRemoteUrl(remoteUrl: string): GitRemoteUrlKind {
  const url = remoteUrl.trim();
  if (url.length === 0) return "other";
  const scheme = SCHEME_PREFIX.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    switch (scheme) {
      case "https":
      case "http":
      case "ssh":
      case "file":
        return scheme;
      default:
        return "other";
    }
  }
  if (isScpStyleGitUrl(url)) return "scp";
  if (WINDOWS_DRIVE_PATH.test(url) || url.startsWith("\\\\")) return "local";
  // git reads `host:path` (a colon before any slash) as ssh; a node never clones from it.
  const colon = url.indexOf(":");
  const slash = url.search(/[\\/]/);
  if (colon !== -1 && (slash === -1 || colon < slash)) return "other";
  return "local";
}

/** A node clones from it without the source's help: https, ssh or scp-style. */
export const isCloneableRemoteKind = (kind: GitRemoteUrlKind): boolean =>
  kind === "https" || kind === "ssh" || kind === "scp";

/** Recreated as a remote on the copy (plain http too, though it is never cloned from). */
export const isRecreatableRemoteKind = (kind: GitRemoteUrlKind): boolean =>
  isCloneableRemoteKind(kind) || kind === "http";

/**
 * Whether the URL carries a password (`scheme://user:password@…`, however many slashes, or
 * `user:password@host:…`): the rule the contract's `ProjectCopyRemoteUrl` refuses.
 */
export function remoteUrlHasPassword(remoteUrl: string): boolean {
  return REMOTE_URL_PASSWORD_PATTERN.test(remoteUrl.trim());
}

/**
 * Drops a password always, and the user name only for http(s): `ssh://git@…` and `git@host:…`
 * keep theirs, which their authentication needs. Everything else stays byte for byte.
 */
export function sanitizeRemoteUrl(remoteUrl: string): string {
  const url = remoteUrl.trim();
  const authority = URL_USERINFO.exec(url);
  if (authority) {
    const [prefixAndUserinfo, scheme = "", userinfo = ""] = authority;
    const prefix = prefixAndUserinfo.slice(0, prefixAndUserinfo.length - userinfo.length - 1);
    const rest = url.slice(prefixAndUserinfo.length);
    if (isHttpScheme(scheme.toLowerCase())) return `${prefix}${rest}`;
    const colon = userinfo.indexOf(":");
    return colon === -1 ? url : `${prefix}${userinfo.slice(0, colon)}@${rest}`;
  }
  const scpWithPassword = /^([^/\\@:]+):[^/\\@]*@(.*)$/s.exec(url);
  if (scpWithPassword) return `${scpWithPassword[1]}@${scpWithPassword[2]}`;
  return url;
}

/** `owner/repo[.git]` (GitLab subgroups included) when every segment is plain; else null. */
function repositoryPath(raw: string): string | null {
  const segments = raw.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2) return null;
  for (const segment of segments) {
    if (!REPOSITORY_PATH_SEGMENT.test(segment) || segment === "." || segment === "..") return null;
    // Azure DevOps (`/org/project/_git/repo`) has its own, different ssh layout.
    if (segment === "_git") return null;
  }
  return segments.join("/");
}

/**
 * The scp-ssh form of an https remote (`git@host:owner/repo.git`) and the https form of an ssh
 * one, from host, owner and repository; null when the URL has no such counterpart (a port, a
 * query, a server-absolute path, a host-specific layout, or any other transport).
 */
export function alternateRemoteUrl(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  switch (classifyRemoteUrl(url)) {
    case "https": {
      const parsed = parseUrl(url);
      if (!parsed || parsed.port !== "" || parsed.search !== "" || parsed.hash !== "") return null;
      if (!SCP_HOST.test(parsed.hostname)) return null;
      const repository = repositoryPath(parsed.pathname);
      return repository ? `git@${parsed.hostname}:${repository}` : null;
    }
    case "ssh": {
      const parsed = parseUrl(url);
      if (!parsed || (parsed.port !== "" && parsed.port !== "22")) return null;
      return httpsFormOf(parsed.hostname, parsed.pathname);
    }
    case "scp": {
      const match = /^[^@]+@([^:]+):(.+)$/s.exec(url);
      if (!match?.[1] || !match[2] || match[2].startsWith("/") || match[2].startsWith("~")) {
        return null;
      }
      return httpsFormOf(match[1], match[2]);
    }
    default:
      return null;
  }
}

function httpsFormOf(host: string, rawPath: string): string | null {
  // `ssh.<host>` endpoints (Azure DevOps, GitHub's port-443 ssh) serve no https.
  if (!SCP_HOST.test(host) || host.toLowerCase().startsWith("ssh.")) return null;
  const repository = repositoryPath(rawPath);
  return repository ? `https://${host.toLowerCase()}/${repository}` : null;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The ssh host of an ssh or scp-style URL as `known_hosts` names it (`host`, or `[host]:port`
 * for another port); null for other transports.
 */
export function sshHostOfRemoteUrl(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  switch (classifyRemoteUrl(url)) {
    case "ssh": {
      const parsed = parseUrl(url);
      if (!parsed || parsed.hostname.length === 0) return null;
      return parsed.port !== "" && parsed.port !== "22"
        ? `[${parsed.hostname}]:${parsed.port}`
        : parsed.hostname;
    }
    case "scp":
      return /^[^@]+@([^:]+):/.exec(url)?.[1] ?? null;
    default:
      return null;
  }
}

/**
 * Credentials hidden in free text (git's stderr, messages, warnings, output tails): the whole
 * user info of an http(s) URL, whose user name is often a token, and the password of any other
 * URL (`ssh://git:***@`). The one redaction every project copy message goes through.
 */
export function redactGitCredentials(text: string): string {
  if (!text.includes("@")) return text;
  return text.replace(TEXT_URL_USERINFO, (match, scheme: string, userinfo: string) => {
    const prefix = match.slice(0, match.length - userinfo.length - 1);
    if (isHttpScheme(scheme.toLowerCase())) return `${prefix}***@`;
    const colon = userinfo.indexOf(":");
    return colon === -1 ? match : `${prefix}${userinfo.slice(0, colon)}:***@`;
  });
}

/**
 * The folder a clone of `remoteUrl` gets by default: its last path segment without `.git`
 * (`git@host:owner/repo.git` → `repo`); null when nothing is left. Not yet a safe folder name.
 */
export function repositoryFolderName(remoteUrl: string): string | null {
  const trimmed = remoteUrl
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/:]/).at(-1) ?? "";
  const name = segment.replace(/\.git$/i, "");
  return name.length > 0 ? name : null;
}

/**
 * A remote as people read it: `host/owner/repo` for the usual URL forms
 * (`git@github.com:me/ryco.git` and `https://github.com/me/ryco.git` both read
 * `github.com/me/ryco`), never with user info; the URL itself otherwise.
 * Case is kept, unlike the repository identity's canonical key.
 */
export function displayRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):\/*(.+?)(?:\.git)?\/?$/u.exec(trimmed);
  // A server-absolute path (`host:/srv/repo.git`) reads like its `ssh://host/srv/repo.git` form.
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(trimmed);
    if (!url.host) return trimmed;
    return `${url.host}${url.pathname.replace(/\.git\/?$/u, "").replace(/\/$/u, "")}`;
  } catch {
    return trimmed;
  }
}
