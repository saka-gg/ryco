import {
  WS_METHODS,
  type EnvironmentId,
  type TerminalSessionSnapshot,
  type ThreadId,
} from "@ryco/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@ryco/shared/projectScripts";
import { Schema } from "effect";

import { readEnvironmentApi } from "./environmentApi";
import { readHostedRpcCapability } from "./hostedHub/capabilities";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

/**
 * Starts a thread terminal's PTY while the xterm chunk still loads, so the
 * user's shell startup overlaps client work instead of following it.
 *
 * Safe only on an explicit open (click, shortcut, mount of the terminal
 * surface): a PTY started by a hover would announce itself as a fresh start,
 * which force-opens the drawer. This module stays free of xterm imports.
 */

export interface ThreadTerminalLaunch {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly runtimeEnv: Record<string, string>;
}

/**
 * The one resolver for where a thread terminal starts, shared by the chat
 * drawer, the workspace terminal tab and the early prepare. They must agree
 * exactly: the server restarts a live PTY and wipes its history when open()
 * arrives with another cwd or environment. A server-reported launch context
 * (the terminal's actual start) wins over the thread's current worktree.
 */
export function resolveThreadTerminalLaunch(input: {
  readonly projectCwd: string | null;
  readonly threadWorktreePath: string | null;
  readonly launchContext: { readonly cwd: string; readonly worktreePath: string | null } | null;
}): ThreadTerminalLaunch | null {
  const worktreePath =
    input.launchContext !== null ? input.launchContext.worktreePath : input.threadWorktreePath;
  if (input.projectCwd === null) {
    return null;
  }
  const project = { cwd: input.projectCwd };
  return {
    cwd: input.launchContext?.cwd ?? projectScriptCwd({ project, worktreePath }),
    worktreePath,
    runtimeEnv: projectScriptRuntimeEnv({ project, worktreePath }),
  };
}

/** Identity of a launch: a prepared open is only reused for the same one. */
export function terminalLaunchKey(launch: {
  readonly cwd: string;
  readonly worktreePath: string | null | undefined;
  readonly runtimeEnv: Record<string, string> | undefined;
}): string {
  const env = Object.entries(launch.runtimeEnv ?? {}).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return JSON.stringify([launch.cwd, launch.worktreePath ?? null, env]);
}

export type TerminalSurfaceLayout = "drawer" | "panel";

export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

const DEFAULT_TERMINAL_DIMENSIONS: TerminalDimensions = { cols: 80, rows: 24 };
export const TERMINAL_DIMENSIONS_STORAGE_KEY = "ryco:terminal-dimensions:v1";
const TerminalDimensionsSchema = Schema.Struct({
  cols: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(1000)),
  rows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(500)),
});
const StoredTerminalDimensionsSchema = Schema.Struct({
  drawer: Schema.optional(TerminalDimensionsSchema),
  panel: Schema.optional(TerminalDimensionsSchema),
});
type StoredTerminalDimensions = typeof StoredTerminalDimensionsSchema.Type;

let storedDimensions: StoredTerminalDimensions | null = null;

function readStoredDimensions(): StoredTerminalDimensions {
  if (storedDimensions !== null) return storedDimensions;
  try {
    storedDimensions =
      getLocalStorageItem(TERMINAL_DIMENSIONS_STORAGE_KEY, StoredTerminalDimensionsSchema) ?? {};
  } catch {
    storedDimensions = {};
  }
  return storedDimensions;
}

/** Last fitted size per surface; a prepared PTY starts at it to avoid a resize. */
export function readLastTerminalDimensions(layout: TerminalSurfaceLayout): TerminalDimensions {
  return readStoredDimensions()[layout] ?? DEFAULT_TERMINAL_DIMENSIONS;
}

export function rememberTerminalDimensions(
  layout: TerminalSurfaceLayout,
  dimensions: TerminalDimensions,
): void {
  const current = readStoredDimensions();
  const previous = current[layout];
  if (previous?.cols === dimensions.cols && previous.rows === dimensions.rows) return;
  if (!Schema.is(TerminalDimensionsSchema)(dimensions)) return;
  storedDimensions = { ...current, [layout]: { cols: dimensions.cols, rows: dimensions.rows } };
  try {
    setLocalStorageItem(
      TERMINAL_DIMENSIONS_STORAGE_KEY,
      storedDimensions,
      StoredTerminalDimensionsSchema,
    );
  } catch {
    // Storage is best effort; the in-memory value still serves this session.
  }
}

interface PreparedTerminalOpen {
  readonly launchKey: string;
  readonly dimensions: TerminalDimensions;
  readonly promise: Promise<TerminalSessionSnapshot>;
  readonly createdAt: number;
}

/**
 * A prepared open older than this is not handed to a mounting terminal: its
 * snapshot could predate more output than the client event buffer retains.
 */
const PREPARED_TERMINAL_OPEN_TTL_MS = 10_000;
const preparedTerminalOpens = new Map<string, PreparedTerminalOpen>();

function preparedTerminalKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  terminalId: string,
): string {
  return JSON.stringify([environmentId, threadId, terminalId]);
}

export interface PrepareThreadTerminalInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly launch: ThreadTerminalLaunch;
  readonly layout: TerminalSurfaceLayout;
}

/**
 * Sends `terminal.open` now. The server's open is idempotent for a live
 * session with the same launch, so this only moves the spawn earlier. The
 * mounting terminal takes the in-flight result instead of opening again.
 */
export function prepareThreadTerminal(input: PrepareThreadTerminalInput): void {
  const key = preparedTerminalKey(input.environmentId, input.threadId, input.terminalId);
  const launchKey = terminalLaunchKey(input.launch);
  const existing = preparedTerminalOpens.get(key);
  if (
    existing &&
    existing.launchKey === launchKey &&
    Date.now() - existing.createdAt < PREPARED_TERMINAL_OPEN_TTL_MS
  ) {
    return;
  }
  // An early open never runs ahead of hosted authorization: until the hosted
  // lifecycle grants terminal access, the terminal opens on its own when it mounts.
  if (!readHostedRpcCapability(WS_METHODS.terminalOpen).allowed) return;
  const api = readEnvironmentApi(input.environmentId);
  if (!api) return;
  const dimensions = readLastTerminalDimensions(input.layout);
  const promise = api.terminal.open({
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.launch.cwd,
    worktreePath: input.launch.worktreePath,
    cols: dimensions.cols,
    rows: dimensions.rows,
    env: input.launch.runtimeEnv,
  });
  const entry: PreparedTerminalOpen = { launchKey, dimensions, promise, createdAt: Date.now() };
  preparedTerminalOpens.set(key, entry);
  promise.catch(() => {
    // A failed prepare must not be handed out; the terminal opens on its own.
    if (preparedTerminalOpens.get(key) === entry) preparedTerminalOpens.delete(key);
  });
}

/** Hands a matching, fresh prepared open to the terminal that mounts. */
export function takePreparedTerminalOpen(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly launchKey: string;
}): {
  readonly promise: Promise<TerminalSessionSnapshot>;
  readonly dimensions: TerminalDimensions;
} | null {
  const key = preparedTerminalKey(input.environmentId, input.threadId, input.terminalId);
  const entry = preparedTerminalOpens.get(key);
  if (!entry) return null;
  preparedTerminalOpens.delete(key);
  if (
    entry.launchKey !== input.launchKey ||
    Date.now() - entry.createdAt >= PREPARED_TERMINAL_OPEN_TTL_MS
  ) {
    return null;
  }
  return { promise: entry.promise, dimensions: entry.dimensions };
}

export function resetPreparedTerminalOpensForTests(): void {
  preparedTerminalOpens.clear();
  storedDimensions = null;
}
