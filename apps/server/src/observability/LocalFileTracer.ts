import type * as Exit from "effect/Exit";
import { Effect, Option, Tracer } from "effect";
import { Headers } from "effect/http";

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
  /**
   * SQL statement spans (spans carrying `db.query.text`) that succeed faster
   * than this are left out of the local trace: they are most of its volume.
   * Failed and slower statements are kept. `0` keeps every statement. The
   * OTLP delegate always receives every span. Neither threshold applies when
   * tracer timing is disabled, because spans then carry no durations.
   */
  readonly sqlSpanMinDurationMs?: number;
  /**
   * Child spans (spans with a local parent) that succeed faster than this are
   * left out of the local trace: sub-millisecond children make up much of its
   * volume. Root spans, including those continuing a remote trace, failed or
   * interrupted spans, and spans that recorded a log message are always kept;
   * statement spans follow `sqlSpanMinDurationMs` alone. `0` keeps every span.
   * The OTLP delegate always receives every span.
   */
  readonly spanMinDurationMs?: number;
}

/** Default for {@link LocalFileTracerOptions.sqlSpanMinDurationMs}. */
export const DEFAULT_LOCAL_TRACE_SQL_MIN_DURATION_MS = 50;

/** Default for {@link LocalFileTracerOptions.spanMinDurationMs}. */
export const DEFAULT_LOCAL_TRACE_SPAN_MIN_DURATION_MS = 5;

interface LocalRecordThresholds {
  readonly sqlSpanMinDurationNs: bigint;
  readonly spanMinDurationNs: bigint;
}

const millisToNanos = (millis: number): bigint =>
  BigInt(Math.max(0, Math.round(millis * 1_000_000)));

const DB_QUERY_TEXT_ATTRIBUTE = "db.query.text";

/** One line per statement: layout whitespace only inflates every trace record. */
export const normalizeSqlText = (sql: string): string => sql.replace(/\s+/gu, " ").trim();

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
  private readonly thresholds: LocalRecordThresholds;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    delegate: Tracer.Span,
    push: (record: EffectTraceRecord) => void,
    redactAttribute: (key: string, value: unknown) => unknown,
    thresholds: LocalRecordThresholds,
  ) {
    this.delegate = delegate;
    this.push = push;
    this.redactAttribute = redactAttribute;
    this.thresholds = thresholds;
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

    if (this.sampled && this.keepsLocalRecord(endTime, exit)) {
      // Normalized only here: most statement spans are dropped above, and
      // their text never needs the rewrite.
      const sql = this.attributes.get(DB_QUERY_TEXT_ATTRIBUTE);
      if (typeof sql === "string") {
        this.attributes.set(DB_QUERY_TEXT_ATTRIBUTE, normalizeSqlText(sql));
      }
      this.push(spanToTraceRecord(this));
    }
  }

  private keepsLocalRecord(endTime: bigint, exit: Exit.Exit<unknown, unknown>): boolean {
    if (exit._tag === "Failure") return true;
    const startTime = this.status.startTime;
    // With timing disabled every span starts and ends at zero: there is no duration to judge.
    if (startTime === 0n && endTime === 0n) return true;
    const minDurationNs = this.minDurationNs();
    return minDurationNs === 0n || endTime - startTime >= minDurationNs;
  }

  /** The duration below which this span, if it succeeded, is left out of the local trace. */
  private minDurationNs(): bigint {
    if (this.attributes.has(DB_QUERY_TEXT_ATTRIBUTE)) return this.thresholds.sqlSpanMinDurationNs;
    if (!Option.exists(this.parent, (parent) => parent._tag === "Span")) return 0n;
    // Log messages are stored as span events, so a span that logged is the only place they live.
    return this.events.length > 0 ? 0n : this.thresholds.spanMinDurationNs;
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

  const thresholds: LocalRecordThresholds = {
    sqlSpanMinDurationNs: millisToNanos(
      options.sqlSpanMinDurationMs ?? DEFAULT_LOCAL_TRACE_SQL_MIN_DURATION_MS,
    ),
    spanMinDurationNs: millisToNanos(
      options.spanMinDurationMs ?? DEFAULT_LOCAL_TRACE_SPAN_MIN_DURATION_MS,
    ),
  };

  return Tracer.make({
    span(spanOptions) {
      return new LocalFileSpan(
        spanOptions,
        delegate.span(spanOptions),
        sink.push,
        redactAttribute,
        thresholds,
      );
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
});
