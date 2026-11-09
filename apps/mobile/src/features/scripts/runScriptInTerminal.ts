import type { EnvironmentApi, TerminalEvent } from "@ryco/contracts";

import {
  SCRIPT_TERMINAL_COLS,
  SCRIPT_TERMINAL_ROWS,
  type ScriptRunRequest,
} from "./projectScriptsModel";

/** How long a new shell may take to print its prompt before the command is typed anyway. */
export const SHELL_READY_TIMEOUT_MS = 10_000;
/**
 * Without the line editor's signal, output must pause this long: a slow shell
 * startup can print early and then load for seconds before its prompt.
 */
export const SHELL_QUIET_MS = 1_500;
/**
 * zsh, bash and fish switch bracketed paste on when their line editor starts
 * reading a command: the moment typed input is no longer lost.
 */
const LINE_EDITOR_READY = "\u001b[?2004h";

/** Whether `output` shows the shell's line editor waiting for a command. */
export function shellPromptShown(output: string): boolean {
  return output.includes(LINE_EDITOR_READY);
}

type TerminalApi = Pick<EnvironmentApi["terminal"], "open" | "write" | "close" | "onEvent">;

/**
 * Resolves once the shell's line editor is reading (bracketed paste switched
 * on), else once output stayed quiet for `quietMs`, at the latest after
 * `timeoutMs`. Input sent while the shell still starts can be lost.
 * Subscribed before the terminal opens, so a fast prompt is not missed.
 */
function shellReady(
  api: TerminalApi,
  threadId: string,
  terminalId: string,
  timing: { readonly timeoutMs: number; readonly quietMs: number },
): {
  readonly ready: Promise<void>;
  /** Output the open's snapshot already holds. */
  readonly sawOutput: (output: string) => void;
  readonly cancel: () => void;
} {
  let unsubscribe: () => void = () => {};
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const onOutput = (output: string) => {
    if (shellPromptShown(output)) {
      resolveReady();
      return;
    }
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(resolveReady, timing.quietMs);
  };
  timeoutTimer = setTimeout(resolveReady, timing.timeoutMs);
  unsubscribe = api.onEvent((event: TerminalEvent) => {
    if (
      event.threadId === threadId &&
      event.terminalId === terminalId &&
      event.type === "output" &&
      event.data.length > 0
    )
      onOutput(event.data);
  });
  return {
    ready,
    sawOutput: onOutput,
    cancel: () => {
      if (quietTimer !== null) clearTimeout(quietTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      unsubscribe();
      // Once only: the run cancels again on its failure path.
      unsubscribe = () => {};
    },
  };
}

/**
 * Opens `terminalId` for the thread and types the request's command once the
 * shell is ready. Typing into a shell that is still starting loses the input
 * (a slow zsh startup discards typeahead), so the command waits until the
 * shell printed its prompt and went quiet.
 */
export async function runScriptInTerminal(input: {
  readonly api: TerminalApi;
  readonly threadId: string;
  readonly terminalId: string;
  readonly request: ScriptRunRequest;
  readonly timeoutMs?: number;
  readonly quietMs?: number;
}): Promise<void> {
  const { api, threadId, terminalId, request } = input;
  const shell = shellReady(api, threadId, terminalId, {
    timeoutMs: input.timeoutMs ?? SHELL_READY_TIMEOUT_MS,
    quietMs: input.quietMs ?? SHELL_QUIET_MS,
  });
  const snapshot = await (async () => {
    try {
      return await api.open({
        threadId,
        terminalId,
        cwd: request.cwd,
        ...(request.worktreePath ? { worktreePath: request.worktreePath } : {}),
        env: request.env,
        cols: SCRIPT_TERMINAL_COLS,
        rows: SCRIPT_TERMINAL_ROWS,
      });
    } catch (cause) {
      shell.cancel();
      throw cause;
    }
  })();
  // The shell exists from here on: a run that fails closes it again on the machine.
  try {
    if (snapshot.history.length > 0) shell.sawOutput(snapshot.history);
    await shell.ready;
    shell.cancel();
    await api.write({ threadId, terminalId, data: request.input });
  } catch (cause) {
    shell.cancel();
    await api.close({ threadId, terminalId }).catch(() => undefined);
    throw cause;
  }
}
