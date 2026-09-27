/** Only an attachment-free exact native command bypasses prompt decoration. */
export function isClaudeNativeCompaction(input: {
  readonly input?: string | undefined;
  readonly attachments?: readonly unknown[] | undefined;
}): boolean {
  return input.input?.trim() === "/compact" && (input.attachments?.length ?? 0) === 0;
}
