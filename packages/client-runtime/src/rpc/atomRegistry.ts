import { AtomRegistry } from "effect/reactivity";

export let appAtomRegistry = AtomRegistry.make();

export function resetAppAtomRegistryForTests() {
  appAtomRegistry.dispose();
  appAtomRegistry = AtomRegistry.make();
}
