import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  OrchestrationShellSettlementPolicy,
  ServerConfig,
  ServerConfigStreamEvent,
} from "@ryco/contracts";
import type { ServerSettingsPatch, SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import { resolveAutoSettleAfterDays } from "@ryco/shared/threadSettlement";

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
  /**
   * The node's own automatic settlement rule, present only when the node keeps
   * one (`nodeAutoSettlement`). A node without it leaves the rule to each client.
   */
  readonly autoSettleAfterDays?: SidebarAutoSettleAfterDays | undefined;
}

export interface EnvironmentThreadCapabilities {
  readonly threadSettlement: ThreadCapabilitySupport;
  readonly threadSnooze: ThreadCapabilitySupport;
  /**
   * The environment's automatic settlement rule, the same on every client.
   * Undefined while this client knows none (a node that predates node-owned
   * settlement, or one not heard from): its threads follow this client's rule.
   */
  readonly autoSettleAfterDays?: SidebarAutoSettleAfterDays | undefined;
}

/**
 * Each environment's thread capabilities as its node last reported them. Every
 * config write records them, and they outlive the config itself: an environment
 * released from the warm set keeps classifying its threads by its own answer
 * until the account's state is cleared. Memory only. The map gets a new
 * identity only when a node's answer changes, never on a status or settings
 * push that leaves it as it was.
 */
let reportedThreadCapabilities: ReadonlyMap<EnvironmentId, ReportedThreadCapabilities> = new Map();
/**
 * The settlement rule each environment's latest shell snapshot carried, kept
 * only while no live config of the node states one (a cached or read-only
 * copy of a node this client is not connected to). Memory only, cleared with
 * the account like the reported capabilities, whose listeners it shares.
 */
let shellSettlementRules: ReadonlyMap<EnvironmentId, SidebarAutoSettleAfterDays> = new Map();
const threadCapabilityListeners = new Set<Listener>();

function emitThreadCapabilities(): void {
  for (const listener of Array.from(threadCapabilityListeners)) listener();
}

/** The rule a node's config states: undefined from a node that leaves it to clients. */
function configAutoSettleRule(
  config: Pick<ServerConfig, "environment" | "settings">,
): SidebarAutoSettleAfterDays | undefined {
  return config.environment?.capabilities?.nodeAutoSettlement === true
    ? resolveAutoSettleAfterDays(config.settings?.threadAutoSettleAfterDays)
    : undefined;
}

/** Records the node's answer; returns whether it changed. */
function recordReportedThreadCapabilities(
  environmentId: EnvironmentId,
  capabilities: Pick<ExecutionEnvironmentCapabilities, "threadSettlement" | "threadSnooze">,
  autoSettleAfterDays: SidebarAutoSettleAfterDays | undefined,
): boolean {
  // A node's config without a flag comes from a node that predates the feature.
  const threadSettlement = capabilities.threadSettlement === true;
  const threadSnooze = capabilities.threadSnooze === true;
  const current = reportedThreadCapabilities.get(environmentId);
  // The node's live answer supersedes what a snapshot carried.
  const supersededShellRule = shellSettlementRules.has(environmentId);
  if (supersededShellRule) {
    const nextRules = new Map(shellSettlementRules);
    nextRules.delete(environmentId);
    shellSettlementRules = nextRules;
  }
  if (
    current?.threadSettlement === threadSettlement &&
    current.threadSnooze === threadSnooze &&
    current.autoSettleAfterDays === autoSettleAfterDays
  ) {
    return supersededShellRule;
  }
  const next = new Map(reportedThreadCapabilities);
  next.set(environmentId, {
    threadSettlement,
    threadSnooze,
    ...(autoSettleAfterDays === undefined ? {} : { autoSettleAfterDays }),
  });
  reportedThreadCapabilities = next;
  return true;
}

function forgetReportedThreadCapabilities(): void {
  if (reportedThreadCapabilities.size === 0 && shellSettlementRules.size === 0) return;
  reportedThreadCapabilities = new Map();
  shellSettlementRules = new Map();
  emitThreadCapabilities();
}

/**
 * Records the settlement rule an environment's shell snapshot carried (live,
 * or a cached or read-only copy). A node whose live config states its rule
 * keeps that one; otherwise the snapshot's rule is the newest this client has
 * and replaces the last known one. A snapshot without a rule (an older node)
 * changes nothing.
 */
export function recordEnvironmentShellSettlementPolicy(
  environmentId: EnvironmentId,
  policy: OrchestrationShellSettlementPolicy | undefined,
): void {
  if (policy === undefined) return;
  const live = configs.get(environmentId);
  if (live !== undefined && configAutoSettleRule(live) !== undefined) return;
  if (
    shellSettlementRules.has(environmentId) &&
    shellSettlementRules.get(environmentId) === policy.autoSettleAfterDays
  ) {
    return;
  }
  const next = new Map(shellSettlementRules);
  next.set(environmentId, policy.autoSettleAfterDays);
  shellSettlementRules = next;
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

/**
 * The rules shell snapshots carried; see {@link recordEnvironmentShellSettlementPolicy}.
 * Notifies through {@link subscribeReportedThreadCapabilities}.
 */
export function getShellSettlementRulesSnapshot(): ReadonlyMap<
  EnvironmentId,
  SidebarAutoSettleAfterDays
> {
  return shellSettlementRules;
}

/** A capability statement that may leave either flag out. */
export interface ThreadCapabilityStatement {
  readonly threadSettlement?: boolean | undefined;
  readonly threadSnooze?: boolean | undefined;
}

export interface EnvironmentThreadCapabilitySources {
  /** What nodes reported, by environment; the current snapshot when omitted. */
  readonly reported?: ReadonlyMap<EnvironmentId, ReportedThreadCapabilities>;
  /** The rules shell snapshots carried, by environment; the current snapshot when omitted. */
  readonly shellSettlementRules?: ReadonlyMap<EnvironmentId, SidebarAutoSettleAfterDays>;
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
 *
 * Its automatic settlement rule comes from the node's live config, else the
 * latest shell snapshot of it, else the last config it reported; undefined
 * when none of them states one (as for rows painted from a persisted startup
 * cache, which keeps no rule), so the client's own rule applies.
 */
export function resolveEnvironmentThreadCapabilities(
  environmentId: EnvironmentId,
  sources: EnvironmentThreadCapabilitySources = {},
): EnvironmentThreadCapabilities {
  const reported = (sources.reported ?? reportedThreadCapabilities).get(environmentId);
  const shellRules = sources.shellSettlementRules ?? shellSettlementRules;
  const capabilities = reported ?? resolveUnreportedThreadCapabilities(sources);
  if (!shellRules.has(environmentId)) return capabilities;
  return { ...capabilities, autoSettleAfterDays: shellRules.get(environmentId) ?? null };
}

function resolveUnreportedThreadCapabilities(
  sources: EnvironmentThreadCapabilitySources,
): EnvironmentThreadCapabilities {
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
    capabilities !== undefined &&
    recordReportedThreadCapabilities(environmentId, capabilities, configAutoSettleRule(config));
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

/**
 * Drops everything known about the listed environments: their configs, what
 * their nodes reported and the rules their snapshots carried. For the nodes of
 * an account that ended, on a client that keeps other environments connected.
 */
export function forgetEnvironmentsServerState(environmentIds: Iterable<EnvironmentId>): void {
  const forgotten = new Set(environmentIds);
  const without = <V>(map: ReadonlyMap<EnvironmentId, V>): ReadonlyMap<EnvironmentId, V> =>
    [...forgotten].some((environmentId) => map.has(environmentId))
      ? new Map([...map].filter(([environmentId]) => !forgotten.has(environmentId)))
      : map;
  const nextConfigs = without(configs);
  const nextReported = without(reportedThreadCapabilities);
  const nextShellRules = without(shellSettlementRules);
  const threadStateChanged =
    nextReported !== reportedThreadCapabilities || nextShellRules !== shellSettlementRules;
  reportedThreadCapabilities = nextReported;
  shellSettlementRules = nextShellRules;
  if (nextConfigs !== configs) {
    configs = nextConfigs;
    emit();
  }
  if (threadStateChanged) emitThreadCapabilities();
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
  shellSettlementRules = new Map();
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
