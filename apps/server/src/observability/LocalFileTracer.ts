import type * as Exit from "effect/Exit";
import { Effect, Option, Tracer } from "effect";
import { Headers } from "effect/unstable/http";

import { spanToTraceRecord } from "./TraceRecord.ts";
import type { EffectTraceRecord } from "./TraceRecord.ts";
import { makeTraceSink, type TraceSink } from "./TraceSink.ts";
import { makeHttpHeaderRedactor } from "./HttpHeaderRedaction.ts";

export interface LocalFileTracerOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly delegate?: Tracer.Tracer;
  readonly sink?: TraceSink;
}

class LocalFileSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;
  attributes: Map<string, unknown>;
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]>;
  private readonly delegate: Tracer.Span;
  private readonly push: (record: EffectTraceRecord) => void;
  private readonly redactAttribute: (key: string, value: unknown) => unknown;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    delegate: Tracer.Span,
    push: (record: EffectTraceRecord) => void,
    redactAttribute: (key: string, value: unknown) => unknown,
  ) {
    this.delegate = delegate;
    this.push = push;
    this.redactAttribute = redactAttribute;
    this.name = delegate.name;
    this.spanId = delegate.spanId;
    this.traceId = delegate.traceId;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = [...options.links];
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
    this.status = {
      _tag: "Started",
      startTime: options.startTime,
    };
    this.attributes = new Map();
    this.events = [];
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit,
    };
    this.delegate.end(endTime, exit);

    if (this.sampled) {
      this.push(spanToTraceRecord(this));
    }
  }

  attribute(key: string, value: unknown): void {
    const redacted = this.redactAttribute(key, value);
    this.attributes.set(key, redacted);
    this.delegate.attribute(key, redacted);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    const nextAttributes = attributes ?? {};
    this.events.push([name, startTime, nextAttributes]);
    this.delegate.event(name, startTime, nextAttributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
    this.delegate.addLinks(links);
  }
}

export const makeLocalFileTracer = Effect.fn("makeLocalFileTracer")(function* (
  options: LocalFileTracerOptions,
) {
  const redactAttribute = makeHttpHeaderRedactor(
    yield* Effect.service(Headers.CurrentRedactedNames),
  );
  const sink =
    options.sink ??
    (yield* makeTraceSink({
      filePath: options.filePath,
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles,
      batchWindowMs: options.batchWindowMs,
    }));

  const delegate =
    options.delegate ??
    Tracer.make({
      span: (spanOptions) => new Tracer.NativeSpan(spanOptions),
    });

  return Tracer.make({
    span(spanOptions) {
      return new LocalFileSpan(spanOptions, delegate.span(spanOptions), sink.push, redactAttribute);
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
});
