import type { EnvironmentId } from "@ryco/contracts/base-schemas";
import { ChangeRequestActivity } from "@ryco/contracts/change-request-review";
import { ChangeRequest, SourceControlChangeRequestDetail } from "@ryco/contracts/source-control";
import * as Schema from "effect/Schema";

import type { PullRequestReadKind, PullRequestReadStore } from "../rpc/pullRequestAtoms";
import { payloadByteLength, type SnapshotDb } from "./snapshotDb";

/**
 * Pull requests kept on this device for reading offline, under the same rules
 * as the cached threads: in the same client-cache database, only while the
 * "Keep recent conversations on this device" setting is on (turning it off
 * removes them), and removed with the environment's snapshot (forgetting the
 * node, Hub sign-out and revocation, Settings' "Clear device cache").
 *
 * Lists, details and activity are kept; diffs are not (large, and read again
 * on demand). Each read is versioned and bounded; a read that fails to decode
 * (another client version) is a cache miss.
 */

export const PULL_REQUEST_READ_SCHEMA_VERSION = 1;
/** Reads kept per environment, most recently written first. */
export const PULL_REQUEST_READS_PER_ENVIRONMENT = 40;
/** A read larger than this is not kept (an unusually long activity). */
export const PULL_REQUEST_READ_MAX_BYTES = 512 * 1024;

const CODECS = {
  list: Schema.toCodecJson(Schema.Array(ChangeRequest)),
  detail: Schema.toCodecJson(SourceControlChangeRequestDetail),
  activity: Schema.toCodecJson(ChangeRequestActivity),
} as const;

export function encodePullRequestRead(kind: PullRequestReadKind, data: unknown): string {
  return JSON.stringify(
    Schema.encodeUnknownSync(CODECS[kind] as Schema.Codec<unknown, unknown>)(data),
  );
}

/** The stored read, or null when it does not decode as this version's `kind`. */
export function decodePullRequestRead(
  kind: PullRequestReadKind,
  stored: { readonly schemaVersion: number; readonly payload: string },
): unknown {
  if (stored.schemaVersion !== PULL_REQUEST_READ_SCHEMA_VERSION) return null;
  try {
    return Schema.decodeUnknownSync(CODECS[kind] as Schema.Codec<unknown, unknown>)(
      JSON.parse(stored.payload),
    );
  } catch {
    return null;
  }
}

function warn(message: string) {
  return (error: unknown) => {
    console.warn(`[pull-request-cache] ${message}`, error);
  };
}

export function createPullRequestReadStore(deps: {
  readonly db: SnapshotDb;
  /** The "keep recent conversations" device setting. */
  readonly isEnabled: () => boolean;
  /**
   * Resolves once `isEnabled` reflects the saved choice. On a cold start the
   * first reads come before the preferences load; they wait instead of
   * reading the setting as off.
   */
  readonly ready?: Promise<void>;
  readonly now: () => number;
}): PullRequestReadStore {
  const ready = (deps.ready ?? Promise.resolve()).catch(() => undefined);
  const write = (
    kind: PullRequestReadKind,
    environmentId: EnvironmentId,
    key: string,
    data: unknown,
  ): void => {
    if (!deps.isEnabled()) return;
    let payload: string;
    try {
      payload = encodePullRequestRead(kind, data);
    } catch (error) {
      warn("could not encode a pull request read")(error);
      return;
    }
    if (payloadByteLength(payload) > PULL_REQUEST_READ_MAX_BYTES) return;
    void deps.db
      .savePullRequestRead({
        environmentId,
        key: `${kind}\u0000${key}`,
        schemaVersion: PULL_REQUEST_READ_SCHEMA_VERSION,
        payload,
        updatedAt: deps.now(),
        keep: PULL_REQUEST_READS_PER_ENVIRONMENT,
      })
      .catch(warn("could not save a pull request read"));
  };
  return {
    save: (kind, environmentId, key, data) => {
      void ready.then(() => write(kind, environmentId, key, data));
    },
    load: async (kind, environmentId, key) => {
      await ready;
      if (!deps.isEnabled()) return null;
      try {
        const stored = await deps.db.loadPullRequestRead(environmentId, `${kind}\u0000${key}`);
        return stored === null ? null : decodePullRequestRead(kind, stored);
      } catch (error) {
        warn("could not read a saved pull request")(error);
        return null;
      }
    },
  };
}

/** Bytes of one environment's saved pull requests (Settings' device cache sizes). */
export async function pullRequestReadsBytes(
  db: SnapshotDb,
  environmentId: EnvironmentId,
): Promise<number> {
  try {
    return await db.pullRequestReadBytes(environmentId);
  } catch {
    return 0;
  }
}
