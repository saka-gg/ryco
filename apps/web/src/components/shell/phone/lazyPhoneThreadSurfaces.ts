import type { ComponentProps } from "react";

import { getPresentationTier } from "../../../lib/presentationTier";
import { preloadableLazy, type PreloadableLazyComponent } from "../../../lib/preloadableLazy";
import type * as PhoneThreadSurfaces from "./phoneThreadSurfaces";

/*
 * The frozen phone tier's thread surfaces, kept out of the chat route graph
 * every desktop thread loads (about 30 KiB). They share one chunk: the first
 * surface a phone thread wants loads all of them, and each mounts once
 * `usePhoneThreadSurfaceReady` reports it ready, so no Suspense fallback ever
 * commits. On the phone tier the chat routes load this chunk next to their own
 * (`loadChatRouteView`), so the thread's first frame still has its app bar and
 * dock: this only changes when the code loads, not what the tier renders.
 *
 * This module is part of the route definitions (boot), so it stays a loader:
 * the mount hook and its error reporting live in `usePhoneThreadSurfaceReady`.
 */

let surfacesModule: Promise<typeof PhoneThreadSurfaces> | null = null;

function loadPhoneThreadSurfaces(): Promise<typeof PhoneThreadSurfaces> {
  // One load (and on failure one error) for every surface; a failed load is
  // forgotten so the next attempt fetches again.
  surfacesModule ??= import("./phoneThreadSurfaces").catch((error: unknown) => {
    surfacesModule = null;
    throw error;
  });
  return surfacesModule;
}

// Annotated through the component types: some props interfaces are module-private.
export const LazyPhoneThreadAppBar: PreloadableLazyComponent<
  ComponentProps<typeof PhoneThreadSurfaces.PhoneThreadAppBar>
> = preloadableLazy(() => loadPhoneThreadSurfaces().then((module) => module.PhoneThreadAppBar));

export const LazyPhoneThreadDock: PreloadableLazyComponent<
  ComponentProps<typeof PhoneThreadSurfaces.PhoneThreadDock>
> = preloadableLazy(() => loadPhoneThreadSurfaces().then((module) => module.PhoneThreadDock));

export const LazyPhoneSessionPolicyControl: PreloadableLazyComponent<
  ComponentProps<typeof PhoneThreadSurfaces.PhoneSessionPolicyControl>
> = preloadableLazy(() =>
  loadPhoneThreadSurfaces().then((module) => module.PhoneSessionPolicyControl),
);

export const LazyPhoneModelSheet: PreloadableLazyComponent<
  ComponentProps<typeof PhoneThreadSurfaces.PhoneModelSheet>
> = preloadableLazy(() => loadPhoneThreadSurfaces().then((module) => module.PhoneModelSheet));

export const LazyMessageActionsSheet: PreloadableLazyComponent<
  ComponentProps<typeof PhoneThreadSurfaces.MessageActionsSheet>
> = preloadableLazy(() => loadPhoneThreadSurfaces().then((module) => module.MessageActionsSheet));

export const LazyPhoneWorkSurfaceSheet: PreloadableLazyComponent<
  ComponentProps<typeof PhoneThreadSurfaces.PhoneWorkSurfaceSheet>
> = preloadableLazy(() => loadPhoneThreadSurfaces().then((module) => module.PhoneWorkSurfaceSheet));

/** The overview sheet; ChatView mounts it on its first open and keeps it. */
export const LazyPhoneOverviewSheet: PreloadableLazyComponent<
  ComponentProps<typeof PhoneThreadSurfaces.PhoneOverviewSheet>
> = preloadableLazy(() => loadPhoneThreadSurfaces().then((module) => module.PhoneOverviewSheet));

const PHONE_THREAD_SURFACES = [
  LazyPhoneThreadAppBar,
  LazyPhoneThreadDock,
  LazyPhoneSessionPolicyControl,
  LazyPhoneModelSheet,
  LazyMessageActionsSheet,
  LazyPhoneWorkSurfaceSheet,
  LazyPhoneOverviewSheet,
];

/**
 * Loads the shared chunk and readies every surface, so each renders on its
 * first pass. Never rejects: a failed load leaves the surfaces unloaded, and
 * the next `usePhoneThreadSurfaceReady` that wants one retries and reports it.
 */
export function preloadPhoneThreadSurfaces(): Promise<void> {
  return Promise.all(PHONE_THREAD_SURFACES.map((surface) => surface.preload())).then(
    () => undefined,
  );
}

/**
 * Loads a chat route view (thread or draft). On the phone tier the phone
 * thread surfaces load alongside it and the route waits for both, so the view
 * commits with its app bar, dock and session policy control in the first frame
 * instead of popping them in one request later. The router awaits this before
 * it commits the match; hover and idle route preloads go through it too.
 */
export function loadChatRouteView<View>(loadView: () => Promise<View>): Promise<View> {
  if (getPresentationTier() !== "phone") return loadView();
  return Promise.all([loadView(), preloadPhoneThreadSurfaces()]).then(([view]) => view);
}
