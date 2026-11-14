import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { WorktreeIdentity } from "./filesystem.ts";

/**
 * `storage_owned_entries.identity_json`: what pins an owned folder before Ryco
 * may delete it. Its shape follows the row's `category`: a staging directory
 * (`temporary`) records its `{ device, inode }`, plus the content `fingerprint`
 * once completed; a linked checkout (`worktree`) records its `WorktreeIdentity`.
 * A removal writes its proof beside these (`removalProofIdentity`), which
 * `readRemovalRecord` reads.
 *
 * Identities are compared field by field, never as JSON text: a rewrite that
 * reorders keys or adds one must not read as "identity changed" and leave the
 * entry stuck.
 */
const at = { device: Schema.Number, inode: Schema.Number };
const Worktree = Schema.Struct({
  ...at,
  gitFile: Schema.String,
  gitDirectory: Schema.String,
  commonDirectory: Schema.String,
  commonDevice: Schema.Number,
  commonInode: Schema.Number,
});
const Temporary = Schema.Struct({
  ...at,
  fingerprint: Schema.optionalKey(Schema.String),
});
export type TemporaryIdentity = typeof Temporary.Type;

const reader = <A>(schema: Schema.Decoder<A>) => {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema));
  return (json: string): A | null => Option.getOrNull(decode(json));
};

/** A `worktree` row's recorded identity; null when the record is unreadable. */
export const readWorktreeIdentity: (json: string) => WorktreeIdentity | null = reader(Worktree);

/** A `temporary` row's recorded identity; null when the record is unreadable. */
export const readTemporaryIdentity = reader(Temporary);

const KEYS = Object.keys(Worktree.fields) as ReadonlyArray<keyof WorktreeIdentity>;
/** `recorded` is readable and names the same checkout as `current` by every key given. */
const sameFields =
  (keys: ReadonlyArray<keyof WorktreeIdentity>) =>
  (recorded: WorktreeIdentity | null, current: WorktreeIdentity): boolean =>
    recorded !== null && keys.every((key) => recorded[key] === current[key]);

/** The same checkout, by every field its identity pins. */
export const isSameWorktreeIdentity = sameFields(KEYS);

/** The same checkout after a same-filesystem Git move: all but its `.git` file's text. */
export const isSameMovedWorktreeIdentity = sameFields(KEYS.filter((key) => key !== "gitFile"));
