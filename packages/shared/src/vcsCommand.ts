/**
 * Which finished shell commands may have changed what Ryco's git views show: the
 * checked-out branch, commits, the index, remote-tracking refs or change requests.
 *
 * A single linear pass splits the command into shell words (quotes kept together,
 * their contents also scanned as nested commands, so `bash -lc 'git rebase main'`
 * counts), then looks for `git`, `gh` and `glab` invocations. It never backtracks:
 * the cost is proportional to the scanned length, at most
 * {@link MAX_SCANNED_COMMAND_CHARS} characters per nesting level.
 *
 * Over-matching is cheap (a status re-read); a command it misses is still caught
 * at the turn's end. A commit message or heredoc body that mentions `git push`
 * counts as a push.
 *
 * @module vcsCommand
 */

/** What a finished shell command may have changed, as far as Ryco's git views care. */
export interface VcsCommandEffect {
  /** HEAD, the branch, commits or the index may have moved: re-read the checkout. */
  readonly local: boolean;
  /** Remote-tracking refs or change requests may have moved: also re-read upstream and the forge. */
  readonly remote: boolean;
}

/** Characters scanned per command; a longer heredoc commit body is scanned no further. */
export const MAX_SCANNED_COMMAND_CHARS = 16_384;

/** Quoted text is scanned again as a command this many levels deep (`sh -c "bash -lc '…'"`). */
const MAX_QUOTE_DEPTH = 3;

const LOCAL: VcsCommandEffect = { local: true, remote: false };
const REMOTE: VcsCommandEffect = { local: false, remote: true };
const BOTH: VcsCommandEffect = { local: true, remote: true };

const GIT_SUBCOMMANDS: ReadonlyMap<string, VcsCommandEffect> = new Map([
  ["checkout", LOCAL],
  ["switch", LOCAL],
  ["branch", LOCAL],
  ["commit", LOCAL],
  ["merge", LOCAL],
  ["rebase", LOCAL],
  ["reset", LOCAL],
  ["revert", LOCAL],
  ["cherry-pick", LOCAL],
  ["am", LOCAL],
  ["stash", LOCAL],
  ["worktree", LOCAL],
  ["pull", BOTH],
  ["push", REMOTE],
  ["fetch", REMOTE],
]);

/** Git global options that take the next word as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
/** Read-only change-request subcommands; every other one may change a pull or merge request. */
const GH_PR_READ_ONLY = new Set(["view", "list", "status", "diff", "checks"]);
const GLAB_MR_READ_ONLY = new Set(["view", "list", "diff"]);
/** `gh`/`glab` options before the subcommand that take a value. */
const FORGE_OPTIONS_WITH_VALUE = new Set(["-R", "--repo"]);

export function mergeVcsCommandEffects(
  left: VcsCommandEffect | null,
  right: VcsCommandEffect | null,
): VcsCommandEffect | null {
  if (left === null) return right;
  if (right === null) return left;
  const local = left.local || right.local;
  const remote = left.remote || right.remote;
  return local && remote ? BOTH : local ? LOCAL : REMOTE;
}

/** Null when the command runs no git or forge command that changes state. */
export function classifyVcsCommand(command: string): VcsCommandEffect | null {
  return scanCommands(
    command.length > MAX_SCANNED_COMMAND_CHARS
      ? command.slice(0, MAX_SCANNED_COMMAND_CHARS)
      : command,
    0,
  );
}

/** `/usr/bin/git`, `git.exe` and `git` are all git. */
function executableName(word: string): string {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  const base = slash >= 0 ? word.slice(slash + 1) : word;
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

/** Index of the first word at or after `from` that is not an option (skipping option values). */
function firstOperand(
  words: ReadonlyArray<string>,
  from: number,
  optionsWithValue: ReadonlySet<string>,
): number {
  let index = from;
  while (index < words.length) {
    const word = words[index]!;
    if (optionsWithValue.has(word)) {
      index += 2;
    } else if (word.startsWith("-")) {
      index += 1;
    } else {
      return index;
    }
  }
  return index;
}

function classifyInvocation(
  executable: string,
  words: ReadonlyArray<string>,
  argsStart: number,
): VcsCommandEffect | null {
  if (executable === "git") {
    const sub = words[firstOperand(words, argsStart, GIT_OPTIONS_WITH_VALUE)];
    return sub === undefined ? null : (GIT_SUBCOMMANDS.get(sub) ?? null);
  }
  const noun = executable === "gh" ? "pr" : "mr";
  const nounIndex = firstOperand(words, argsStart, FORGE_OPTIONS_WITH_VALUE);
  if (words[nounIndex] !== noun) return null;
  const sub = words[firstOperand(words, nounIndex + 1, FORGE_OPTIONS_WITH_VALUE)];
  if (sub === undefined) return null;
  if (sub === "checkout") return BOTH;
  return (executable === "gh" ? GH_PR_READ_ONLY : GLAB_MR_READ_ONLY).has(sub) ? null : REMOTE;
}

function classifyWords(words: ReadonlyArray<string>): VcsCommandEffect | null {
  let effect: VcsCommandEffect | null = null;
  for (let index = 0; index < words.length; index += 1) {
    const executable = executableName(words[index]!);
    if (executable === "git" || executable === "gh" || executable === "glab") {
      effect = mergeVcsCommandEffects(effect, classifyInvocation(executable, words, index + 1));
    }
  }
  return effect;
}

const SINGLE_QUOTE = 39;
const DOUBLE_QUOTE = 34;
const BACKSLASH = 92;
const NEWLINE = 10;

/** Characters that end a simple command: the next word starts a new one. */
function isCommandSeparator(code: number): boolean {
  // \n ; & | ( ) `
  return (
    code === NEWLINE ||
    code === 59 ||
    code === 38 ||
    code === 124 ||
    code === 40 ||
    code === 41 ||
    code === 96
  );
}

function isWordSeparator(code: number): boolean {
  // space, \t, \r, \v, \f, and the redirections < > (`git push>/dev/null` is `git push`)
  return (
    code === 32 ||
    code === 9 ||
    code === 13 ||
    code === 11 ||
    code === 12 ||
    code === 60 ||
    code === 62
  );
}

function isPlainWordCharacter(code: number): boolean {
  return (
    !isWordSeparator(code) &&
    !isCommandSeparator(code) &&
    code !== SINGLE_QUOTE &&
    code !== DOUBLE_QUOTE &&
    code !== BACKSLASH
  );
}

/**
 * One pass over `text`: words are grouped into simple commands and classified;
 * quoted text joins its word and is also scanned as a command of its own.
 */
function scanCommands(text: string, depth: number): VcsCommandEffect | null {
  let effect: VcsCommandEffect | null = null;
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) effect = mergeVcsCommandEffects(effect, classifyWords(words));
    words = [];
  };
  const quoted = (contents: string) => {
    word += contents;
    inWord = true;
    if (depth + 1 < MAX_QUOTE_DEPTH && contents.length > 0) {
      effect = mergeVcsCommandEffects(effect, scanCommands(contents, depth + 1));
    }
  };

  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isWordSeparator(code)) {
      endWord();
      index += 1;
    } else if (isCommandSeparator(code)) {
      endCommand();
      index += 1;
    } else if (code === SINGLE_QUOTE) {
      // Literal up to the next single quote.
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      quoted(text.slice(index + 1, end));
      index = end + 1;
    } else if (code === DOUBLE_QUOTE) {
      // Up to the next unescaped double quote; a backslash escapes one character.
      let contents = "";
      let runStart = index + 1;
      let cursor = runStart;
      while (cursor < text.length) {
        const inner = text.charCodeAt(cursor);
        if (inner === DOUBLE_QUOTE) break;
        if (inner === BACKSLASH && cursor + 1 < text.length) {
          contents += text.slice(runStart, cursor) + text[cursor + 1];
          cursor += 2;
          runStart = cursor;
        } else {
          cursor += 1;
        }
      }
      quoted(contents + text.slice(runStart, cursor));
      index = cursor + 1;
    } else if (code === BACKSLASH) {
      // A backslash-newline continues the line; otherwise it escapes one character.
      if (text.charCodeAt(index + 1) === NEWLINE) {
        endWord();
      } else if (index + 1 < text.length) {
        word += text[index + 1];
        inWord = true;
      }
      index += 2;
    } else {
      const start = index;
      index += 1;
      while (index < text.length && isPlainWordCharacter(text.charCodeAt(index))) index += 1;
      word += text.slice(start, index);
      inWord = true;
    }
  }
  endCommand();
  return effect;
}
