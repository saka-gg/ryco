import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";

import { canonicalizeHubOrigin, normalizeHubNodeName } from "@ryco/shared/nodeIdentity";

import { openProtectedStateFile, type ProtectedStateFileFailure } from "./ProtectedStateFile.ts";

export interface PendingHubEnrollmentState {
  /**
   * Absent on legacy records and read as `device-code`.
   *
   * The native-claim preparation reuses this identity-key ownership slot so an
   * older binary still sees and can erase the provisional key instead of
   * dropping an unknown field and orphaning non-listable secret material.
   */
  readonly kind?: "device-code" | "native-claim";
  readonly hubOrigin: string;
  readonly keySecretName: string;
  readonly pollingSecretName: string;
  /**
   * Exact bounded label proposed to the Hub for this ceremony.
   *
   * Null only for records written before label persistence existed. It is
   * display metadata, never an identity or bearer value.
   */
  readonly label: string | null;
  /**
   * The short human code the service issued for this ceremony.
   *
   * Bounded non-bearer routing metadata: it identifies which pending request an
   * approver is looking at and proves nothing on its own. The polling secret,
   * which is a bearer value, stays in the protected store.
   *
   * Null until the start response arrives, and null for records written before
   * this field existed. A ceremony whose code is unknown is still pollable — it
   * simply cannot be re-displayed, so a caller must treat null as "unreadable"
   * rather than as a corrupt state.
   */
  readonly deviceCode: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly pollIntervalMs: number | null;
  readonly cleanupRequested: boolean;
}

export interface ActiveHubNodeState {
  readonly hubOrigin: string;
  readonly nodeId: string;
  readonly activeKeyId: string;
  readonly activeKeySecretName: string;
  readonly cleanupPollingSecretName: string | null;
  readonly enrolledAt: number;
}

/**
 * What an identity rotation does to the §7.5 continuity chain.
 *
 * §7.5 forbids the node from deciding this for itself: a rotation motivated by
 * compromise of the outgoing key MUST break the chain, because a continuity
 * certificate signed by a key an adversary also holds proves nothing, and the
 * operator is the only party that knows which case this is. The choice is made
 * when the rotation is staged and must survive to the promotion that consumes
 * it, which is why it is persisted here rather than passed along in memory.
 */
export type NodeRotationContinuityMode = "continue" | "break";

export interface StagedHubRotationState {
  readonly hubOrigin: string;
  readonly rotationRequestId: string;
  readonly newKeyId: string;
  readonly newKeySecretName: string;
  /**
   * Absent on records written before this field existed, and read as `"break"`.
   *
   * Fail-closed by construction: §7.5 says a node that cannot determine the
   * rotation's continuity disposition MUST NOT synthesize a link, and a
   * deliberate break costs a re-verification while a fabricated certificate
   * costs the guarantee.
   */
  readonly continuityMode: NodeRotationContinuityMode;
  readonly stagedAt: number;
  readonly activatedAt: number | null;
}

/**
 * A leave that has been committed to but not finished.
 *
 * Erasing an identity spans two stores, and a crash between them would either
 * orphan protected secrets or leave state pointing at keys that are already
 * gone. Recording the intent — and every secret name to erase — before touching
 * either lets the next start finish the job. Mirrors the `cleanupRequested`
 * marker the pending-enrollment teardown already uses, hoisted to the top level
 * because a leave spans the active node, a pending ceremony, and a staged
 * rotation at once.
 */
export interface PendingHubTeardownState {
  readonly secretNames: ReadonlyArray<string>;
  readonly requestedAt: number;
}

/**
 * The class of protected store that owns this identity's secret material.
 *
 * This is non-secret affinity metadata. It prevents a restart from silently
 * selecting a different store when OS credential-store availability changes.
 */
export type HubProtectedStoreBackend = "os" | "permissioned-file";

export interface LocalHubIdentityState {
  readonly version: 1;
  readonly revision: number;
  readonly environmentId: string;
  readonly protectedStoreBackend: HubProtectedStoreBackend | null;
  readonly pendingEnrollment: PendingHubEnrollmentState | null;
  readonly activeNode: ActiveHubNodeState | null;
  readonly stagedRotation: StagedHubRotationState | null;
  readonly pendingTeardown: PendingHubTeardownState | null;
  // The identity-key destroy queue is deliberately NOT here. `parseState` below
  // reconstructs this record from its known keys alone, so a binary older than
  // any field deletes it on the next write — and the one thing a rotation
  // promotion cannot afford to lose is the name of the outgoing private key,
  // because the protected store has no listing and a forgotten name is a key
  // nothing can ever collect. It lives in `NodeIdentityKeyRetirementStore`, a
  // record of its own whose parser preserves unknown top-level keys, for the
  // same reason the §7.5 lineage and the §6.4 prekey slots do.
}

export type LocalHubIdentityStateErrorCode =
  | "identity_state_unavailable"
  | "identity_state_locked"
  | "identity_state_corrupt"
  | "identity_state_operation_failed";

export class LocalHubIdentityStateError extends Error {
  readonly code: LocalHubIdentityStateErrorCode;

  constructor(code: LocalHubIdentityStateErrorCode) {
    super("Local Hub identity state operation failed.");
    this.name = "LocalHubIdentityStateError";
    this.code = code;
  }
}

export interface LocalHubIdentityStateStore {
  readonly readOrCreate: () => Promise<LocalHubIdentityState>;
  readonly update: (
    change: (current: LocalHubIdentityState) => LocalHubIdentityState,
  ) => Promise<LocalHubIdentityState>;
  /**
   * Discard the identity entirely and mint a fresh `EnvironmentId`.
   *
   * Scoped to this record on purpose. The §7.5 identity-continuity lineage lives
   * in its own durable record precisely so that erasing a Hub identity does not
   * erase the node's lineage anchor as a side effect; a leave breaks the chain,
   * and it does so explicitly rather than by deleting the state that proves the
   * break happened (`NodeIdentityContinuityStore`).
   *
   * For the same reason it does not clear the destroy queue: that record names
   * private keys this reset would otherwise make unreachable, so a leave erases
   * them first and resets it explicitly (`NodeIdentityKeyRetirementStore`).
   */
  readonly reset: () => Promise<LocalHubIdentityState>;
}

const ENVIRONMENT_ID = /^env_[A-Za-z0-9_-]{22}$/;
const NODE_ID = /^node_[A-Za-z0-9_-]{22,43}$/;
const NODE_KEY_ID = /^nkey_[A-Za-z0-9_-]{22}$/;
const ROTATION_ID = /^nrot_[A-Za-z0-9_-]{22}$/;
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/**
 * Deliberately looser than the wire-format check in `HubEnrollmentClient`. This
 * bounds charset and length so a state file cannot smuggle an unbounded or
 * injectable value; it does not pin the service's code format, so a service that
 * changes it cannot retroactively corrupt an existing state file.
 */
const DEVICE_CODE = /^[A-Z0-9-]{4,32}$/;
const MAX_STATE_BYTES = 16 * 1024;

function stateError(code: LocalHubIdentityStateErrorCode): never {
  throw new LocalHubIdentityStateError(code);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isNullableDeviceCode(value: unknown): value is string | null {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && DEVICE_CODE.test(value);
}

function isNullableLabel(value: unknown): value is string | null {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  try {
    return normalizeHubNodeName(value) === value;
  } catch {
    return false;
  }
}

function isSecretName(value: unknown): value is string {
  return typeof value === "string" && SECRET_NAME.test(value);
}

function parseProtectedStoreBackend(value: unknown): HubProtectedStoreBackend | null {
  if (value === undefined || value === null) return null;
  if (value === "os" || value === "permissioned-file") return value;
  return stateError("identity_state_corrupt");
}

function parsePending(value: unknown): PendingHubEnrollmentState | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return stateError("identity_state_corrupt");
  const candidate = value as Partial<PendingHubEnrollmentState>;
  if (
    (candidate.kind !== undefined &&
      candidate.kind !== "device-code" &&
      candidate.kind !== "native-claim") ||
    !isSecretName(candidate.keySecretName) ||
    !isSecretName(candidate.pollingSecretName) ||
    !isTimestamp(candidate.createdAt) ||
    !isNullableTimestamp(candidate.expiresAt) ||
    (candidate.pollIntervalMs !== null &&
      (!Number.isSafeInteger(candidate.pollIntervalMs) ||
        Number(candidate.pollIntervalMs) < 1_000 ||
        Number(candidate.pollIntervalMs) > 60_000)) ||
    (candidate.cleanupRequested !== undefined && typeof candidate.cleanupRequested !== "boolean") ||
    !isNullableDeviceCode(candidate.deviceCode) ||
    !isNullableLabel(candidate.label)
  ) {
    return stateError("identity_state_corrupt");
  }
  let hubOrigin: string;
  try {
    hubOrigin = canonicalizeHubOrigin(candidate.hubOrigin ?? "");
  } catch {
    return stateError("identity_state_corrupt");
  }
  return {
    kind: candidate.kind ?? "device-code",
    hubOrigin,
    keySecretName: candidate.keySecretName,
    pollingSecretName: candidate.pollingSecretName,
    // Absent on legacy records. They stay pollable and use the pre-feature
    // friendly machine label when their ceremony is displayed.
    label: candidate.label ?? null,
    // Absent on records written before this field existed. Those ceremonies stay
    // pollable; they just cannot be re-displayed.
    deviceCode: candidate.deviceCode ?? null,
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
    pollIntervalMs: candidate.pollIntervalMs as number | null,
    cleanupRequested: candidate.cleanupRequested ?? false,
  };
}

function parseActive(value: unknown): ActiveHubNodeState | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return stateError("identity_state_corrupt");
  const candidate = value as Partial<ActiveHubNodeState>;
  if (
    typeof candidate.nodeId !== "string" ||
    !NODE_ID.test(candidate.nodeId) ||
    typeof candidate.activeKeyId !== "string" ||
    !NODE_KEY_ID.test(candidate.activeKeyId) ||
    !isSecretName(candidate.activeKeySecretName) ||
    (candidate.cleanupPollingSecretName !== undefined &&
      candidate.cleanupPollingSecretName !== null &&
      !isSecretName(candidate.cleanupPollingSecretName)) ||
    !isTimestamp(candidate.enrolledAt)
  ) {
    return stateError("identity_state_corrupt");
  }
  let hubOrigin: string;
  try {
    hubOrigin = canonicalizeHubOrigin(candidate.hubOrigin ?? "");
  } catch {
    return stateError("identity_state_corrupt");
  }
  return {
    hubOrigin,
    nodeId: candidate.nodeId,
    activeKeyId: candidate.activeKeyId,
    activeKeySecretName: candidate.activeKeySecretName,
    cleanupPollingSecretName: candidate.cleanupPollingSecretName ?? null,
    enrolledAt: candidate.enrolledAt,
  };
}

function parseContinuityMode(value: unknown): NodeRotationContinuityMode {
  // Absent reads as `"break"` — the fail-closed disposition of §7.5 — while a
  // value that is present and unrecognized is corruption: something wrote a
  // disposition this binary cannot honour, and guessing which way it meant is
  // precisely the synthesis §7.5 forbids.
  if (value === undefined || value === null) return "break";
  if (value === "continue" || value === "break") return value;
  return stateError("identity_state_corrupt");
}

function parseRotation(value: unknown): StagedHubRotationState | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return stateError("identity_state_corrupt");
  const candidate = value as Partial<StagedHubRotationState>;
  if (
    typeof candidate.rotationRequestId !== "string" ||
    !ROTATION_ID.test(candidate.rotationRequestId) ||
    typeof candidate.newKeyId !== "string" ||
    !NODE_KEY_ID.test(candidate.newKeyId) ||
    !isSecretName(candidate.newKeySecretName) ||
    !isTimestamp(candidate.stagedAt) ||
    !isNullableTimestamp(candidate.activatedAt)
  ) {
    return stateError("identity_state_corrupt");
  }
  let hubOrigin: string;
  try {
    hubOrigin = canonicalizeHubOrigin(candidate.hubOrigin ?? "");
  } catch {
    return stateError("identity_state_corrupt");
  }
  return {
    hubOrigin,
    rotationRequestId: candidate.rotationRequestId,
    newKeyId: candidate.newKeyId,
    newKeySecretName: candidate.newKeySecretName,
    continuityMode: parseContinuityMode(candidate.continuityMode),
    stagedAt: candidate.stagedAt,
    activatedAt: candidate.activatedAt,
  };
}

const MAX_TEARDOWN_SECRETS = 8;

function parseTeardown(value: unknown): PendingHubTeardownState | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return stateError("identity_state_corrupt");
  const candidate = value as Partial<PendingHubTeardownState>;
  if (
    !Array.isArray(candidate.secretNames) ||
    candidate.secretNames.length > MAX_TEARDOWN_SECRETS ||
    !candidate.secretNames.every((name) => isSecretName(name)) ||
    !isTimestamp(candidate.requestedAt)
  ) {
    return stateError("identity_state_corrupt");
  }
  return { secretNames: [...candidate.secretNames], requestedAt: candidate.requestedAt };
}

function parseState(value: unknown): LocalHubIdentityState {
  if (typeof value !== "object" || value === null) return stateError("identity_state_corrupt");
  const candidate = value as Partial<LocalHubIdentityState>;
  if (
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.revision) ||
    Number(candidate.revision) < 0 ||
    typeof candidate.environmentId !== "string" ||
    !ENVIRONMENT_ID.test(candidate.environmentId)
  ) {
    return stateError("identity_state_corrupt");
  }
  const state: LocalHubIdentityState = {
    version: 1,
    revision: candidate.revision as number,
    environmentId: candidate.environmentId,
    protectedStoreBackend: parseProtectedStoreBackend(candidate.protectedStoreBackend),
    pendingEnrollment: parsePending(candidate.pendingEnrollment),
    activeNode: parseActive(candidate.activeNode),
    stagedRotation: parseRotation(candidate.stagedRotation),
    pendingTeardown: parseTeardown(candidate.pendingTeardown),
  };
  if (state.pendingEnrollment !== null && state.activeNode !== null) {
    return stateError("identity_state_corrupt");
  }
  return state;
}

/**
 * Every identity secret this record currently calls in service.
 *
 * The destroy queue lives in a record of its own and cannot be compared against
 * this one by a parser, so the comparison happens where the destruction does:
 * a queued name that appears here belongs to a promotion that has not committed
 * yet, and destroying it would erase the key the node authenticates with
 * (`NodeIdentityKeyRetirementStore`).
 */
export function identitySecretsInService(state: LocalHubIdentityState): ReadonlySet<string> {
  return new Set(
    [
      state.activeNode?.activeKeySecretName,
      state.activeNode?.cleanupPollingSecretName,
      state.stagedRotation?.newKeySecretName,
      state.pendingEnrollment?.keySecretName,
      state.pendingEnrollment?.pollingSecretName,
    ].filter((name): name is string => typeof name === "string"),
  );
}

function makeInitialState(): LocalHubIdentityState {
  return {
    version: 1,
    revision: 0,
    environmentId: `env_${randomBytes(16).toString("base64url")}`,
    protectedStoreBackend: null,
    pendingEnrollment: null,
    activeNode: null,
    stagedRotation: null,
    pendingTeardown: null,
  };
}

const FAILURE_CODES: Readonly<Record<ProtectedStateFileFailure, LocalHubIdentityStateErrorCode>> = {
  unavailable: "identity_state_unavailable",
  locked: "identity_state_locked",
  corrupt: "identity_state_corrupt",
  operation_failed: "identity_state_operation_failed",
};

export async function makeLocalHubIdentityStateStore(
  statePath: string,
): Promise<LocalHubIdentityStateStore> {
  const file = await openProtectedStateFile({
    path: statePath,
    maxBytes: MAX_STATE_BYTES,
    fail: (failure) => stateError(FAILURE_CODES[failure]),
  });

  const readState = async (): Promise<LocalHubIdentityState | null> => {
    const raw = await file.readJson();
    return raw === null ? null : parseState(raw);
  };

  // Re-validating on the way out is not redundant: it is what makes a value the
  // caller mutated into an impossible shape fail before it reaches the disk.
  const writeState = (state: LocalHubIdentityState): Promise<void> =>
    file.writeJson(parseState(state));

  const withLock = file.withLock;

  const readOrCreate = (): Promise<LocalHubIdentityState> =>
    withLock(async () => {
      const existing = await readState();
      if (existing !== null) return existing;
      const initial = makeInitialState();
      await writeState(initial);
      return initial;
    });

  const update: LocalHubIdentityStateStore["update"] = (change) =>
    withLock(async () => {
      const current = await readState();
      if (current === null) return stateError("identity_state_operation_failed");
      const proposed = parseState(change(current));
      if (
        proposed.environmentId !== current.environmentId ||
        proposed.revision !== current.revision + 1
      ) {
        return stateError("identity_state_operation_failed");
      }
      await writeState(proposed);
      return proposed;
    });

  /**
   * Replace the state with a fresh identity, under the same writer lock.
   *
   * Separate from `update` on purpose: `update` forbids replacing the
   * `EnvironmentId`, which is exactly right for every ordinary mutation and
   * exactly wrong for a leave. After the signing key is erased the machine can
   * prove nothing about its former self, and reusing the identifier would
   * collide with the node record it just abandoned on the service side.
   */
  const reset: LocalHubIdentityStateStore["reset"] = () =>
    withLock(async () => {
      const fresh = makeInitialState();
      await writeState(fresh);
      return fresh;
    });

  return { readOrCreate, update, reset };
}

/**
 * The id the Hub knows this node by (`env_…`, what hosted clients key it by) while it holds an
 * active enrollment it is not leaving; null when it is not enrolled or the identity cannot be read.
 * Reads the identity state alone, as `identitySummary({ fingerprint: false })` does: it never
 * creates the record, takes the writer lock or opens key custody, and leaves a node that never
 * had a Hub identity untouched.
 */
export async function readActiveHubEnvironmentId(statePath: string): Promise<string | null> {
  try {
    await lstat(statePath);
  } catch {
    return null;
  }
  try {
    const file = await openProtectedStateFile({
      path: statePath,
      maxBytes: MAX_STATE_BYTES,
      fail: (failure) => stateError(FAILURE_CODES[failure]),
    });
    const raw = await file.readJson();
    if (raw === null) return null;
    const state = parseState(raw);
    return state.activeNode !== null && state.pendingTeardown === null ? state.environmentId : null;
  } catch {
    return null;
  }
}
