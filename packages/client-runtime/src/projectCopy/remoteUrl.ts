/**
 * Remote URL rules of a cross-node copy, as the client applies them before it hands a URL to a
 * node (A12, A13): which remotes a node can clone from, which are recreated on the copy, and
 * how credentials are stripped. The destination checks them again.
 *
 * @module projectCopy/remoteUrl
 */
import { isWindowsAbsolutePath } from "@ryco/shared/path";

/** How a remote URL travels. Only https, http, ssh and scp-style remotes are recreated. */
export type RemoteUrlKind = "https" | "http" | "ssh" | "scp" | "file" | "local" | "other";

export function classifyRemoteUrl(remoteUrl: string): RemoteUrlKind {
  const value = remoteUrl.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === "https") return "https";
    if (scheme === "http") return "http";
    if (scheme === "ssh" || scheme === "git+ssh" || scheme === "ssh+git") return "ssh";
    if (scheme === "file") return "file";
    return "other";
  }
  if (
    value.length === 0 ||
    isWindowsAbsolutePath(value) ||
    value.startsWith("/") ||
    value.startsWith(".") ||
    value.startsWith("~")
  ) {
    return "local";
  }
  // git reads `[user@]host:path` as scp-style only when no slash comes before the first colon.
  const colon = value.indexOf(":");
  const slash = value.indexOf("/");
  return colon > 0 && (slash === -1 || colon < slash) ? "scp" : "local";
}

/** A node can clone it without the source's help: https, ssh or scp-style. */
export const isCloneableRemoteKind = (kind: RemoteUrlKind): boolean =>
  kind === "https" || kind === "ssh" || kind === "scp";

/** Recreated as a remote on the copy (plain http too, though it is never cloned from). */
export const isRecreatableRemoteKind = (kind: RemoteUrlKind): boolean =>
  isCloneableRemoteKind(kind) || kind === "http";

/**
 * Drops a password always, and the username only for http(s): `ssh://git@…` and `git@host:…`
 * keep theirs, which their authentication needs.
 */
export function sanitizeRemoteUrl(remoteUrl: string): string {
  const value = remoteUrl.trim();
  const kind = classifyRemoteUrl(value);
  if (kind === "https" || kind === "http") {
    return value.replace(/^(https?:\/\/)[^/?#@]*@/i, "$1");
  }
  if (kind === "scp") {
    return value.replace(/^([^/@:]+):[^/@]*@/, "$1@");
  }
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*):[^/?#@]*@/i, "$1@");
}

/** The folder a clone of `remoteUrl` gets by default: its last path segment without `.git`. */
export function repositoryFolderName(remoteUrl: string): string | null {
  const trimmed = remoteUrl
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/:]/).at(-1) ?? "";
  const name = segment.replace(/\.git$/i, "");
  return name.length > 0 ? name : null;
}
