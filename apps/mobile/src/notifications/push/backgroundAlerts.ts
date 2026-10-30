import {
  HostedHubApiError,
  nativePushHubSupport,
  type HostedHubApi,
  type NativePushHubSupport,
} from "@ryco/client-runtime/authorization";
import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";
import type { PushAlertKind, PushPresence } from "@ryco/contracts/push";
import type { NativePushEnvironment, NativePushPlatform } from "@ryco/contracts/push-hub";

import {
  BACKGROUND_ALERT_KINDS,
  HUB_PUSH_CAPABILITY_RECHECK_MS,
  HUB_PUSH_CAPABILITY_RETRY_MS,
  PUSH_PRESENCE_REFRESH_MS,
  environmentPushStateFromError,
  environmentPushStateFromStatus,
  hubRegistrationFailure,
  initialBackgroundAlertsSnapshot,
  isBackgroundPushConfirmed,
  type BackgroundAlertsHubStatus,
  type BackgroundAlertsSnapshot,
  type BackgroundAlertsSupport,
  type EnvironmentPushState,
} from "./backgroundAlertsModel";
import type { PushKey, PushKeyStore } from "./pushKeyStore";

/** One node connection, as background alerts see it. */
export interface BackgroundAlertsConnection {
  readonly environmentId: EnvironmentId;
  /** Reached through the Hub relay; a direct connection can never receive push. */
  readonly viaHub: boolean;
  /**
   * Evidence of the socket attempt that delivered a current shell: a new
   * object after every reconnect, null while down. The app registers again on
   * every connect.
   */
  readonly readReady: () => object | null;
  readonly subscribeReady: (listener: () => void) => () => void;
  readonly push: WsRpcClient["push"];
}

export type BackgroundAlertsAccount =
  | {
      readonly status: "signed-in";
      readonly accountId: string;
      /** This device's Hub E2EE enrollment, once it is ready. */
      readonly enrollmentId: string | null;
    }
  | { readonly status: "signed-out" }
  /** Signing in, restoring, expired or unreachable: nothing changes until it settles. */
  | { readonly status: "pending" };

export interface BackgroundAlertsPorts {
  readonly support: BackgroundAlertsSupport;
  readonly build: {
    readonly platform: NativePushPlatform;
    /** The bundle id, which is the APNs topic. */
    readonly topic: string;
    readonly apnsEnvironment: NativePushEnvironment;
  };
  readonly preferences: {
    /** `enabled`: background alerts and thread alerts are both on. */
    readonly read: () => { readonly enabled: boolean; readonly sound: boolean };
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly account: {
    readonly read: () => BackgroundAlertsAccount;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly hub: () => Pick<
    HostedHubApi,
    "getNativePushCapability" | "registerNativePush" | "unregisterNativePush"
  >;
  readonly connections: {
    readonly list: () => ReadonlyArray<BackgroundAlertsConnection>;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly pushKey: PushKeyStore;
  readonly notifications: {
    readonly readPermission: () => Promise<boolean>;
    /** The APNs device token, hex. */
    readonly readDeviceToken: () => Promise<string>;
  };
  readonly app: {
    readonly isActive: () => boolean;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly timers: {
    readonly setInterval: (callback: () => void, ms: number) => unknown;
    readonly clearInterval: (handle: unknown) => void;
  };
  readonly now: () => number;
  readonly onError?: (context: string, error: unknown) => void;
}

export interface BackgroundAlerts {
  readonly getSnapshot: () => BackgroundAlertsSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Follows preferences, the account, connections and the app state; returns stop. */
  readonly start: () => () => void;
  /** Reads the Hub's capability for the settings row, unless it is known and fresh. */
  readonly checkAvailability: () => Promise<void>;
  readonly isConfirmed: (environmentId: EnvironmentId, kind: PushAlertKind) => boolean;
}

interface CapabilityCheck {
  readonly accountId: string;
  readonly support: NativePushHubSupport | "unreachable";
  readonly checkedAt: number;
}

interface NodeRegistration {
  readonly connection: BackgroundAlertsConnection;
  readonly ready: object;
  readonly keyId: string;
  readonly sound: boolean;
}

/**
 * Registers this device for background alerts and keeps it registered
 * (`docs/push-alerts.md`).
 *
 * Nothing happens until the Hub says it can push to this build. With a Hub
 * without push the capability read is the only request: no permission prompt,
 * no token, no node RPC, and the app's own alerts are untouched. Once the Hub
 * can: the push key, the APNs token, the Hub registration, then
 * `push.registerDevice` on every Hub channel each time it connects, and
 * `push.setPresence` while the app is in front.
 *
 * Turned off, it removes the Hub registration, the live nodes' registrations
 * and the key. Signed out or switched account, it deletes the key: the next
 * account gets a new one. One reconcile runs at a time and reads everything
 * afresh, so any trigger just asks for one.
 */
export function createBackgroundAlerts(ports: BackgroundAlertsPorts): BackgroundAlerts {
  let snapshot = initialBackgroundAlertsSnapshot(ports.support);
  const listeners = new Set<() => void>();

  let capability: CapabilityCheck | null = null;
  let capabilityInFlight: Promise<void> | null = null;
  let key: PushKey | null = null;
  /** What the extension last got told this run: the enrollment and the sound setting. */
  let keyRegistration: string | null = null;
  let token: string | null = null;
  /** The account, enrollment and token the Hub holds a registration for. */
  let hubRegistration: string | null = null;
  /** Turned off, but the Hub's registration could not be removed yet. */
  let hubRemovalPending = false;
  const nodes = new Map<EnvironmentId, NodeRegistration>();
  /** While off: whether a key left from an earlier run was looked for yet. */
  let leftoverChecked = false;
  let signedInAccountId: string | null = null;
  /** After a failed Hub request or token read, the next waits for this or the next foreground. */
  let hubRetryAt = 0;

  let running = false;
  let rerun = false;
  let started = 0;
  let presenceTimer: unknown = null;

  const report = (context: string, error: unknown) => ports.onError?.(context, error);

  const publish = (patch: Partial<BackgroundAlertsSnapshot>) => {
    const next = { ...snapshot, ...patch };
    if (
      next.enabled === snapshot.enabled &&
      next.hub === snapshot.hub &&
      next.device === snapshot.device &&
      next.environments === snapshot.environments
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const setEnvironment = (environmentId: EnvironmentId, state: EnvironmentPushState | null) => {
    const environments = new Map(snapshot.environments);
    if (state === null) environments.delete(environmentId);
    else environments.set(environmentId, state);
    publish({ environments });
  };

  const setHub = (hub: BackgroundAlertsHubStatus) => publish({ hub });

  const forgetLocally = () => {
    key = null;
    keyRegistration = null;
    hubRegistration = null;
    nodes.clear();
    publish({ device: "idle", environments: new Map() });
  };

  const deleteKey = async () => {
    try {
      await ports.pushKey.deleteKey();
    } catch (error) {
      report("Deleting the push key failed", error);
    }
    forgetLocally();
  };

  const capabilityIsFresh = (accountId: string): boolean => {
    if (capability?.accountId !== accountId) return false;
    if (capability.support === "available") return true;
    const age = ports.now() - capability.checkedAt;
    return capability.support === "unreachable"
      ? age < HUB_PUSH_CAPABILITY_RETRY_MS
      : age < HUB_PUSH_CAPABILITY_RECHECK_MS;
  };

  const readCapability = (accountId: string): Promise<void> => {
    if (capabilityIsFresh(accountId)) return Promise.resolve();
    capabilityInFlight ??= (async () => {
      setHub("checking");
      let support: CapabilityCheck["support"];
      try {
        support = nativePushHubSupport(await ports.hub().getNativePushCapability(), ports.build);
      } catch (error) {
        report("Reading the Hub's push capability failed", error);
        support = "unreachable";
      }
      capability = { accountId, support, checkedAt: ports.now() };
      setHub(support);
    })().finally(() => {
      capabilityInFlight = null;
    });
    return capabilityInFlight;
  };

  const isLive = (registration: NodeRegistration) =>
    registration.connection.readReady() === registration.ready;

  const sendPresence = (presence: PushPresence, registrations: Iterable<NodeRegistration>) => {
    for (const registration of registrations) {
      if (!isLive(registration)) continue;
      void registration.connection.push
        .setPresence({ state: presence })
        .catch((error: unknown) => report("Sending push presence failed", error));
    }
  };

  const syncPresenceTimer = () => {
    const wanted = started > 0 && ports.app.isActive() && nodes.size > 0;
    if (wanted && presenceTimer === null) {
      presenceTimer = ports.timers.setInterval(
        () => sendPresence("foreground", nodes.values()),
        PUSH_PRESENCE_REFRESH_MS,
      );
    } else if (!wanted && presenceTimer !== null) {
      ports.timers.clearInterval(presenceTimer);
      presenceTimer = null;
    }
  };

  /**
   * Turned off: the Hub stops delivering, live nodes forget the key, and the
   * key goes, so a node that still seals to it reaches only the generic text.
   * A key left by an earlier run counts too, so this survives a restart.
   */
  const turnOff = async () => {
    if (key === null && !hubRemovalPending && !leftoverChecked) {
      leftoverChecked = true;
      try {
        key = await ports.pushKey.readKey();
      } catch (error) {
        report("Reading the push key failed", error);
      }
      if (key !== null) hubRemovalPending = true;
    }
    if (key === null && !hubRemovalPending) return;
    if ((hubRegistration !== null || hubRemovalPending) && ports.now() >= hubRetryAt) {
      try {
        await ports.hub().unregisterNativePush();
        hubRemovalPending = false;
      } catch (error) {
        // A Hub without the route has nothing to remove.
        hubRemovalPending = !(error instanceof HostedHubApiError && error.status === 404);
        if (hubRemovalPending) {
          report("Removing the Hub push registration failed", error);
          hubRetryAt = ports.now() + HUB_PUSH_CAPABILITY_RETRY_MS;
        }
      }
    } else if (hubRegistration !== null) {
      hubRemovalPending = true;
    }
    await Promise.all(
      [...nodes.values()]
        .filter(isLive)
        .map((registration) =>
          registration.connection.push
            .unregisterDevice({ keyId: registration.keyId })
            .catch((error: unknown) => report("Removing a node push registration failed", error)),
        ),
    );
    if (key !== null) await deleteKey();
    else forgetLocally();
  };

  const registerNodes = async (sound: boolean, pushKey: PushKey) => {
    const connections = ports.connections.list();
    for (const connection of connections) {
      if (!connection.viaHub) continue;
      const ready = connection.readReady();
      if (ready === null) continue;
      const previous = nodes.get(connection.environmentId);
      if (
        previous?.connection === connection &&
        previous.ready === ready &&
        previous.sound === sound &&
        previous.keyId === pushKey.keyId
      ) {
        continue;
      }
      nodes.delete(connection.environmentId);
      setEnvironment(connection.environmentId, { status: "registering" });
      try {
        const state = environmentPushStateFromStatus(
          await connection.push.registerDevice({
            keyId: pushKey.keyId,
            publicKey: pushKey.publicKey,
            kinds: BACKGROUND_ALERT_KINDS,
            sound,
          }),
        );
        setEnvironment(connection.environmentId, state);
        if (state.status !== "registered") continue;
        const registration = { connection, ready, keyId: pushKey.keyId, sound };
        nodes.set(connection.environmentId, registration);
        // The node pushes nothing to a device in front; local alerts cover it.
        if (ports.app.isActive()) sendPresence("foreground", [registration]);
      } catch (error) {
        const state = environmentPushStateFromError(error);
        if (state.status === "failed") report("Registering for push with a node failed", error);
        setEnvironment(connection.environmentId, state);
      }
    }
    // A connection that is down keeps its state until it is back; one that left
    // the list is dropped.
    const listed = new Set(connections.map((connection) => connection.environmentId));
    for (const environmentId of snapshot.environments.keys()) {
      if (listed.has(environmentId)) continue;
      nodes.delete(environmentId);
      setEnvironment(environmentId, null);
    }
    syncPresenceTimer();
  };

  const reconcileOnce = async () => {
    const preferences = ports.preferences.read();
    const account = ports.account.read();
    publish({ enabled: preferences.enabled });
    if (ports.support !== "supported" || account.status === "pending") return;

    // The key belongs to the account that registered it. Signing out, or into
    // another account, replaces it; the Hub drops its registration with the
    // session, and the nodes drop the enrollment.
    const accountId = account.status === "signed-in" ? account.accountId : null;
    if (signedInAccountId !== null && accountId !== signedInAccountId) {
      capability = null;
      hubRemovalPending = false;
      await deleteKey();
      syncPresenceTimer();
    }
    signedInAccountId = accountId;
    if (account.status === "signed-out") {
      setHub("signed-out");
      return;
    }

    if (!preferences.enabled) {
      await turnOff();
      if (capabilityInFlight === null) {
        setHub(capability?.accountId === account.accountId ? capability.support : "unknown");
      }
      syncPresenceTimer();
      return;
    }
    // Turned on again: a removal still owed is overtaken by the new registration.
    hubRemovalPending = false;
    leftoverChecked = false;

    await readCapability(account.accountId);
    if (capability?.support !== "available") return;

    if (!(await ports.notifications.readPermission())) {
      publish({ device: "permission-denied" });
      return;
    }
    if (account.enrollmentId === null) {
      setHub("enrollment-pending");
      return;
    }
    try {
      key ??= await ports.pushKey.ensureKey();
      // A key recorded for another enrollment is another account's, or an
      // install's before it enrolled again: start over with a new one.
      if (key.enrollmentId !== null && key.enrollmentId !== account.enrollmentId) {
        await ports.pushKey.deleteKey();
        forgetLocally();
        key = await ports.pushKey.ensureKey();
      }
      const recorded = `${account.enrollmentId}\n${String(preferences.sound)}`;
      if (keyRegistration !== recorded) {
        await ports.pushKey.setRegistration({
          enrollmentId: account.enrollmentId,
          sound: preferences.sound,
        });
        keyRegistration = recorded;
      }
    } catch (error) {
      report("Setting up the push key failed", error);
      publish({ device: "key-unavailable" });
      return;
    }
    if (token === null) {
      if (ports.now() < hubRetryAt) return;
      try {
        token = await ports.notifications.readDeviceToken();
      } catch (error) {
        report("Reading the APNs token failed", error);
        hubRetryAt = ports.now() + HUB_PUSH_CAPABILITY_RETRY_MS;
        publish({ device: "token-unavailable" });
        return;
      }
    }
    publish({ device: "ready" });

    const registration = `${account.accountId}\n${account.enrollmentId}\n${token}`;
    if (hubRegistration !== registration) {
      if (ports.now() < hubRetryAt) return;
      setHub("registering");
      try {
        await ports.hub().registerNativePush({
          platform: ports.build.platform,
          token,
          environment: ports.build.apnsEnvironment,
          topic: ports.build.topic,
        });
        hubRegistration = registration;
      } catch (error) {
        const status = hubRegistrationFailure(error);
        if (status === "failed") report("Registering for push with the Hub failed", error);
        hubRetryAt = ports.now() + HUB_PUSH_CAPABILITY_RETRY_MS;
        if (status === "hub-unsupported" || status === "topic-unsupported") {
          capability = { accountId: account.accountId, support: status, checkedAt: ports.now() };
        }
        setHub(status);
        return;
      }
    }
    setHub("registered");
    await registerNodes(preferences.sound, key);
  };

  const reconcile = async (): Promise<void> => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      for (;;) {
        rerun = false;
        try {
          await reconcileOnce();
        } catch (error) {
          report("Background alerts failed", error);
        }
        // Something changed while this one ran: run once more, unless stopped.
        if (!rerun || started === 0) break;
      }
    } finally {
      running = false;
    }
  };

  const request = () => {
    if (started > 0) void reconcile();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      started += 1;
      const readySubscriptions = new Map<BackgroundAlertsConnection, () => void>();
      const followConnections = () => {
        const current = new Set(ports.connections.list().filter((connection) => connection.viaHub));
        for (const [connection, unsubscribe] of readySubscriptions) {
          if (current.has(connection)) continue;
          unsubscribe();
          readySubscriptions.delete(connection);
        }
        for (const connection of current) {
          if (!readySubscriptions.has(connection)) {
            readySubscriptions.set(connection, connection.subscribeReady(request));
          }
        }
      };
      let wasActive = ports.app.isActive();
      const onAppState = () => {
        const active = ports.app.isActive();
        if (active === wasActive) return;
        wasActive = active;
        sendPresence(active ? "foreground" : "background", nodes.values());
        syncPresenceTimer();
        if (!active) return;
        // Coming back retries what failed: the Hub, the token, a node.
        hubRetryAt = 0;
        if (capability?.support === "unreachable") capability = null;
        request();
      };
      const unsubscribes = [
        ports.preferences.subscribe(request),
        ports.account.subscribe(request),
        ports.connections.subscribe(() => {
          followConnections();
          request();
        }),
        ports.app.subscribe(onAppState),
      ];
      followConnections();
      request();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        started -= 1;
        for (const unsubscribe of unsubscribes) unsubscribe();
        for (const unsubscribe of readySubscriptions.values()) unsubscribe();
        readySubscriptions.clear();
        syncPresenceTimer();
      };
    },
    checkAvailability: async () => {
      if (ports.support !== "supported") return;
      const account = ports.account.read();
      if (account.status === "signed-out") {
        setHub("signed-out");
        return;
      }
      if (account.status === "signed-in") await readCapability(account.accountId);
    },
    isConfirmed: (environmentId, kind) => isBackgroundPushConfirmed(snapshot, environmentId, kind),
  };
}
