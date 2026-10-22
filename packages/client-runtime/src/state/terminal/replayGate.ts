/**
 * Reports a terminal emulator sends to the host on its own, never as typed input: device
 * attributes (`…c`), status and cursor position reports (`…n`, `…R`), mode reports (`…$y`),
 * window reports (`…t`), kitty keyboard flags (`?…u`), and any OSC or DCS string (colour,
 * DECRQSS, XTVERSION and XTGETTCAP replies). Only Shift/Ctrl+F3 (`CSI 1;<mod>R`) shares a
 * shape with them.
 */
const TERMINAL_REPLY_PATTERN =
  // eslint-disable-next-line no-control-regex -- Terminal reports are control sequences.
  /^(?:(?:\u001b\[|\u009b)(?:[?>]?[0-9;]*[cnRt]|\??[0-9;]*\$y|\?[0-9;]*u)|(?:\u001b[P\]]|[\u0090\u009d])[\s\S]*(?:\u0007|\u001b\\|\u009c))$/;

/** Whether `data` an emulator emitted is a reply to a terminal query rather than user input. */
export function isTerminalReplyData(data: string): boolean {
  return TERMINAL_REPLY_PATTERN.test(data);
}

/** The emulator a surface writes to: `callback` runs once everything written before it is parsed. */
export interface TerminalReplayWriter {
  write(data: string, callback?: () => void): void;
}

export interface TerminalReplayGate {
  /**
   * Runs `writeReplay`, whose writes restore output that is not live (history, a history delta,
   * output buffered while the surface was detached). Whatever queries it holds were answered when
   * they were live or have timed out, so answering them again would type the reply into the shell.
   */
  replay(writeReplay: () => void): void;
  /** Whether emulator data is a reply to replayed output and must not reach the PTY. */
  dropsData(data: string): boolean;
}

/**
 * Keeps one emulator's replayed output from answering queries into the live shell. Keep the gate
 * with the emulator it was made for: a reply can come after the surface that wrote the replay
 * was detached.
 */
export function createTerminalReplayGate(writer: TerminalReplayWriter): TerminalReplayGate {
  let replaying = 0;
  const raise = () => {
    replaying += 1;
  };
  const lower = () => {
    replaying -= 1;
  };
  return {
    replay: (writeReplay) => {
      // Parsing is asynchronous: an emulator answers a query when it parses it, not when it is
      // written. Raising and lowering from write callbacks brackets exactly the replayed bytes,
      // so replies to live output written before or after still reach the shell.
      writer.write("", raise);
      try {
        writeReplay();
      } finally {
        writer.write("", lower);
      }
    },
    // User input typed while a long history parses still goes out; only replies are dropped.
    dropsData: (data) => replaying > 0 && isTerminalReplyData(data),
  };
}
