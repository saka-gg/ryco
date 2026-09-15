/** Compatibility only: never turn a persisted recall into a different prompt. */
export const REMOVED_PROJECT_MEMORY_MESSAGE =
  "Project memory was intentionally removed. This saved request cannot be sent. Compose a new message.";

export function hasRetiredProjectMemory(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "projectMemory" in value &&
    value.projectMemory !== undefined
  );
}

export function rejectRetiredProjectMemory(value: unknown): void {
  if (hasRetiredProjectMemory(value)) throw new Error(REMOVED_PROJECT_MEMORY_MESSAGE);
}
