import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import {
  CLI_PROXY_HUB_POLL_INTERVAL_MS,
  type CliProxyHubRead,
  type SubscriptionLimitsEnvironment,
} from "@ryco/client-runtime/usage";

import {
  statisticsUnavailableReason,
  type StatisticsAccessEnvironment,
} from "../features/settings/statistics/statisticsAccess";
import type { RycoWidgetsNativeModule } from "./rycoWidgetsNative";
import {
  buildSubscriptionUsageSnapshot,
  buildSubscriptionUsageTimeline,
  type SubscriptionUsageSnapshot,
} from "./subscriptionUsageSnapshot";
import { SUBSCRIPTION_USAGE_WIDGET_KIND } from "./widgetKinds";
import { encodeWidgetTimeline } from "./widgetTimeline";

/** What the widgets follow, injected so the runtime runs without React Native. */
export interface WidgetsRuntimeDeps {
  readonly native: Pick<RycoWidgetsNativeModule, "writeTimeline" | "clear">;
  /** Each connected environment's config, with its providers' limits (`environmentServerConfigs`). */
  readonly configs: {
    readonly snapshot: () => ReadonlyMap<EnvironmentId, ServerConfig>;
    readonly subscribe: (listener: () => void) => () => void;
  };
  /** The shared hub reads (`CliProxyHubReads`): their last answers, and a way to ask again. */
  readonly hubs: {
    readonly snapshot: () => ReadonlyMap<EnvironmentId, CliProxyHubRead>;
    readonly subscribe: (listener: () => void) => () => void;
    readonly read: (environmentId: EnvironmentId) => Promise<unknown>;
  };
  /** React Native's `AppState`, reduced to whether the app is in the foreground. */
  readonly appState: {
    readonly isActive: () => boolean;
    readonly subscribe: (listener: (active: boolean) => void) => () => void;
  };
  /** What a tap on the widget opens. */
  readonly url: string;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/** A machine the app lists (Home's environments), with what decides whether Limits reads it. */
export interface WidgetEnvironment extends StatisticsAccessEnvironment {
  readonly environmentId: EnvironmentId;
}

export interface WidgetsRuntime {
  /**
   * The machines the app lists, as Home shows them. Only those the Limits tab would read (connected,
   * with owner access) reach the widget; nothing is written before the first list arrives.
   */
  readonly setEnvironments: (environments: ReadonlyArray<WidgetEnvironment>) => void;
  /** Stops following the app. `clear` also empties the widgets, as on sign-out. */
  readonly stop: (options?: { readonly clear?: boolean }) => Promise<void>;
  /** Resolves once every write asked for so far has finished. */
  readonly settled: () => Promise<void>;
}

/**
 * The machines whose limits the widget may show: those the Limits tab reads
 * (`statisticsUnavailableReason`). A teammate's machine where this phone is a viewer or operator
 * never reaches the Lock Screen.
 */
export function widgetEnvironmentIds(
  environments: ReadonlyArray<WidgetEnvironment>,
): ReadonlySet<EnvironmentId> {
  return new Set(
    environments
      .filter((environment) => statisticsUnavailableReason(environment) === null)
      .map((environment) => environment.environmentId),
  );
}

function sameIds(left: ReadonlySet<EnvironmentId>, right: ReadonlySet<EnvironmentId>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/** The environments the widget reads: each allowed config, with the hubs its node last reported. */
export function widgetEnvironments(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
  hubs: ReadonlyMap<EnvironmentId, CliProxyHubRead>,
  allowed: ReadonlySet<EnvironmentId>,
): SubscriptionLimitsEnvironment[] {
  return [...configs].flatMap(([environmentId, config]) =>
    allowed.has(environmentId)
      ? [
          {
            environmentId,
            // Never shown: the widget names no node.
            label: environmentId,
            // Connected, by `allowed`; how old its numbers are is the widget's own expiry.
            connected: true,
            providers: config.providers,
            hubs: hubs.get(environmentId)?.hubs ?? [],
          },
        ]
      : [],
  );
}

/**
 * Keeps the subscription usage widget current while the app runs: it rebuilds the widget's
 * snapshot whenever a provider config or a hub read changes, and writes it only when it differs
 * from the last one written, so thread and config traffic that leaves the limits alone writes
 * nothing. Hubs are read again when the app comes to the foreground and every five minutes while
 * it stays there, only on the machines the widget may show. It never asks a node to re-read its
 * providers.
 */
export function startWidgetsRuntime(deps: WidgetsRuntimeDeps): WidgetsRuntime {
  const now = deps.now ?? Date.now;
  const onError =
    deps.onError ?? ((error: unknown) => console.warn("The widgets were not updated.", error));
  let written: string | null = null;
  let writes: Promise<void> = Promise.resolve();
  let stopped = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  // Unknown until the app reports its machines: an empty list would clear the widget.
  let allowed: ReadonlySet<EnvironmentId> | null = null;
  const askedHubs = new Set<EnvironmentId>();

  const enqueue = (write: () => Promise<void>, key: string | null) => {
    writes = writes.then(write).catch((error: unknown) => {
      // A failed write is tried again with the next change.
      if (written === key) written = null;
      onError(error);
    });
  };

  const publish = () => {
    if (stopped || allowed === null) return;
    const snapshot: SubscriptionUsageSnapshot = buildSubscriptionUsageSnapshot(
      widgetEnvironments(deps.configs.snapshot(), deps.hubs.snapshot(), allowed),
      deps.url,
    );
    const key = JSON.stringify(snapshot);
    if (key === written) return;
    written = key;
    if (snapshot.providers.length === 0) {
      enqueue(() => deps.native.clear(SUBSCRIPTION_USAGE_WIDGET_KIND), key);
      return;
    }
    const json = encodeWidgetTimeline(buildSubscriptionUsageTimeline(snapshot, now()));
    enqueue(() => deps.native.writeTimeline(SUBSCRIPTION_USAGE_WIDGET_KIND, json), key);
  };

  /** The machines with a config the widget may show: the only ones whose hubs it reads. */
  const readable = () =>
    [...deps.configs.snapshot().keys()].filter((id) => allowed?.has(id) === true);

  const readHubs = (environmentIds: Iterable<EnvironmentId>) => {
    for (const environmentId of environmentIds) {
      askedHubs.add(environmentId);
      // A hub read never rejects; its answer arrives through `hubs.subscribe`.
      void deps.hubs.read(environmentId).catch(onError);
    }
  };

  /** A machine that connected since the last round gets its hubs read now, not in five minutes. */
  const readNewHubs = () => {
    if (deps.appState.isActive()) readHubs(readable().filter((id) => !askedHubs.has(id)));
  };

  const onConfigs = () => {
    publish();
    readNewHubs();
  };

  const foreground = () => {
    readHubs(readable());
    poll ??= setInterval(() => readHubs(readable()), CLI_PROXY_HUB_POLL_INTERVAL_MS);
  };
  const background = () => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
  };

  const unsubscribes = [
    deps.configs.subscribe(onConfigs),
    deps.hubs.subscribe(publish),
    deps.appState.subscribe((active) => (active ? foreground() : background())),
  ];
  publish();
  if (deps.appState.isActive()) foreground();

  return {
    setEnvironments: (environments) => {
      if (stopped) return;
      const next = widgetEnvironmentIds(environments);
      if (allowed !== null && sameIds(allowed, next)) return;
      // A machine that drops out and comes back is new again: its hubs are read when it returns.
      for (const id of askedHubs) if (!next.has(id)) askedHubs.delete(id);
      allowed = next;
      publish();
      readNewHubs();
    },
    stop: async (options = {}) => {
      if (stopped) return writes;
      stopped = true;
      background();
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (options.clear === true) {
        enqueue(() => deps.native.clear(SUBSCRIPTION_USAGE_WIDGET_KIND), null);
      }
      return writes;
    },
    settled: () => writes,
  };
}
