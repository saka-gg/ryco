import * as AtomRegistry from "effect/reactivity/AtomRegistry";

export let appAtomRegistry = AtomRegistry.make();

export function resetAppAtomRegistryForTests() {
  appAtomRegistry.dispose();
  appAtomRegistry = AtomRegistry.make();
}
