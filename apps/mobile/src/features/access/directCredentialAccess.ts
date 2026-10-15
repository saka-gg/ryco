import type { SavedEnvironmentRecord } from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";

export interface DirectCredentialCatalog {
  readonly waitForHydration: () => Promise<void>;
  readonly list: () => ReadonlyArray<Pick<SavedEnvironmentRecord, "environmentId">>;
  readonly readBearerToken: (environmentId: EnvironmentId) => Promise<string | null>;
  readonly registryStore: { readonly subscribe: (listener: () => void) => () => void };
}

function environmentSetKey(catalog: DirectCredentialCatalog): string {
  return catalog
    .list()
    .map((environment) => environment.environmentId)
    .toSorted()
    .join("\u0000");
}

/**
 * Whether any saved direct environment holds a readable credential: the direct
 * plane's launch answer for the access gate. Published once the catalog has
 * hydrated and again when the saved environments change; the returned stop
 * ends the watch and drops answers still in flight.
 *
 * Every socket open marks its environment connected in the registry, which
 * changes nothing this answer depends on. With a credential already readable
 * and the same environments saved, a registry change is not re-read, so a
 * connect or reconnect costs no extra keychain read. Without one, or while a
 * newer read is still in flight (it may answer for a set that has since
 * changed back), every change is re-read: pairing the same node again keeps its
 * id but stores a new credential.
 */
export function watchDirectCredentialAccess(
  catalog: DirectCredentialCatalog,
  publish: (readable: boolean) => void,
): () => void {
  let active = true;
  let generation = 0;
  // The generation `evaluated` answers; behind `generation` while a read is pending.
  let settled = 0;
  let evaluated: { readonly key: string; readonly readable: boolean } | null = null;
  const evaluate = async () => {
    const issued = ++generation;
    await catalog.waitForHydration();
    const key = environmentSetKey(catalog);
    let readable = false;
    for (const environment of catalog.list()) {
      try {
        const token = await catalog.readBearerToken(environment.environmentId);
        if (typeof token === "string" && token.length > 0) {
          readable = true;
          break;
        }
      } catch {
        // An unreadable credential is not authority.
      }
    }
    if (!active || issued !== generation) return;
    settled = issued;
    evaluated = { key, readable };
    publish(readable);
  };
  const unsubscribe = catalog.registryStore.subscribe(() => {
    if (
      settled === generation &&
      evaluated?.readable === true &&
      evaluated.key === environmentSetKey(catalog)
    ) {
      return;
    }
    void evaluate();
  });
  void evaluate();
  return () => {
    active = false;
    generation += 1;
    unsubscribe();
  };
}
