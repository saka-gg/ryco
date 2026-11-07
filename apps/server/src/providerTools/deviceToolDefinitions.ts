/**
 * The device tool catalogue the provider gateway advertises in `tools/list`,
 * and the per-action argument specs it is built from (also the source of
 * Agent Control's `ryco_device` schema), with the bounds the descriptors
 * advertise and `deviceToolActions.ts` enforces.
 *
 * Two tools carry every action: `device_read` (read-only: list, screenshot,
 * describe_ui, wait, logs) and `device` (everything that changes a device,
 * and the reads too). Fifteen tools cost every session ~12 kB of schema;
 * two flat ones cost a fraction, on every provider, and the read-only split
 * keeps providers that auto-approve read-only tools from asking about reads.
 *
 * Split from `deviceToolGateway.ts` so it loads with the first `tools/list`
 * or tool call: the gateway starts with every server, and only a session that
 * lists or drives device tools needs the catalogue.
 *
 * @module providerTools/deviceToolDefinitions
 */
import {
  DEVICE_SCROLL_MAX_SWIPES,
  DEVICE_SCROLL_MIN_SWIPES,
  DEVICE_SWIPE_DURATION_MAX_MS,
  DEVICE_SWIPE_DURATION_MIN_MS,
  DeviceTestingPermission,
  DeviceTestingTextSize,
  type DeviceHardwareButton,
  type DeviceTestingAction,
} from "@ryco/contracts";

import type { DeviceToolName } from "./deviceToolGateway.ts";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const UDID = { type: "string", maxLength: 128, description: "Device udid from list." } as const;
export const DEVICE_TOOL_BUTTONS: readonly DeviceHardwareButton[] = [
  "home",
  "back",
  "recents",
  "lock",
  "volume-up",
  "volume-down",
];
const OBSERVE = {
  type: "boolean",
  description:
    "Default true: wait for the screen to settle and return it. false skips that, for bursts.",
} as const;
const SCREENSHOT = {
  type: "boolean",
  description:
    "true attaches a screenshot; false never. Default: only devices without an accessibility tree.",
} as const;
const SNAPSHOT = {
  type: "string",
  enum: ["diff", "full"],
  description:
    'Leave unset ("diff"): only what changed since your last screen, all of it after a big change. "full" re-lists every element.',
} as const;
const EVIDENCE = { observe: OBSERVE, screenshot: SCREENSHOT, snapshot: SNAPSHOT } as const;
const REF = {
  type: "string",
  maxLength: 16,
  description: "Element ref from a snapshot, e.g. @e5. Preferred over label and x/y.",
} as const;
const LABEL = { type: "string", maxLength: 512 } as const;
const ROLE = { type: "string", maxLength: 64 } as const;

/**
 * Bounds the descriptors advertise and `deviceToolActions.ts` enforces. The
 * wait bounds mirror `deviceObservation.ts` (asserted by the gateway test) so
 * the descriptors need not load it.
 */
export const DEVICE_TOOL_BOUNDS = {
  textMaxLength: 4_096,
  waitDefaultMs: 5_000,
  waitMaxMs: 30_000,
  logMaxSeconds: 3_600,
  logMaxLimit: 400,
  logContainsMaxLength: 200,
} as const;
export const DEVICE_TOOL_LOG_LEVELS = ["error", "default", "info", "debug"] as const;
const SETTING_TYPES = [
  "appearance",
  "text-size",
  "location",
  "clear-location",
  "permission",
  "push",
  "preset",
  "orientation",
  "network",
] as const satisfies readonly DeviceTestingAction["type"][];
const SETTING_VALUES = [
  ...new Set([
    "light",
    "dark",
    ...DeviceTestingTextSize.literals,
    "large-text",
    "dark-large-text",
    "standard",
    "portrait",
    "landscape-left",
    "portrait-upside-down",
    "landscape-right",
    "on",
    "off",
  ]),
];

/** One action: its internal tool name (dispatch and Agent Control), arguments and kind. */
export interface DeviceActionDefinition {
  readonly name: DeviceToolName;
  /** Read-only actions are `device_read`'s; the rest are `device`'s (which also runs reads). */
  readonly readOnly: boolean;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

const action = (
  name: DeviceToolName,
  readOnly: boolean,
  properties: Record<string, unknown>,
  required: readonly string[] = ["udid"],
): DeviceActionDefinition => ({
  name,
  readOnly,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});

const POINT = { type: "number", minimum: 0, maximum: 20_000 } as const;

export const DEVICE_ACTION_DEFINITIONS: readonly DeviceActionDefinition[] = [
  action("device_list", true, { includeShutdown: { type: "boolean" } }, []),
  action("device_boot", false, { udid: UDID }),
  action(
    "device_install",
    false,
    {
      udid: UDID,
      appPath: { type: "string", description: "Absolute path of a built .app or .apk." },
    },
    ["udid", "appPath"],
  ),
  action(
    "device_launch",
    false,
    {
      udid: UDID,
      bundleId: { type: "string" },
      arguments: { type: "array", items: { type: "string", maxLength: 1_024 }, maxItems: 64 },
      ...EVIDENCE,
    },
    ["udid", "bundleId"],
  ),
  action("device_open_url", false, { udid: UDID, url: { type: "string" }, ...EVIDENCE }, [
    "udid",
    "url",
  ]),
  action("device_tap", false, {
    udid: UDID,
    ref: REF,
    label: LABEL,
    role: ROLE,
    x: POINT,
    y: POINT,
    ...EVIDENCE,
  }),
  action(
    "device_swipe",
    false,
    {
      udid: UDID,
      fromX: POINT,
      fromY: POINT,
      toX: POINT,
      toY: POINT,
      durationMs: {
        type: "integer",
        minimum: DEVICE_SWIPE_DURATION_MIN_MS,
        maximum: DEVICE_SWIPE_DURATION_MAX_MS,
      },
      ...EVIDENCE,
    },
    ["udid", "fromX", "fromY", "toX", "toY"],
  ),
  action(
    "device_type",
    false,
    {
      udid: UDID,
      text: { type: "string", maxLength: DEVICE_TOOL_BOUNDS.textMaxLength },
      ref: REF,
      label: LABEL,
      role: ROLE,
      ...EVIDENCE,
    },
    ["udid", "text"],
  ),
  action(
    "device_press_button",
    false,
    { udid: UDID, button: { type: "string", enum: [...DEVICE_TOOL_BUTTONS] }, ...EVIDENCE },
    ["udid", "button"],
  ),
  action("device_screenshot", true, { udid: UDID }),
  action("device_describe_ui", true, {
    udid: UDID,
    format: { type: "string", enum: ["compact", "tree"] },
  }),
  action("device_scroll_to_element", false, {
    udid: UDID,
    ref: REF,
    label: LABEL,
    role: ROLE,
    maxSwipes: {
      type: "integer",
      minimum: DEVICE_SCROLL_MIN_SWIPES,
      maximum: DEVICE_SCROLL_MAX_SWIPES,
    },
    ...EVIDENCE,
  }),
  action("device_wait", true, {
    udid: UDID,
    ref: REF,
    label: LABEL,
    role: ROLE,
    gone: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 0, maximum: DEVICE_TOOL_BOUNDS.waitMaxMs },
    screenshot: SCREENSHOT,
    snapshot: SNAPSHOT,
  }),
  action(
    "device_logs",
    true,
    {
      udid: UDID,
      bundleId: { type: "string" },
      sinceSeconds: { type: "integer", minimum: 1, maximum: DEVICE_TOOL_BOUNDS.logMaxSeconds },
      level: { type: "string", enum: [...DEVICE_TOOL_LOG_LEVELS] },
      contains: {
        type: "string",
        maxLength: DEVICE_TOOL_BOUNDS.logContainsMaxLength,
        description: "Case-insensitive text the message must contain.",
      },
      limit: { type: "integer", minimum: 1, maximum: DEVICE_TOOL_BOUNDS.logMaxLimit },
    },
    ["udid", "bundleId"],
  ),
  action(
    "device_configure",
    false,
    {
      udid: UDID,
      setting: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...SETTING_TYPES] },
          value: { type: "string", enum: SETTING_VALUES },
          latitude: { type: "number", minimum: -90, maximum: 90 },
          longitude: { type: "number", minimum: -180, maximum: 180 },
          bundleId: { type: "string" },
          service: { type: "string", enum: [...DeviceTestingPermission.literals] },
          decision: { type: "string", enum: ["grant", "revoke", "reset"] },
          payload: { type: "string", maxLength: 4_096 },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
    ["udid", "setting"],
  ),
];

/** The action name an internal tool name answers to: `device_tap` → `tap`. */
export const deviceActionName = (name: DeviceToolName): string => name.slice("device_".length);

/** The advertised tools: `device` (actions that change a device) and `device_read` (reads). */
export const DEVICE_TOOL = "device";
export const DEVICE_READ_TOOL = "device_read";
export type DeviceAdvertisedToolName = typeof DEVICE_TOOL | typeof DEVICE_READ_TOOL;

export interface DeviceToolDefinition {
  readonly name: DeviceAdvertisedToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

/** Every argument of `actions`, merged into one flat object schema (providers handle flat best). */
export function mergedActionProperties(
  actions: readonly DeviceActionDefinition[],
): Record<string, unknown> {
  return Object.assign({}, ...actions.map((definition) => definition.inputSchema.properties));
}

function actionTool(
  name: DeviceAdvertisedToolName,
  description: string,
  actions: readonly DeviceActionDefinition[],
  annotations: Record<string, unknown>,
): DeviceToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions.map((entry) => deviceActionName(entry.name)) },
        ...mergedActionProperties(actions),
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations,
  };
}

const READ_ACTIONS = DEVICE_ACTION_DEFINITIONS.filter((definition) => definition.readOnly);
const WRITE_ACTIONS = DEVICE_ACTION_DEFINITIONS.filter((definition) => !definition.readOnly);

const READ_DESCRIPTION = `Read Ryco's iOS simulators and Android emulators. Actions: list (devices and udids; call first), describe_ui (the screen as text: one line per element with its @eN ref, role, quoted label, value and (x,y) tap point; format "tree" for the raw tree), screenshot, wait (until a ref or label appears, gone:true disappears, or with neither until the screen settles; timeoutMs up to ${DEVICE_TOOL_BOUNDS.waitMaxMs}), logs (an app's log and crash reports by bundleId: unified log on iOS, logcat on Android).`;

const DEVICE_DESCRIPTION =
  "Drive Ryco's iOS simulators and Android emulators. Actions: tap (ref, label with optional role, or x,y points as the screenshot and screen text show them, upright even when the device is turned), type (text into the focused field; pass ref or label to tap the field first), swipe, press_button, scroll_to_element (ref or label), launch (bundleId), open_url, boot, install (absolute appPath of a built .app or .apk; Ryco never builds), configure (appearance, text-size, location, permission, preset; push and clear-location on iOS; orientation and network on/off on Android). Inputs wait for the screen to settle and return settled, screenChanged and the screen as text, by default only what changed since your last snapshot. Read the screen, list devices, wait and read logs with device_read.";

export const DEVICE_TOOL_DEFINITIONS: readonly DeviceToolDefinition[] = [
  actionTool(DEVICE_READ_TOOL, READ_DESCRIPTION, READ_ACTIONS, {
    title: "Read devices",
    ...READ_ONLY,
  }),
  actionTool(DEVICE_TOOL, DEVICE_DESCRIPTION, WRITE_ACTIONS, {
    title: "Drive device",
    ...WRITE,
    openWorldHint: true,
  }),
];

/** `device_read` listing only `list`: what a thread held by Agent Control sees. */
export const DEVICE_LIST_ONLY_TOOL_DEFINITIONS: readonly DeviceToolDefinition[] = [
  actionTool(
    DEVICE_READ_TOOL,
    "List Ryco's iOS simulators and Android emulators.",
    DEVICE_ACTION_DEFINITIONS.filter((definition) => definition.name === "device_list"),
    { title: "List devices", ...READ_ONLY },
  ),
];
