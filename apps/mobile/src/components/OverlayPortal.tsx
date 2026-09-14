import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { View } from "react-native";

type Entries = ReadonlyMap<number, ReactNode>;
type Listener = (entries: Entries) => void;
function createPortalStore() {
  const entries = new Map<number, ReactNode>();
  const listeners = new Set<Listener>();
  return {
    entries,
    listeners,
    emit() {
      const snapshot = new Map(entries);
      for (const listener of listeners) listener(snapshot);
    },
  };
}
const rootStore = createPortalStore();
const PortalContext = createContext(rootStore);
let nextKey = 0;

/** Native sheets need a local host: their native position is outside Fabric's layout tree. */
export function OverlayPortalScope({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createPortalStore);
  return (
    <PortalContext.Provider value={store}>
      <View style={{ flex: 1 }}>
        {children}
        <OverlayPortalHost />
      </View>
    </PortalContext.Provider>
  );
}

/** Projects into the nearest sheet host, or the app root for regular screens. */
export function OverlayPortal(props: { readonly children: ReactNode }) {
  const store = useContext(PortalContext);
  const [key] = useState(() => nextKey++);
  useEffect(() => {
    store.entries.set(key, props.children);
    store.emit();
  });
  useEffect(
    () => () => {
      store.entries.delete(key);
      store.emit();
    },
    [key, store],
  );
  return null;
}

export function OverlayPortalHost() {
  const store = useContext(PortalContext);
  const [current, setCurrent] = useState<Entries>(() => new Map(store.entries));
  useEffect(() => {
    store.listeners.add(setCurrent);
    // Child portals may have registered before this host's effect ran.
    store.emit();
    return () => {
      store.listeners.delete(setCurrent);
    };
  }, [store]);
  if (current.size === 0) return null;
  return (
    <View pointerEvents="box-none" className="absolute inset-0">
      {[...current.entries()].map(([key, node]) => (
        <View key={key} pointerEvents="box-none" className="absolute inset-0">
          {node}
        </View>
      ))}
    </View>
  );
}
