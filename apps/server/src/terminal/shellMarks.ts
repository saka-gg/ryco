/**
 * shellMarks - the terminal manager's side of Ryco's shell marks (`shellIntegration.ts`): the
 * OSC 133 prompt, command-start and command-end marks a zsh or bash terminal prints with its
 * session's nonce (`ESC ] 133 ; D ; <code> ; ryco=<nonce> BEL`).
 *
 * The manager reads them to know whether the shell waits at its prompt, whether someone typed at
 * that prompt since, and how the last command ended, and removes them from what it stores and
 * sends to clients, so the nonce never reaches a history file, `ryco_inspect_thread`, a client or
 * anything an agent can read. Only the agent terminal mirror gets the raw stream.
 *
 * Cheap on the output path: a chunk without `ESC ]` costs one `indexOf`.
 *
 * @module shellMarks
 */

export interface ShellMarkState {
  /** The shell drew a prompt since it started (its startup files are done). */
  promptSeen: boolean;
  /** The last mark was a prompt: no command runs. */
  atPrompt: boolean;
  /** Input reached the shell since it drew that prompt (a half-typed line, or an Enter). */
  inputSincePrompt: boolean;
  /** Ryco's marks read so far, in order: tells whether a mark came after a given moment. */
  markCount: number;
  /** The output cursor of the chunk with the latest mark (set by the manager), 0 before one. */
  lastMarkSequence: number;
  /** How the last command ended, and the output cursor of that mark. */
  lastEnd: { readonly exitCode: number | null; readonly sequence: number } | null;
  /** Output held back because a mark may continue in the next chunk. */
  pending: string;
}

export const emptyShellMarkState = (): ShellMarkState => ({
  promptSeen: false,
  atPrompt: false,
  inputSincePrompt: false,
  markCount: 0,
  lastMarkSequence: 0,
  lastEnd: null,
  pending: "",
});

const OSC_START = "\u001b]";
/** Longest tail held back for a mark that may continue in the next chunk. */
const MAX_PENDING = 512;
// oxlint-disable-next-line no-control-regex -- terminal escape sequences
const MARK_RE = /\u001b\](133|633|7772);([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
const MARK_PREFIXES = ["\u001b]133;", "\u001b]633;", "\u001b]7772;"];

/** History and clients never carry Ryco's marks (nonce-bearing 133/633) or the mirror's 7772. */
export function isRycoMarkContent(content: string): boolean {
  return (
    content.startsWith("7772;") ||
    ((content.startsWith("133;") || content.startsWith("633;")) && content.includes(";ryco="))
  );
}

/**
 * Reads the marks in one chunk of a shell's output (`nonce` from its spawn; `null`: a shell
 * without Ryco's marks), updates `state`, and returns the chunk without Ryco's marks, holding back
 * a tail that may be the start of a mark split across chunks. `onEnd` gets each command end.
 */
export function readShellMarks(
  state: ShellMarkState,
  chunk: string,
  nonce: string | null,
  onEnd: (exitCode: number | null) => void,
): string {
  const data = state.pending + chunk;
  state.pending = "";
  if (data.indexOf(OSC_START) < 0) return data;
  let out = data.replace(MARK_RE, (whole, kind: string, content: string) => {
    const params = content.split(";");
    const ours = nonce !== null && params.includes(`ryco=${nonce}`);
    if (ours && kind === "133") applyMark(state, params, onEnd);
    return ours || isRycoMarkContent(`${kind};${content}`) ? "" : whole;
  });
  // A mark that may continue in the next chunk waits for it (bounded).
  const lastStart = out.lastIndexOf(OSC_START);
  if (lastStart >= 0 && out.length - lastStart <= MAX_PENDING) {
    const tail = out.slice(lastStart);
    const unterminated = !tail.includes("\u0007") && !tail.includes("\u001b\\");
    // Only a tail that clearly starts a mark ("ESC ]13", "ESC ]63", "ESC ]77"): a bare "ESC ]"
    // is never held back, so other output is not delayed.
    if (
      unterminated &&
      tail.length >= 4 &&
      MARK_PREFIXES.some((prefix) => prefix.startsWith(tail) || tail.startsWith(prefix))
    ) {
      state.pending = tail;
      out = out.slice(0, lastStart);
    }
  }
  return out;
}

function applyMark(
  state: ShellMarkState,
  params: ReadonlyArray<string>,
  onEnd: (exitCode: number | null) => void,
): void {
  state.markCount += 1;
  const kind = params[0];
  if (kind === "A") {
    state.promptSeen = true;
    state.atPrompt = true;
    state.inputSincePrompt = false;
  } else if (kind === "C") {
    state.atPrompt = false;
  } else if (kind === "D") {
    // The command ended; the shell is at its prompt again only once it drew it (A).
    state.atPrompt = false;
    const code = params[1] !== undefined && /^-?\d+$/.test(params[1]) ? Number(params[1]) : null;
    onEnd(code);
  }
}

/** Input reached the shell: at its prompt, that is a line being typed (or an Enter). */
export function noteShellInput(state: ShellMarkState): void {
  if (state.atPrompt) state.inputSincePrompt = true;
}
