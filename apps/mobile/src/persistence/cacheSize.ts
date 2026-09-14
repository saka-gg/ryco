/** Estimated retained JS payload bytes; excludes native view buffers and object overhead. */
export function cachedPayloadBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 4;
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + cachedPayloadBytes(item), 0);
  return Object.values(value).reduce<number>((sum, item) => sum + cachedPayloadBytes(item), 0);
}
export function formatCacheBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
