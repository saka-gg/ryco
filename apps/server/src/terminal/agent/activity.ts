/**
 * What a running command is doing, from what the terminal shows and, where the PTY tells it, from
 * the tty itself: still printing, waiting at a prompt, owning the screen, or silent.
 *
 * The tty signal is exact where the screen is a guess: a program reading hidden input (`getpass`,
 * `sudo`, `ssh`, `read -s`) turns echo off and keeps line mode, so `echo: false, canonical: true`
 * means "waiting for a secret" whatever the prompt says. Raw-mode programs (line editors,
 * prompt libraries, full-screen programs) turn both off and draw their own echo, so for them the
 * text decides, with patterns tighter than a plain "ends with a colon": a secret word only on the
 * cursor's own line and only at its end, prompt characters only where output stopped mid-line,
 * and progress bars excluded.
 *
 * Pure, so the rules are unit-tested. Called on a tool's poll over the visible tail only, never
 * per chunk of output.
 *
 * @module terminal/agent/activity
 */

export type ActivityKind =
  /** Nothing is running; the shell waits at its prompt. */
  | "idle"
  /** Output arrived recently. */
  | "working"
  /** Output stopped at something that asks for input. */
  | "waiting-for-input"
  /** A full-screen program (editor, pager, top ...) owns the screen. */
  | "full-screen"
  /** No output for a while and nothing looks like a prompt: busy, or waiting without one. */
  | "silent";

export interface TtyInputMode {
  readonly echo: boolean;
  readonly canonical: boolean;
}

export interface ActivityInput {
  readonly running: boolean;
  /** Milliseconds since the terminal last printed anything. */
  readonly quietMs: number;
  /** Text on the cursor line before the cursor, untrimmed. */
  readonly beforeCursor: string;
  /** Text on the cursor line after the cursor (non-empty when the cursor sits inside a line). */
  readonly afterCursor: string;
  /** The last few non-empty lines of the screen, oldest first. */
  readonly tail: ReadonlyArray<string>;
  readonly alternate: boolean;
  /** False while the command has printed nothing yet. */
  readonly outputSinceStart?: boolean;
  /** The tty's flags, when the PTY adapter can read them. */
  readonly inputMode?: TtyInputMode | undefined;
}

export interface SignInHint {
  /** Links on screen that a sign-in flow asks the user to open. */
  readonly urls: ReadonlyArray<string>;
  /** Device or one-time codes on screen (ABCD-1234). */
  readonly codes: ReadonlyArray<string>;
}

export interface Activity {
  readonly kind: ActivityKind;
  /** The prompt asks for something secret: the user types it, never the agent. */
  readonly secret: boolean;
  /** How `secret` / `waiting-for-input` is known: from the tty's flags or from the screen. */
  readonly evidence: "tty" | "screen" | "none";
  /** The prompt line (trimmed, at most 160 characters), when waiting at one. */
  readonly prompt?: string;
  /** A sign-in flow waits in a browser: its link and code. */
  readonly signIn?: SignInHint;
  /** Seconds since the last output, rounded to tenths. */
  readonly quietSeconds: number;
}

/** Output must have been quiet this long before a prompt counts as waiting. */
export const QUIET_MS = 1_200;
/** Hidden input is known from the tty, so a much shorter pause is enough. */
export const TTY_QUIET_MS = 300;

/**
 * A secret word near the end of the cursor line, which must end like a prompt:
 * "Password:", "[sudo] password for ann:", "Enter passphrase for key '/k':", "Enter PIN:",
 * "Paste your API token:", "ann@host's password: ". Never matched in older lines.
 */
const SECRET_PROMPT_RE =
  /\b(?:password|passphrase|passcode|pin(?:\s+code)?|otp|one[- ]time\s+(?:password|passcode|code)|2fa(?:\s+code)?|mfa(?:\s+code)?|two[- ]factor(?:\s+(?:auth(?:entication)?\s+)?code)?|verification\s+code|auth(?:entication)?\s+code|security\s+code|(?:access|auth|api|personal access)?\s*token|secret(?:\s+key)?|private\s+key|api[- ]key|access\s+key)\b[^\n]{0,60}?[:?>]\s*$/i;

/** Choices that only ever appear in prompts. */
const CHOICE_RE =
  /\((?:y\/n|yes\/no)\)|\[(?:y\/n|yes\/no)\]|\(use arrow keys\)|press (?:enter|return|any key)\b|\((?:enter|return) to (?:submit|confirm|select)\)|\(default:? [^)]{1,40}\)\s*[:?]?\s*$|\[default:? [^\]]{1,40}\]\s*[:?]?\s*$/i;

/** The end of a line a program stopped at to read input. */
const PROMPT_END_RE = /[?:>»›❯]\s?$/;
/** A shell-like prompt of a REPL or subshell ("$ ", "mysql> ", "# "), with its trailing space. */
const SUBSHELL_PROMPT_RE = /(?:^|\s|\w)[$#%>] $/;
/** Progress output redrawn in place ends in a number, a bar or a counter, not a question. */
const PROGRESS_RE =
  /\d(?:[.,]\d+)?\s?%|\[[=#>\-.\s]{3,}\]|\d+\s*\/\s*\d+\s*$|\b(?:eta|elapsed)\b|[⠁-⣿]/i;
/** Words of a browser sign-in or device-code flow. */
const SIGN_IN_WORDS_RE =
  /\b(?:log ?in|sign ?in|authori[sz]e|authenticate|activate|device|one[- ]time code|verification|user code|enter (?:the )?code)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s'"<>()\]]+/gi;
const DEVICE_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g;
const CODE_AFTER_WORD_RE = /\bcode\b[^\n]{0,30}?[:\s]\s*([A-Z0-9]{6,12})\b/g;

/** Links and device codes of a sign-in flow in `lines`, newest last, without duplicates. */
export function extractSignIn(lines: ReadonlyArray<string>): SignInHint | undefined {
  const text = lines.join("\n");
  if (!SIGN_IN_WORDS_RE.test(text)) return undefined;
  const urls = unique(
    [...text.matchAll(URL_RE)].map((match) => match[0].replace(/[.,;:!?]+$/, "")),
  ).slice(-3);
  const codes = unique([
    ...[...text.matchAll(DEVICE_CODE_RE)].map((match) => match[0]),
    ...[...text.matchAll(CODE_AFTER_WORD_RE)].map((match) => match[1]!),
  ])
    .filter((code) => /\d/.test(code) || code.includes("-"))
    .slice(-3);
  return urls.length > 0 || codes.length > 0 ? { urls, codes } : undefined;
}

const unique = (values: ReadonlyArray<string>) => [...new Set(values)];

export function assessActivity(input: ActivityInput): Activity {
  const quietSeconds = Math.round(input.quietMs / 100) / 10;
  if (!input.running) return { kind: "idle", secret: false, evidence: "none", quietSeconds };

  const line = input.beforeCursor.trimEnd();
  const atLineEnd = input.afterCursor.trim() === "";
  const cursorLinePrompt = line.trim() !== "" && atLineEnd ? line.trim().slice(-160) : undefined;
  const secretText = cursorLinePrompt !== undefined && SECRET_PROMPT_RE.test(line);
  const mode = input.inputMode;

  // Hidden input in line mode: the tty says so, whatever the screen shows.
  if (mode !== undefined && !mode.echo && mode.canonical && input.quietMs >= TTY_QUIET_MS) {
    return {
      kind: "waiting-for-input",
      secret: true,
      evidence: "tty",
      ...(cursorLinePrompt === undefined ? {} : { prompt: cursorLinePrompt }),
      quietSeconds,
    };
  }
  if (input.alternate) {
    return { kind: "full-screen", secret: secretText, evidence: "screen", quietSeconds };
  }
  if (input.quietMs < QUIET_MS) {
    return { kind: "working", secret: false, evidence: "none", quietSeconds };
  }

  const recent = input.tail.slice(-8);
  const signIn = extractSignIn(recent);
  const choice =
    (cursorLinePrompt !== undefined && CHOICE_RE.test(line)) ||
    input.tail
      .slice(-3)
      .some((tailLine) => /\(use arrow keys\)|press (?:enter|return)\b/i.test(tailLine));
  const promptEnd =
    cursorLinePrompt !== undefined &&
    !PROGRESS_RE.test(line) &&
    (PROMPT_END_RE.test(line) || SUBSHELL_PROMPT_RE.test(input.beforeCursor));
  if (secretText || choice || promptEnd || signIn !== undefined) {
    return {
      kind: "waiting-for-input",
      secret: secretText,
      evidence: "screen",
      ...(cursorLinePrompt === undefined
        ? recent.length > 0
          ? { prompt: recent[recent.length - 1]!.trim().slice(-160) }
          : {}
        : { prompt: cursorLinePrompt }),
      ...(signIn === undefined ? {} : { signIn }),
      quietSeconds,
    };
  }
  return { kind: "silent", secret: false, evidence: "none", quietSeconds };
}

const SHELL_PROMPT_RE = /(?:^PS [^>]*>|[$#%>❯»➜λ])\s?$/;

/** Without shell integration: does the cursor line look like a shell prompt waiting for a command? */
export function looksLikeShellPrompt(beforeCursor: string, afterCursor: string): boolean {
  return (
    afterCursor.trim() === "" && beforeCursor.trim() !== "" && SHELL_PROMPT_RE.test(beforeCursor)
  );
}
