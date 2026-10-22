import type { EnvironmentId } from "@ryco/contracts";
import type { UnknownUnionMember } from "@ryco/contracts/base-schemas";
import * as Atom from "effect/reactivity/Atom";

import { appAtomRegistry } from "./atomRegistry.ts";

const knownEnvironmentIds = new Set<EnvironmentId>();

/**
 * Whether an environment's node has sent something this build cannot read: an
 * event, stream item or update kind added after this app was built. The
 * streams skip it and keep going; this flag is how the app learns it is
 * missing something and can suggest updating. It stays set for the app's
 * life: a node does not get older, and updating the app reloads it.
 */
export const environmentNodeNewerAtom = Atom.family((environmentId: EnvironmentId) => {
  knownEnvironmentIds.add(environmentId);
  return Atom.make(false).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-node-newer:${environmentId}`),
  );
});

/** A stream skipped what a node sent because this build does not know it. */
export function recordNewerNodeContent(
  environmentId: EnvironmentId,
  unknown: UnknownUnionMember,
): void {
  const atom = environmentNodeNewerAtom(environmentId);
  if (appAtomRegistry.get(atom)) return;
  appAtomRegistry.set(atom, true);
  console.warn("A node sent something this app version cannot show; update the app to see it", {
    environmentId,
    [unknown.tag]: unknown.value,
  });
}

export function isEnvironmentNodeNewer(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(environmentNodeNewerAtom(environmentId));
}

export function resetNewerNodeStateForTests(): void {
  for (const environmentId of knownEnvironmentIds) {
    appAtomRegistry.set(environmentNodeNewerAtom(environmentId), false);
  }
}
