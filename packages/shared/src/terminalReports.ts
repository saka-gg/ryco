/**
 * Reports a terminal emulator sends to the host on its own, never as typed input: device
 * attributes (`…c`), status and cursor position reports (`…n`, `…R`), mode reports (`…$y`),
 * window reports (`…t`), kitty keyboard flags (`?…u`), and any OSC or DCS string (colour,
 * DECRQSS, XTVERSION and XTGETTCAP replies). Only Shift/Ctrl+F3 (`CSI 1;<mod>R`) shares a
 * shape with them.
 */
const TERMINAL_REPLY_SOURCE = String.raw`(?:\u001b\[|\u009b)(?:[?>]?[0-9;]*[cnRt]|\??[0-9;]*\$y|\?[0-9;]*u)|(?:\u001b[P\]]|[\u0090\u009d])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)`;
/** Focus-in and focus-out reports (`CSI I`, `CSI O`), sent once the shell turned them on. */
const TERMINAL_FOCUS_REPORT_SOURCE = String.raw`(?:\u001b\[|\u009b)[IO]`;

const TERMINAL_REPLY = new RegExp(TERMINAL_REPLY_SOURCE, "y");
const TERMINAL_REPORT = new RegExp(`${TERMINAL_FOCUS_REPORT_SOURCE}|${TERMINAL_REPLY_SOURCE}`, "y");

/** Whether `data` is one or more back-to-back matches of the sticky `pattern`, and nothing else. */
function consistsOf(pattern: RegExp, data: string): boolean {
  if (data.length === 0) return false;
  let index = 0;
  while (index < data.length) {
    pattern.lastIndex = index;
    if (!pattern.test(data)) return false;
    index = pattern.lastIndex;
  }
  return true;
}

/** Whether `data` an emulator emitted holds only replies to terminal queries, no user input. */
export function isTerminalReplyData(data: string): boolean {
  return consistsOf(TERMINAL_REPLY, data);
}

/**
 * Whether `data` an emulator emitted holds only reports it sends on its own: query replies and
 * focus reports. Such data never comes from a key the user pressed, so it cannot start a command.
 */
export function isTerminalReportData(data: string): boolean {
  return consistsOf(TERMINAL_REPORT, data);
}
