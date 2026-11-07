/**
 * Pure grading for the device routing eval: no SDK, no server, no I/O, so
 * `grading.test.ts` checks it offline against recorded fake transcripts.
 *
 * What it grades is routing and recovery discipline, not whether the UI task
 * succeeded: device UI goes through Ryco's device tools (any tool whose name
 * contains `ryco_device`), never through simctl/idb/adb/AppleScript, failures
 * stop after two attempts, and taps use snapshot refs or labels.
 *
 * The raw-UI patterns and the "at most two failed device attempts" rule are
 * adapted from t3code's `evals/mcp-tool-use/device-grading.ts` (MIT).
 */

/** One tool call as the runner recorded it. */
export interface RecordedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** Present when a native subagent (the Agent tool) made the call. */
  readonly agentId?: string | undefined;
  /** The tool's result text, as the model saw it. */
  readonly result?: string | undefined;
  readonly isError?: boolean | undefined;
}

export interface Transcript {
  readonly calls: readonly RecordedToolCall[];
  /** The text of the last assistant message (the SDK result's `result`). */
  readonly finalText: string;
  /** Every assistant text block, main thread and subagents, in order. */
  readonly texts: readonly string[];
  /** Elements the fake device registered a tap on, as `screen/label#index`. */
  readonly tapped?: readonly string[] | undefined;
}

export interface CaseExpectation {
  /** No shell command may drive device UI (default true). */
  readonly noRawUi?: boolean;
  /** At least one device tool call. */
  readonly deviceUsed?: boolean;
  /** No device tool call at all (control cases). */
  readonly noDevice?: boolean;
  /** Each action must appear among successful-or-not device calls, e.g. ["tap"]. */
  readonly deviceActions?: readonly string[];
  /** Failed device input calls (tap, type, swipe, ...) allowed in the whole case. */
  readonly maxFailedDeviceInputs?: number;
  /** Device calls of any kind allowed in the whole case. */
  readonly maxDeviceCalls?: number;
  /** Every tap names its target by ref or label, never bare x/y. */
  readonly tapsByRefOrLabel?: boolean;
  /** Every tap names its target by ref (`@eN`). */
  readonly tapsByRef?: boolean;
  /** A device input call made by a native subagent. */
  readonly subagentDeviceInput?: boolean;
  /** Regexes some Bash command must match (case-insensitive). */
  readonly shellMust?: readonly string[];
  /** Regexes the final text must match (case-insensitive). */
  readonly finalTextMust?: readonly string[];
  /** Regexes no Bash command may match (case-insensitive). */
  readonly shellMustNot?: readonly string[];
  /** Elements (`screen/label#index`) the device must have received a tap on. */
  readonly mustTap?: readonly string[];
  /** Elements the device must never have received a tap on. */
  readonly mustNotTap?: readonly string[];
}

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string | undefined;
}

export interface Grade {
  readonly pass: boolean;
  readonly checks: readonly Check[];
}

// ── Classification ─────────────────────────────────────────────────

/** Actions that change what is on a device's screen. */
export const DEVICE_INPUT_ACTIONS = new Set([
  "tap",
  "swipe",
  "type",
  "press_button",
  "scroll_to_element",
  "launch",
  "open_url",
  "configure",
]);

/**
 * A Ryco device tool: the gateway's server (`mcp__ryco_device__*`) or Agent Control's
 * `ryco_device`. Matched as a whole name segment, so a hallucinated tool that merely contains the
 * text (`mcp__x__ryco_device_read_placeholder`) does not count.
 */
export function isDeviceTool(name: string): boolean {
  return /(?:^|__)ryco_device(?:__|$)/u.test(name);
}

/**
 * The action a device tool call performs, for either catalogue shape: the
 * two-tool one (`device` / `device_read` with an `action` argument) or the
 * per-action one (`device_tap`, `device_list`, ...).
 */
export function deviceAction(call: Pick<RecordedToolCall, "name" | "input">): string | null {
  if (!isDeviceTool(call.name)) return null;
  const tool = call.name.split("__").at(-1) ?? call.name;
  const action = call.input.action;
  if (typeof action === "string" && action.length > 0) return action;
  if (tool.startsWith("device_") && tool !== "device_read") return tool.slice("device_".length);
  // `ryco_device` (Agent Control) and the two-tool catalogue without an action.
  return tool;
}

/**
 * Shell commands that drive simulator or emulator UI (or bypass Ryco's device
 * ownership: boot, launch, URLs) instead of using the device tools. Builds,
 * `simctl install`, `simctl list`, `simctl spawn ... log` and `adb logcat` /
 * `adb install` stay allowed.
 */
const RAW_UI_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "simctl ui/io/launch",
    /\bsimctl\s+(?:io|ui|launch|terminate|openurl|boot|shutdown|erase|privacy|location|push|status_bar|keychain|addmedia|pbcopy|pbpaste)\b/iu,
  ],
  ["idb", /(?:^|[\s;&|(`/])idb\s+\S/iu],
  [
    "adb input",
    /\badb\b[^\n;|&]*\b(?:input|screencap|screenrecord|am\s+start|monkey|uiautomator|exec-out)\b/iu,
  ],
  ["AppleScript", /\bosascript\b|\btell\s+application\s+["']?(?:Simulator|System Events)/iu],
  [
    "open Simulator.app",
    /\bopen\s+(?:-\w+\s+)*(?:-a\s+)?["']?(?:[^\s"']*\/)?Simulator(?:\.app)?\b/iu,
  ],
  ["cliclick/screencapture", /\b(?:cliclick|screencapture)\b/iu],
  ["expo/react-native run", /\b(?:expo\s+run:ios|react-native\s+run-ios|run-android)\b/iu],
  ["xcrun ui scripting", /\bxcrun\s+(?:xctrace|simctl\s+io)\b/iu],
];

/** Why a command counts as raw device UI, or null when it does not. */
export function rawUiReason(command: string): string | null {
  for (const [reason, pattern] of RAW_UI_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

export function bashCommands(transcript: Transcript): string[] {
  return transcript.calls
    .filter((call) => call.name === "Bash" && typeof call.input.command === "string")
    .map((call) => call.input.command as string);
}

const hasString = (input: Record<string, unknown>, key: string) =>
  typeof input[key] === "string" && (input[key] as string).trim().length > 0;

// ── Grading ────────────────────────────────────────────────────────

export function gradeTranscript(expect: CaseExpectation, transcript: Transcript): Grade {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) =>
    checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });

  const deviceCalls = transcript.calls.filter((call) => isDeviceTool(call.name));
  const actions = deviceCalls.map((call) => deviceAction(call));
  const inputCalls = deviceCalls.filter((call) =>
    DEVICE_INPUT_ACTIONS.has(deviceAction(call) ?? ""),
  );
  const commands = bashCommands(transcript);

  if (expect.noRawUi !== false) {
    const raw = commands
      .map((command) => ({ command, reason: rawUiReason(command) }))
      .filter((entry) => entry.reason !== null);
    add(
      "no raw device UI in shell",
      raw.length === 0,
      raw.length === 0
        ? undefined
        : raw.map((entry) => `${entry.reason}: ${clip(entry.command)}`).join(" | "),
    );
  }
  if (expect.deviceUsed === true) {
    add("used a device tool", deviceCalls.length > 0, `${deviceCalls.length} device calls`);
  }
  if (expect.noDevice === true) {
    add(
      "no device tool",
      deviceCalls.length === 0,
      deviceCalls.length === 0 ? undefined : actions.join(", "),
    );
  }
  for (const action of expect.deviceActions ?? []) {
    add(
      `device action ${action}`,
      actions.includes(action),
      `actions: ${actions.join(", ") || "none"}`,
    );
  }
  if (expect.maxFailedDeviceInputs !== undefined) {
    const failed = inputCalls.filter((call) => call.isError === true).length;
    add(
      `at most ${expect.maxFailedDeviceInputs} failed device inputs`,
      failed <= expect.maxFailedDeviceInputs,
      `${failed} failed`,
    );
  }
  if (expect.maxDeviceCalls !== undefined) {
    add(
      `at most ${expect.maxDeviceCalls} device calls`,
      deviceCalls.length <= expect.maxDeviceCalls,
      `${deviceCalls.length} calls`,
    );
  }
  const taps = deviceCalls.filter((call) => deviceAction(call) === "tap");
  if (expect.tapsByRefOrLabel === true || expect.tapsByRef === true) {
    const byRef = expect.tapsByRef === true;
    const offending = taps.filter((call) =>
      byRef
        ? !hasString(call.input, "ref")
        : !hasString(call.input, "ref") && !hasString(call.input, "label"),
    );
    add(
      byRef ? "taps use refs" : "taps use refs or labels",
      taps.length > 0 && offending.length === 0,
      taps.length === 0
        ? "no tap"
        : offending.length === 0
          ? undefined
          : offending.map((call) => clip(JSON.stringify(call.input))).join(" | "),
    );
  }
  if (expect.subagentDeviceInput === true) {
    const fromSubagent = inputCalls.filter((call) => call.agentId !== undefined);
    add(
      "subagent drove the device with device tools",
      fromSubagent.length > 0,
      `${fromSubagent.length} subagent device inputs`,
    );
  }
  for (const pattern of expect.shellMust ?? []) {
    const regex = new RegExp(pattern, "iu");
    add(
      `shell ran /${pattern}/`,
      commands.some((command) => regex.test(command)),
    );
  }
  for (const pattern of expect.shellMustNot ?? []) {
    const regex = new RegExp(pattern, "iu");
    const hit = commands.find((command) => regex.test(command));
    add(
      `shell never ran /${pattern}/`,
      hit === undefined,
      hit === undefined ? undefined : clip(hit),
    );
  }
  const tapped = transcript.tapped ?? [];
  for (const element of expect.mustTap ?? []) {
    add(
      `device tapped ${element}`,
      tapped.includes(element),
      `tapped: ${tapped.join(", ") || "nothing"}`,
    );
  }
  for (const element of expect.mustNotTap ?? []) {
    add(`device never tapped ${element}`, !tapped.includes(element));
  }
  for (const pattern of expect.finalTextMust ?? []) {
    const regex = new RegExp(pattern, "iu");
    add(
      `final text matches /${pattern}/`,
      regex.test(transcript.finalText),
      regex.test(transcript.finalText) ? undefined : clip(transcript.finalText, 160),
    );
  }
  return { pass: checks.every((check) => check.pass), checks };
}

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
