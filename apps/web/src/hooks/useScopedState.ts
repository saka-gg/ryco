import { useCallback, useInsertionEffect, useRef, useState } from "react";

/**
 * State that belongs to `scope`: a new scope reads `initial(scope)` until
 * something sets the state in it.
 *
 * This replaces resetting state from render (calling a setter while
 * rendering when the scope changed), which React can lose: a render-phase
 * update is not kept for a rebase, so when the hook still holds an update of
 * another priority (a wheel or resize event's, even one that changed
 * nothing), the next render brings back the old scope's value.
 *
 * The setter writes to the scope last committed. That scope is current before
 * any layout effect of the commit that brought it, children's included, so a
 * child reporting from its mount writes to the new scope.
 */
export function useScopedState<S extends object, T>(
  scope: S,
  initial: (scope: S) => T,
): readonly [T, (value: T) => void] {
  const committedScopeRef = useRef(scope);
  useInsertionEffect(() => {
    committedScopeRef.current = scope;
  }, [scope]);
  const [entry, setEntry] = useState<{ readonly scope: S; readonly value: T } | null>(null);
  const value = entry !== null && entry.scope === scope ? entry.value : initial(scope);
  const setValue = useCallback((next: T) => {
    const target = committedScopeRef.current;
    setEntry((current) =>
      current !== null && current.scope === target && Object.is(current.value, next)
        ? current
        : { scope: target, value: next },
    );
  }, []);
  return [value, setValue];
}
