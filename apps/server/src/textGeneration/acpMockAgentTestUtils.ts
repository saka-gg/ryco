import { readFileSync } from "node:fs";

import { Effect } from "effect";

/**
 * Waits, in real time, until the ACP mock agent (`scripts/acp-mock-agent.ts`) has logged a
 * `session/prompt` request to its `RYCO_ACP_REQUEST_LOG_PATH`.
 */
export function waitForAcpPromptRequest(requestLogPath: string): Effect.Effect<void> {
  return Effect.promise(async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      let log = "";
      try {
        log = readFileSync(requestLogPath, "utf8");
      } catch {
        // Not written yet.
      }
      if (log.includes('"session/prompt"')) return;
      if (Date.now() >= deadline) throw new Error("The ACP mock agent never received a prompt.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}
