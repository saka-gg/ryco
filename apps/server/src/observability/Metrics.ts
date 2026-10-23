import { Duration, Effect, Exit, Metric } from "effect";
import { dual } from "effect/Function";

import {
  compactMetricAttributes,
  normalizeModelMetricLabel,
  outcomeFromExit,
} from "./Attributes.ts";

export {
  DEFAULT_ROLLING_WINDOW_MAX_SAMPLES,
  DEFAULT_ROLLING_WINDOW_MS,
  RollingDurationWindow,
} from "./RollingDurationWindow.ts";
export {
  LocalDiagnosticsMetrics,
  LocalDiagnosticsMetricsLive,
  makeLocalDiagnosticsMetrics,
  type LocalDiagnosticsMetricsShape,
  type ServerLocalDiagnosticsMetricsSnapshot,
} from "./Services/LocalDiagnosticsMetrics.ts";

export const metricNames = {
  rpcRequestsTotal: "ryco_rpc_requests_total",
  rpcRequestDuration: "ryco_rpc_request_duration",
  orchestrationCommandsTotal: "ryco_orchestration_commands_total",
  orchestrationCommandDuration: "ryco_orchestration_command_duration",
  orchestrationCommandAckDuration: "ryco_orchestration_command_ack_duration",
  orchestrationEventsProcessedTotal: "ryco_orchestration_events_processed_total",
  providerSessionsTotal: "ryco_provider_sessions_total",
  providerTurnsTotal: "ryco_provider_turns_total",
  providerTurnDuration: "ryco_provider_turn_duration",
  providerRuntimeEventsTotal: "ryco_provider_runtime_events_total",
  providerRuntimeStaleEventsTotal: "ryco_provider_runtime_stale_events_total",
  providerStaleStopTimeoutsTotal: "ryco_provider_stale_stop_timeouts_total",
  contextHandoffsTotal: "ryco_context_handoffs_total",
  contextHandoffContextBytesTotal: "ryco_context_handoff_context_bytes_total",
  contextHandoffContextEntriesTotal: "ryco_context_handoff_context_entries_total",
  contextHandoffPreparationDuration: "ryco_context_handoff_preparation_duration",
  contextHandoffDispatchDuration: "ryco_context_handoff_dispatch_duration",
  providerEventLogRecordsDroppedTotal: "ryco_provider_event_log_records_dropped_total",
  runtimeQueueEnqueuesTotal: "ryco_runtime_queue_enqueues_total",
  runtimeQueueDequeuesTotal: "ryco_runtime_queue_dequeues_total",
  runtimeQueueDepth: "ryco_runtime_queue_depth",
  runtimeQueueHighWater: "ryco_runtime_queue_high_water",
  runtimeQueueBlockedDuration: "ryco_runtime_queue_blocked_duration",
  runtimeQueueCoalescedTotal: "ryco_runtime_queue_coalesced_total",
  runtimeQueueOverflowsTotal: "ryco_runtime_queue_overflows_total",
  runtimeQueueRecoveriesTotal: "ryco_runtime_queue_recoveries_total",
  startupCommandGateEnqueuesTotal: "ryco_startup_command_gate_enqueues_total",
  startupCommandGateQueueDepth: "ryco_startup_command_gate_queue_depth",
  startupCommandGateQueueHighWater: "ryco_startup_command_gate_queue_high_water",
  startupCommandGateQueueWaitDuration: "ryco_startup_command_gate_queue_wait_duration",
  providerStartupAdmissionTotal: "ryco_provider_startup_admission_total",
  providerStartupQueueDepth: "ryco_provider_startup_queue_depth",
  providerStartupQueueHighWater: "ryco_provider_startup_queue_high_water",
  providerStartupQueueWaitDuration: "ryco_provider_startup_queue_wait_duration",
  gitCommandsTotal: "ryco_git_commands_total",
  gitCommandDuration: "ryco_git_command_duration",
  terminalSessionsTotal: "ryco_terminal_sessions_total",
  terminalRestartsTotal: "ryco_terminal_restarts_total",
  serverEventLoopStallsTotal: "ryco_server_event_loop_stalls_total",
  serverEventLoopStallMaxMs: "ryco_server_event_loop_stall_max_ms",
  serverEventLoopUtilization: "ryco_server_event_loop_utilization",
} as const;

export const rpcRequestsTotal = Metric.counter(metricNames.rpcRequestsTotal, {
  description: "Total RPC requests handled by the websocket RPC server.",
});

export const rpcRequestDuration = Metric.timer(metricNames.rpcRequestDuration, {
  description: "RPC request handling duration.",
});

export const orchestrationCommandsTotal = Metric.counter(metricNames.orchestrationCommandsTotal, {
  description: "Total orchestration commands dispatched.",
});

export const orchestrationCommandDuration = Metric.timer(metricNames.orchestrationCommandDuration, {
  description: "Orchestration command dispatch duration.",
});

export const orchestrationCommandAckDuration = Metric.timer(
  metricNames.orchestrationCommandAckDuration,
  {
    description:
      "Time from orchestration command dispatch to the first committed domain event emitted for that command.",
  },
);

export const orchestrationEventsProcessedTotal = Metric.counter(
  metricNames.orchestrationEventsProcessedTotal,
  {
    description: "Total orchestration intent events processed by runtime reactors.",
  },
);

export const providerSessionsTotal = Metric.counter(metricNames.providerSessionsTotal, {
  description: "Total provider session lifecycle operations.",
});

export const providerTurnsTotal = Metric.counter(metricNames.providerTurnsTotal, {
  description: "Total provider turn lifecycle operations.",
});

export const providerTurnDuration = Metric.timer(metricNames.providerTurnDuration, {
  description: "Provider turn request duration.",
});

export const providerRuntimeEventsTotal = Metric.counter(metricNames.providerRuntimeEventsTotal, {
  description: "Total canonical provider runtime events processed.",
});

export const providerRuntimeStaleEventsTotal = Metric.counter(
  metricNames.providerRuntimeStaleEventsTotal,
  {
    description: "Total provider runtime events dropped because their instance or epoch is stale.",
  },
);

export const providerStaleStopTimeoutsTotal = Metric.counter(
  metricNames.providerStaleStopTimeoutsTotal,
  {
    description: "Total bounded stale provider runtime stop attempts that timed out.",
  },
);

export const contextHandoffsTotal = Metric.counter(metricNames.contextHandoffsTotal, {
  description: "Total context handoff operations by durable lifecycle outcome.",
});

export const contextHandoffContextBytesTotal = Metric.counter(
  metricNames.contextHandoffContextBytesTotal,
  {
    description: "Total rendered context bytes prepared for context handoff target turns.",
  },
);

export const contextHandoffContextEntriesTotal = Metric.counter(
  metricNames.contextHandoffContextEntriesTotal,
  {
    description: "Total structured context entries included in context handoff target turns.",
  },
);

export const contextHandoffPreparationDuration = Metric.timer(
  metricNames.contextHandoffPreparationDuration,
  {
    description: "Context handoff preparation duration before target turn dispatch.",
  },
);

export const contextHandoffDispatchDuration = Metric.timer(
  metricNames.contextHandoffDispatchDuration,
  {
    description: "Context handoff target turn dispatch duration through provider acceptance.",
  },
);

export const providerEventLogRecordsDroppedTotal = Metric.counter(
  metricNames.providerEventLogRecordsDroppedTotal,
  {
    description: "Total provider observability log records dropped by bounded logging queues.",
  },
);

export const runtimeQueueEnqueuesTotal = Metric.counter(metricNames.runtimeQueueEnqueuesTotal, {
  description: "Total runtime queue enqueue attempts by queue.",
});

export const runtimeQueueDequeuesTotal = Metric.counter(metricNames.runtimeQueueDequeuesTotal, {
  description: "Total runtime queue dequeues by queue.",
});

export const runtimeQueueDepth = Metric.gauge(metricNames.runtimeQueueDepth, {
  description: "Current tracked runtime queue depth.",
});

export const runtimeQueueHighWater = Metric.gauge(metricNames.runtimeQueueHighWater, {
  description: "Highest observed tracked runtime queue depth.",
});

export const runtimeQueueBlockedDuration = Metric.timer(metricNames.runtimeQueueBlockedDuration, {
  description: "Time producers spent waiting for bounded runtime queue admission.",
});

export const runtimeQueueCoalescedTotal = Metric.counter(metricNames.runtimeQueueCoalescedTotal, {
  description: "Total replaceable runtime queue items merged into newer state.",
});

export const runtimeQueueOverflowsTotal = Metric.counter(metricNames.runtimeQueueOverflowsTotal, {
  description: "Total bounded runtime queue overflows.",
});

export const runtimeQueueRecoveriesTotal = Metric.counter(metricNames.runtimeQueueRecoveriesTotal, {
  description: "Total recoveries completed after bounded runtime queue pressure.",
});

export const startupCommandGateEnqueuesTotal = Metric.counter(
  metricNames.startupCommandGateEnqueuesTotal,
  {
    description: "Total startup command gate enqueue attempts by outcome.",
  },
);

export const startupCommandGateQueueDepth = Metric.gauge(metricNames.startupCommandGateQueueDepth, {
  description: "Current number of commands waiting for startup command readiness.",
});

export const startupCommandGateQueueHighWater = Metric.gauge(
  metricNames.startupCommandGateQueueHighWater,
  {
    description: "Highest observed startup command gate queue depth.",
  },
);

export const startupCommandGateQueueWaitDuration = Metric.timer(
  metricNames.startupCommandGateQueueWaitDuration,
  {
    description: "Time startup commands spent waiting for command readiness.",
  },
);

export const providerStartupAdmissionTotal = Metric.counter(
  metricNames.providerStartupAdmissionTotal,
  {
    description: "Total provider startup admission attempts by outcome.",
  },
);

export const providerStartupQueueDepth = Metric.gauge(metricNames.providerStartupQueueDepth, {
  description: "Current number of provider session starts in admission per provider instance.",
});

export const providerStartupQueueHighWater = Metric.gauge(
  metricNames.providerStartupQueueHighWater,
  {
    description: "Highest observed provider startup admission depth per provider instance.",
  },
);

export const providerStartupQueueWaitDuration = Metric.timer(
  metricNames.providerStartupQueueWaitDuration,
  {
    description: "Time provider session starts spent waiting for startup admission.",
  },
);

export const gitCommandsTotal = Metric.counter(metricNames.gitCommandsTotal, {
  description: "Total git commands executed by the server runtime.",
});

export const gitCommandDuration = Metric.timer(metricNames.gitCommandDuration, {
  description: "Git command execution duration.",
});

export const terminalSessionsTotal = Metric.counter(metricNames.terminalSessionsTotal, {
  description: "Total terminal sessions started.",
});

export const terminalRestartsTotal = Metric.counter(metricNames.terminalRestartsTotal, {
  description: "Total terminal restart requests handled.",
});

export const serverEventLoopStallsTotal = Metric.counter(metricNames.serverEventLoopStallsTotal, {
  description:
    "Total event-loop and libuv threadpool stalls of 2 s or more recorded by the lifetime monitor, by kind.",
});

export const serverEventLoopStallMaxMs = Metric.gauge(metricNames.serverEventLoopStallMaxMs, {
  description: "Longest event-loop stall in the last 30 s monitor window, 0 when there was none.",
});

export const serverEventLoopUtilization = Metric.gauge(metricNames.serverEventLoopUtilization, {
  description: "Event-loop utilization (busy fraction, 0..1) over the last 30 s monitor window.",
});

export const metricAttributes = (
  attributes: Readonly<Record<string, unknown>>,
): ReadonlyArray<[string, string]> => Object.entries(compactMetricAttributes(attributes));

export const increment = (
  metric: Metric.Metric<number, unknown>,
  attributes: Readonly<Record<string, unknown>>,
  amount = 1,
) => Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), amount);

export interface WithMetricsOptions {
  readonly counter?: Metric.Metric<number, unknown>;
  readonly timer?: Metric.Metric<Duration.Duration, unknown>;
  readonly attributes?:
    | Readonly<Record<string, unknown>>
    | (() => Readonly<Record<string, unknown>>);
  readonly outcomeAttributes?: (
    outcome: ReturnType<typeof outcomeFromExit>,
  ) => Readonly<Record<string, unknown>>;
}

const withMetricsImpl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: WithMetricsOptions,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const exit = yield* Effect.exit(effect);
    const duration = Duration.millis(Math.max(0, Date.now() - startedAt));
    const baseAttributes =
      typeof options.attributes === "function" ? options.attributes() : (options.attributes ?? {});

    if (options.timer) {
      yield* Metric.update(
        Metric.withAttributes(options.timer, metricAttributes(baseAttributes)),
        duration,
      );
    }

    if (options.counter) {
      const outcome = outcomeFromExit(exit);
      yield* Metric.update(
        Metric.withAttributes(
          options.counter,
          metricAttributes({
            ...baseAttributes,
            outcome,
            ...(options.outcomeAttributes ? options.outcomeAttributes(outcome) : {}),
          }),
        ),
        1,
      );
    }

    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    return yield* Effect.failCause(exit.cause);
  });

export const withMetrics: {
  <A, E, R>(
    options: WithMetricsOptions,
  ): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WithMetricsOptions): Effect.Effect<A, E, R>;
} = dual(2, withMetricsImpl);

export const providerMetricAttributes = (
  provider: string,
  extra?: Readonly<Record<string, unknown>>,
) =>
  compactMetricAttributes({
    provider,
    ...extra,
  });

export const providerTurnMetricAttributes = (input: {
  readonly provider: string;
  readonly model: string | null | undefined;
  readonly extra?: Readonly<Record<string, unknown>>;
}) => {
  const modelFamily = normalizeModelMetricLabel(input.model);
  return compactMetricAttributes({
    provider: input.provider,
    ...(modelFamily ? { modelFamily } : {}),
    ...input.extra,
  });
};
