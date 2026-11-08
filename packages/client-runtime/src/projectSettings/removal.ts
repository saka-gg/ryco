/** The facts a project removal confirmation states, one per line. */
export function describeProjectRemoval(input: {
  readonly name: string;
  readonly cwd: string;
  readonly environmentLabel: string | null;
  readonly threadCount: number;
}): { readonly title: string; readonly lines: readonly string[] } {
  const threads = `${input.threadCount} thread${input.threadCount === 1 ? "" : "s"}`;
  return {
    title:
      input.threadCount > 0
        ? `Remove project "${input.name}" and delete its ${threads}?`
        : `Remove project "${input.name}"?`,
    lines: [
      `Path: ${input.cwd}`,
      ...(input.environmentLabel ? [`Environment: ${input.environmentLabel}`] : []),
      ...(input.threadCount > 0
        ? ["This permanently clears conversation history for those threads."]
        : []),
      "This removes only this project entry.",
      ...(input.threadCount > 0 ? ["This action cannot be undone."] : []),
    ],
  };
}
