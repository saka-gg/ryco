/**
 * doctorOwnership - who has the database, and the background service `ryco doctor` may pause.
 *
 * Ownership comes from the database owner lock (`persistence/databaseOwnerLock.ts`): the doctor
 * probes it and then takes maintenance ownership, which a running server never grants. A server
 * that is this data directory's running `ryco service` (the service manager names its pid, or it
 * recorded this service's label) is stopped and started
 * again afterwards; any other server (the desktop app, a `ryco serve`) must be stopped by the
 * user, because the CLI never stops the desktop app.
 *
 * Before stopping the service the doctor writes `<stateDir>/doctor-service-paused.json`, so a run
 * that is killed before it could restart the service is finished by the next run: it restarts the
 * service named there. The marker is removed once the service runs again.
 *
 * @module doctorOwnership
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { Data, Effect, Option, Schema, type Scope } from "effect";

import {
  acquireDatabaseMaintenance,
  type DatabaseOwnedError,
  type DatabaseOwner,
  type DatabaseOwnerLockError,
  type DatabaseOwnership,
  describeDatabaseOwner,
  probeDatabaseOwner,
} from "../persistence/databaseOwnerLock.ts";
import { parsePersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { SERVER_RUNTIME_STATE_FILE_NAME } from "../config.ts";
import {
  type NodeServicePlatform,
  type NodeServiceStatus,
  readNodeServiceStatus,
  startNodeService,
  stopNodeService,
} from "../service/nodeService.ts";

export interface DoctorOwnershipControl {
  readonly probe: (dbPath: string) => Effect.Effect<DatabaseOwnership, DatabaseOwnerLockError>;
  /** Maintenance ownership, released with the scope. */
  readonly acquireMaintenance: (
    dbPath: string,
  ) => Effect.Effect<void, DatabaseOwnedError, Scope.Scope>;
}

export const databaseOwnerLockOwnership: DoctorOwnershipControl = {
  probe: probeDatabaseOwner,
  acquireMaintenance: (dbPath) => acquireDatabaseMaintenance(dbPath, "doctor").pipe(Effect.asVoid),
};

export class DoctorServiceError extends Data.TaggedError("DoctorServiceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** This data directory's background service (`ryco service`), when the platform has one. */
export interface DoctorServiceControl {
  readonly platform: NodeServicePlatform | null;
  readonly label: string;
  /** Null when the platform has no service manager, or its state cannot be read. */
  readonly status: Effect.Effect<NodeServiceStatus | null>;
  readonly stop: (label: string) => Effect.Effect<void, DoctorServiceError>;
  readonly start: (label: string) => Effect.Effect<void, DoctorServiceError>;
}

const serviceCall = (run: () => Promise<unknown>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new DoctorServiceError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.asVoid);

export const nodeServiceControl = (
  platform: NodeServicePlatform | null,
  label: string,
): DoctorServiceControl => ({
  platform,
  label,
  status:
    platform === null
      ? Effect.succeed(null)
      : Effect.tryPromise(() => readNodeServiceStatus(platform, label)).pipe(
          Effect.orElseSucceed(() => null),
        ),
  stop: (target) =>
    platform === null ? Effect.void : serviceCall(() => stopNodeService(platform, target)),
  start: (target) =>
    platform === null ? Effect.void : serviceCall(() => startNodeService(platform, target)),
});

/**
 * The owner is this data directory's running service: the service manager names the owner's pid,
 * or the owner recorded that it runs as this service (`RYCO_SERVICE_LABEL`), which also covers a
 * service manager that reports no pid. A service that is not running is never stopped (and so
 * never started) by the doctor.
 */
export const isServiceOwner = (owner: DatabaseOwner, status: NodeServiceStatus | null): boolean =>
  owner.kind === "server" &&
  status !== null &&
  status.running &&
  (status.pid === owner.pid ||
    (owner.launcher === "service" && owner.serviceLabel === status.label));

// ---------------------------------------------------------------------------
// Paused-service marker
// ---------------------------------------------------------------------------

export const PAUSED_SERVICE_MARKER_FILE_NAME = "doctor-service-paused.json";

const PausedServiceMarker = Schema.Struct({
  version: Schema.Literal(1),
  label: Schema.String,
  platform: Schema.Literals(["launchd", "systemd"]),
  pausedAt: Schema.String,
  doctorPid: Schema.Int,
});
export type PausedServiceMarker = typeof PausedServiceMarker.Type;

const PausedServiceMarkerJson = Schema.fromJsonString(PausedServiceMarker);

export const pausedServiceMarkerPath = (stateDir: string) =>
  NodePath.join(stateDir, PAUSED_SERVICE_MARKER_FILE_NAME);

export const readPausedServiceMarker = (
  stateDir: string,
): Effect.Effect<PausedServiceMarker | null> =>
  Effect.promise(() => readFile(pausedServiceMarkerPath(stateDir), "utf8").catch(() => null)).pipe(
    Effect.map((content) =>
      content === null
        ? null
        : Option.getOrNull(Schema.decodeUnknownOption(PausedServiceMarkerJson)(content.trim())),
    ),
  );

export const writePausedServiceMarker = (stateDir: string, marker: PausedServiceMarker) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        pausedServiceMarkerPath(stateDir),
        `${Schema.encodeSync(PausedServiceMarkerJson)(marker)}\n`,
        { mode: 0o600 },
      );
    },
    catch: (cause) =>
      new DoctorServiceError({
        message: `Could not record that the service is paused: ${String(cause)}`,
        cause,
      }),
  });

export const removePausedServiceMarker = (stateDir: string) =>
  Effect.promise(() =>
    rm(pausedServiceMarkerPath(stateDir), { force: true }).catch(() => undefined),
  );

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Where a server listens, from its `server-runtime.json`, when that file names this owner. */
export const readOwnerEndpoint = (
  stateDir: string,
  owner: DatabaseOwner,
): Effect.Effect<string | null> =>
  owner.endpoint !== undefined
    ? Effect.succeed(owner.endpoint)
    : Effect.promise(() =>
        readFile(NodePath.join(stateDir, SERVER_RUNTIME_STATE_FILE_NAME), "utf8").catch(() => null),
      ).pipe(
        Effect.map((content) => {
          if (content === null) return null;
          const state = parsePersistedServerRuntimeState(content);
          return Option.isSome(state) && state.value.pid === owner.pid ? state.value.origin : null;
        }),
      );

/**
 * Why `--apply` cannot run while `owner` has the database, and what to do. This data
 * directory's running service never reaches this (the doctor stops it); a service does when it
 * is another data directory's, or its service manager does not show it running.
 */
export function describeOwnerRefusal(input: {
  readonly owner: DatabaseOwner;
  readonly endpoint: string | null;
  readonly commandPrefix: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const { owner } = input;
  const holder = describeDatabaseOwner(owner);
  const again = `Then run \`${input.commandPrefix} doctor --apply\` again.`;
  // A legacy owner's description already names where it listens.
  const where = input.endpoint === null || owner.legacy ? "" : ` It listens on ${input.endpoint}.`;
  if (owner.kind === "maintenance") {
    return `Another Ryco process is upgrading or repairing this database: ${holder}. Wait for it to finish. ${again}`;
  }
  const quit = (input.platform ?? process.platform) === "darwin" ? "quit it (⌘Q)" : "quit it";
  const intro = `${holder.charAt(0).toUpperCase()}${holder.slice(1)} has this database open.${where}`;
  switch (owner.launcher) {
    case "desktop":
      return `${intro} Quit the Ryco desktop app first; the CLI cannot stop the desktop app. ${again}`;
    case "service":
      return `${intro} The doctor only stops this data directory's service, and only while its service manager shows it running; it could not match this one, so stop it yourself (\`ryco service stop\` with the \`--base-dir\` it serves). ${again}`;
    case "serve":
      return `${intro} Stop that \`ryco serve\` (Ctrl-C in its terminal, or end the process that started it). ${again}`;
    case "cli":
    case "unknown":
      return `${intro} If it is the Ryco desktop app, ${quit}; the CLI cannot stop the desktop app. Otherwise stop that \`ryco serve\`. ${again}`;
  }
}
