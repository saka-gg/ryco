import type { ServerConfig } from "@ryco/contracts";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import type { ClientTracingExporter } from "./clientTracingExporter";

/**
 * Matches the server's own OTLP export interval: the effect exporter batches
 * spans per interval, and a one-second interval meant up to one authenticated
 * POST a second per open client while requests were active.
 */
const DEFAULT_EXPORT_INTERVAL_MS = 10_000;

let activeDelegate: Tracer.Tracer | null = null;
let activeExporter: ClientTracingExporter | null = null;
let activeConfigKey: string | null = null;
let configurationGeneration = 0;
let pendingConfiguration = Promise.resolve();

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

/**
 * The tracer every client runtime is built with. It forwards to the OTLP
 * delegate once tracing is configured and records plain native spans until
 * then, so it costs nothing on the boot path: the exporter, its HTTP client,
 * and its serializer load only when `configureClientTracing` first runs.
 */
export const ClientTracingLive = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return activeDelegate?.span(options) ?? new Tracer.NativeSpan(options);
    },
  }),
);

/**
 * Browser spans are exported only to a server that has a use for them: one
 * that advertises it wants them (it forwards to an OTLP collector or was
 * started with browser tracing on), or any server in a perf-profile build.
 * Older servers advertise nothing and receive nothing.
 */
export function shouldExportClientTraces(input: {
  readonly observability: ServerConfig["observability"] | null | undefined;
  readonly perfProfile: boolean;
}): boolean {
  return input.perfProfile || input.observability?.browserTracesEnabled === true;
}

/** Stops exporting spans; they are recorded as plain native spans again. */
export function disableClientTracing(): Promise<void> {
  pendingConfiguration = pendingConfiguration.finally(async () => {
    configurationGeneration++;
    activeConfigKey = null;
    activeDelegate = null;
    const exporter = activeExporter;
    activeExporter = null;
    await exporter?.dispose();
  });
  return pendingConfiguration;
}

export function configureClientTracing(config: ClientTracingConfig = {}): Promise<void> {
  if (config.exportIntervalMs === undefined && activeConfigKey !== null) {
    return pendingConfiguration;
  }
  pendingConfiguration = pendingConfiguration.finally(() => applyClientTracingConfig(config));
  return pendingConfiguration;
}

async function applyClientTracingConfig(config: ClientTracingConfig): Promise<void> {
  const otlpTracesUrl = resolvePrimaryEnvironmentHttpUrl("/api/observability/v1/traces");
  const exportIntervalMs = Math.max(10, config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS);
  const nextConfigKey = `${otlpTracesUrl}|${exportIntervalMs}`;

  if (activeConfigKey === nextConfigKey && activeDelegate !== null) {
    return;
  }

  activeConfigKey = nextConfigKey;
  const generation = ++configurationGeneration;

  const previousExporter = activeExporter;
  activeDelegate = null;
  activeExporter = null;

  await previousExporter?.dispose();

  let exporter: ClientTracingExporter;
  try {
    const { startClientTracingExporter } = await import("./clientTracingExporter");
    exporter = await startClientTracingExporter({ url: otlpTracesUrl, exportIntervalMs });
  } catch (error) {
    if (generation === configurationGeneration) {
      console.warn("Failed to configure client tracing exporter", {
        error: formatError(error),
        otlpTracesUrl,
      });
    }
    return;
  }

  if (generation !== configurationGeneration) {
    await exporter.dispose();
    return;
  }

  activeDelegate = exporter.tracer;
  activeExporter = exporter;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

export async function __resetClientTracingForTests() {
  configurationGeneration++;
  activeConfigKey = null;
  activeDelegate = null;
  pendingConfiguration = Promise.resolve();

  const exporter = activeExporter;
  activeExporter = null;

  await exporter?.dispose();
}
