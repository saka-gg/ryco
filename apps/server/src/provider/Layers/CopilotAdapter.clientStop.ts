import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";

/**
 * Budget for a graceful Copilot client stop wherever a stall would hold something else up:
 * server shutdown (the desktop SIGKILLs its backend 3 s after SIGTERM), provider probes and
 * one-shot text generation. The SDK's own `stop()` waits up to 10 s for `runtime.shutdown` and
 * another 10 s for the CLI to exit after it is killed.
 */
export const COPILOT_CLIENT_STOP_TIMEOUT_MS = 1_000;

/**
 * A user-initiated session stop has no exit deadline behind it, so the CLI gets longer to
 * detach and flush the session before it is killed.
 */
export const COPILOT_SESSION_STOP_TIMEOUT_MS = 5_000;

export interface CopilotClientStopOutcome {
  /** The graceful stop missed its budget and the client was force-stopped. */
  readonly forced: boolean;
  /** Set when detaching `session` failed (the client was still stopped). */
  readonly disconnectError?: unknown;
}

/**
 * Stop a Copilot client within `timeoutMs`: detach `session` when given, then run the SDK's
 * graceful `stop()`. When that does not finish in time the client is force-stopped, which
 * disposes the connection and SIGKILLs the CLI (unless the graceful stop already reached its
 * own SIGTERM of the CLI and is only waiting for the exit); the abandoned graceful attempt
 * settles on its own. Never rejects.
 */
export async function stopCopilotClient(input: {
  readonly client: Pick<CopilotClient, "stop" | "forceStop">;
  readonly session?: Pick<CopilotSession, "disconnect"> | undefined;
  readonly timeoutMs: number;
}): Promise<CopilotClientStopOutcome> {
  const { client, session, timeoutMs } = input;
  let disconnectError: unknown;
  let disconnectFailed = false;
  const graceful = (async () => {
    if (session !== undefined) {
      try {
        await session.disconnect();
      } catch (error) {
        disconnectFailed = true;
        disconnectError = error;
      }
    }
    try {
      await client.stop();
    } catch {
      // `stop()` reports cleanup problems in its result; a throw leaves nothing to retry.
    }
    return "stopped" as const;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
  });
  try {
    const winner = await Promise.race([graceful, deadline]);
    if (winner === "stopped") {
      return disconnectFailed ? { forced: false, disconnectError } : { forced: false };
    }
  } finally {
    clearTimeout(timer);
  }

  try {
    await client.forceStop();
  } catch {
    // Best effort: forceStop only signals and disposes handles.
  }
  return { forced: true };
}
