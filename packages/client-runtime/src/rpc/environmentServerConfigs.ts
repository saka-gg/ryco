import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  ServerConfig,
  ServerConfigStreamEvent,
} from "@ryco/contracts";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";

import {
  clearServerConfigState,
  getServerConfig,
  publishServerConfig,
  toServerConfigUpdateSource,
  type ServerConfigUpdateSource,
} from "./serverState.ts";

type Listener = () => void;

/**
 * Every environment's last known server config, written by its connection's own
 * config observer (`onConfigUpdated`) and nowhere else. The global server-state
 * atoms are derived from the active environment's entry through
 * {@link startActiveEnvironmentServerConfigProjection}, so a config change
 * reaches the UI once, and inactive environments never touch the global state.
 */
let configs: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();
const listeners = new Set<Listener>();
/** What produced each stored config, so the projection announces it as that. */
const updateSources = new WeakMap<ServerConfig, ServerConfigUpdateSource>();

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

export function subscribeEnvironmentServerConfigs(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether a node supports a thread lifecycle feature: `true` or `false` as the
 * node itself stated, or `"unknown"` while this client has no statement from
 * it (a cold or cached node, one still connecting, or a directory entry that
 * does not carry the flag).
 */
export type ThreadCapabilitySupport = boolean | "unknown";

/** What a node's own config stated about its thread lifecycle features. */
export interface ReportedThreadCapabilities {
  readonly threadSettlement: boolean;
  readonly threadSnooze: boolean;
}

export interface EnvironmentThreadCapabilities {
  readonly threadSettlement: ThreadCapabilitySupport;
  readonly threadSnooze: ThreadCapabilitySupport;
}

/**
 * Each environment's thread capabilities as its node last reported them. Every
 * config write records them, and they outlive the config itself: an environment
 * released from the warm set keeps classifying its threads by its own answer
 * until the account's state is cleared. Memory only. The map gets a new
 * identity only when a node's answer changes, never on a status or settings
 * push.
 */
let reportedThreadCapabilities: ReadonlyMap<EnvironmentId, ReportedThreadCapabilities> = new Map();
const threadCapabilityListeners = new Set<Listener>();

function emitThreadCapabilities(): void {
  for (const listener of Array.from(threadCapabilityListeners)) listener();
}

/** Records the node's answer; returns whether it changed. */
function recordReportedThreadCapabilities(
  environmentId: EnvironmentId,
  capabilities: Pick<ExecutionEnvironmentCapabilities, "threadSettlement" | "threadSnooze">,
): boolean {
  // A node's config without a flag comes from a node that predates the feature.
  const threadSettlement = capabilities.threadSettlement === true;
  const threadSnooze = capabilities.threadSnooze === true;
  const current = reportedThreadCapabilities.get(environmentId);
  if (current?.threadSettlement === threadSettlement && current.threadSnooze === threadSnooze) {
    return false;
  }
  const next = new Map(reportedThreadCapabilities);
  next.set(environmentId, { threadSettlement, threadSnooze });
  reportedThreadCapabilities = next;
  return true;
}

function forgetReportedThreadCapabilities(): void {
  if (reportedThreadCapabilities.size === 0) return;
  reportedThreadCapabilities = new Map();
  emitThreadCapabilities();
}

export function subscribeReportedThreadCapabilities(listener: Listener): () => void {
  threadCapabilityListeners.add(listener);
  return () => {
    threadCapabilityListeners.delete(listener);
  };
}

export function getReportedThreadCapabilitiesSnapshot(): ReadonlyMap<
  EnvironmentId,
  ReportedThreadCapabilities
> {
  return reportedThreadCapabilities;
}

/** A capability statement that may leave either flag out. */
export interface ThreadCapabilityStatement {
  readonly threadSettlement?: boolean | undefined;
  readonly threadSnooze?: boolean | undefined;
}

export interface EnvironmentThreadCapabilitySources {
  /** What nodes reported, by environment; the current snapshot when omitted. */
  readonly reported?: ReadonlyMap<EnvironmentId, ReportedThreadCapabilities>;
  /**
   * A descriptor the node itself sent (a saved environment's, or a standard
   * session's primary). Never a hosted placeholder built from the directory.
   */
  readonly descriptor?:
    | Pick<ExecutionEnvironmentCapabilities, "threadSettlement" | "threadSnooze">
    | null
    | undefined;
  /** Directory metadata, honored only for the flags it states. */
  readonly directory?: ThreadCapabilityStatement | null | undefined;
}

/**
 * The one rule for an environment's thread capabilities, the same for every
 * client and whether or not the environment is selected or connected: what its
 * node reported to this client (live, or last known since its connection was
 * released), else a descriptor the node sent, else the flags a directory
 * states, else unknown.
 */
export function resolveEnvironmentThreadCapabilities(
  environmentId: EnvironmentId,
  sources: EnvironmentThreadCapabilitySources = {},
): EnvironmentThreadCapabilities {
  const reported = (sources.reported ?? reportedThreadCapabilities).get(environmentId);
  if (reported !== undefined) return reported;
  if (sources.descriptor) {
    return {
      threadSettlement: sources.descriptor.threadSettlement === true,
      threadSnooze: sources.descriptor.threadSnooze === true,
    };
  }
  return {
    threadSettlement: sources.directory?.threadSettlement ?? "unknown",
    threadSnooze: sources.directory?.threadSnooze ?? "unknown",
  };
}

/**
 * Stores `config` as the environment's current one. `type` is the stream event
 * that produced it (a snapshot when omitted) and is what the projection reports
 * when it shows the config.
 */
export function writeEnvironmentServerConfig(
  environmentId: EnvironmentId,
  config: ServerConfig,
  type: ServerConfigStreamEvent["type"] = "snapshot",
): void {
  if (configs.get(environmentId) === config) return;
  updateSources.set(config, toServerConfigUpdateSource(type));
  const next = new Map(configs);
  next.set(environmentId, config);
  configs = next;
  // A config without a capability block states nothing about them.
  const capabilities = config.environment?.capabilities;
  const capabilitiesChanged =
    capabilities !== undefined && recordReportedThreadCapabilities(environmentId, capabilities);
  emit();
  if (capabilitiesChanged) emitThreadCapabilities();
}

export function patchEnvironmentServerSettings(
  environmentId: EnvironmentId,
  patch: ServerSettingsPatch,
): void {
  const current = configs.get(environmentId);
  if (!current) return;
  writeEnvironmentServerConfig(
    environmentId,
    {
      ...current,
      settings: {
        ...current.settings,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      } as ServerConfig["settings"],
    },
    "settingsUpdated",
  );
}

export function readEnvironmentServerConfig(environmentId: EnvironmentId): ServerConfig | null {
  return configs.get(environmentId) ?? null;
}

export function getEnvironmentServerConfigsSnapshot(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return configs;
}

/**
 * Drops one environment's entry; every other environment keeps its own. Its
 * reported thread capabilities stay, as the last known answer.
 */
export function forgetEnvironmentServerConfig(environmentId: EnvironmentId): void {
  if (!configs.has(environmentId)) return;
  const next = new Map(configs);
  next.delete(environmentId);
  configs = next;
  emit();
}

/** Drops every entry and every reported thread capability (account teardown). */
export function clearEnvironmentServerConfigs(): void {
  forgetReportedThreadCapabilities();
  if (configs.size === 0) return;
  configs = new Map();
  emit();
}

export function resetEnvironmentServerConfigsForTests(): void {
  configs = new Map();
  listeners.clear();
  reportedThreadCapabilities = new Map();
  threadCapabilityListeners.clear();
}

/**
 * Whether the global config atoms currently hold this environment's config,
 * whether as its stored entry or as a local overlay of it.
 */
export function isEnvironmentServerConfigShown(environmentId: EnvironmentId): boolean {
  const shown = getServerConfig();
  if (shown === null) return false;
  return shown === configs.get(environmentId) || shown.environment.environmentId === environmentId;
}

export interface ActiveEnvironmentServerConfigSource {
  /** The environment whose config the global server state shows, or null for none. */
  readonly readActive: () => EnvironmentId | null;
  /** Notifies when {@link readActive} may have changed; returns the unsubscribe. */
  readonly subscribeActive: (listener: () => void) => () => void;
}

/**
 * The entry that replaced `previous` for the environment already shown, with
 * the local writes the shown config carries over `previous` kept for every
 * part the update did not touch: an optimistic settings write stands through a
 * provider status event, and a settings event or a snapshot replaces it.
 */
function keepLocalWrites(input: {
  readonly shown: ServerConfig;
  readonly previous: ServerConfig;
  readonly next: ServerConfig;
  readonly update: ServerConfigUpdateSource;
}): ServerConfig {
  const { shown, previous, next, update } = input;
  if (update === "snapshot") return next;
  const settings =
    update !== "settingsUpdated" && shown.settings !== previous.settings
      ? shown.settings
      : next.settings;
  const providers =
    update !== "providerStatuses" && shown.providers !== previous.providers
      ? shown.providers
      : next.providers;
  return settings === next.settings && providers === next.providers
    ? next
    : { ...next, settings, providers };
}

/**
 * Derives the global server config atoms from the active environment's entry:
 * the entry's config object is published once per change (announced as the
 * stream event that produced it, and carrying any local write to the shown
 * settings or providers that event does not replace), switching the active
 * environment publishes the other entry straight from memory (announced as a
 * snapshot, since all of it is new to the UI), and an active environment
 * without an entry (never connected, or forgotten) resets the config atoms.
 * The welcome payload belongs to the primary lifecycle stream and is left
 * alone. Returns the disposer; the atoms keep their last value after it.
 */
export function startActiveEnvironmentServerConfigProjection(
  source: ActiveEnvironmentServerConfigSource,
): () => void {
  let published: ServerConfig | null = null;
  let publishedEnvironmentId: EnvironmentId | null = null;
  let hasPublished = false;
  const sync = () => {
    const environmentId = source.readActive();
    const config = environmentId === null ? null : readEnvironmentServerConfig(environmentId);
    if (hasPublished && config === published) return;
    const previous = published;
    const followsShownEnvironment = hasPublished && environmentId === publishedEnvironmentId;
    hasPublished = true;
    published = config;
    publishedEnvironmentId = environmentId;
    if (config === null) {
      clearServerConfigState();
      return;
    }
    const shown = getServerConfig();
    if (!followsShownEnvironment) {
      // A projection started again over the same entry (a remount) finds it
      // already shown and does not announce it a second time.
      if (shown !== config) publishServerConfig(config, "snapshot");
      return;
    }
    const update = updateSources.get(config) ?? "snapshot";
    const next =
      shown !== null && previous !== null
        ? keepLocalWrites({ shown, previous, next: config, update })
        : config;
    if (shown !== next) publishServerConfig(next, update);
  };
  sync();
  const unsubscribeActive = source.subscribeActive(sync);
  const unsubscribeConfigs = subscribeEnvironmentServerConfigs(sync);
  return () => {
    unsubscribeActive();
    unsubscribeConfigs();
  };
}
