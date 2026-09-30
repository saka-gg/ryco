/**
 * Terminal presentation for `ryco setup`: status lines, headings, and the
 * runner-aware commands its hints suggest. Colour only on a real terminal, and
 * never when NO_COLOR is set or TERM is dumb.
 */
import { isEphemeralCliInstall } from "../service/nodeService.ts";

const colorEnabled = () =>
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

const paint = (code: string) => (text: string) =>
  colorEnabled() ? `\u001b[${code}m${text}\u001b[0m` : text;

export const bold = paint("1");
export const dim = paint("2");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

export type StatusTone = "ok" | "warn" | "off";

/** `✓ text`, `! text`, or `– text`, indented under a heading. */
export function statusLine(tone: StatusTone, text: string): string {
  const mark = tone === "ok" ? green("✓") : tone === "warn" ? yellow("!") : dim("–");
  return `  ${mark} ${text}`;
}

export const heading = (text: string) => `${bold(text)}`;

/** Whether prompts can run: both ends of the conversation are a terminal. */
export const isInteractiveTerminal = () =>
  process.stdin.isTTY === true && process.stdout.isTTY === true;

/**
 * How the user ran this CLI, so every hint is a command they can paste: `ryco`
 * for an installed CLI, `npx ryco-cli` for one launched through npx or bunx.
 */
export function cliCommandPrefix(scriptPath: string | undefined = process.argv[1]): string {
  if (scriptPath === undefined) return "ryco";
  return isEphemeralCliInstall(scriptPath) ? "npx ryco-cli" : "ryco";
}
