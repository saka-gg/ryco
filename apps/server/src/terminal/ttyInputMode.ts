/**
 * ttyInputMode - reads whether a pty echoes input and buffers it by line (termios `ECHO` and
 * `ICANON`), the only reliable sign that a program waits for hidden input: `getpass`, `sudo`,
 * `ssh` and `read -s` turn echo off and keep line mode. Raw-mode programs (line editors, the
 * shell's own prompt, full-screen programs) turn both off and draw their own echo.
 *
 * @module ttyInputMode
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import type { PtyInputMode } from "./Services/PTY.ts";

/** `ECHO` is the same bit on Linux and macOS; `ICANON` differs. */
const ECHO = 0o10;
const icanonBit = (platform: NodeJS.Platform) => (platform === "darwin" ? 0x100 : 0o2);

export const inputModeFromLocalFlags = (
  localFlags: number,
  platform: NodeJS.Platform,
): PtyInputMode | undefined =>
  Number.isInteger(localFlags)
    ? { echo: (localFlags & ECHO) !== 0, canonical: (localFlags & icanonBit(platform)) !== 0 }
    : undefined;

/** `stty -a` output: flags are words, a leading `-` turns one off. */
export const parseSttyInputMode = (output: string): PtyInputMode | undefined => {
  const words = new Set(output.split(/[\s;]+/));
  const echo = words.has("echo") ? true : words.has("-echo") ? false : undefined;
  const canonical = words.has("icanon") ? true : words.has("-icanon") ? false : undefined;
  return echo === undefined || canonical === undefined ? undefined : { echo, canonical };
};

const STTY_TIMEOUT_MS = 1_000;

/** An absolute path, so a `stty` earlier on the server's PATH is never what runs. */
let sttyPath: string | null | undefined;
const resolveStty = () => {
  sttyPath ??= ["/bin/stty", "/usr/bin/stty"].find((candidate) => existsSync(candidate)) ?? null;
  return sttyPath;
};

/** Reads the flags of the tty at `device` with `stty`; `undefined` on any failure. */
export const readInputModeWithStty = (
  device: string,
  platform: NodeJS.Platform,
): Promise<PtyInputMode | undefined> =>
  new Promise((resolve) => {
    const stty = resolveStty();
    if (stty === null) return resolve(undefined);
    try {
      execFile(
        stty,
        ["-a", platform === "darwin" ? "-f" : "-F", device],
        { timeout: STTY_TIMEOUT_MS, encoding: "utf8" },
        (error, stdout) => resolve(error ? undefined : parseSttyInputMode(stdout)),
      );
    } catch {
      resolve(undefined);
    }
  });
