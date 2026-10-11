export const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  // Dropped connections and missed heartbeats fail in-flight calls with this.
  /\bSocketReadError\b/i,
  /Unable to connect to the Ryco server WebSocket\./i,
  /\bping timeout\b/i,
] as const;

export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) ? null : (message ?? null);
}
