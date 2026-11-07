/**
 * The shell simulator: what a Bash call in an eval case gets instead of
 * running. Pure, so `shell.test.ts` pins that nothing but plain reads inside
 * the temp repo ever really runs.
 *
 * Plain reads (cat, ls, grep, ...) inside the repo run for real; known build
 * and install commands get canned success; everything else, raw device UI
 * included, "succeeds" with no output. The runner swaps the command for a
 * harmless `printf` of the simulated output.
 */
import type { ShellMock } from "./cases.ts";

export interface ShellRecord {
  readonly command: string;
  readonly mode: "read-only" | "mock" | "default";
  readonly output: string;
  readonly exitCode: number;
}

const DEFAULT_SHELL_MOCKS: readonly ShellMock[] = [
  { match: "^git (status|diff|log)\\b", output: "" },
  {
    match: "\\bxcodebuild\\b(?![^\\n]*-(?:list|showBuildSettings|version))[^\\n]*\\bbuild\\b",
    output:
      "Build settings from command line:\n    SDKROOT = iphonesimulator26.0\n\n** BUILD SUCCEEDED **\n\nApp: build/Build/Products/Debug-iphonesimulator/Acme.app\n",
  },
  { match: "\\bxcodebuild\\b[^\\n]*-list", output: "Schemes:\n    Acme\n" },
  { match: "\\bsimctl\\s+install\\b", output: "" },
  {
    match: "\\bsimctl\\s+list\\b",
    output:
      "== Devices ==\n-- iOS 26.0 --\n    iPhone 17 Pro (FAKE-0001) (Booted)\n    iPad Pro 13-inch (FAKE-0002) (Shutdown)\n",
  },
];

/**
 * Reads that may really run in the temp repo: every segment of a `&&`, `||`,
 * `;` or `|` chain is one of these, with no substitution, redirection, home or
 * parent paths, and absolute paths only inside the repo.
 */
const READ_ONLY_SEGMENT =
  /^(?:cat|ls|head|tail|grep|rg|find|wc|pwd|tree|file|stat|sed -n|echo|printf)\b/u;
const UNSAFE = /[`<>\\]|\$\(|\.\.|~|\s-(?:exec|execdir|delete|ok|fprint)\b|\s-i\b/u;

function isReadOnly(command: string, cwd: string): boolean {
  if (UNSAFE.test(command)) return false;
  const segments = command.split(/&&|\|\||[;|\n]/u).map((segment) => segment.trim());
  if (!segments.every((segment) => segment.length === 0 || READ_ONLY_SEGMENT.test(segment)))
    return false;
  const absolute = command.match(/(?:^|[\s='"])\/[^\s'"]*/gu) ?? [];
  return absolute.every((match) => match.replace(/^[\s='"]/u, "").startsWith(cwd));
}

export function simulateShell(
  command: string,
  cwd: string,
  mocks: readonly ShellMock[],
): ShellRecord {
  const trimmed = command.trim();
  if (isReadOnly(trimmed, cwd)) return { command, mode: "read-only", output: "", exitCode: 0 };
  for (const mock of [...mocks, ...DEFAULT_SHELL_MOCKS]) {
    if (new RegExp(mock.match, "u").test(trimmed)) {
      return { command, mode: "mock", output: mock.output, exitCode: mock.exitCode ?? 0 };
    }
  }
  return { command, mode: "default", output: "", exitCode: 0 };
}

/** The harmless command that prints a simulated result in place of the real one. */
export function simulatedCommand(record: ShellRecord): string {
  const encoded = Buffer.from(record.output, "utf8").toString("base64");
  const print = record.output.length > 0 ? `printf '%s' '${encoded}' | base64 --decode` : "true";
  return record.exitCode === 0 ? print : `${print}; (exit ${record.exitCode})`;
}
