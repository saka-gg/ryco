/**
 * CallerChannel - how a project copy caller's bytes reach this node, and the one rule that
 * follows from it (amendment 33): opted-in ignored files such as `.env` never cross a connection
 * that is not encrypted, on either leg of a copy. The source leaves them out of an export
 * started there and refuses to read them out; the destination refuses to take them in.
 *
 * The rule is the one secret answers follow (`ws/rpcConnectionPath.ts`): a relay channel counts
 * only while it is end-to-end encrypted, and a direct connection only over TLS, Tailscale or
 * from this machine. Plain `ws://` from another machine counts as unencrypted, like a plaintext
 * relay, and so does a connection the node knows nothing about.
 *
 * @module CallerChannel
 */
import { ProjectCopyError } from "@ryco/contracts/project-copy";

/**
 * `encrypted`: the node saw the connection as encrypted end to end, or never on a network in
 * the clear. `unencrypted`: anything else. Calls from inside the node pass no channel and are
 * trusted.
 */
export type ProjectCopyCallerChannel = "encrypted" | "unencrypted";

/** Whether bytes holding opted-in ignored files may cross `channel`. */
export const mayCarryIgnoredFiles = (channel: ProjectCopyCallerChannel | undefined): boolean =>
  channel !== "unencrypted";

/** The refusal for `subject` ("This export", "This transfer", …) on a channel that may not. */
export const ignoredFilesRefused = (subject: string): ProjectCopyError =>
  new ProjectCopyError({
    code: "access-denied",
    message: `${subject} carries ignored files, which never travel over an unencrypted connection.`,
  });
