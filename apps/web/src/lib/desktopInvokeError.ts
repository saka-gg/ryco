/** Strips Electron's invoke wrapper so the main-process message reads plainly. */
export function desktopInvokeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u, "").trim() ||
    fallback
  );
}
