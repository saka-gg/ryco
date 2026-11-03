import type { EnvironmentId } from "@ryco/contracts/base-schemas";
import type {
  PushAlertKind,
  PushKeyId,
  PushPresence,
  PushPublicKey,
  PushSetPresenceResult,
} from "@ryco/contracts/push";
import type { NativePushEnvironment, NativePushPlatform } from "@ryco/contracts/push-hub";

import { HostedHubApiError, type HostedHubApi } from "../../authorization/api.ts";
import { nativePushHubSupport, type NativePushHubSupport } from "../../authorization/nativePush.ts";
import type { WsRpcClient } from "../../rpc/wsRpcClient.ts";
import {
  BACKGROUND_ALERT_KINDS,
  HUB_PUSH_CAPABILITY_RECHECK_MS,
  HUB_PUSH_CAPABILITY_RETRY_MS,
  NODE_PUSH_RETRY_MS,
  PUSH_PRESENCE_REFRESH_MS,
  awaitsHubDelivery,
  environmentPushStateFromError,
  environmentPushStateFromStatus,
  hubRegistrationFailure,
  initialBackgroundAlertsSnapshot,
  isBackgroundPushConfirmed,
  type BackgroundAlertsHubStatus,
  type BackgroundAlertsSnapshot,
  type BackgroundAlertsSupport,
  type EnvironmentPushState,
} from "./backgroundAlertsModel.ts";

/** This installation's push key, as the native key store describes it. */
export interface PushKey {
  readonly publicKey: PushPublicKey;
  readonly keyId: PushKeyId;
  /** The Hub enrollment alerts are opened with, as last recorded; null before the first. */
  readonly enrollmentId: string | null;
}

/** The native push key (`docs/push-alerts.md`); only its public half crosses into JavaScript. */
export interface PushKeyStore {
  readonly available: boolean;
  /** The key, created if absent. */
  readonly ensureKey: () => Promise<PushKey>;
  /** The key if one exists; never creates one. */
  readonly readKey: () => Promise<PushKey | null>;
  /** Records what the extension opens alerts with: the Hub enrollment and the sound setting. */
  readonly setRegistration: (input: {
    readonly enrollmentId: string;
    readonly sound: boolean;
  }) => Promise<void>;
  readonly deleteKey: () => Promise<void>;
}

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
  /**
   * Survives a restart: the account whose Hub registration this device turned
   * off but could not remove yet. Kept until the Hub confirms the removal.
   */
  readonly hubRemoval: {
    readonly read: () => Promise<string | null>;
    readonly write: (accountId: string | null) => Promise<void>;
  };
  /**
   * Survives a restart: the push key an earlier installation of the app left,
   * read before the install check deleted it. Its node registrations are
   * retired by its public key (they sit under that installation's enrollment,
   * which this one cannot speak for); null when there is none, or it is older
   * than a node keeps a registration nobody refreshes.
   */
  /** Read once; the memo itself drops a key past `EARLIER_INSTALL_KEY_RETIRE_MS`. */
  readonly earlierInstallKey: {
    readonly read: () => Promise<PushKey | null>;
  };
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

/** The last `push.registerDevice` on one connection, whatever it answered. */
interface NodeAttempt {
  readonly connection: BackgroundAlertsConnection;
  readonly ready: object;
  readonly keyId: PushKey["keyId"];
  readonly sound: boolean;
  readonly state: EnvironmentPushState;
  /** When it ran, or null once a presence tick or a foreground asked for it again. */
  readonly at: number | null;
  /**
   * The node answers presence with this device's registration, so it is asked
   * again only when that says the registration is gone. An older node answers
   * nothing and is asked again until its Hub confirmed delivery.
   */
  readonly reportsStatus: boolean;
}

/**
 * Registers this device for background alerts and keeps it registered
 * (`docs/push-alerts.md`).
 *
 * Nothing happens until the Hub says it can push to this build. With a Hub
 * without push the capability read is the only request: no permission prompt,
 * no token, no node RPC, and the app's own alerts are untouched. Once the Hub
 * can: the push key, the APNs token, the Hub registration, then
 * `push.registerDevice` once per connection on every Hub channel, and
 * `push.setPresence` while the app is in front. Each connection's answer is
 * kept: a refusal is not asked again until the next connect, a failure not
 * before a minute or the next foreground. A node answers presence with this
 * device's registration, so it is registered again only when it lost it; an
 * older node that cannot confirm its Hub's delivery yet is asked again while
 * the app is in front. A key an earlier installation left is retired on every
 * Hub machine by its public key.
 *
 * Turned off, it removes the Hub registration, the live nodes' registrations
 * and the key; a Hub removal that failed is owed, across restarts, until the
 * Hub confirms it. Signed out or switched account, it deletes the key: the
 * next account gets a new one. One reconcile runs at a time and reads
 * everything afresh, so any trigger just asks for one.
 */
export function createBackgroundAlerts(ports: BackgroundAlertsPorts): BackgroundAlerts {
  let snapshot = initialBackgroundAlertsSnapshot(ports.support);
  const listeners = new Set<() => void>();

  let capability: CapabilityCheck | null = null;
  let capabilityInFlight: Promise<void> | null = null;
  /** Read once, then again on the next foreground or settings change. */
  let permission: boolean | null = null;
  let key: PushKey | null = null;
  /** What the extension last got told this run: the enrollment and the sound setting. */
  let keyRegistration: string | null = null;
  let token: string | null = null;
  /** The account, enrollment and token the Hub holds a registration for. */
  let hubRegistration: string | null = null;
  /** The account whose Hub registration is still to be removed; undefined until read. */
  let hubRemovalOwed: string | null | undefined;
  const attempts = new Map<EnvironmentId, NodeAttempt>();
  /** While off: whether a key left from an earlier run was looked for yet. */
  let leftoverChecked = false;
  let signedInAccountId: string | null = null;
  /** After a failed Hub request or token read, the next waits for this or the next foreground. */
  let hubRetryAt = 0;
  /** The same for a failed Hub removal; a failed registration never holds a removal back. */
  let hubRemovalRetryAt = 0;
  /** The earlier installation's key, once read (null: none); undefined until read. */
  let earlierKey: PushKey | null | undefined;
  /** Connections that answered its retirement, by the connect that did. */
  const earlierKeyRetired = new Map<EnvironmentId, object>();

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

  const isLive = (attempt: NodeAttempt) => attempt.connection.readReady() === attempt.ready;

  const registeredNodes = () =>
    [...attempts.values()].filter((attempt) => attempt.state.status === "registered");

  /** Asks the matching connections again at the next reconcile; whether any did. */
  const askAgain = (matches: (attempt: NodeAttempt) => boolean): boolean => {
    let any = false;
    for (const [environmentId, attempt] of attempts) {
      if (!isLive(attempt) || !matches(attempt)) continue;
      attempts.set(environmentId, { ...attempt, at: null });
      any = true;
    }
    return any;
  };

  const forgetLocally = () => {
    key = null;
    keyRegistration = null;
    hubRegistration = null;
    attempts.clear();
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

  const readHubRemovalOwed = async (): Promise<string | null> => {
    if (hubRemovalOwed !== undefined) return hubRemovalOwed;
    try {
      hubRemovalOwed = await ports.hubRemoval.read();
    } catch (error) {
      report("Reading the owed Hub push removal failed", error);
      hubRemovalOwed = null;
    }
    return hubRemovalOwed;
  };

  const setHubRemovalOwed = async (accountId: string | null) => {
    if (hubRemovalOwed === accountId) return;
    hubRemovalOwed = accountId;
    try {
      await ports.hubRemoval.write(accountId);
    } catch (error) {
      report("Recording the owed Hub push removal failed", error);
    }
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

  /**
   * A node's answer to presence. One that reports this device's registration
   * speaks for it: one it still holds refreshes what the app knows (its Hub may
   * deliver now) without registering again, which would rewrite the node's
   * registration file, and one it lost is registered again at once. An older
   * node answers `{}`.
   */
  const onPresenceAnswer = (
    attempt: NodeAttempt,
    answer: PushSetPresenceResult,
    afterRegistering: boolean,
  ) => {
    const environmentId = attempt.connection.environmentId;
    const status = answer.status;
    if (status === undefined || attempts.get(environmentId) !== attempt || !isLive(attempt)) {
      return;
    }
    if (!status.registered || status.keyId !== attempt.keyId) {
      // The node took it a moment ago: a contradicting answer waits for the next tick, so a
      // node that keeps saying so is asked at most once a tick.
      if (afterRegistering) return;
      // Lost (the node left its Hub, or dropped it): not covered until registered again.
      const lost: NodeAttempt = {
        ...attempt,
        state: { status: "registering" },
        at: null,
        reportsStatus: true,
      };
      attempts.set(environmentId, lost);
      setEnvironment(environmentId, lost.state);
      syncPresenceTimer();
      request();
      return;
    }
    const state = environmentPushStateFromStatus(status);
    attempts.set(environmentId, { ...attempt, state, reportsStatus: true });
    setEnvironment(environmentId, state);
  };

  const sendPresence = (
    presence: PushPresence,
    nodes: Iterable<NodeAttempt>,
    afterRegistering = false,
  ) => {
    for (const attempt of nodes) {
      if (!isLive(attempt)) continue;
      void attempt.connection.push
        .setPresence({ state: presence })
        .then((answer) => onPresenceAnswer(attempt, answer, afterRegistering))
        .catch((error: unknown) => report("Sending push presence failed", error));
    }
  };

  /** A node that cannot say whether its Hub delivers is asked by registering again. */
  const awaitsReregistration = (attempt: NodeAttempt) =>
    !attempt.reportsStatus && awaitsHubDelivery(attempt.state);

  const syncPresenceTimer = () => {
    const wanted = started > 0 && ports.app.isActive() && registeredNodes().length > 0;
    if (wanted && presenceTimer === null) {
      presenceTimer = ports.timers.setInterval(() => {
        // A node that reports its registration answers this; an older one
        // that could not confirm its Hub's delivery yet is asked again.
        sendPresence("foreground", registeredNodes());
        if (askAgain(awaitsReregistration)) request();
      }, PUSH_PRESENCE_REFRESH_MS);
    } else if (!wanted && presenceTimer !== null) {
      ports.timers.clearInterval(presenceTimer);
      presenceTimer = null;
    }
  };

  /**
   * Asks the live Hub channels holding the key to forget it: those that took
   * it this run, or, for a key an earlier run left, every one that is up. The
   * public key lets a node remove it also when this device registered it under
   * an enrollment it had before.
   */
  const unregisterNodes = async (pushKey: PushKey, leftover: boolean) => {
    const { keyId, publicKey } = pushKey;
    const connections = leftover
      ? ports.connections
          .list()
          .filter((connection) => connection.viaHub && connection.readReady() !== null)
      : registeredNodes()
          .filter((attempt) => attempt.keyId === keyId && isLive(attempt))
          .map((attempt) => attempt.connection);
    await Promise.all(
      connections.map((connection) =>
        connection.push.unregisterDevice({ keyId, publicKey }).catch((error: unknown) => {
          // An older node, or a channel that never could register, has nothing to remove.
          if (environmentPushStateFromError(error).status === "failed") {
            report("Removing a node push registration failed", error);
          }
        }),
      ),
    );
  };

  /**
   * Turned off: the Hub stops delivering, live nodes forget the key, and the
   * key goes, so a node that still seals to it reaches only the generic text.
   * Any key, from this run or an earlier one, means a Hub registration may
   * exist; its removal is recorded as owed before the key goes, and stays owed
   * across restarts until the Hub confirms it (a 404 is already gone).
   */
  const turnOff = async (accountId: string) => {
    const leftover = key === null;
    if (leftover && !leftoverChecked) {
      leftoverChecked = true;
      try {
        key = await ports.pushKey.readKey();
      } catch (error) {
        report("Reading the push key failed", error);
      }
    }
    if (key !== null || hubRegistration !== null) await setHubRemovalOwed(accountId);
    if (hubRemovalOwed === accountId && ports.now() >= hubRemovalRetryAt) {
      try {
        await ports.hub().unregisterNativePush();
        await setHubRemovalOwed(null);
      } catch (error) {
        if (error instanceof HostedHubApiError && error.status === 404) {
          await setHubRemovalOwed(null);
        } else {
          report("Removing the Hub push registration failed", error);
          hubRemovalRetryAt = ports.now() + HUB_PUSH_CAPABILITY_RETRY_MS;
        }
      }
    }
    if (key !== null) {
      await unregisterNodes(key, leftover);
      await deleteKey();
    }
  };

  /**
   * Retires the key an earlier installation left on every Hub channel that is
   * up, by its public key: those registrations sit under that installation's
   * enrollment, so nothing else this installation can do removes them. Each
   * channel is asked once per connection, for as long as the key is
   * remembered (`EARLIER_INSTALL_KEY_RETIRE_MS`, the nodes' own drop): the app
   * lists only the machines it is connected to now, so "every machine
   * answered" is never known, and a refusal now may be a channel not ready yet.
   */
  const retireEarlierInstallKey = async () => {
    if (earlierKey === undefined) {
      try {
        earlierKey = await ports.earlierInstallKey.read();
      } catch (error) {
        report("Reading the earlier installation's push key failed", error);
        earlierKey = null;
      }
    }
    const retired = earlierKey;
    if (retired === null) return;
    const hubConnections = ports.connections.list().filter((connection) => connection.viaHub);
    for (const connection of hubConnections) {
      const ready = connection.readReady();
      if (ready === null || earlierKeyRetired.get(connection.environmentId) === ready) continue;
      try {
        await connection.push.unregisterDevice({
          keyId: retired.keyId,
          publicKey: retired.publicKey,
        });
      } catch (error) {
        // A channel that cannot take it never will; a failure is asked again.
        if (environmentPushStateFromError(error).status === "failed") {
          report("Retiring the earlier installation's push key failed", error);
          continue;
        }
      }
      earlierKeyRetired.set(connection.environmentId, ready);
    }
  };

  /**
   * Whether a connection that answered already is asked again: when a presence
   * tick or a foreground asked for it, or a minute after a failure. A refusal
   * waits for the next connect.
   */
  const attemptDue = (attempt: NodeAttempt): boolean =>
    attempt.at === null ||
    (attempt.state.status === "failed" && ports.now() - attempt.at >= NODE_PUSH_RETRY_MS);

  const registerNodes = async (sound: boolean, pushKey: PushKey) => {
    const connections = ports.connections.list();
    for (const connection of connections) {
      if (!connection.viaHub) continue;
      const ready = connection.readReady();
      if (ready === null) continue;
      const previous = attempts.get(connection.environmentId);
      const same =
        previous?.connection === connection &&
        previous.ready === ready &&
        previous.sound === sound &&
        previous.keyId === pushKey.keyId;
      if (same && !attemptDue(previous)) continue;
      // Asking a registered node again only refreshes what it reports.
      const refreshed = same && previous.state.status === "registered" ? previous : null;
      if (refreshed === null) {
        attempts.delete(connection.environmentId);
        setEnvironment(connection.environmentId, { status: "registering" });
      }
      let state: EnvironmentPushState;
      try {
        state = environmentPushStateFromStatus(
          await connection.push.registerDevice({
            keyId: pushKey.keyId,
            publicKey: pushKey.publicKey,
            kinds: BACKGROUND_ALERT_KINDS,
            sound,
          }),
        );
      } catch (error) {
        state = environmentPushStateFromError(error);
        if (state.status === "failed") report("Registering for push with a node failed", error);
      }
      // A refresh that did not get through leaves the registration as it was:
      // the presence keeps going, and the next tick asks again.
      if (refreshed !== null && state.status === "failed") state = refreshed.state;
      const attempt: NodeAttempt = {
        connection,
        ready,
        keyId: pushKey.keyId,
        sound,
        state,
        at: ports.now(),
        // Known for this connect; a reconnect may reach an updated (or older) node.
        reportsStatus: same && previous.reportsStatus,
      };
      attempts.set(connection.environmentId, attempt);
      setEnvironment(connection.environmentId, state);
      // The node pushes nothing to a device in front; local alerts cover it.
      if (state.status === "registered" && refreshed === null && ports.app.isActive()) {
        sendPresence("foreground", [attempt], true);
      }
    }
    // A connection that is down keeps its state until it is back; one that left
    // the list is dropped.
    const listed = new Set(connections.map((connection) => connection.environmentId));
    for (const environmentId of snapshot.environments.keys()) {
      if (listed.has(environmentId)) continue;
      attempts.delete(environmentId);
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
      await deleteKey();
      syncPresenceTimer();
    }
    signedInAccountId = accountId;
    // A removal owed for another session went with that session.
    const owed = await readHubRemovalOwed();
    if (owed !== null && owed !== accountId) await setHubRemovalOwed(null);
    if (account.status === "signed-out") {
      setHub("signed-out");
      return;
    }
    // Whether or not alerts are on here: the earlier installation's may still be.
    await retireEarlierInstallKey();

    if (!preferences.enabled) {
      await turnOff(account.accountId);
      if (capabilityInFlight === null) {
        setHub(capability?.accountId === account.accountId ? capability.support : "unknown");
      }
      syncPresenceTimer();
      return;
    }
    leftoverChecked = false;

    await readCapability(account.accountId);
    if (capability?.support !== "available") return;

    permission ??= await ports.notifications.readPermission();
    if (!permission) {
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
        // The key now belongs to this enrollment, so a later one replaces it.
        key = { ...key, enrollmentId: account.enrollmentId };
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
    // The new registration overtakes a removal still owed from turning off.
    await setHubRemovalOwed(null);
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
        sendPresence(active ? "foreground" : "background", registeredNodes());
        syncPresenceTimer();
        if (!active) return;
        // Coming back retries what failed (the Hub, the token, a node), asks a
        // node again whether its Hub delivers, and reads the permission afresh:
        // it can only change in Settings, outside the app.
        hubRetryAt = 0;
        hubRemovalRetryAt = 0;
        permission = null;
        if (capability?.support === "unreachable") capability = null;
        askAgain((attempt) => attempt.state.status === "failed" || awaitsReregistration(attempt));
        request();
      };
      const unsubscribes = [
        ports.preferences.subscribe(() => {
          // Turning alerts on asks for the permission first.
          permission = null;
          request();
        }),
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
