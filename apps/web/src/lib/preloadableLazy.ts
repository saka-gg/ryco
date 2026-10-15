import {
  createElement,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type FunctionComponent,
} from "react";

import { scheduleIdleTask } from "./idleTask";
import { allowsSpeculativePreload } from "./shellIdlePreload";

/**
 * A code-split component that renders synchronously once its module is loaded.
 *
 * `React.lazy` throws on the first render even when the module already
 * resolved (its initializer goes through `.then`), so every first mount commits
 * the Suspense fallback, and React 19 then holds the retry commit until 300 ms
 * after that fallback (the Suspense reveal throttle). An idle `import()` cannot
 * prevent it: the lazy wrapper itself stays uninitialised.
 *
 * `preloadableLazy` keeps the resolved component in module state instead.
 * Callers start the load with `preload()` — from a route `beforeLoad`/`loader`,
 * an idle task, or an intent event — and once it has settled the component
 * renders on the first pass with no fallback. Rendering before it settled still
 * suspends, so keep a `<Suspense>` boundary around it as a safety net, or mount
 * it only once {@link useLazyComponentReady} reports it ready: then it never
 * suspends and needs no boundary (on-demand panels and dialogs).
 */
export interface PreloadableModule {
  /**
   * Starts (or joins) the module load. Never rejects: a failed load surfaces
   * from the next render as an error, and the following `preload()` retries.
   */
  readonly preload: () => Promise<void>;
  /** Whether the next render returns the component synchronously. */
  readonly isLoaded: () => boolean;
  /**
   * The error of the last load when it failed and no retry is in flight, else
   * null. Optional so hand-written modules stay valid; `preloadableLazy`
   * always provides it.
   */
  readonly loadFailure?: () => { readonly error: unknown } | null;
}

export interface PreloadableLazyComponent<P extends object>
  extends FunctionComponent<P>, PreloadableModule {
  readonly loadFailure: () => { readonly error: unknown } | null;
}

export function preloadableLazy<P extends object>(
  load: () => Promise<ComponentType<P>>,
): PreloadableLazyComponent<P> {
  let component: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  let failure: { readonly error: unknown } | null = null;

  const preload = (): Promise<void> => {
    if (component) return Promise.resolve();
    if (pending) return pending;
    failure = null;
    const attempt: Promise<void> = Promise.resolve()
      .then(load)
      .then(
        (resolved) => {
          component = resolved;
        },
        (error: unknown) => {
          failure = { error };
        },
      )
      .finally(() => {
        if (pending === attempt) pending = null;
      });
    pending = attempt;
    return attempt;
  };

  function PreloadableLazy(props: P) {
    if (!component) {
      // A settled failure renders as an error (the nearest error boundary)
      // instead of retrying in a loop; the next explicit `preload()` retries.
      if (failure && !pending) throw failure.error;
      use(preload());
      if (!component) throw failure?.error ?? new Error("Lazy component failed to load.");
    }
    return createElement(component, props);
  }

  return Object.assign(PreloadableLazy, {
    preload,
    isLoaded: () => component !== null,
    loadFailure: () => (pending ? null : failure),
  });
}

export interface LazyComponentReadyOptions {
  /**
   * Handles a failed load in place of the default (report ready, so the mount
   * throws to the nearest error boundary). The hook then keeps reporting false,
   * so nothing mounts, and loads again the next time `wanted` turns true or
   * when `retry` runs (a Retry action, say). For surfaces inside a larger view
   * (the chat's panels and dialogs), where an error boundary would take the
   * whole view down and a silent failure would leave the surface stuck.
   */
  readonly onLoadError?: (error: unknown, retry: () => void) => void;
}

/**
 * Whether `component` can mount without suspending, starting its load when
 * `wanted` turns true. On-demand surfaces (a dialog's first open) mount only
 * once this is true, so they never commit a Suspense fallback: the surface
 * appears as soon as its chunk lands instead of up to 300 ms later, and a
 * component that has already loaded mounts in the same commit that wants it.
 * A failed load reports true, so the mount throws to the nearest error
 * boundary, unless `options.onLoadError` handles it.
 */
export function useLazyComponentReady(
  component: PreloadableModule,
  wanted: boolean,
  options?: LazyComponentReadyOptions,
): boolean {
  // `isLoaded()` reads module state that changes without a re-render (an idle
  // preload). React Compiler would cache it per `component` and keep reporting
  // the first render's answer, so a preloaded dialog still waited an extra
  // commit on its first open; this hook stays uncompiled.
  "use no memo";
  // Both are kept per component, so a caller that swaps `component` never
  // mounts the new one on the previous one's settled load. A preloadable
  // component is a function, so the setters take it through an updater.
  const [settledFor, setSettledFor] = useState<PreloadableModule | null>(null);
  // A handled failure parks the load until the next intent: `retry`, or the
  // surface being wanted again after it was let go.
  const [failedFor, setFailedFor] = useState<PreloadableModule | null>(null);
  if (failedFor !== null && !wanted) setFailedFor(null);
  const failed = failedFor === component;
  const loaded = component.isLoaded();
  const handlesLoadError = options?.onLoadError !== undefined;
  // The latest handler, read when the load settles. Not `useEffectEvent`:
  // React 19.2 refreshes an effect event only in plain function components,
  // so inside a `memo` or `forwardRef` caller it kept the first render's
  // handler, and the handler's view of the caller's state was stale.
  const onLoadErrorRef = useRef(options?.onLoadError);
  useLayoutEffect(() => {
    onLoadErrorRef.current = options?.onLoadError;
  });

  useEffect(() => {
    if (!wanted || loaded || failed) return;
    let active = true;
    // `preload()` never rejects; after a failure it starts a fresh attempt.
    void component.preload().then(() => {
      if (!active) return;
      if (handlesLoadError && !component.isLoaded()) {
        setFailedFor(() => component);
        onLoadErrorRef.current?.(
          component.loadFailure?.()?.error ?? new Error("Lazy component failed to load."),
          () => setFailedFor(null),
        );
        return;
      }
      setSettledFor(() => component);
    });
    return () => {
      active = false;
    };
  }, [component, failed, handlesLoadError, loaded, wanted]);
  return loaded || (wanted && settledFor === component);
}

/**
 * Loads `component` in an idle slot after the caller mounts, while `enabled`,
 * so a surface the user is likely to open next does not wait on its chunk. A
 * failed idle load stays quiet: the next `preload()` (the open) retries it.
 * The download is speculative, so data saver and slow links skip it (see
 * `allowsSpeculativePreload`) and load the surface on the open instead.
 */
export function usePreloadWhenIdle(component: PreloadableModule, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || component.isLoaded() || !allowsSpeculativePreload()) return;
    return scheduleIdleTask(() => {
      void component.preload();
    });
  }, [component, enabled]);
}
