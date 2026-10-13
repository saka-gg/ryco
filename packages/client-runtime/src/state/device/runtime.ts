import type { EnvironmentId } from "@ryco/contracts";

import type { DeviceRpcClient } from "../../rpc/deviceRpcClient.ts";
import { useDeviceStateStore } from "./store.ts";

export interface DeviceConnectionBinding {
  readonly reconnecting: () => void;
  readonly dispose: () => void;
}

/**
 * Owns one environment's device event stream and its generation. Stream events
 * carry the generation current when they arrive, so a replaced connection can
 * never publish state into the new environment session.
 *
 * The inventory is not read here: listing devices runs `xcrun simctl` / `adb`
 * on the server, so the simulator pane lists on mount and again whenever the
 * generation changes, never on every connect. Connections do not call this
 * directly; `registerDeviceConnection` binds it while a surface retains the
 * environment's device runtime (`ensureDeviceRuntime`).
 */
export function bindDeviceConnection(
  environmentId: EnvironmentId,
  client: DeviceRpcClient,
): DeviceConnectionBinding {
  let active = true;
  let generation = useDeviceStateStore.getState().beginConnection(environmentId);
  const store = () => useDeviceStateStore.getState();

  const unsubscribe = client.onEvent(
    (event) => {
      if (active) store().applyEvent(environmentId, generation, event);
    },
    {
      onResubscribe: () => {
        if (!active) return;
        generation = store().beginConnection(environmentId);
      },
      onError: () => {
        if (active) {
          store().markConnectionError(
            environmentId,
            generation,
            "Simulator event stream disconnected.",
          );
        }
      },
    },
  );
  return {
    reconnecting: () => {
      if (!active) return;
      generation = store().beginConnection(environmentId);
    },
    dispose: () => {
      if (!active) return;
      active = false;
      unsubscribe();
      store().clearEnvironment(environmentId, generation);
    },
  };
}

/**
 * How long a device runtime nothing retains keeps its event stream, so moving
 * between threads or briefly away does not resubscribe each time.
 */
export const DEVICE_RUNTIME_IDLE_MS = 60_000;

interface DeviceRuntimeRegistration {
  readonly client: DeviceRpcClient;
  binding: DeviceConnectionBinding | null;
}

/** Live registrations per environment; the last one is the current connection's. */
const registrations = new Map<EnvironmentId, DeviceRuntimeRegistration[]>();
const retainCounts = new Map<EnvironmentId, number>();
const idleTimers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();

function currentRegistration(environmentId: EnvironmentId): DeviceRuntimeRegistration | null {
  return registrations.get(environmentId)?.at(-1) ?? null;
}

function cancelIdleUnbind(environmentId: EnvironmentId): void {
  const timer = idleTimers.get(environmentId);
  if (timer === undefined) return;
  clearTimeout(timer);
  idleTimers.delete(environmentId);
}

function bindRegistration(
  environmentId: EnvironmentId,
  registration: DeviceRuntimeRegistration,
): void {
  registration.binding ??= bindDeviceConnection(environmentId, registration.client);
}

function unbindRegistration(registration: DeviceRuntimeRegistration): void {
  const binding = registration.binding;
  registration.binding = null;
  binding?.dispose();
}

/**
 * Makes a connection's device client available to device surfaces without
 * starting anything: the event stream starts only once a surface retains the
 * environment (`ensureDeviceRuntime`), immediately if one already does. The
 * newest registration is the environment's; disposing it hands the stream back
 * to an earlier connection that is still live. `reconnecting` starts a new
 * generation while bound, and `dispose` ends the stream and forgets the client.
 */
export function registerDeviceConnection(
  environmentId: EnvironmentId,
  client: DeviceRpcClient,
): DeviceConnectionBinding {
  const registration: DeviceRuntimeRegistration = { client, binding: null };
  const live = registrations.get(environmentId) ?? [];
  const previous = live.at(-1);
  if (previous) unbindRegistration(previous);
  registrations.set(environmentId, [...live, registration]);
  if ((retainCounts.get(environmentId) ?? 0) > 0) bindRegistration(environmentId, registration);
  let disposed = false;
  return {
    reconnecting: () => {
      if (!disposed) registration.binding?.reconnecting();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const wasCurrent = currentRegistration(environmentId) === registration;
      unbindRegistration(registration);
      const remaining = (registrations.get(environmentId) ?? []).filter(
        (entry) => entry !== registration,
      );
      if (remaining.length === 0) {
        registrations.delete(environmentId);
        cancelIdleUnbind(environmentId);
        return;
      }
      registrations.set(environmentId, remaining);
      const next = remaining.at(-1);
      if (wasCurrent && next && (retainCounts.get(environmentId) ?? 0) > 0) {
        bindRegistration(environmentId, next);
      }
    },
  };
}

/**
 * Retains an environment's device runtime for a device surface (a thread view
 * that can open the simulator pane, the pane itself). The first retainer
 * starts the event stream on the environment's current connection, and later
 * connections bind as they register. Once nothing retains it, the stream stops
 * after `DEVICE_RUNTIME_IDLE_MS`. Returns the release.
 */
export function ensureDeviceRuntime(environmentId: EnvironmentId): () => void {
  retainCounts.set(environmentId, (retainCounts.get(environmentId) ?? 0) + 1);
  cancelIdleUnbind(environmentId);
  const registration = currentRegistration(environmentId);
  if (registration) bindRegistration(environmentId, registration);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (retainCounts.get(environmentId) ?? 0) - 1);
    if (remaining > 0) {
      retainCounts.set(environmentId, remaining);
      return;
    }
    retainCounts.delete(environmentId);
    cancelIdleUnbind(environmentId);
    idleTimers.set(
      environmentId,
      setTimeout(() => {
        idleTimers.delete(environmentId);
        if ((retainCounts.get(environmentId) ?? 0) > 0) return;
        const current = currentRegistration(environmentId);
        if (current) unbindRegistration(current);
      }, DEVICE_RUNTIME_IDLE_MS),
    );
  };
}

/** Whether an environment's device event stream is running. */
export function isDeviceRuntimeBound(environmentId: EnvironmentId): boolean {
  return currentRegistration(environmentId)?.binding != null;
}

export function resetDeviceRuntimeForTests(): void {
  for (const timer of idleTimers.values()) clearTimeout(timer);
  idleTimers.clear();
  for (const live of registrations.values()) for (const entry of live) unbindRegistration(entry);
  registrations.clear();
  retainCounts.clear();
}
