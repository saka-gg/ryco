/**
 * remoteEditorLink - Links that open a file or folder on another machine in
 * an editor on this one, over the editor's own SSH remote support.
 *
 * The VS Code family (VS Code, Insiders, VSCodium, Cursor, Windsurf) takes
 * `<scheme>://vscode-remote/ssh-remote+<destination>/<path>[:line[:column]]`;
 * Zed takes `zed://ssh/<destination>/<path>`. The destination is an SSH alias
 * from this machine's `~/.ssh/config`, or `user@host`.
 *
 * @module remoteEditorLink
 */
import { EDITORS, type EditorId } from "@ryco/contracts/editor";

const TARGET_WITH_POSITION = /^(.*?):(\d+)(?::(\d+))?$/u;

/** The editor's remote URL scheme, or undefined when it cannot open over SSH. */
export function remoteEditorScheme(editor: EditorId): string | undefined {
  const definition = EDITORS.find((candidate) => candidate.id === editor);
  return definition !== undefined && "remoteScheme" in definition
    ? definition.remoteScheme
    : undefined;
}

/** Editors that can open a path on another machine. */
export const REMOTE_CAPABLE_EDITOR_IDS: ReadonlyArray<EditorId> = EDITORS.flatMap((editor) =>
  "remoteScheme" in editor ? [editor.id] : [],
);

/**
 * The link for `target` (an absolute path, optionally ending in `:line` or
 * `:line:column`) on `host`; undefined for an editor without SSH support.
 */
export function buildRemoteEditorLink(input: {
  readonly editor: EditorId;
  readonly host: string;
  readonly username?: string | null;
  readonly target: string;
}): string | undefined {
  const scheme = remoteEditorScheme(input.editor);
  if (scheme === undefined) return undefined;
  const position = TARGET_WITH_POSITION.exec(input.target);
  const path = position?.[1] ? position[1] : input.target;
  const line = position?.[1] ? position[2] : undefined;
  const column = position?.[1] ? position[3] : undefined;
  // A Windows path (`C:\…`) appears as `/C:/…` in a remote URI.
  const posixPath = path.replaceAll("\\", "/");
  const rootedPath = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  const encodedPath = rootedPath.split("/").map(encodeURIComponent).join("/");
  const username = input.username?.trim() || undefined;
  if (input.editor === "zed") {
    // Zed reads this segment as SSH URL userinfo, so the `@` stays literal.
    const destination =
      username === undefined
        ? encodeURIComponent(input.host)
        : `${encodeURIComponent(username)}@${encodeURIComponent(input.host)}`;
    return `${scheme}://ssh/${destination}${encodedPath}`;
  }
  const destination = username === undefined ? input.host : `${username}@${input.host}`;
  const suffix = line === undefined ? "" : `:${line}${column === undefined ? "" : `:${column}`}`;
  return `${scheme}://vscode-remote/ssh-remote+${encodeURIComponent(destination)}${encodedPath}${suffix}`;
}

/**
 * Where an SSH target's alias points: `user@host` aliases split, a bare alias
 * kept whole (the SSH config resolves it on this machine).
 */
export function sshEditorDestination(target: {
  readonly alias: string;
  readonly username?: string | null;
}): { readonly host: string; readonly username: string | null } | null {
  const alias = target.alias.trim();
  if (alias.length === 0) return null;
  const separator = alias.lastIndexOf("@");
  const host = separator === -1 ? alias : alias.slice(separator + 1);
  const username =
    target.username?.trim() || (separator === -1 ? null : alias.slice(0, separator)) || null;
  return host.length === 0 ? null : { host, username };
}

/**
 * Whether `url` is exactly a remote editor link this module builds; the
 * desktop app opens only those beyond plain web links.
 */
export function isRemoteEditorLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.slice(0, -1);
  const editor = EDITORS.find(
    (candidate) => "remoteScheme" in candidate && candidate.remoteScheme === scheme,
  );
  if (editor === undefined) return false;
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return false;
  }
  return editor.id === "zed"
    ? parsed.host === "ssh" && parsed.pathname.length > 1
    : parsed.host === "vscode-remote" && parsed.pathname.startsWith("/ssh-remote+");
}
