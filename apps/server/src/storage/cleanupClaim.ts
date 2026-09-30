import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { StorageError } from "@ryco/contracts";
import type { WorktreeIdentity } from "./filesystem.ts";
import { assertStorageSettingsLease, type StorageSettingsLease } from "./settingsAdmission.ts";

declare const cleanupClaimBrand: unique symbol;
/** Runtime identity, not a structurally forgeable caller proof. Never serialized or resumed. */
export interface StorageCleanupClaim {
  readonly [cleanupClaimBrand]: true;
}
interface ClaimInput {
  readonly id: string;
  readonly repository: string;
  readonly candidate: string;
  readonly quarantine: string;
  readonly fingerprint: string;
  readonly identity: WorktreeIdentity;
  readonly lease: StorageSettingsLease;
}
interface ClaimRecord {
  readonly input: ClaimInput;
  readonly identityJSON: string;
  readonly validate: () => Promise<void>;
}
const claims = new WeakMap<object, ClaimRecord>();
const refused = (detail: string) => new StorageError({ detail });

/** Mint only after the ledger owns removal and persists the exact recovery location.
 * SQL plus an unforgeable active admission lease are mandatory, including in drivers.
 */
export function mintStorageCleanupClaim(sql: SqlClient.SqlClient, input: ClaimInput) {
  return Effect.gen(function* () {
    const authorized = Object.freeze({ ...input });
    const identityJSON = JSON.stringify(authorized.identity);
    const proofJSON = JSON.stringify({
      ...authorized.identity,
      quarantinePath: authorized.quarantine,
    });
    const durable = Effect.gen(function* () {
      yield* Effect.try({
        try: () => assertStorageSettingsLease(authorized.lease),
        catch: () => refused("Active cleanup admission is required."),
      });
      const rows = yield* sql<{
        state: string;
        category: string;
        path: string;
        repository_path: string;
        identity_json: string;
      }>`SELECT state, category, path, repository_path, identity_json FROM storage_owned_entries WHERE id = ${authorized.id}`;
      const row = rows[0];
      if (
        !row ||
        row.state !== "removing" ||
        row.category !== "worktree" ||
        row.path !== authorized.candidate ||
        row.repository_path !== authorized.repository ||
        row.identity_json !== proofJSON
      )
        return yield* refused("Durable owned-worktree removal and quarantine proof are required.");
    });
    yield* durable;
    const claim = Object.freeze({}) as StorageCleanupClaim;
    claims.set(claim, {
      input: authorized,
      identityJSON,
      validate: () => Effect.runPromise(durable),
    });
    return claim;
  });
}

export function assertStorageCleanupClaim(claim: StorageCleanupClaim): void {
  const record = claims.get(claim);
  if (!record) throw refused("Verified cleanup requires a live node-owned claim capability.");
  assertStorageSettingsLease(record.input.lease);
}

export async function validateStorageCleanupClaim(
  claim: StorageCleanupClaim,
  repository: string,
  candidate: string,
  quarantine: string,
  fingerprint: string,
  identityJSON: string,
): Promise<void> {
  assertStorageCleanupClaim(claim);
  const record = claims.get(claim)!;
  const expected = record.input;
  if (
    expected.repository !== repository ||
    expected.candidate !== candidate ||
    expected.quarantine !== quarantine ||
    expected.fingerprint !== fingerprint ||
    record.identityJSON !== identityJSON
  )
    throw refused("Cleanup capability does not authorize this removal target.");
  await record.validate();
  assertStorageCleanupClaim(claim);
}
