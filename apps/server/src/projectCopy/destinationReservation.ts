/**
 * Destination reservations: at most one repository-creating operation per destination folder on
 * this node, across the cross-node import job and the legacy `sourceControl.cloneRepository`.
 *
 * Both check that a destination is missing or empty and then create it, so two of them racing for
 * one folder could both pass the check, and the loser's cleanup could delete the winner's clone.
 * Each holds the folder's reservation for its whole run instead. A reservation is keyed on the
 * destination's identity, not its spelling: the realpath of its nearest existing ancestor joined
 * with the remaining segments, case-folded on case-insensitive volumes, so `~/Code/App`,
 * `/Users/me/code/app` and a path through a symlinked parent all collide.
 *
 * Reservations live in memory, process-wide (a request and the job it starts run on different
 * fibers). The import job also persists its key in `project_imports`, whose partial unique index
 * keeps two running jobs off one destination at the database level.
 *
 * @module destinationReservation
 */
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";

interface Reservation {
  /** What holds it, e.g. `project import <id>`; for diagnostics only. */
  readonly holder: string;
}

const reservations = new Map<string, Reservation>();

const flipCase = (value: string): string =>
  [...value]
    .map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
    .join("");

/**
 * Whether the volume holding `existingPath` matches names case-insensitively: its spelling with
 * the case flipped names the same directory. A path without letters falls back to the platform's
 * default (macOS and Windows volumes usually are).
 */
const isCaseInsensitiveVolume = async (existingPath: string): Promise<boolean> => {
  const flipped = flipCase(existingPath);
  if (flipped === existingPath)
    return process.platform === "darwin" || process.platform === "win32";
  try {
    const [original, other] = await Promise.all([
      stat(existingPath, { bigint: true }),
      stat(flipped, { bigint: true }),
    ]);
    return original.dev === other.dev && original.ino === other.ino;
  } catch {
    return false;
  }
};

/** `~` and `~/…` name the home directory, as every destination field allows; nothing else expands. */
const expandHome = (value: string): string =>
  value === "~"
    ? os.homedir()
    : value.startsWith("~/") || value.startsWith("~\\")
      ? path.join(os.homedir(), value.slice(2))
      : value;

/**
 * The reservation key of a destination folder (absolute, `~`-relative, or relative to the
 * server's working directory): the realpath of its nearest existing ancestor joined with the
 * segments below it, case-folded on a case-insensitive volume. Never fails; when no ancestor
 * resolves, it keys on the resolved spelling.
 */
export const projectDestinationReservationKey = (destinationPath: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const resolved = path.resolve(expandHome(destinationPath.trim()));
    let ancestor = resolved;
    const below: Array<string> = [];
    let canonicalAncestor: string | null = null;
    for (;;) {
      try {
        canonicalAncestor = await realpath(ancestor);
        break;
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        below.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
    if (canonicalAncestor === null) return resolved;
    const key = path.join(canonicalAncestor, ...below);
    return (await isCaseInsensitiveVolume(canonicalAncestor)) ? key.toLowerCase() : key;
  });

/**
 * Takes the reservation for `key`, or answers null when another operation holds it. The returned
 * release is idempotent and frees only this reservation, never one taken after it.
 */
export const tryReserveProjectDestination = (key: string, holder: string): (() => void) | null => {
  if (reservations.has(key)) return null;
  const reservation: Reservation = { holder };
  reservations.set(key, reservation);
  return () => {
    if (reservations.get(key) === reservation) reservations.delete(key);
  };
};

/** Why a reserved destination is refused. */
export const projectDestinationReservedMessage = (destinationPath: string): string =>
  `Another clone or import into ${destinationPath} is already running on this node.`;

/**
 * Runs `effect` holding the reservation of `destinationPath`, released however it ends. When
 * another operation holds it, fails with `onReserved(message)` without running `effect`. The
 * legacy clone wraps its whole run in this, so it and the import job exclude each other.
 */
export const withProjectDestinationReservation =
  <E2>(options: {
    readonly destinationPath: string;
    /** What holds it, e.g. `sourceControl.cloneRepository`; for diagnostics only. */
    readonly holder: string;
    readonly onReserved: (message: string) => E2;
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.flatMap(projectDestinationReservationKey(options.destinationPath), (key) =>
      Effect.acquireUseRelease(
        Effect.sync(() => tryReserveProjectDestination(key, options.holder)),
        (release): Effect.Effect<A, E | E2, R> =>
          release === null
            ? Effect.fail(
                options.onReserved(projectDestinationReservedMessage(options.destinationPath)),
              )
            : effect,
        (release) => Effect.sync(() => release?.()),
      ),
    );
