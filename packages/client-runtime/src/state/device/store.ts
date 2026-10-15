import type {
  DeviceAvailability,
  DeviceDescriptor,
  DeviceEvent,
  DeviceOpenPaneRequestedEvent,
  EnvironmentId,
  ThreadDeviceState,
  ThreadId,
} from "@ryco/contracts";
import { create } from "zustand";

import { scopeThreadRef, scopedThreadKey } from "../../scoped.ts";

export type DeviceConnectionStatus = "idle" | "connecting" | "connected" | "error";

export interface EnvironmentDeviceState {
  readonly generation: number;
  readonly status: DeviceConnectionStatus;
  readonly availability: DeviceAvailability | null;
  readonly devices: readonly DeviceDescriptor[];
  readonly error: string | null;
}

export interface DeviceStateStore {
  readonly environmentById: Readonly<Record<string, EnvironmentDeviceState>>;
  readonly threadByKey: Readonly<Record<string, ThreadDeviceState>>;
  readonly pendingOpenByThreadKey: Readonly<Record<string, DeviceOpenPaneRequestedEvent>>;
  readonly beginConnection: (environmentId: EnvironmentId) => number;
  readonly markConnectionError: (
    environmentId: EnvironmentId,
    generation: number,
    message: string,
  ) => void;
  readonly applyInventory: (
    environmentId: EnvironmentId,
    generation: number,
    devices: readonly DeviceDescriptor[],
    availability: DeviceAvailability,
  ) => void;
  readonly applyThreadSnapshot: (
    environmentId: EnvironmentId,
    generation: number,
    snapshot: ThreadDeviceState,
  ) => void;
  readonly applyEvent: (
    environmentId: EnvironmentId,
    generation: number,
    event: DeviceEvent,
  ) => void;
  readonly consumeOpenRequest: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => DeviceOpenPaneRequestedEvent | null;
  /**
   * Forget an environment's device state. `keepOpenRequests` keeps the agent's
   * pane requests for threads the user has not opened yet: the stream stops for
   * idleness while the connection lives on, and the server hands each request
   * to one stream only.
   *
   * A kept request lives as long as the connection, as one delivered to an
   * always-bound stream did, not for the server's shorter hold of requests no
   * stream heard: the client has already been told, and the request is still
   * the agent's latest for that thread when the user opens it.
   */
  readonly clearEnvironment: (
    environmentId: EnvironmentId,
    generation: number,
    options?: { readonly keepOpenRequests?: boolean },
  ) => void;
  /**
   * Drop the pane requests kept for an environment whose stream already
   * stopped for idleness, once its connection ends too.
   */
  readonly clearOpenRequests: (environmentId: EnvironmentId) => void;
}

function withoutEnvironment<T>(
  byKey: Record<string, T>,
  environmentId: EnvironmentId,
): Record<string, T> {
  const prefix = `${environmentId}:`;
  return Object.fromEntries(Object.entries(byKey).filter(([key]) => !key.startsWith(prefix)));
}

const EMPTY_ENVIRONMENT_STATE: EnvironmentDeviceState = Object.freeze({
  generation: 0,
  status: "idle",
  availability: null,
  devices: [],
  error: null,
});

export const useDeviceStateStore = create<DeviceStateStore>((set, get) => ({
  environmentById: {},
  threadByKey: {},
  pendingOpenByThreadKey: {},
  beginConnection: (environmentId) => {
    const generation = (get().environmentById[environmentId]?.generation ?? 0) + 1;
    set((state) => ({
      environmentById: {
        ...state.environmentById,
        [environmentId]: {
          generation,
          status: "connecting",
          availability: state.environmentById[environmentId]?.availability ?? null,
          devices: state.environmentById[environmentId]?.devices ?? [],
          error: null,
        },
      },
    }));
    return generation;
  },
  markConnectionError: (environmentId, generation, message) =>
    set((state) => {
      const current = state.environmentById[environmentId];
      if (!current || current.generation !== generation) return state;
      return {
        environmentById: {
          ...state.environmentById,
          [environmentId]: { ...current, status: "error", error: message },
        },
      };
    }),
  applyInventory: (environmentId, generation, devices, availability) =>
    set((state) => {
      const current = state.environmentById[environmentId];
      if (!current || current.generation !== generation) return state;
      return {
        environmentById: {
          ...state.environmentById,
          [environmentId]: {
            generation,
            status: "connected",
            availability,
            devices: [...devices],
            error: null,
          },
        },
      };
    }),
  applyThreadSnapshot: (environmentId, generation, snapshot) =>
    set((state) => {
      const currentEnvironment = state.environmentById[environmentId];
      if (!currentEnvironment || currentEnvironment.generation !== generation) return state;
      const key = scopedThreadKey(scopeThreadRef(environmentId, snapshot.threadId));
      const current = state.threadByKey[key];
      if (current && current.version >= snapshot.version) return state;
      return {
        environmentById: {
          ...state.environmentById,
          [environmentId]: {
            ...currentEnvironment,
            status: "connected",
            availability: snapshot.availability,
            devices: [...snapshot.devices],
            error: null,
          },
        },
        threadByKey: { ...state.threadByKey, [key]: snapshot },
      };
    }),
  applyEvent: (environmentId, generation, event) => {
    if (event.type === "device.thread-state") {
      get().applyThreadSnapshot(environmentId, generation, event.state);
      return;
    }
    set((state) => {
      const currentEnvironment = state.environmentById[environmentId];
      if (!currentEnvironment || currentEnvironment.generation !== generation) return state;
      const key = scopedThreadKey(scopeThreadRef(environmentId, event.threadId));
      return {
        pendingOpenByThreadKey: { ...state.pendingOpenByThreadKey, [key]: event },
      };
    });
  },
  consumeOpenRequest: (environmentId, threadId) => {
    const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
    const request = get().pendingOpenByThreadKey[key] ?? null;
    if (!request) return null;
    set((state) => {
      const next = { ...state.pendingOpenByThreadKey };
      delete next[key];
      return { pendingOpenByThreadKey: next };
    });
    return request;
  },
  clearEnvironment: (environmentId, generation, options) =>
    set((state) => {
      const current = state.environmentById[environmentId];
      if (!current || current.generation !== generation) return state;
      return {
        environmentById: {
          ...state.environmentById,
          [environmentId]: {
            ...EMPTY_ENVIRONMENT_STATE,
            // Never reuse a generation: late events from the disposed client
            // must stay stale if this environment reconnects later.
            generation,
          },
        },
        threadByKey: withoutEnvironment(state.threadByKey, environmentId),
        pendingOpenByThreadKey: options?.keepOpenRequests
          ? state.pendingOpenByThreadKey
          : withoutEnvironment(state.pendingOpenByThreadKey, environmentId),
      };
    }),
  clearOpenRequests: (environmentId) =>
    set((state) => {
      const pendingOpenByThreadKey = withoutEnvironment(
        state.pendingOpenByThreadKey,
        environmentId,
      );
      return Object.keys(pendingOpenByThreadKey).length ===
        Object.keys(state.pendingOpenByThreadKey).length
        ? state
        : { pendingOpenByThreadKey };
    }),
}));

export function selectEnvironmentDeviceState(environmentId: EnvironmentId): EnvironmentDeviceState {
  return useDeviceStateStore.getState().environmentById[environmentId] ?? EMPTY_ENVIRONMENT_STATE;
}

export function selectThreadDeviceState(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadDeviceState | null {
  const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  return useDeviceStateStore.getState().threadByKey[key] ?? null;
}
