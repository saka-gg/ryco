import type { ReadonlyRecord } from "effect/Record";
import { Context, Effect, Layer, Scope } from "effect";
import { Atom, Reactivity } from "effect/reactivity";

import { appAtomRegistry } from "./atomRegistry.ts";

/**
 * Reactivity keys accepted by `AtomRpc` query/mutation `reactivityKeys` and by
 * the {@link Reactivity} service.
 */
export type ReactivityKeys =
  | ReadonlyArray<unknown>
  | ReadonlyRecord<string, ReadonlyArray<unknown>>;

/**
 * Static reactivity key for server configuration/settings/providers state.
 */
export const SERVER_CONFIG_KEY = "server-config";

/**
 * Scoped reactivity key for git/source-control state of a working directory.
 */
export function gitScopeKey(cwd: string): string {
  return `git:${cwd}`;
}

/**
 * Scoped reactivity key for project (file tree / search) state of a working
 * directory.
 */
export function projectScopeKey(cwd: string): string {
  return `project:${cwd}`;
}

/**
 * Scoped reactivity key for checkpoint/diff state of a thread.
 */
export function checkpointScopeKey(threadId: string): string {
  return `checkpoint:${threadId}`;
}

/**
 * Builders for the explicit, scoped invalidation keys used across the RPC
 * layer. Each returns an array suitable for `reactivityKeys` or for the
 * imperative {@link invalidate} helper.
 */
export const InvalidationKeys = {
  git: (cwd: string): ReadonlyArray<string> => [gitScopeKey(cwd)],
  project: (cwd: string): ReadonlyArray<string> => [projectScopeKey(cwd)],
  checkpoint: (threadId: string): ReadonlyArray<string> => [checkpointScopeKey(threadId)],
  serverConfig: (): ReadonlyArray<string> => [SERVER_CONFIG_KEY],
} as const;

/**
 * Effectful invalidation for use inside atom effects/mutations. Requires the
 * {@link Reactivity} service provided by the atom runtime.
 */
export const invalidate = (
  keys: ReactivityKeys,
): Effect.Effect<void, never, Reactivity.Reactivity> => Reactivity.invalidate(keys);

type ReactivityService = Context.Service.Shape<typeof Reactivity.Reactivity>;

let sharedReactivity: ReactivityService | null = null;
let sharedMemoMap: Layer.MemoMap | null = null;

/**
 * Resolve the single {@link Reactivity} instance shared by all atoms created
 * through `Atom.runtime` (including {@link AtomRpcClient}). The instance is
 * memoized against `Atom.defaultMemoMap`, so this returns the same service the
 * atoms register their refresh handlers against.
 */
function getSharedReactivity(): ReactivityService {
  const memoMap = appAtomRegistry.get(Atom.runtime.memoMap);
  if (sharedReactivity && sharedMemoMap === memoMap) {
    return sharedReactivity;
  }
  const scope = Effect.runSync(Scope.make());
  const context = Effect.runSync(Layer.buildWithMemoMap(Reactivity.layer, memoMap, scope));
  sharedMemoMap = memoMap;
  sharedReactivity = Context.get(context, Reactivity.Reactivity);
  return sharedReactivity;
}

/**
 * Imperatively invalidate scoped reactivity keys, refreshing every mounted atom
 * registered with the matching keys. Intended for push-driven invalidation
 * (orchestration events, server config streams) that runs outside an effect.
 */
export function invalidateKeys(keys: ReactivityKeys): void {
  getSharedReactivity().invalidateUnsafe(keys);
}

/**
 * Invalidate git/source-control state for a working directory.
 */
export function invalidateGit(cwd: string): void {
  invalidateKeys(InvalidationKeys.git(cwd));
}

/**
 * Invalidate project (file tree / search) state for a working directory.
 */
export function invalidateProject(cwd: string): void {
  invalidateKeys(InvalidationKeys.project(cwd));
}

/**
 * Invalidate checkpoint/diff state for a thread.
 */
export function invalidateCheckpoint(threadId: string): void {
  invalidateKeys(InvalidationKeys.checkpoint(threadId));
}

/**
 * Invalidate server configuration/settings/providers state.
 */
export function invalidateServerConfig(): void {
  invalidateKeys(InvalidationKeys.serverConfig());
}

/**
 * Reset the cached {@link Reactivity} resolution. Tests that dispose the atom
 * registry should call this so subsequent invalidations re-resolve the shared
 * service.
 */
export function resetInvalidationForTests(): void {
  sharedReactivity = null;
  sharedMemoMap = null;
}
