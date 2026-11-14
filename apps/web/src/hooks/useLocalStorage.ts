import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { isHostedHubMode } from "../env";

const isomorphicLocalStorage: Storage = (() => {
  if (typeof window !== "undefined" && !isHostedHubMode()) return window.localStorage;
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (_) => store.get(_) ?? null,
    key: (_) => Record.keys(store).at(_) ?? null,
    get length() {
      return store.size;
    },
    removeItem: (_) => store.delete(_),
    setItem: (_, value) => store.set(_, value),
  };
})();

/**
 * The storage `getLocalStorageItem` and `setLocalStorageItem` use: the
 * window's localStorage, shared by every window of this origin, or this
 * window's memory (hosted Hub builds, and no window at all).
 */
export const appLocalStorage: Storage = isomorphicLocalStorage;

const decode = <T, E>(schema: Schema.Codec<T, E>, value: string) =>
  Schema.decodeSync(Schema.fromJsonString(schema))(value);

const encode = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Schema.encodeSync(Schema.fromJsonString(schema))(value);

export const getLocalStorageItem = <T, E>(key: string, schema: Schema.Codec<T, E>): T | null => {
  const item = isomorphicLocalStorage.getItem(key);
  return item ? decode(schema, item) : null;
};

export const setLocalStorageItem = <T, E>(key: string, value: T, schema: Schema.Codec<T, E>) => {
  const valueToSet = encode(schema, value);
  isomorphicLocalStorage.setItem(key, valueToSet);
};

export const removeLocalStorageItem = (key: string) => {
  isomorphicLocalStorage.removeItem(key);
};

const LOCAL_STORAGE_CHANGE_EVENT = "ryco:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key },
    }),
  );
}

export function useLocalStorage<T, E>(
  key: string,
  initialValue: T,
  schema: Schema.Codec<T, E>,
): [T, (value: T | ((val: T) => T)) => void] {
  // Uncompiled on purpose: Babel's React Compiler never compiled this function
  // (it bails on value blocks inside try/catch). Oxc can, but its render reads
  // have not been audited for purity yet. Remove after that audit.
  "use no memo";
  // Get the initial value from localStorage or use the provided initialValue
  const [storedValue, setStoredValueState] = useState<T>(() => {
    try {
      const item = getLocalStorageItem(key, schema);
      return item ?? initialValue;
    } catch (error) {
      console.error("[LOCALSTORAGE] Error:", error);
      return initialValue;
    }
  });
  // The value the next functional update starts from. Every state write goes through
  // `setStoredValue`, so it never lags, even for several updates before a render.
  const latestValueRef = useRef(storedValue);
  const setStoredValue = useCallback((next: T) => {
    latestValueRef.current = next;
    setStoredValueState(next);
  }, []);
  // Callers often pass a fresh literal (`{}`); reading it through an effect event keeps the
  // storage listeners from re-subscribing on every render.
  const readInitialValue = useEffectEvent(() => initialValue);

  // The setter persists outside React's updater, which must stay pure (StrictMode runs it
  // twice), so an encode or quota error is caught here instead of thrown from a render.
  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      const valueToStore =
        typeof value === "function" ? (value as (val: T) => T)(latestValueRef.current) : value;
      let stored = true;
      try {
        if (valueToStore === null) {
          removeLocalStorageItem(key);
        } else {
          setLocalStorageItem(key, valueToStore, schema);
        }
      } catch (error) {
        stored = false;
        console.error("[LOCALSTORAGE] Error:", error);
      }
      setStoredValue(valueToStore);
      // After the state update, other hooks for this key re-read storage. A refused write
      // keeps the value in memory only; announcing it would re-read the old value.
      if (stored) queueMicrotask(() => dispatchLocalStorageChange(key));
    },
    [key, schema, setStoredValue],
  );

  const prevKeyRef = useRef(key);

  // Re-sync from localStorage when key changes
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      try {
        const newValue = getLocalStorageItem(key, schema);
        setStoredValue(newValue ?? readInitialValue());
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    }
  }, [key, schema, setStoredValue]);

  // Listen for storage events from other tabs AND custom events from the same tab
  useEffect(() => {
    const syncFromStorage = () => {
      try {
        const newValue = getLocalStorageItem(key, schema);
        setStoredValue(newValue ?? readInitialValue());
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === key) {
        syncFromStorage();
      }
    };

    const handleLocalChange = (event: CustomEvent<LocalStorageChangeDetail>) => {
      if (event.detail.key === key) {
        syncFromStorage();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
    };
  }, [key, schema, setStoredValue]);

  return [storedValue, setValue];
}
