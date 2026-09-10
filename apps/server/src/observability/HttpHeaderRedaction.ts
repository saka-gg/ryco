import { LOCAL_INTRODUCTION_CONTROL_HEADER } from "@ryco/contracts";
import { Headers } from "effect/unstable/http";

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
