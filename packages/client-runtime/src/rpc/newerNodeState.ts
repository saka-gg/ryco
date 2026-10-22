import type { EnvironmentId } from "@ryco/contracts";
import { isUnknownUnionMember, type UnknownUnionMember } from "@ryco/contracts/base-schemas";
import * as Atom from "effect/reactivity/Atom";

import { appAtomRegistry } from "./atomRegistry.ts";

const knownEnvironmentIds = new Set<EnvironmentId>();

/**
 * Whether an environment's node has sent something this build cannot read: an
 * event, stream item or update kind added after this app was built. The
 * streams skip it and keep going. It stays set for the app's life: a node does
 * not get older, and updating the app reloads it.
 *
 * No UI reads it yet: today it only limits the warning to one per environment.
 * It is the state an "update this app to see everything" hint will read.
 */
export const environmentNodeNewerAtom = Atom.family((environmentId: EnvironmentId) => {
  knownEnvironmentIds.add(environmentId);
  return Atom.make(false).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-node-newer:${environmentId}`),
  );
});

/** A stream skipped what a node sent because this build does not know it. */
function recordNewerNodeContent(environmentId: EnvironmentId, unknown: UnknownUnionMember): void {
  const atom = environmentNodeNewerAtom(environmentId);
  if (appAtomRegistry.get(atom)) return;
  appAtomRegistry.set(atom, true);
  console.warn("A node sent something this app version cannot show; update the app to see it", {
    environmentId,
    [unknown.tag]: unknown.value,
  });
}

/**
 * Whether the caller must skip `value` because it is a member a newer node
 * added that this build does not know. When it is, sets the environment's
 * `environmentNodeNewerAtom` and warns once per environment.
 */
export function skipNewerNodeContent<A>(
  environmentId: EnvironmentId,
  value: A,
): value is Extract<A, UnknownUnionMember> {
  if (!isUnknownUnionMember(value)) return false;
  recordNewerNodeContent(environmentId, value);
  return true;
}

export function isEnvironmentNodeNewer(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(environmentNodeNewerAtom(environmentId));
}

export function resetNewerNodeStateForTests(): void {
  for (const environmentId of knownEnvironmentIds) {
    appAtomRegistry.set(environmentNodeNewerAtom(environmentId), false);
  }
}
