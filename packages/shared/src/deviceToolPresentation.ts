/**
 * Work-log presentation of Ryco's device tools (iOS Simulator / Android
 * Emulator). Three generations of names reach the client, each spelled
 * differently by every provider (`mcp__ryco_device__device` in Claude, server
 * `ryco_device` plus tool `device` in Codex, `ryco-device` in ACP,
 * `ryco_device_<session>_device` in OpenCode):
 *
 * - the device server's `device` / `device_read` with an `action` argument,
 * - its older one-tool-per-action names (`device_tap`, `device_list`, ...),
 * - Agent Control's `ryco_device`, its read tools and `ryco_propose_device_*`.
 *
 * All of them resolve here to one action, shown as a verb with running and
 * settled forms ("Tapping" / "Tapped") and a short target from the arguments.
 * Pure and dependency-free: chat rows import it.
 */

/** A device tool call as the work log carries it. */
export interface DeviceToolIdentity {
  /** The tool name, possibly prefixed with its server (`mcp__ryco_device__device`). */
  readonly name: string;
  /** The MCP server, when the provider reports it apart from the tool. */
  readonly server?: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

export type DeviceToolStatus = "running" | "completed" | "failed";

export interface DeviceToolPresentation {
  /** "Tapped", "Waited for", "Took a screenshot", "Requested device boot". */
  readonly verb: string;
  /** `@e5 "Sign in"`, `"hello"`, `at 120, 340`; null when the verb says it all. */
  readonly target: string | null;
  /** Verb and target as one phrase. */
  readonly label: string;
}

/** Base, running and settled forms; then a preposition before a target, or the object without one. */
type Verb = readonly [
  base: string,
  running: string,
  done: string,
  prep?: string | undefined,
  object?: string,
];

const read = (object: string): Verb => ["Read", "Reading", "Read", undefined, object];

const VERBS: Readonly<Record<string, Verb>> = {
  tap: ["Tap", "Tapping", "Tapped"],
  swipe: ["Swipe", "Swiping", "Swiped"],
  type: ["Type", "Typing", "Typed"],
  press_button: ["Press", "Pressing", "Pressed", undefined, "a button"],
  scroll_to_element: ["Scroll", "Scrolling", "Scrolled", "to"],
  wait: ["Wait", "Waiting", "Waited", "for"],
  launch: ["Launch", "Launching", "Launched", undefined, "an app"],
  open_url: ["Open", "Opening", "Opened", undefined, "a URL"],
  boot: ["Boot", "Booting", "Booted", undefined, "the device"],
  install: ["Install", "Installing", "Installed", undefined, "an app"],
  configure: ["Configure", "Configuring", "Configured", undefined, "the device"],
  list: ["List", "Listing", "Listed", undefined, "devices"],
  screenshot: ["Take", "Taking", "Took", undefined, "a screenshot"],
  describe_ui: read("the screen"),
  logs: read("device logs"),
  state: read("device state"),
  // `device` / `device_read` whose arguments did not reach the client.
  use: ["Use", "Using", "Used", undefined, "the device"],
  read: read("the device"),
};

/** Actions a device tool performs; `state` is Agent Control's alone, `use` and `read` are fallbacks. */
const DEVICE_ACTIONS = Object.keys(VERBS).filter(
  (action) => action !== "state" && action !== "use" && action !== "read",
);

/** What a `ryco_propose_device_*` call asks the user to approve. */
const PROPOSALS: Readonly<Record<string, string>> = {
  boot: "device boot",
  attach: "device attach",
  detach: "device detach",
  install: "app install",
  launch: "app launch",
  open_url: "URL open",
  input: "device input",
  recording: "recording",
  shutdown: "device shutdown",
};

/** Agent Control tools with a fixed action; `ryco_device` reads it from its arguments. */
const AGENT_CONTROL_TOOLS: Readonly<Record<string, string>> = {
  ryco_device: "use",
  ryco_list_devices: "list",
  ryco_read_device_screenshot: "screenshot",
  ryco_describe_device_ui: "describe_ui",
  ryco_read_device_state: "state",
};

const PROPOSAL_PREFIX = "ryco_propose_device_";

const KNOWN_TOOLS = [
  "device",
  "device_read",
  ...DEVICE_ACTIONS.map((action) => `device_${action}`),
  ...Object.keys(AGENT_CONTROL_TOOLS),
  ...Object.keys(PROPOSALS).map((action) => PROPOSAL_PREFIX + action),
];

// `<server>__<tool>`, `<server>.<tool>`, `<server>: <tool>`, `<server>_<tool>`; the server is
// matched lazily against the exact tool names, so separators inside it still split right.
const PREFIXED_TOOL = new RegExp(
  `^(?:(.*?)(?:__|\\s*[.:/·]\\s*|_|\\s+))?(${KNOWN_TOOLS.join("|")})$`,
);

const normalize = (value: string) => value.trim().toLowerCase().replaceAll("-", "_");

const isDeviceServer = (server: string) => /^(?:mcp_+)?ryco_device(?:_|$)/.test(server);
const isRycoServer = (server: string) => /^(?:mcp_+)?ryco(?:_|$)/.test(server);

interface ResolvedDeviceTool {
  readonly action: string;
  readonly proposal: boolean;
}

function resolveTool(server: string | null, tool: string): ResolvedDeviceTool | null {
  if (tool.startsWith("ryco_")) {
    if (server !== null && !isRycoServer(server)) return null;
    if (tool.startsWith(PROPOSAL_PREFIX)) {
      const action = tool.slice(PROPOSAL_PREFIX.length);
      return action in PROPOSALS ? { action, proposal: true } : null;
    }
    const action = AGENT_CONTROL_TOOLS[tool];
    return action ? { action, proposal: false } : null;
  }
  // A bare `device` is too common a name to claim without Ryco's server in front of it.
  if (server === null ? tool === "device" : !isDeviceServer(server)) return null;
  if (tool === "device") return { action: "use", proposal: false };
  if (tool === "device_read") return { action: "read", proposal: false };
  const action = tool.slice("device_".length);
  return DEVICE_ACTIONS.includes(action) ? { action, proposal: false } : null;
}

/** Which device tool a call names, if any, with its action read from the arguments. */
export function resolveDeviceTool(identity: DeviceToolIdentity): ResolvedDeviceTool | null {
  const name = normalize(identity.name);
  let resolved: ResolvedDeviceTool | null;
  if (identity.server !== undefined) {
    resolved = KNOWN_TOOLS.includes(name) ? resolveTool(normalize(identity.server), name) : null;
  } else {
    const match = PREFIXED_TOOL.exec(name);
    resolved = match ? resolveTool(match[1] ?? null, match[2]!) : null;
  }
  if (resolved === null || resolved.proposal) return resolved;
  if (resolved.action === "use" || resolved.action === "read") {
    const raw = identity.input?.action;
    const action = typeof raw === "string" ? normalize(raw) : "";
    const known = action === "describe" ? "describe_ui" : action;
    if (DEVICE_ACTIONS.includes(known)) return { action: known, proposal: false };
  }
  return resolved;
}

// --- targets ---------------------------------------------------------------

const TARGET_MAX_CHARS = 40;

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= TARGET_MAX_CHARS ? flat : `${flat.slice(0, TARGET_MAX_CHARS - 1)}…`;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

const quoted = (value: unknown): string | null => {
  const string = text(value);
  return string === null ? null : `"${clip(string)}"`;
};

function point(x: unknown, y: unknown): string | null {
  const px = num(x);
  const py = num(y);
  return px === null || py === null ? null : `${px}, ${py}`;
}

/** `@e5 "Sign in"`, `"Sign in"`, or the role alone. */
function element(input: Readonly<Record<string, unknown>>): string | null {
  const ref = text(input.ref)?.trim() ?? null;
  const label = quoted(input.label);
  if (ref !== null) return label === null ? ref : `${ref} ${label}`;
  return label ?? text(input.role)?.trim() ?? null;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const words = (value: string) => {
  const spaced = value.replaceAll(/[-_]/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

function settingTarget(setting: Readonly<Record<string, unknown>>): string | null {
  const type = text(setting.type);
  const value = text(setting.value);
  switch (type) {
    case "appearance":
      return value ? `${value} appearance` : "appearance";
    case "text-size":
      return value ? `text size ${words(value).toLowerCase()}` : "text size";
    case "location": {
      const at = point(setting.latitude, setting.longitude);
      return at ? `location ${at}` : "location";
    }
    case "clear-location":
      return "location (cleared)";
    case "permission": {
      const service = text(setting.service);
      return service ? `${service} permission` : "a permission";
    }
    case "push":
      return "a push notification";
    case "preset":
      return value ? `${words(value).toLowerCase()} preset` : "a preset";
    case "orientation":
      return value ? `${words(value).toLowerCase()} orientation` : "orientation";
    case "network":
      return value ? `network ${value}` : "network";
    default:
      return type;
  }
}

function basename(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.findLast((segment) => segment.length > 0) ?? path;
}

function actionTarget(action: string, input: Readonly<Record<string, unknown>>): string | null {
  switch (action) {
    case "tap":
      return element(input) ?? (point(input.x, input.y) ? `at ${point(input.x, input.y)}` : null);
    case "type":
      return quoted(input.text);
    case "swipe": {
      const from = point(input.fromX, input.fromY);
      const to = point(input.toX, input.toY);
      return from && to ? `from ${from} to ${to}` : element(input);
    }
    case "press_button": {
      const button = text(input.button);
      return button ? words(button) : null;
    }
    case "scroll_to_element":
      return element(input);
    case "wait": {
      const target = element(input);
      if (target === null) return input.gone === true ? null : "the screen to settle";
      return input.gone === true ? `${target} to disappear` : target;
    }
    case "launch":
      return text(input.bundleId) ? clip(String(input.bundleId)) : null;
    case "open_url":
      return text(input.url) ? clip(String(input.url)) : null;
    case "install":
      return text(input.appPath) ? clip(basename(String(input.appPath))) : null;
    case "configure": {
      const setting = asRecord(input.setting);
      return setting ? settingTarget(setting) : null;
    }
    default:
      return null;
  }
}

/** The input a `ryco_propose_device_input` asks for: "a tap" at a point, "a Home button press". */
function proposedInput(
  input: Readonly<Record<string, unknown>>,
): readonly [noun: string, target: string | null] | null {
  const step = asRecord(input.action);
  if (step === null) return null;
  const kind = step.kind;
  switch (kind) {
    case "tap":
    case "swipe":
      return [`a ${kind}`, actionTarget(kind, step)];
    case "press-button": {
      const button = text(step.button);
      return [button ? `a ${words(button)} button press` : "a button press", null];
    }
    default:
      return null;
  }
}

/** What a proposal asks for: its noun, and the app, URL, input or recording direction it names. */
function proposal(
  action: string,
  input: Readonly<Record<string, unknown>>,
): readonly [noun: string, target: string | null] {
  if (action === "input") return proposedInput(input) ?? [PROPOSALS.input!, null];
  if (action === "recording") return [PROPOSALS.recording!, text(input.action)];
  return [PROPOSALS[action]!, actionTarget(action, input)];
}

/**
 * The verb and target of a device tool call, or null when the call is not one.
 * A failed call takes the base form ("Tap"), so it never reads as done.
 */
export function deviceToolPresentation(
  identity: DeviceToolIdentity,
  status: DeviceToolStatus,
): DeviceToolPresentation | null {
  const resolved = resolveDeviceTool(identity);
  if (resolved === null) return null;
  const input = identity.input ?? {};
  const form = status === "running" ? 1 : status === "completed" ? 2 : 0;
  if (resolved.proposal) {
    const [noun, target] = proposal(resolved.action, input);
    const verb = `${["Request", "Requesting", "Requested"][form]} ${noun}`;
    return { verb, target, label: target ? `${verb} ${target}` : verb };
  }
  const forms = VERBS[resolved.action]!;
  const [, , , prep, object] = forms;
  const target = actionTarget(resolved.action, input);
  const verb =
    target === null
      ? [forms[form], object].filter(Boolean).join(" ")
      : [forms[form], prep].filter(Boolean).join(" ");
  return { verb, target, label: target ? `${verb} ${target}` : verb };
}
