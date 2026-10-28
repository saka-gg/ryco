/**
 * databaseOwnerLock - Which process owns a Ryco database.
 *
 * Two Ryco servers on one data directory (the desktop app and a `ryco serve`
 * or `ryco service` on the default `~/.ryco`, or two dev servers) used to share
 * one SQLite database: both migrated it, both ran projectors and reactors over
 * it, and a newer binary could upgrade the schema under an older one. Owning
 * the database is now explicit, through `<dbPath>.owner`:
 *
 * - A server owns it for its whole lifetime: taken before the port binds,
 *   released after the last connection closed ({@link DatabaseOwnerLeaseLive}).
 *   A second server waits briefly (a desktop replacing its own backend, a
 *   service restart), then fails with a typed startup error, `database-in-use`.
 *   A `ryco service` waits for as long as another server runs, so it takes over
 *   once the desktop app quits instead of crash-looping under launchd/systemd.
 * - Maintenance (a CLI migration, a restore, `ryco doctor`) owns it
 *   exclusively for one operation, and never while a server owns it.
 * - Every other process (the `ryco auth`, `hub`, `project`, `setup` commands)
 *   still opens the database while a server runs. Only migrating is gated: see
 *   `migrationOwnershipPolicy.ts`.
 *
 * Liveness is the Hub identity lock's: pid plus boot id plus process start time
 * (`processLock/processIdentity.ts`), so a crashed, killed or rebooted owner's
 * lock is reclaimed without a heartbeat (a suspended laptop must not look
 * stale). The record also names the inode of the lock file itself, so a lock
 * copied along with a data directory never claims the copy.
 *
 * Unlike the Hub lock this one fails closed: nothing else arbitrates database
 * ownership, and the conditions that make the lock file unusable (another
 * user's file, a read-only or full disk) also make the database unsafe.
 * `RYCO_DB_OWNER_LOCK=off` skips it, loudly, for filesystems that cannot hold it.
 *
 * Servers that predate this lock write no lock file; while no lock file
 * exists, a live `server-runtime.json` pid that also listens on its recorded
 * port counts as a (legacy) server owner.
 *
 * @module databaseOwnerLock
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as NodePath from "node:path";

import { Clock, Config, Context, Data, Effect, Layer, Option, type Scope } from "effect";

import packageJson from "../../package.json" with { type: "json" };
import { SERVER_RUNTIME_STATE_FILE_NAME, ServerConfig } from "../config.ts";
import {
  createLockFileExclusive,
  type LockFileRead,
  readLockFile,
  reclaimLockFile,
  removeLockFileIfUnchanged,
} from "../processLock/exclusiveLockFile.ts";
import {
  BOOT_ID_PATTERN,
  defaultProcessProbe,
  isHolderAbandoned,
  type ProcessProbe,
  START_TIME_PATTERN,
  UNPARSEABLE_LOCK_GRACE_MS,
} from "../processLock/processIdentity.ts";
import {
  isAcceptingConnections,
  isPersistedServerRunning,
  parsePersistedServerRuntimeState,
  persistedServerHost,
} from "../serverRuntimeState.ts";
import { nodeServiceManagerOfProcess } from "../service/nodeServiceManager.ts";
import { migrationSchemaDigest, SUPPORTED_MIGRATION_ID } from "./Migrations.ts";

export type DatabaseOwnerKind = "server" | "maintenance";
export type DatabaseOwnerLauncher = "desktop" | "service" | "serve" | "cli" | "unknown";

export interface DatabaseOwner {
  readonly pid: number;
  readonly kind: DatabaseOwnerKind;
  /** ISO time ownership was taken (for a legacy owner, when it started serving). */
  readonly startedAt: string;
  /** "serve" | "cli-migration" | "restore" | "doctor" | ... */
  readonly purpose: string;
  readonly launcher: DatabaseOwnerLauncher;
  /** `RYCO_SERVICE_LABEL` of a `ryco service` owner. */
  readonly serviceLabel?: string | undefined;
  /** The owner's server package version, or "unknown". */
  readonly appVersion: string;
  /** Highest migration id the owner's binary knows; null when unknown (legacy). */
  readonly schemaSupported: number | null;
  /** The owner binary's `migrationSchemaDigest`; null when unknown (legacy). */
  readonly schemaDigest: string | null;
  /** A server from before this lock, recognized through `server-runtime.json`. */
  readonly legacy: boolean;
  /** Where a legacy owner listens (`host:port`). */
  readonly endpoint?: string | undefined;
  /** Held by this process. */
  readonly self: boolean;
}

export type DatabaseOwnership =
  | { readonly state: "free" }
  | { readonly state: "owned"; readonly owner: DatabaseOwner };

export type DatabaseOwnerLockErrorReason =
  | "foreign-file"
  | "unreadable"
  | "being-written"
  | "io-error";

/** The lock file exists but cannot be judged: treat the database as owned. */
export class DatabaseOwnerLockError extends Data.TaggedError("DatabaseOwnerLockError")<{
  readonly lockPath: string;
  readonly reason: DatabaseOwnerLockErrorReason;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Ownership could not be taken. Fatal at server startup (`database-in-use`). */
export class DatabaseOwnedError extends Data.TaggedError("DatabaseOwnedError")<{
  readonly dbPath: string;
  readonly lockPath: string;
  readonly owner: DatabaseOwner | null;
  readonly reason: "held" | DatabaseOwnerLockErrorReason;
  readonly message: string;
}> {}

/** A process without ownership needed to upgrade a database that a live process owns. */
export class DatabaseUpgradeBlockedError extends Data.TaggedError("DatabaseUpgradeBlockedError")<{
  readonly owner: DatabaseOwner | null;
  /** The database's schema (latest applied migration). */
  readonly from: number;
  /** This binary's schema. */
  readonly to: number;
  /** Keys of the compatibility repairs this database has never recorded (`repairsPending`). */
  readonly repairs: ReadonlyArray<string>;
  readonly message: string;
}> {}

export interface DatabaseOwnerLeaseShape {
  readonly dbPath: string;
  readonly lockPath: string;
  readonly owner: DatabaseOwner;
  /** False when `RYCO_DB_OWNER_LOCK=off` skipped the lock. */
  readonly enforced: boolean;
}

/** The server-lifetime ownership of `ServerConfig.dbPath`, provided by {@link DatabaseOwnerLeaseLive}. */
export class DatabaseOwnerLease extends Context.Service<
  DatabaseOwnerLease,
  DatabaseOwnerLeaseShape
>()("ryco/persistence/DatabaseOwnerLease") {}

/** Machine and process facts the lock reads; replaced in tests to act as another process. */
export interface DatabaseOwnerLockEnvironment {
  readonly pid: number;
  /** Tells the process a service manager started from the ones it started in turn. */
  readonly parentPid: number;
  /** Wall clock, for records and lock-file ages. Waits use the Effect clock. */
  readonly now: () => number;
  readonly probe: ProcessProbe;
  /** Whether something accepts TCP connections at `host:port` within `timeoutMs`. */
  readonly isListening: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export const DatabaseOwnerLockEnvironment = Context.Reference<DatabaseOwnerLockEnvironment>(
  "ryco/persistence/DatabaseOwnerLockEnvironment",
  {
    defaultValue: () => ({
      pid: process.pid,
      parentPid: process.ppid,
      now: Date.now,
      probe: defaultProcessProbe,
      isListening: isAcceptingConnections,
    }),
  },
);

/** How long a server waits for another server (a desktop replacing its backend, a restart). */
export const SERVER_HOLDER_WAIT_MS = 10_000;
/** How long a server waits for a CLI migration, restore or doctor run to finish. */
export const MAINTENANCE_HOLDER_WAIT_MS = 10 * 60_000;
/**
 * How long a lock record that is being written (created, not filled in yet) is read again before
 * its unknown writer counts as the holder.
 */
export const BEING_WRITTEN_WAIT_MS = 1_000;
/** A lock file is at most this large; anything bigger is not one. */
const LOCK_FILE_MAX_BYTES = 2_048;

export const databaseOwnerLockPath = (dbPath: string): string => `${dbPath}.owner`;

/** One optional setting; an invalid value counts as unset, without affecting the others. */
const optionalSetting = <A>(config: Config.Config<Option.Option<A>>) =>
  config.pipe(Effect.orElseSucceed(() => Option.none<A>()));

interface LockConfig {
  readonly mode: Option.Option<string>;
  readonly waitMs: Option.Option<number>;
  readonly serviceLabel: Option.Option<string>;
  readonly systemdExecPid: Option.Option<string>;
}

const readLockConfig: Effect.Effect<LockConfig> = Effect.all({
  mode: optionalSetting(Config.String("RYCO_DB_OWNER_LOCK").pipe(Config.option)),
  waitMs: optionalSetting(Config.Int("RYCO_DB_OWNER_WAIT_MS").pipe(Config.option)),
  serviceLabel: optionalSetting(Config.String("RYCO_SERVICE_LABEL").pipe(Config.option)),
  systemdExecPid: optionalSetting(Config.String("SYSTEMD_EXEC_PID").pipe(Config.option)),
});

const lockDisabledBy = (config: LockConfig) =>
  Option.match(config.mode, {
    onNone: () => false,
    onSome: (mode) => ["off", "0", "false"].includes(mode.trim().toLowerCase()),
  });

/** `RYCO_DB_OWNER_LOCK=off`: no lock file, and migrations behave as before the lock. */
export const isDatabaseOwnerLockDisabled: Effect.Effect<boolean> = readLockConfig.pipe(
  Effect.map(lockDisabledBy),
);

/**
 * How long a server waits for another server: `waitMs` when given, without a
 * deadline for a service, else `RYCO_DB_OWNER_WAIT_MS` or 10 s.
 */
const serverHolderWaitMs = (
  launcher: DatabaseOwnerLauncher,
  config: LockConfig,
  waitMs: number | "forever" | undefined,
): number | "forever" =>
  waitMs ??
  (launcher === "service"
    ? "forever"
    : Option.getOrElse(config.waitMs, () => SERVER_HOLDER_WAIT_MS));

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

interface OwnerRecord {
  readonly version: number;
  readonly token: string;
  readonly pid: number;
  readonly kind: DatabaseOwnerKind;
  readonly purpose: string;
  readonly launcher: DatabaseOwnerLauncher;
  readonly appVersion: string;
  readonly startedAt: string;
  readonly bootTime: number;
  readonly bootId: string | null;
  readonly startTime: string | null;
  /** Inode of the lock file this record was written into; 0 when the filesystem reported none. */
  readonly ino: number;
  readonly schemaSupported: number;
  readonly schemaDigest: string;
  readonly serviceLabel?: string;
}

const LAUNCHERS: ReadonlySet<string> = new Set<DatabaseOwnerLauncher>([
  "desktop",
  "service",
  "serve",
  "cli",
  "unknown",
]);

const shortString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/**
 * Lenient on purpose: later versions may add fields, and a record this binary
 * cannot read counts as half-written, which another binary would reclaim after
 * a minute. Only the fields every version keeps are required.
 */
function decodeOwnerRecord(content: string): OwnerRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (
    typeof record.version !== "number" ||
    record.version < 1 ||
    !shortString(record.token, 64) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    (kind !== "server" && kind !== "maintenance") ||
    typeof record.bootTime !== "number" ||
    !Number.isFinite(record.bootTime) ||
    !(
      record.bootId === null ||
      (typeof record.bootId === "string" && BOOT_ID_PATTERN.test(record.bootId))
    ) ||
    !(
      record.startTime === null ||
      (typeof record.startTime === "string" && START_TIME_PATTERN.test(record.startTime))
    ) ||
    // Not a safe integer everywhere: Windows file ids reach past 2^53, and Node
    // reports them as the same rounded number on every stat of that file.
    typeof record.ino !== "number" ||
    !Number.isFinite(record.ino) ||
    record.ino < 0
  ) {
    return undefined;
  }
  const launcher = LAUNCHERS.has(record.launcher as string)
    ? (record.launcher as DatabaseOwnerLauncher)
    : "unknown";
  return {
    version: record.version,
    token: record.token,
    pid: record.pid as number,
    kind,
    purpose: shortString(record.purpose, 64) ? record.purpose : "unknown",
    launcher,
    appVersion: shortString(record.appVersion, 64) ? record.appVersion : "unknown",
    startedAt: shortString(record.startedAt, 64) ? record.startedAt : "",
    bootTime: record.bootTime,
    bootId: record.bootId as string | null,
    startTime: record.startTime as string | null,
    ino: record.ino,
    schemaSupported: Number.isSafeInteger(record.schemaSupported)
      ? (record.schemaSupported as number)
      : 0,
    schemaDigest: shortString(record.schemaDigest, 64) ? record.schemaDigest : "",
    ...(shortString(record.serviceLabel, 256) ? { serviceLabel: record.serviceLabel } : {}),
  };
}

const readOwnerLock = (lockPath: string): Promise<LockFileRead<OwnerRecord>> =>
  readLockFile(lockPath, { maxBytes: LOCK_FILE_MAX_BYTES, decode: decodeOwnerRecord });

/**
 * Tokens of the leases this process holds or is taking, per lock path. A lock
 * naming this pid with any other token is left over from an earlier process
 * that had the same pid (a container's pid 1).
 */
const localTokens = new Map<string, Set<string>>();

const registerToken = (lockPath: string, token: string) => {
  const tokens = localTokens.get(lockPath) ?? new Set<string>();
  tokens.add(token);
  localTokens.set(lockPath, tokens);
};

const unregisterToken = (lockPath: string, token: string) => {
  const tokens = localTokens.get(lockPath);
  tokens?.delete(token);
  if (tokens?.size === 0) localTokens.delete(lockPath);
};

const isLocalToken = (lockPath: string, token: string) =>
  localTokens.get(lockPath)?.has(token) === true;

const ownerFromRecord = (
  lockPath: string,
  record: OwnerRecord,
  env: DatabaseOwnerLockEnvironment,
): DatabaseOwner => ({
  pid: record.pid,
  kind: record.kind,
  startedAt: record.startedAt,
  purpose: record.purpose,
  launcher: record.launcher,
  ...(record.serviceLabel !== undefined ? { serviceLabel: record.serviceLabel } : {}),
  appVersion: record.appVersion,
  schemaSupported: record.schemaSupported,
  schemaDigest: record.schemaDigest,
  legacy: false,
  self: record.pid === env.pid && isLocalToken(lockPath, record.token),
});

/**
 * A lock file that cannot be parsed is being written right now, or was torn
 * by a crash: stale once it is older than the grace period, or when it was
 * last written before this boot (its writer cannot have survived the reboot).
 */
function isUnparseableLockStale(
  read: { readonly mtimeMs: number },
  env: DatabaseOwnerLockEnvironment,
  probe: ProcessProbe,
): boolean {
  return (
    env.now() - read.mtimeMs > UNPARSEABLE_LOCK_GRACE_MS || read.mtimeMs < probe.bootTime() - 1_000
  );
}

/** True when the recorded owner is certainly gone (or the record is not this file's own). */
async function isRecordAbandoned(
  lockPath: string,
  read: { readonly record: OwnerRecord; readonly ino: number },
  env: DatabaseOwnerLockEnvironment,
  probe: ProcessProbe,
): Promise<boolean> {
  const { record } = read;
  // Copied together with its data directory: it names another file.
  if (record.ino !== 0 && record.ino !== read.ino) return true;
  if (record.pid === env.pid) return !isLocalToken(lockPath, record.token);
  return isHolderAbandoned(
    {
      pid: record.pid,
      bootTime: record.bootTime,
      bootId: record.bootId ?? undefined,
      startTime: record.startTime ?? undefined,
    },
    probe,
  );
}

// ---------------------------------------------------------------------------
// Legacy owners
// ---------------------------------------------------------------------------

/**
 * A server from before this lock that still runs on this data directory: its
 * `server-runtime.json` names a live pid other than ours, and something
 * listens on the recorded port (which rules out a reused pid). Best effort for
 * the transition: a legacy server whose file was cleared is not seen.
 */
async function readLegacyServerOwner(
  dbPath: string,
  env: DatabaseOwnerLockEnvironment,
): Promise<DatabaseOwner | null> {
  let content: string;
  try {
    content = await readFile(
      NodePath.join(NodePath.dirname(dbPath), SERVER_RUNTIME_STATE_FILE_NAME),
      "utf8",
    );
  } catch {
    return null;
  }
  const parsed = parsePersistedServerRuntimeState(content);
  if (Option.isNone(parsed) || parsed.value.pid === env.pid) return null;
  const state = parsed.value;
  if (
    !(await isPersistedServerRunning(state, {
      processAlive: env.probe.processAlive,
      isListening: env.isListening,
    }))
  ) {
    return null;
  }
  const host = persistedServerHost(state);
  return {
    pid: state.pid,
    kind: "server",
    startedAt: state.startedAt,
    purpose: "serve",
    launcher: "unknown",
    appVersion: "unknown",
    schemaSupported: null,
    schemaDigest: null,
    legacy: true,
    endpoint: `${host.includes(":") ? `[${host}]` : host}:${state.port}`,
    self: false,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const displayPath = (path: string): string => {
  const home = homedir();
  return home.length > 1 && (path === home || path.startsWith(`${home}${NodePath.sep}`))
    ? `~${path.slice(home.length)}`
    : path;
};

const pad2 = (value: number) => String(value).padStart(2, "0");

/** "15:01" today, "2026-10-22 15:01" otherwise, in local time. */
export function formatOwnerSince(iso: string, nowMs: number): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const now = new Date(nowMs);
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${time}`;
}

/** "the Ryco desktop app (pid 4242, version 0.1.36, running since 15:01)" */
export function describeDatabaseOwner(owner: DatabaseOwner, nowMs: number = Date.now()): string {
  const since = formatOwnerSince(owner.startedAt, nowMs);
  if (owner.legacy) {
    return `an older Ryco server (${[
      `pid ${owner.pid}`,
      owner.endpoint !== undefined ? `listening on ${owner.endpoint}` : null,
      since !== null ? `started ${since}` : null,
    ]
      .filter((part) => part !== null)
      .join(", ")})`;
  }
  const details = [
    `pid ${owner.pid}`,
    owner.appVersion !== "unknown" ? `version ${owner.appVersion}` : null,
    since !== null ? `${owner.kind === "server" ? "running since" : "started"} ${since}` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  switch (owner.launcher) {
    case "desktop":
      return `the Ryco desktop app (${details})`;
    case "service":
      return `the background service${owner.serviceLabel ? ` ${owner.serviceLabel}` : ""} (${details})`;
    case "serve":
      return `\`ryco serve\` (${details})`;
    case "cli":
      return `\`ryco\` (${details})`;
    case "unknown":
      return `a Ryco process (${details})`;
  }
}

export function describeDatabaseOwnedFailure(input: {
  readonly dbPath: string;
  readonly lockPath: string;
  readonly owner: DatabaseOwner | null;
  readonly reason: DatabaseOwnedError["reason"];
  readonly detail?: string | undefined;
  readonly nowMs?: number | undefined;
}): string {
  const dataDirectory = displayPath(NodePath.dirname(input.dbPath));
  const lockPath = displayPath(input.lockPath);
  switch (input.reason) {
    case "unreadable":
      return `Ryco cannot read ${lockPath} (permission denied). A Ryco server running as another user may be using this database. Stop it, or remove the file if no Ryco server runs.`;
    case "foreign-file":
      return `${lockPath} is not a Ryco owner lock (a directory, a link or an unexpected file), so Ryco cannot tell whether another server is using this database. Remove it if no Ryco server runs.`;
    case "being-written":
      return `Another Ryco process is taking over ${dataDirectory} right now. Retry in a moment.`;
    case "io-error":
      return `Ryco could not create its owner lock ${lockPath}${input.detail ? ` (${input.detail})` : ""}, so it cannot make sure that it is the only server using this database. Fix the directory's permissions or free disk space; on a filesystem that cannot hold the lock, set RYCO_DB_OWNER_LOCK=off and make sure only one Ryco server runs.`;
    case "held": {
      const owner = input.owner;
      if (owner === null) {
        return `Another Ryco process is taking over ${dataDirectory} right now. Retry in a moment.`;
      }
      const holder = describeDatabaseOwner(owner, input.nowMs);
      if (owner.kind === "maintenance") {
        return `Ryco is upgrading or repairing this database in another process (${holder}). Wait for it to finish, then retry.`;
      }
      if (owner.legacy) {
        return `${holder.charAt(0).toUpperCase()}${holder.slice(1)} is using ${dataDirectory}. Quit it first.`;
      }
      const next =
        owner.launcher === "service"
          ? `Stop it with \`ryco service stop\`, or start this one with a different --base-dir.`
          : `Quit the other one, or start this one with a different --base-dir.`;
      return `Another Ryco server is using this data directory: ${holder}. Only one Ryco server can use ${dataDirectory} at a time. ${next}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const lockErrorMessage = (
  lockPath: string,
  reason: DatabaseOwnerLockErrorReason,
  detail?: string,
) => describeDatabaseOwnedFailure({ dbPath: lockPath, lockPath, owner: null, reason, detail });

/**
 * Who owns the database now, without taking anything. Stale locks count as
 * free (and are left in place); a lock that cannot be judged is an error, which
 * callers treat as owned.
 */
export const probeDatabaseOwner = (
  dbPath: string,
): Effect.Effect<DatabaseOwnership, DatabaseOwnerLockError> =>
  Effect.gen(function* () {
    const env = yield* DatabaseOwnerLockEnvironment;
    const lockPath = databaseOwnerLockPath(dbPath);
    const fail = (reason: DatabaseOwnerLockErrorReason, detail?: string, cause?: unknown) =>
      Effect.fail(
        new DatabaseOwnerLockError({
          lockPath,
          reason,
          message: lockErrorMessage(lockPath, reason, detail),
          cause,
        }),
      );
    const outcome = yield* Effect.tryPromise({
      try: async (): Promise<
        | { readonly _tag: "owned"; readonly owner: DatabaseOwner }
        | { readonly _tag: "free" }
        | {
            readonly _tag: "error";
            readonly reason: DatabaseOwnerLockErrorReason;
            readonly detail?: string;
          }
      > => {
        const read = await readOwnerLock(lockPath);
        switch (read.kind) {
          case "unreadable":
            return { _tag: "error", reason: "unreadable", detail: read.code };
          case "foreign":
            return { _tag: "error", reason: "foreign-file" };
          case "unparseable":
            if (!isUnparseableLockStale(read, env, env.probe)) {
              return { _tag: "error", reason: "being-written" };
            }
            break;
          case "holder":
            if (!(await isRecordAbandoned(lockPath, read, env, env.probe))) {
              return { _tag: "owned", owner: ownerFromRecord(lockPath, read.record, env) };
            }
            break;
          case "absent":
            break;
        }
        const legacy = await readLegacyServerOwner(dbPath, env);
        return legacy === null ? { _tag: "free" } : { _tag: "owned", owner: legacy };
      },
      catch: (cause) =>
        new DatabaseOwnerLockError({
          lockPath,
          reason: "io-error",
          message: lockErrorMessage(lockPath, "io-error", String(cause)),
          cause,
        }),
    });
    switch (outcome._tag) {
      case "owned":
        return { state: "owned", owner: outcome.owner } as const;
      case "free":
        return { state: "free" } as const;
      case "error":
        return yield* fail(outcome.reason, outcome.detail);
    }
  });

/**
 * {@link probeDatabaseOwner}, except that a lock record still being written is read again for up
 * to {@link BEING_WRITTEN_WAIT_MS}, as taking ownership does: its writer may yet turn out to be a
 * known owner, or give the lock up.
 */
export const probeDatabaseOwnerSettled = (
  dbPath: string,
): Effect.Effect<DatabaseOwnership, DatabaseOwnerLockError> =>
  Effect.gen(function* () {
    const startedMs = yield* Clock.currentTimeMillis;
    for (;;) {
      const probed = yield* Effect.result(probeDatabaseOwner(dbPath));
      if (probed._tag === "Success") return probed.success;
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedMs;
      if (probed.failure.reason !== "being-written" || elapsedMs >= BEING_WRITTEN_WAIT_MS) {
        return yield* Effect.fail(probed.failure);
      }
      yield* Effect.sleep(Math.min(pollDelayMs(elapsedMs), BEING_WRITTEN_WAIT_MS - elapsedMs));
    }
  });

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

interface OwnershipRequest {
  readonly kind: DatabaseOwnerKind;
  readonly purpose: string;
  readonly launcher: DatabaseOwnerLauncher;
  readonly serviceLabel?: string | undefined;
  readonly appVersion: string;
  /** How long to wait for a server holder; maintenance requests never wait for one. */
  readonly waitForServerMs: number | "forever";
  /** How long to wait for a maintenance holder. */
  readonly waitForMaintenanceMs: number;
}

type Attempt =
  | { readonly _tag: "acquired"; readonly record: OwnerRecord }
  | { readonly _tag: "retry" }
  | { readonly _tag: "held"; readonly owner: DatabaseOwner | null }
  | {
      readonly _tag: "unusable";
      readonly reason: DatabaseOwnerLockErrorReason;
      readonly detail?: string;
    };

async function attemptOwnership(input: {
  readonly dbPath: string;
  readonly lockPath: string;
  readonly token: string;
  readonly request: OwnershipRequest;
  readonly env: DatabaseOwnerLockEnvironment;
  readonly probe: ProcessProbe;
}): Promise<Attempt> {
  const { dbPath, lockPath, token, request, env, probe } = input;
  // A reclaimer that died holding its guard: stale when a half-written lock would be.
  const isReclaimGuardStale = (mtimeMs: number) => isUnparseableLockStale({ mtimeMs }, env, probe);
  // Looked up before the file exists, so a half-written lock never waits on them.
  const bootId = (await probe.bootId()) ?? null;
  const startTime = (await probe.processStartTime(env.pid)) ?? null;
  let created: OwnerRecord | undefined;
  registerToken(lockPath, token);
  let acquired = false;
  try {
    const wasCreated = await createLockFileExclusive(
      lockPath,
      (ino) => {
        created = {
          version: 1,
          token,
          pid: env.pid,
          kind: request.kind,
          purpose: request.purpose,
          launcher: request.launcher,
          appVersion: request.appVersion,
          startedAt: new Date(env.now()).toISOString(),
          bootTime: probe.bootTime(),
          bootId,
          startTime,
          ino,
          schemaSupported: SUPPORTED_MIGRATION_ID,
          schemaDigest: migrationSchemaDigest,
          ...(request.serviceLabel !== undefined ? { serviceLabel: request.serviceLabel } : {}),
        };
        return `${JSON.stringify(created)}\n`;
        // Not synced: an fsync cost 11-19 ms (spikes over 1 s) on the startup
        // path, and a lock torn by a power loss is stale anyway (see
        // `isUnparseableLockStale`).
      },
      { sync: false },
    );
    if (wasCreated && created !== undefined) {
      // A server from before this lock writes none: it would otherwise be invisible.
      const legacy = await readLegacyServerOwner(dbPath, env);
      if (legacy !== null) {
        await removeLockFileIfUnchanged(lockPath, { ino: created.ino });
        return { _tag: "held", owner: legacy };
      }
      acquired = true;
      return { _tag: "acquired", record: created };
    }
  } finally {
    if (!acquired) unregisterToken(lockPath, token);
  }

  const read = await readOwnerLock(lockPath);
  switch (read.kind) {
    case "absent":
      return { _tag: "retry" };
    case "unreadable":
      return { _tag: "unusable", reason: "unreadable", detail: read.code };
    case "foreign":
      return { _tag: "unusable", reason: "foreign-file" };
    case "unparseable":
      if (!isUnparseableLockStale(read, env, probe)) return { _tag: "held", owner: null };
      await reclaimLockFile(lockPath, read, isReclaimGuardStale);
      return { _tag: "retry" };
    case "holder":
      if (await isRecordAbandoned(lockPath, read, env, probe)) {
        await reclaimLockFile(lockPath, read, isReclaimGuardStale);
        return { _tag: "retry" };
      }
      return { _tag: "held", owner: ownerFromRecord(lockPath, read.record, env) };
  }
}

/** 100 ms while a handover is likely, then slower: a long wait polls every 2 s. */
const pollDelayMs = (elapsedMs: number) =>
  elapsedMs < 2_000 ? 100 : elapsedMs < SERVER_HOLDER_WAIT_MS ? 250 : 2_000;

const acquireOwnership = (
  dbPath: string,
  request: OwnershipRequest,
): Effect.Effect<DatabaseOwnerLeaseShape, DatabaseOwnedError, Scope.Scope> =>
  Effect.gen(function* () {
    const env = yield* DatabaseOwnerLockEnvironment;
    const lockPath = databaseOwnerLockPath(dbPath);
    const token = randomUUID();
    // A holder's start time cannot change: one `ps` per holder, not one per poll.
    const startTimes = new Map<number, Promise<string | undefined>>();
    const probe: ProcessProbe = {
      ...env.probe,
      processStartTime: (pid) => {
        let lookup = startTimes.get(pid);
        if (lookup === undefined) {
          lookup = env.probe.processStartTime(pid);
          startTimes.set(pid, lookup);
        }
        return lookup;
      },
    };
    const owned = (
      reason: DatabaseOwnedError["reason"],
      owner: DatabaseOwner | null,
      detail?: string,
    ) =>
      new DatabaseOwnedError({
        dbPath,
        lockPath,
        owner,
        reason,
        message: describeDatabaseOwnedFailure({
          dbPath,
          lockPath,
          owner,
          reason,
          detail,
          nowMs: env.now(),
        }),
      });

    yield* Effect.tryPromise(() => mkdir(NodePath.dirname(dbPath), { recursive: true })).pipe(
      Effect.mapError((cause) => owned("io-error", null, String(cause))),
    );

    const startedMs = yield* Clock.currentTimeMillis;
    let waitLogged = false;
    let quickRetries = 0;
    for (;;) {
      // Uninterruptible (bounded by file operations and a 2 s `ps`), so a lock
      // this process created always has its release registered.
      const attempt = yield* Effect.uninterruptible(
        Effect.tryPromise({
          try: () => attemptOwnership({ dbPath, lockPath, token, request, env, probe }),
          catch: (cause) => owned("io-error", null, String(cause)),
        }).pipe(
          Effect.tap((result) =>
            result._tag === "acquired"
              ? Effect.addFinalizer(() => releaseOwnership(lockPath, token, env))
              : Effect.void,
          ),
        ),
      );
      if (attempt._tag === "acquired") {
        const owner = ownerFromRecord(lockPath, attempt.record, env);
        return { dbPath, lockPath, owner, enforced: true } satisfies DatabaseOwnerLeaseShape;
      }
      if (attempt._tag === "unusable") {
        return yield* Effect.fail(owned(attempt.reason, null, attempt.detail));
      }
      if (attempt._tag === "retry") {
        // Usually one retry after reclaiming a stale lock; never a hot loop.
        quickRetries += 1;
        if (quickRetries <= 3) continue;
      } else {
        quickRetries = 0;
      }
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedMs;
      // Still retrying (another process is reclaiming a stale lock): no holder is
      // known, as for a lock being written, and the same deadline applies.
      const holder = attempt._tag === "held" ? attempt.owner : null;
      const allowedMs: number | "forever" =
        request.kind === "maintenance"
          ? holder !== null && holder.kind === "server"
            ? 0
            : Math.max(request.waitForMaintenanceMs, holder === null ? BEING_WRITTEN_WAIT_MS : 0)
          : holder !== null && holder.kind === "maintenance"
            ? request.waitForServerMs === "forever"
              ? "forever"
              : Math.max(request.waitForServerMs, MAINTENANCE_HOLDER_WAIT_MS)
            : holder === null && request.waitForServerMs !== "forever"
              ? Math.max(request.waitForServerMs, BEING_WRITTEN_WAIT_MS)
              : request.waitForServerMs;
      if (allowedMs !== "forever" && elapsedMs >= allowedMs) {
        return yield* Effect.fail(owned(holder === null ? "being-written" : "held", holder));
      }
      if (!waitLogged && holder !== null && (elapsedMs >= 1_000 || allowedMs === "forever")) {
        waitLogged = true;
        yield* Effect.logInfo(
          `Waiting for ${describeDatabaseOwner(holder, env.now())} to release the database`,
          { lockPath, ownerKind: holder.kind },
        );
      }
      const delayMs = pollDelayMs(elapsedMs);
      yield* Effect.sleep(
        allowedMs === "forever" ? delayMs : Math.max(1, Math.min(delayMs, allowedMs - elapsedMs)),
      );
    }
  });

/** Remove the lock only if it is still this lease's (token, pid and inode). Never fails. */
const releaseOwnership = (lockPath: string, token: string, env: DatabaseOwnerLockEnvironment) =>
  Effect.tryPromise(async () => {
    const read = await readOwnerLock(lockPath);
    if (read.kind === "holder" && read.record.token === token && read.record.pid === env.pid) {
      await removeLockFileIfUnchanged(lockPath, read);
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => unregisterToken(lockPath, token))),
    Effect.catch((cause) =>
      // A leftover lock is reclaimed by liveness: this pid will be dead.
      Effect.logWarning("Could not release the database owner lock", { lockPath, cause }),
    ),
  );

interface ServerOwnerInfo {
  readonly launcher: DatabaseOwnerLauncher;
  readonly appVersion?: string | undefined;
  readonly serviceLabel?: string | undefined;
}

const acquireServerOwnership = (
  dbPath: string,
  info: ServerOwnerInfo,
  config: LockConfig,
  waitMs: number | "forever" | undefined,
) =>
  acquireOwnership(dbPath, {
    kind: "server",
    purpose: "serve",
    launcher: info.launcher,
    serviceLabel: info.serviceLabel,
    appVersion: info.appVersion ?? packageJson.version,
    waitForServerMs: serverHolderWaitMs(info.launcher, config, waitMs),
    waitForMaintenanceMs: 0,
  });

/**
 * Own the database for a server's lifetime (released with the scope). Waits
 * `waitMs` (default 10 s, or `RYCO_DB_OWNER_WAIT_MS`) for another server, up
 * to 10 min for maintenance, and without a deadline for `launcher: "service"`.
 */
export const acquireDatabaseServer = (
  dbPath: string,
  info: ServerOwnerInfo,
  options?: { readonly waitMs?: number | "forever" | undefined },
): Effect.Effect<DatabaseOwnerLeaseShape, DatabaseOwnedError, Scope.Scope> =>
  readLockConfig.pipe(
    Effect.flatMap((config) => acquireServerOwnership(dbPath, info, config, options?.waitMs)),
  );

/**
 * Own the database exclusively for one operation (released with the scope).
 * Fails at once while a server owns it; waits up to `waitMs` (default 0) for
 * another maintenance owner.
 */
export const acquireDatabaseMaintenance = (
  dbPath: string,
  purpose = "maintenance",
  options?: { readonly waitMs?: number | undefined },
): Effect.Effect<DatabaseOwnerLeaseShape, DatabaseOwnedError, Scope.Scope> =>
  acquireOwnership(dbPath, {
    kind: "maintenance",
    purpose,
    launcher: "cli",
    appVersion: packageJson.version,
    waitForServerMs: 0,
    waitForMaintenanceMs: options?.waitMs ?? 0,
  });

/**
 * The server's ownership of `ServerConfig.dbPath`, held until the layer is
 * released. Provide it outside the persistence layers, so it is taken before
 * the database is opened and released after it is closed.
 */
export const DatabaseOwnerLeaseLive: Layer.Layer<
  DatabaseOwnerLease,
  DatabaseOwnedError,
  ServerConfig
> = Layer.effect(
  DatabaseOwnerLease,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const lockConfig = yield* readLockConfig;
    const env = yield* DatabaseOwnerLockEnvironment;
    // Not the label alone: everything the service starts inherits it, and a `ryco serve`
    // that one of its agents runs would wait for another server without a deadline.
    const serviceLabel =
      config.mode !== "desktop" &&
      nodeServiceManagerOfProcess({
        serviceLabel: Option.getOrUndefined(lockConfig.serviceLabel),
        platform: env.probe.platform,
        pid: env.pid,
        parentPid: env.parentPid,
        systemdExecPid: Option.getOrUndefined(lockConfig.systemdExecPid),
      }) !== null
        ? Option.getOrUndefined(lockConfig.serviceLabel)
        : undefined;
    const launcher: DatabaseOwnerLauncher =
      config.mode === "desktop" ? "desktop" : serviceLabel !== undefined ? "service" : "serve";
    if (lockDisabledBy(lockConfig)) {
      yield* Effect.logWarning(
        "RYCO_DB_OWNER_LOCK=off: not checking whether another Ryco server uses this database. Two servers on one database corrupt each other's state; make sure only one runs.",
        { dbPath: config.dbPath },
      );
      return {
        dbPath: config.dbPath,
        lockPath: databaseOwnerLockPath(config.dbPath),
        owner: {
          pid: env.pid,
          kind: "server",
          startedAt: new Date(env.now()).toISOString(),
          purpose: "serve",
          launcher,
          serviceLabel,
          appVersion: packageJson.version,
          schemaSupported: SUPPORTED_MIGRATION_ID,
          schemaDigest: migrationSchemaDigest,
          legacy: false,
          self: true,
        },
        enforced: false,
      } satisfies DatabaseOwnerLeaseShape;
    }
    const startedAt = performance.now();
    const lease = yield* acquireServerOwnership(
      config.dbPath,
      { launcher, serviceLabel },
      lockConfig,
      undefined,
    );
    yield* Effect.logDebug("database owner lock acquired", {
      lockPath: lease.lockPath,
      launcher,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
    return lease;
  }),
);
