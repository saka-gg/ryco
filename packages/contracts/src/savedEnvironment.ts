import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";

/** An SSH host a desktop reaches a saved environment through. */
export const DesktopSshEnvironmentTarget = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});
export type DesktopSshEnvironmentTarget = typeof DesktopSshEnvironmentTarget.Type;

/**
 * A saved environment whose direct access was issued over a trusted Hub relay
 * channel (Hub-linked direct access), rather than by a pasted pairing link.
 */
export const SavedEnvironmentHubLink = Schema.Struct({
  /** The node's Hub environment id: a different id from the direct one. */
  hubEnvironmentId: Schema.String,
  /** When the direct credential was last issued; it is renewed through the Hub. */
  linkedAt: Schema.String,
  /**
   * The node identity key (Ed25519, base64url) the grant named: each direct
   * address must prove it before the bearer goes there. A link saved before
   * the proof existed has none, so it is never used and is renewed instead.
   */
  nodeIdentityPublicKey: Schema.optionalKey(Schema.String),
});
export type SavedEnvironmentHubLink = typeof SavedEnvironmentHubLink.Type;

/**
 * A saved environment as every client stores it (browser storage, the
 * desktop's registry file, the phone's KV). Each store extends these fields
 * with its own credential fields, and decodes stored records through the
 * result one by one (`decodeSavedEnvironmentRecords`), so a field added here
 * reaches every platform and an unreadable record never hides the others.
 */
export const PersistedSavedEnvironmentRecord = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  wsBaseUrl: Schema.String,
  httpBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(DesktopSshEnvironmentTarget),
  hubLink: Schema.optionalKey(SavedEnvironmentHubLink),
  /**
   * When the user switched the machine off (ISO time). A switched-off machine
   * stays saved with its credential but never connects until switched on.
   * Absent means on, so an app that predates the field keeps it on.
   */
  disabledAt: Schema.optionalKey(Schema.String),
});
export type PersistedSavedEnvironmentRecord = typeof PersistedSavedEnvironmentRecord.Type;
