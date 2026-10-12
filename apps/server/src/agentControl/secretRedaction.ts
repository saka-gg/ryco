/**
 * Redaction of Agent Control bearer (`rycoac_…`) and bootstrap (`rycoacb_…`)
 * tokens from values headed for logs, persistence, or provider-facing output.
 *
 * Both entry points are copy-on-write: the common case (nothing to redact)
 * walks the value once and returns the same reference without allocating.
 *
 * @module agentControl/secretRedaction
 */

/** Every Agent Control token contains this; text without it has nothing to redact. */
export const AGENT_CONTROL_SECRET_MARKER = "rycoac";
const SECRET_PATTERN = /rycoacb?_[A-Za-z0-9_-]{43}/g;
const REDACTED = "[REDACTED]";

/** Redacts Agent Control tokens in one string; returns `value` itself when it holds none. */
export const redactAgentControlSecretText = (value: string): string =>
  value.includes(AGENT_CONTROL_SECRET_MARKER) ? value.replaceAll(SECRET_PATTERN, REDACTED) : value;

/**
 * Defensive redaction for provider configs and events that necessarily carry
 * scoped secrets. Objects and arrays are copied only along paths that changed
 * (a changed object becomes a plain object of its own enumerable entries);
 * `Error`s are always flattened to `{ name, message }`.
 */
export const redactAgentControlSecrets = (value: unknown): unknown => {
  if (typeof value === "string") return redactAgentControlSecretText(value);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactAgentControlSecretText(value.message),
    };
  }
  if (Array.isArray(value)) {
    let copy: Array<unknown> | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index];
      const redacted = redactAgentControlSecrets(entry);
      if (redacted !== entry) {
        copy ??= value.slice();
        copy[index] = redacted;
      }
    }
    return copy ?? value;
  }

  const record = value as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const entry = record[key];
    const redacted = redactAgentControlSecrets(entry);
    if (redacted !== entry) {
      copy ??= { ...record };
      copy[key] = redacted;
    }
  }
  return copy ?? value;
};

export interface SharedPayloadSecretRedactor {
  /** Redacts one provider message; the result is cached per message object. */
  readonly payload: (payload: unknown) => unknown;
  /** Redacts a runtime event, reusing the cached result for its `raw.payload`. */
  readonly event: <E extends object>(event: E) => E;
}

/**
 * Redaction for adapters that fan one provider message out into several
 * runtime events, each carrying the same message object as `raw.payload`
 * (and logging it natively first). The message is walked once; every later
 * event reuses that result by reference. Only `raw.payload` is cached:
 * messages are never mutated after receipt, the events built around them
 * are always fresh objects.
 */
export function makeSharedPayloadSecretRedactor(): SharedPayloadSecretRedactor {
  const redactedPayloads = new WeakMap<object, unknown>();
  const payload = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) {
      return redactAgentControlSecrets(value);
    }
    if (redactedPayloads.has(value)) {
      return redactedPayloads.get(value);
    }
    const redacted = redactAgentControlSecrets(value);
    redactedPayloads.set(value, redacted);
    return redacted;
  };
  const raw = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return redactAgentControlSecrets(value);
    }
    const record = value as Record<string, unknown>;
    let copy: Record<string, unknown> | undefined;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      const entry = record[key];
      const redacted = key === "payload" ? payload(entry) : redactAgentControlSecrets(entry);
      if (redacted !== entry) {
        copy ??= { ...record };
        copy[key] = redacted;
      }
    }
    return copy ?? value;
  };
  return {
    payload,
    event: <E extends object>(event: E): E => {
      const record = event as Record<string, unknown>;
      let copy: Record<string, unknown> | undefined;
      for (const key in record) {
        if (!Object.hasOwn(record, key)) continue;
        const entry = record[key];
        const redacted = key === "raw" ? raw(entry) : redactAgentControlSecrets(entry);
        if (redacted !== entry) {
          copy ??= { ...record };
          copy[key] = redacted;
        }
      }
      return (copy ?? event) as E;
    },
  };
}
