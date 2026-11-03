/**
 * AnalyticsService - Anonymous telemetry capture contract.
 *
 * Provides a best-effort event API for runtime telemetry. Telemetry is opt-in:
 * unless it is configured, the service is {@link AnalyticsService.disabled}.
 *
 * @module AnalyticsService
 */
import { Effect, Layer, Context } from "effect";

export interface AnalyticsServiceShape {
  /**
   * Whether recorded events are delivered anywhere. Callers skip work that
   * only feeds analytics when this is false.
   */
  readonly enabled: boolean;

  /**
   * Record an event for delivery; best effort, never fails.
   */
  readonly record: (
    event: string,
    properties?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void, never>;

  /**
   * Flush queued telemetry.
   */
  readonly flush: Effect.Effect<void, never>;
}

const disabledAnalyticsService: AnalyticsServiceShape = {
  enabled: false,
  record: () => Effect.void,
  flush: Effect.void,
};

export class AnalyticsService extends Context.Service<AnalyticsService, AnalyticsServiceShape>()(
  "ryco/telemetry/Services/AnalyticsService",
) {
  /** Delivers nothing: the service when telemetry is not configured, and in tests. */
  static readonly disabled = disabledAnalyticsService;
  static readonly layerTest = Layer.succeed(AnalyticsService, disabledAnalyticsService);
}
