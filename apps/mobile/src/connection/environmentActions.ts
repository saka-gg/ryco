import type { EnvironmentId } from "@ryco/contracts";
import {
  clearProjectIconCache,
  type SavedEnvironmentRecord,
} from "@ryco/client-runtime/connection";

import { useStore } from "../state/threadsRuntime";
import { clearProjectFilesStateForEnvironment } from "../rpc/projectFilesAtoms";
import { purgeEnvironmentSnapshot } from "../persistence/environmentSnapshotPersistence";
import type { MobileE2eeTrustStore } from "../platform/e2eeTrustStore";
import type { MobileConnectionRegistry } from "../runtime/bootstrap";

// §2.6 / §3-22..26: the saved-environment lifecycle actions, mirroring
// apps/web/src/environments/runtime/service.ts. Free functions over ONE registry
// ({catalog, remoteApi, driver}); no forked runtime logic — every op composes the
// runtime supervisor + catalog + threads store. All desktop-SSH / relay / hosted
// arms are dropped (direct-node only). A record's bearer token NEVER enters a
// return value or view model (§3-25 secret boundary) — it lives only in SecretKV.

export interface ResolvedPairingTarget {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly credential: string;
}

export interface AddSavedEnvironmentInput {
  readonly label: string;
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}

export interface EnvironmentActionsDeps {
  readonly registry: MobileConnectionRegistry;
  /** Resolve a pairing URL / host+code into a target (ryco* schemes, §Task 6). */
  readonly resolvePairingTarget: (input: {
    readonly pairingUrl?: string;
    readonly host?: string;
    readonly pairingCode?: string;
  }) => ResolvedPairingTarget;
  readonly now?: () => string;
  /** §13.1 client trust records, cleared when the owner forgets a node. */
  readonly trustStore?: Pick<MobileE2eeTrustStore, "forgetEnvironment">;
}

const MISSING_CREDENTIAL_MESSAGE = "Unable to persist saved environment credentials.";

/**
 * The app's trust store, loaded when a node is forgotten. It carries the curve
 * and hash primitives, and these actions are bound on the launch path (the
 * connection controller Home mounts), where Metro would otherwise evaluate them
 * before the first frame. It is the same singleton the hosted runtime hydrates.
 */
const lazyMobileTrustStore: Pick<MobileE2eeTrustStore, "forgetEnvironment"> = {
  forgetEnvironment: async (environmentId) =>
    (await import("../platform/e2eeTrustStore")).mobileE2eeTrustStore.forgetEnvironment(
      environmentId,
    ),
};

export function createEnvironmentActions(deps: EnvironmentActionsDeps) {
  const { registry } = deps;
  const isoNow = deps.now ?? (() => new Date().toISOString());
  const trustStore = deps.trustStore ?? lazyMobileTrustStore;

  const connect = (record: SavedEnvironmentRecord) =>
    registry.driver.supervisor.ensureSavedEnvironmentConnection(record, (isCancelled) =>
      registry.driver.connectSavedEnvironment(record, isCancelled),
    );

  async function addSavedEnvironment(
    input: AddSavedEnvironmentInput,
  ): Promise<SavedEnvironmentRecord> {
    const target = deps.resolvePairingTarget({
      ...(input.pairingUrl !== undefined ? { pairingUrl: input.pairingUrl } : {}),
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.pairingCode !== undefined ? { pairingCode: input.pairingCode } : {}),
    });

    // Pre-auth: identify the node so the token + record are keyed by EnvironmentId.
    const descriptor = await registry.remoteApi.fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: target.httpBaseUrl,
    });
    const environmentId = descriptor.environmentId;

    // §3-22 single-record snapshot for rollback (no bulk registry API on mobile).
    const prior = registry.catalog.get(environmentId);

    const bearerSession = await registry.remoteApi.bootstrapRemoteBearerSession({
      httpBaseUrl: target.httpBaseUrl,
      credential: target.credential,
    });
    // The remembered session answer (role, expiry) belongs to the credential
    // this pairing replaces; the connect below must not start from it.
    registry.driver.forgetSessionHint(environmentId);

    const record: SavedEnvironmentRecord = {
      environmentId,
      label: input.label.trim() || prior?.label || descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      createdAt: prior?.createdAt ?? isoNow(),
      lastConnectedAt: isoNow(),
    };

    await registry.catalog.persistRecord(record);
    const didPersistToken = await registry.catalog.writeBearerToken(
      environmentId,
      bearerSession.sessionToken,
    );
    if (!didPersistToken) {
      // Roll the registry back BEFORE the upsert (the failing path never upserts,
      // so the store needs no rollback).
      if (prior) await registry.catalog.persistRecord(prior);
      throw new Error(MISSING_CREDENTIAL_MESSAGE);
    }

    // The upsert auto-persists and fires the supervisor's registry subscription.
    registry.catalog.registryStore.getState().upsert(record);
    // A connect still running started on the credential this pairing replaced;
    // joining it would answer for the old one.
    registry.driver.supervisor.cancelPendingSavedEnvironmentConnection(environmentId);
    await registry.driver.supervisor.remove(environmentId).catch(() => false);
    // Until that cancel and removal, the old attempt or connection could still
    // record the replaced credential's answer over the forget above. Neither can
    // now, so forget once more before the connect reads the hint.
    registry.driver.forgetSessionHint(environmentId);
    await connect(record);
    return record;
  }

  async function reconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
    const record = registry.catalog.get(environmentId);
    if (!record) return;
    await registry.driver.supervisor.remove(environmentId).catch(() => false);
    await connect(record);
  }

  async function disconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
    await registry.driver.supervisor.remove(environmentId).catch(() => false);
  }

  async function removeSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
    await registry.driver.supervisor.remove(environmentId).catch(() => false);
    registry.driver.supervisor.disposeThreadDetailSubscriptionsForEnvironment(environmentId);
    registry.catalog.registryStore.getState().remove(environmentId);
    registry.catalog.runtimeStore.getState().clear(environmentId);
    // The remembered session answer (role, expiry) goes with the credential.
    registry.driver.forgetSessionHint(environmentId);
    useStore.getState().removeEnvironmentState(environmentId);
    // Forgetting a node also forgets its persisted snapshot — cached content
    // must not outlive the environment it belongs to (wave 2, plan step 5).
    purgeEnvironmentSnapshot(environmentId);
    // Keyed-query caches are not part of the threads store: the workspace
    // listings and file contents this node handed us are memory-only and scoped
    // to its environment id, so forgetting the node drops them here or not at
    // all.
    clearProjectFilesStateForEnvironment(environmentId);
    clearProjectIconCache(environmentId);
    await registry.catalog.removeBearerToken(environmentId);
    // The owner forgetting a node also forgets its §13 trust state — the pin, the
    // latch, the approval, and any legacy consent — and drops the
    // `anyNodeVerified` marker for that Hub origin if no verified pin under it
    // survives (docs/relay-e2ee-protocol.md §13.1, §13.3). A node is reachable on
    // both planes under one environment id, and this is the only place that acts
    // on the owner's decision to forget it; there is no generic secret-wipe path
    // to inherit, so the registration is by hand.
    await trustStore.forgetEnvironment(environmentId);
  }

  function renameSavedEnvironment(environmentId: EnvironmentId, label: string): void {
    registry.catalog.registryStore.getState().rename(environmentId, label);
  }

  return {
    addSavedEnvironment,
    reconnectSavedEnvironment,
    disconnectSavedEnvironment,
    removeSavedEnvironment,
    renameSavedEnvironment,
  };
}

export type EnvironmentActions = ReturnType<typeof createEnvironmentActions>;
