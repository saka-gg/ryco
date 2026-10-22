/**
 * CallerChannel - how a project copy caller's bytes reach this node, and the one rule that
 * follows from it (amendment 33): opted-in ignored files such as `.env` never cross a relay
 * channel the Hub can read, on either leg of a copy. The source leaves them out of an export
 * started there and refuses to read them out; the destination refuses to take them in.
 *
 * @module CallerChannel
 */
import { ProjectCopyError } from "@ryco/contracts/project-copy";

/**
 * `relay-plaintext` is a relay channel in legacy plaintext mode, or one still negotiating: the
 * Hub can read what it carries. Calls from inside the node pass no channel and are trusted.
 */
export type ProjectCopyCallerChannel = "direct" | "relay-e2ee" | "relay-plaintext";

/** Whether bytes holding opted-in ignored files may cross `channel`. */
export const mayCarryIgnoredFiles = (channel: ProjectCopyCallerChannel | undefined): boolean =>
  channel !== "relay-plaintext";

/** The refusal for `subject` ("This export", "This transfer", …) on a channel that may not. */
export const ignoredFilesRefused = (subject: string): ProjectCopyError =>
  new ProjectCopyError({
    code: "access-denied",
    message: `${subject} carries ignored files, which never travel over an unencrypted relay.`,
  });
