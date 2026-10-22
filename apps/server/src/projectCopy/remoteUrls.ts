/**
 * remoteUrls - the pure remote-URL rules of a cross-node project copy: how a URL travels, what
 * a copy may write as a remote, the https ↔ ssh alternate, and credential redaction for
 * everything git prints. `GitNetwork` exposes them; nothing here runs git.
 *
 * @module remoteUrls
 */
import { isScpStyleGitUrl } from "../sourceControl/gitCloneAccess.ts";
import type { GitRemoteUrlKind } from "./Services/GitNetwork.ts";

const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):\/\//i;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
/** The same rule as the contract's `ProjectCopyRemoteUrl`: `scheme://user:password@` or `user:password@host:`. */
const URL_PASSWORD = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/?#@]*:[^/?#@]*@|[^/\\@:]+:[^/\\@]*@)/i;
/** `scheme://userinfo@` anywhere in free text; the userinfo runs to the last `@` of the authority. */
const TEXT_URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#'"]+)@/gi;
const REPOSITORY_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SCP_HOST = /^[A-Za-z0-9.-]+$/;

const isHttpScheme = (scheme: string) => scheme === "http" || scheme === "https";

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
  // git reads `host:path` (a colon before any slash) as ssh; this server never does.
  const colon = url.indexOf(":");
  const slash = url.search(/[\\/]/);
  if (colon !== -1 && (slash === -1 || colon < slash)) return "other";
  return "local";
}

/** Whether the URL carries a password (`scheme://user:password@…` or `user:password@host:…`). */
export function remoteUrlHasPassword(remoteUrl: string): boolean {
  return URL_PASSWORD.test(remoteUrl.trim());
}

/**
 * Drops a password always, and the user name only for http(s): `ssh://git@…` and `git@host:…`
 * keep theirs, which their authentication needs. Everything else stays byte for byte.
 */
export function sanitizeRemoteUrl(remoteUrl: string): string {
  const url = remoteUrl.trim();
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@(.*)$/is.exec(url);
  if (authority) {
    const [, prefix = "", userinfo = "", rest = ""] = authority;
    if (isHttpScheme(prefix.slice(0, -3).toLowerCase())) return `${prefix}${rest}`;
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
 * Credentials hidden in free text (git's stderr, messages, warnings): the whole user info of an
 * http(s) URL, whose user name is often a token, and the password of any other URL.
 */
export function redactGitCredentials(text: string): string {
  if (!text.includes("@")) return text;
  return text.replace(TEXT_URL_USERINFO, (match, prefix: string, userinfo: string) => {
    if (isHttpScheme(prefix.slice(0, -3).toLowerCase())) return `${prefix}***@`;
    const colon = userinfo.indexOf(":");
    return colon === -1 ? match : `${prefix}${userinfo.slice(0, colon)}:***@`;
  });
}

/** At most `maxChars` of `text`, trimmed, keeping its end (where git puts the reason). */
export function tailOfText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-(maxChars - 1)).trimStart()}`;
}
