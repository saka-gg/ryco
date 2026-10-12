import { Exit, Layer, ManagedRuntime, Scope, type Tracer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/observability";

import { isElectron } from "../env";
import { APP_VERSION } from "~/branding";

/**
 * The OTLP side of client tracing: the HTTP exporter, its serializer, and the
 * runtime that owns them. Loaded by `clientTracing.ts` only when tracing is
 * configured, so none of it is part of the boot graph.
 */

const CLIENT_TRACING_RESOURCE = {
  serviceName: "ryco-web",
  attributes: {
    "service.runtime": "ryco-web",
    "service.mode": isElectron ? "electron" : "browser",
    "service.version": APP_VERSION,
  },
} as const;

const delegateRuntimeLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  OtlpExporter.layerFlusher,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

export interface ClientTracingExporter {
  readonly tracer: Tracer.Tracer;
  readonly dispose: () => Promise<void>;
}

export async function startClientTracingExporter(input: {
  readonly url: string;
  readonly exportIntervalMs: number;
}): Promise<ClientTracingExporter> {
  const runtime = ManagedRuntime.make(delegateRuntimeLayer);
  const scope = runtime.runSync(Scope.make());
  const dispose = () =>
    runtime
      .runPromise(Scope.close(scope, Exit.void))
      .catch(() => undefined)
      .finally(() => {
        runtime.dispose();
      });

  try {
    const tracer = await runtime.runPromise(
      Scope.provide(scope)(
        OtlpTracer.make({
          url: input.url,
          exportInterval: `${input.exportIntervalMs} millis`,
          resource: CLIENT_TRACING_RESOURCE,
        }),
      ),
    );
    return { tracer, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
