import * as Schema from "effect/Schema";

/**
 * A member's role in a space, which is also the role a session acts with on a
 * node (the relay's effective role, a linked direct route's role). Every role
 * literal in the contracts derives from this one.
 */
export const SpaceRole = Schema.Literals(["viewer", "operator", "owner"]);
export type SpaceRole = typeof SpaceRole.Type;

/** A node session's role: a space role, or `client` for a direct pairing without one. */
export type NodeSessionRole = SpaceRole | "client";
