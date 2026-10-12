import { createElement, type ComponentType } from "react";

/**
 * A route screen whose module is evaluated on first render instead of at launch.
 *
 * React Navigation's static configuration omits `getComponent`, so laziness has
 * to live in the component itself: `load` is a function-scoped `require()`,
 * which Metro registers but does not execute until it is called (the same
 * pattern `index.ts` uses for the dev-only vector runner). The resolved
 * component is cached, so every later render and every second navigator that
 * names the same screen reuse one module evaluation.
 *
 * The props type is the loaded component's own, so static navigation keeps
 * inferring each route's params from it.
 */
export interface LazyScreen<P extends object> {
  (props: P): ReturnType<typeof createElement>;
  displayName: string;
  /** Evaluate the screen's module now (idle prewarm); idempotent. */
  readonly preload: () => void;
}

export function lazyScreen<P extends object>(
  displayName: string,
  load: () => ComponentType<P>,
): LazyScreen<P> {
  let resolved: ComponentType<P> | null = null;
  const resolve = (): ComponentType<P> => (resolved ??= load());
  const screen = (props: P) => createElement(resolve(), props);
  return Object.assign(screen, {
    displayName,
    preload: () => {
      resolve();
    },
  });
}
