/**
 * Where a path on an environment opens in an editor: the one rule every
 * "Open in editor" surface goes through (see `openPathInEditor` in
 * `editorPreferences.ts`).
 *
 * - On the primary environment the node opens its own editor, as before.
 * - On a machine added over SSH, this computer's editor opens the path over
 *   the editor's own SSH remote support (`vscode://vscode-remote/ssh-remote+…`).
 * - Anywhere else nothing is opened: a path on another machine must never
 *   reach this computer's editor, where it fails or opens a same-named file.
 */
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@ryco/contracts";
import { sshEditorDestination } from "@ryco/shared/remoteEditorLink";

export type EditorOpenRoute =
  | { readonly kind: "local" }
  | { readonly kind: "remote-ssh"; readonly host: string; readonly username: string | null }
  | { readonly kind: "unavailable"; readonly reason: string };

export const REMOTE_EDITOR_UNAVAILABLE_REASON =
  "Files on this machine open in an editor only on the machine itself, or from here when it was added over SSH.";

/**
 * How a path on `environmentId` opens. An unknown environment (no thread
 * context) counts as the primary one, which is what every caller meant before.
 */
export function resolveEditorOpenRoute(input: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly sshTarget: DesktopSshEnvironmentTarget | null | undefined;
}): EditorOpenRoute {
  if (
    input.environmentId === null ||
    input.environmentId === undefined ||
    input.environmentId === input.primaryEnvironmentId
  ) {
    return { kind: "local" };
  }
  const destination = input.sshTarget ? sshEditorDestination(input.sshTarget) : null;
  if (destination !== null) return { kind: "remote-ssh", ...destination };
  return { kind: "unavailable", reason: REMOTE_EDITOR_UNAVAILABLE_REASON };
}
