/**
 * Work-log presentation of Ryco's Computer Use tools. Providers spell the same
 * call differently (`mcp__ryco__computer_click` in Claude, server
 * `ryco_agent_control` plus tool `computer_click` in Codex, `ryco-computer_click`
 * in ACP, `ryco_<session>_computer_click` in OpenCode); every spelling resolves
 * here to one action, shown as plain words with running and settled forms
 * ("Clicking" / "Clicked") and a short target from the arguments, so a chat
 * reads `Clicked "Senden"` instead of the raw MCP name.
 * Pure and dependency-free: chat rows import it.
 */

/** A tool call as the work log carries it. */
export interface ComputerToolIdentity {
  /** The tool name, possibly prefixed with its server (`mcp__ryco__computer_click`). */
  readonly name: string;
  /** The MCP server, when the provider reports it apart from the tool. */
  readonly server?: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

export type ComputerToolStatus = "running" | "completed" | "failed";

export interface ComputerToolPresentation {
  /** "Clicked", "Opened", "Looked at the screen". */
  readonly verb: string;
  /** `"Senden"`, `Spark`, `amazon.de/…`; null when the verb says it all. */
  readonly target: string | null;
  /** Verb and target as one phrase. */
  readonly label: string;
}

/** Base (shown on failure), running and settled forms; then the object used when no target fits. */
type Verb = readonly [base: string, running: string, done: string, object?: string];

const look = (object: string): Verb => ["Look at", "Looking at", "Looked at", object];

const VERBS: Readonly<Record<string, Verb>> = {
  click: ["Click", "Clicking", "Clicked"],
  type_text: ["Type", "Typing", "Typed", "text"],
  set_value: ["Fill in", "Filling in", "Filled in", "a field"],
  paste: ["Paste", "Pasting", "Pasted", "text"],
  press_key: ["Press", "Pressing", "Pressed", "a key"],
  scroll: ["Scroll", "Scrolling", "Scrolled"],
  launch_app: ["Open", "Opening", "Opened", "an app"],
  activate_window: ["Bring", "Bringing", "Brought", "a window to the front"],
  invoke_menu: ["Choose", "Choosing", "Chose", "a menu item"],
  run: ["Run", "Running", "Ran", "several steps"],
  wait: ["Wait", "Waiting", "Waited"],
  get_state: look("the screen"),
  screenshot: ["Take", "Taking", "Took", "a screenshot"],
  list_windows: look("open windows"),
  list_apps: look("open apps"),
  get_screen_size: look("the screen size"),
  verify_state: ["Check", "Checking", "Checked", "the screen"],
  inspect: look("the screen in detail"),
  help: ["Read", "Reading", "Read", "Computer Use help"],
  browser_prepare: ["Prepare", "Preparing", "Prepared", "a browser"],
  browser_state: look("the page"),
  browser_navigate: ["Open", "Opening", "Opened", "a page"],
  browser_click: ["Click", "Clicking", "Clicked", "on the page"],
  browser_type: ["Type", "Typing", "Typed", "on the page"],
  browser_press: ["Press", "Pressing", "Pressed", "Enter"],
  browser_pointer: ["Point", "Pointing", "Pointed", "on the page"],
  browser_dialog: ["Answer", "Answering", "Answered", "a page dialog"],
  browser_download: ["Download", "Downloading", "Downloaded", "a file"],
  browser_upload: ["Upload", "Uploading", "Uploaded", "a file"],
  // A Computer Use call whose action is not known here.
  use: ["Use", "Using", "Used", "the computer"],
};

const ACTIONS = Object.keys(VERBS).filter((action) => action !== "use");

// `<server>__computer_x`, `<server>.computer_x`, `<server>-computer_x`, `<server>_computer_x`,
// or the bare `computer_x`. Only Ryco's server (or none) may claim the name.
const PREFIXED_TOOL = /^(?:(.*?)(?:__|\s*[.:/·]\s*|[-_]|\s+))?computer_([a-z_]+)$/;

const normalize = (value: string) => value.trim().toLowerCase();

const isRycoServer = (server: string) => /^(?:mcp_+)?ryco(?:[-_]|$)/.test(server);

/** Which Computer Use action a call names, if any. */
export function resolveComputerTool(identity: ComputerToolIdentity): string | null {
  const name = normalize(identity.name);
  let server: string | null;
  let action: string | undefined;
  if (identity.server !== undefined) {
    server = normalize(identity.server);
    action = /^computer_([a-z_]+)$/.exec(name)?.[1];
  } else {
    const match = PREFIXED_TOOL.exec(name);
    server = match?.[1] || null;
    action = match?.[2];
  }
  if (action === undefined) return null;
  if (server !== null && !isRycoServer(server)) return null;
  return ACTIONS.includes(action) ? action : "use";
}

// --- targets ---------------------------------------------------------------

const TARGET_MAX_CHARS = 40;

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= TARGET_MAX_CHARS ? flat : `${flat.slice(0, TARGET_MAX_CHARS - 1)}…`;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const quoted = (value: unknown): string | null => {
  const string = text(value);
  return string === null ? null : `"${clip(string)}"`;
};

/** A URL without its scheme and `www.`, for reading. */
function page(value: unknown): string | null {
  const url = text(value);
  if (url === null) return null;
  return clip(url.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, ""));
}

function keyName(value: unknown): string | null {
  const key = text(value);
  if (key === null) return null;
  return key
    .split("+")
    .map((part) => {
      const lower = part.trim().toLowerCase();
      if (lower === "meta" || lower === "cmd" || lower === "command") return "⌘";
      if (lower === "shift") return "⇧";
      if (lower === "alt" || lower === "option") return "⌥";
      if (lower === "ctrl" || lower === "control") return "⌃";
      return lower.length === 1
        ? lower.toUpperCase()
        : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

function actionTarget(action: string, input: Readonly<Record<string, unknown>>): string | null {
  switch (action) {
    case "click":
    case "set_value":
    case "scroll":
      return quoted(input.label);
    case "type_text":
    case "browser_type":
    case "paste":
      return quoted(input.text);
    case "press_key":
      return keyName(input.key);
    case "launch_app":
      return text(input.app) ? clip(String(input.app)) : null;
    case "invoke_menu":
      return Array.isArray(input.path)
        ? clip(input.path.filter((part) => typeof part === "string").join(" › ")) || null
        : null;
    case "run":
      return Array.isArray(input.steps)
        ? `${input.steps.length} ${input.steps.length === 1 ? "step" : "steps"}`
        : null;
    case "wait":
      return quoted(input.label);
    case "browser_navigate":
      return page(input.url);
    default:
      return null;
  }
}

/**
 * The verb and target of a Computer Use call, or null when the call is not one.
 * A failed call takes the base form ("Click"), so it never reads as done.
 */
export function computerToolPresentation(
  identity: ComputerToolIdentity,
  status: ComputerToolStatus,
): ComputerToolPresentation | null {
  const action = resolveComputerTool(identity);
  if (action === null) return null;
  const forms = VERBS[action]!;
  const form = status === "running" ? 1 : status === "completed" ? 2 : 0;
  const target = actionTarget(action, identity.input ?? {});
  const object = forms[3];
  const verb = target === null && object ? `${forms[form]} ${object}` : forms[form]!;
  return { verb, target, label: target ? `${verb} ${target}` : verb };
}
