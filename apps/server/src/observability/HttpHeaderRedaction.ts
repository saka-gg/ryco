import { LOCAL_INTRODUCTION_CONTROL_HEADER } from "@ryco/contracts";
import { Layer } from "effect";
import { Headers, HttpMiddleware } from "effect/http";

/**
 * Records every request and response header on HTTP server spans. Effect
 * captures none by default; credentials stay out of spans through
 * `Headers.CurrentRedactedNames` and the redactor below.
 */
export const HttpSpanHeadersLive = Layer.succeed(HttpMiddleware.TracerHeaderFilter, () => true);

/** Capture policy before HTTP tracing defers span completion outside its request context. */
export function makeHttpHeaderRedactor(names: ReadonlyArray<string | RegExp>) {
  const redactedNames = [...names, LOCAL_INTRODUCTION_CONTROL_HEADER, "dpop", "dpop-nonce"];
  return (key: string, value: unknown): unknown => {
    const match = /^http\.(?:request|response)\.header\.(.+)$/iu.exec(key);
    if (!match) return value;
    const name = match[1]!.toLowerCase();
    return String(
      Headers.redact(Headers.fromInput({ [name]: String(value) }), redactedNames)[name],
    );
  };
}
