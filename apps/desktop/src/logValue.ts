/** A value for one desktop log line: whitespace (newlines included) collapsed, so it cannot split the line. */
export function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** An error's message as a desktop log value. */
export function describeErrorForLog(error: unknown): string {
  return sanitizeLogValue(error instanceof Error ? error.message : String(error));
}
