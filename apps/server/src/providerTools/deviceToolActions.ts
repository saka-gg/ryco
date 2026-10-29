/**
 * What each provider-gateway device tool does: argument parsing, the device
 * call, and the settled-screen evidence inputs return.
 *
 * Split from `deviceToolGateway.ts` so it loads with the first device tool
 * call: the gateway starts with every server, and this is the part only a
 * session that drives a device needs. The catalogue lives in
 * `deviceToolDefinitions.ts`; the gateway keeps the transport, the Agent
 * Control lock, and `executeDeviceTool`'s agent-activity scope around
 * `runDeviceTool`.
 *
 * Evidence, waits and the compact screen snapshot are adapted from Synara
 * commit 74e0b3654 (#1924); see THIRD_PARTY_NOTICES.md.
 *
 * @module providerTools/deviceToolActions
 */
import {
  DEVICE_SCROLL_MAX_SWIPES,
  DEVICE_SCROLL_MIN_SWIPES,
  DEVICE_SWIPE_DURATION_MAX_MS,
  DEVICE_SWIPE_DURATION_MIN_MS,
  DeviceBundleId,
  DeviceLaunchAppInput,
  DeviceTestingInput,
  DeviceTypeTextInput,
  type DeviceLaunchAppResult,
  type DeviceOpenPaneReason,
} from "@ryco/contracts";
import { Schema } from "effect";

import type { DeviceLogQuery, DeviceLogResult } from "../device/DeviceBackend.ts";
import type { DeviceManager } from "../device/DeviceManager.ts";
import {
  DEVICE_GATEWAY_IMAGE_MAX_BASE64_CHARS,
  DEVICE_LAUNCH_SETTLE_TIMEOUT_MS,
  DEVICE_WAIT_DEFAULT_MS,
  DEVICE_WAIT_MAX_MS,
  deviceActionContent,
  deviceEvidenceContent,
  evidenceScreenshotMode,
  formatUiSnapshot,
  inlineDeviceScreenshot,
  observe,
  waitFor,
  waitForSettle,
  type DeviceObservation,
  type DeviceToolContent,
} from "../device/deviceObservation.ts";
import { clippedElementText } from "../device/deviceUiSnapshot.ts";
import { planIosTestingAction } from "../device/iosTestingActions.ts";
import {
  DeviceUiTargetError,
  readTapRequest,
  type DeviceUiTargetMatch,
} from "../device/uiTreeTargeting.ts";
import {
  DEVICE_TOOL_BOUNDS,
  DEVICE_TOOL_BUTTONS,
  DEVICE_TOOL_LOG_LEVELS,
} from "./deviceToolDefinitions.ts";
import {
  DeviceAttachmentFenceError,
  DeviceToolArgumentError,
  type DeviceToolCallInput,
} from "./deviceToolGateway.ts";

type JsonRecord = Record<string, unknown>;

const LOG_DEFAULT_SECONDS = 300;
const LOG_DEFAULT_LIMIT = 100;
/** Reverse-DNS bundle ids only: they reach simctl as an argument. */
const LOG_BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/u;
/**
 * A JSON tree past this many bytes, as it travels (escaped, UTF-8, inside the
 * result's JSON), cannot ride beside its metadata in Agent Control's 512 KiB
 * response cap.
 */
const UI_TREE_MAX_BYTES = 400_000;
/** The same bound for a log read: older lines are left out until it fits. */
const LOG_RESULT_MAX_BYTES = UI_TREE_MAX_BYTES;
const LOG_FIT_NOTE =
  " Older lines were left out to fit the response; ask for fewer or filter with contains.";

/** Bytes of `value` as `jsonContent` sends it: pretty-printed, escaped inside the result's JSON, in UTF-8. */
const travelingBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(JSON.stringify(value, null, 2)), "utf8");

/** Drops the oldest log lines until the read fits the response cap (non-Latin text runs large). */
function fitLogResult(result: DeviceLogResult): DeviceLogResult {
  if (travelingBytes(result) <= LOG_RESULT_MAX_BYTES) return result;
  // The fewest dropped lines that fit: the result shrinks as lines go.
  let low = 1;
  let high = result.log.length;
  const fitted = (dropped: number): DeviceLogResult => ({
    ...result,
    log: result.log.slice(dropped),
    omitted: result.omitted + dropped,
    note: `${result.note}${LOG_FIT_NOTE}`,
  });
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (travelingBytes(fitted(middle)) <= LOG_RESULT_MAX_BYTES) high = middle;
    else low = middle + 1;
  }
  return fitted(low);
}

/** "require-attached" refusals; the first names the fix, the second who holds the device. */
export const DEVICE_NOT_ATTACHED_TEXT =
  "Device control is limited to the device attached to this thread. Attach it with ryco_propose_device_attach, or ask the user to pick it in this thread's device pane.";
export const DEVICE_SHARED_TEXT =
  "Another thread also has this device attached, and device control needs it attached to this thread only. Ask the user to detach it in the other thread's device pane; an attach request cannot take it from another thread.";

/** Why `threadId` may not drive `udid` under "require-attached", or null when it may. */
export function attachmentFenceRefusal(
  manager: Pick<DeviceManager, "exclusiveAttachment">,
  threadId: string,
  udid: string,
): string | null {
  switch (manager.exclusiveAttachment(threadId, udid)) {
    case "exclusive":
      return null;
    case "unattached":
      return DEVICE_NOT_ATTACHED_TEXT;
    case "shared":
      return DEVICE_SHARED_TEXT;
  }
}

function stringArg(args: JsonRecord, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.trim().length === 0)) {
    throw new DeviceToolArgumentError(
      `Argument ${JSON.stringify(name)} must be a${required ? " non-empty" : ""} string.`,
    );
  }
  return value;
}

/** A non-empty string when present. */
function optionalStringArg(args: JsonRecord, name: string): string | undefined {
  return args[name] === undefined ? undefined : stringArg(args, name);
}

function numberArg(args: JsonRecord, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 20_000) {
    throw new DeviceToolArgumentError(
      `Argument ${JSON.stringify(name)} must be a device point from 0 to 20000.`,
    );
  }
  return value;
}

function booleanArg(args: JsonRecord, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new DeviceToolArgumentError(`Argument ${JSON.stringify(name)} must be a boolean.`);
  }
  return value;
}

function enumArg<const T extends string>(
  args: JsonRecord,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new DeviceToolArgumentError(
      `Argument ${JSON.stringify(name)} must be one of: ${values.join(", ")}.`,
    );
  }
  return value as T;
}

function boundedInteger(
  args: JsonRecord,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DeviceToolArgumentError(
      `Argument ${JSON.stringify(name)} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value as number;
}

/** Decode with a contract schema, replacing its issue dump with one agent-facing sentence. */
function decodeArg<A>(decode: (value: unknown) => A, value: unknown, message: string): A {
  try {
    return decode(value);
  } catch {
    throw new DeviceToolArgumentError(message);
  }
}

const decodeTypedText = Schema.decodeUnknownSync(DeviceTypeTextInput.fields.text);
const decodeBundleId = Schema.decodeUnknownSync(DeviceBundleId);
const decodeLaunchArguments = Schema.decodeUnknownSync(DeviceLaunchAppInput.fields.arguments);
const decodeTestingInput = Schema.decodeUnknownSync(DeviceTestingInput);

function readSetting(udid: string, args: JsonRecord): DeviceTestingInput {
  const setting = args.setting;
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
    throw new DeviceToolArgumentError('Argument "setting" must be an object with a type.');
  }
  let input: DeviceTestingInput;
  try {
    input = decodeTestingInput({ udid, action: setting });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error))
      .replaceAll('["action"]', "setting")
      .replace(/\s+/gu, " ")
      .trim();
    throw new DeviceToolArgumentError(`Argument "setting" is not a valid setting: ${detail}.`);
  }
  // The backend's own checks past the schema (a push payload's size, JSON and
  // aps object), run here too so a malformed payload is the agent's mistake
  // to fix and never a device failure on the pane.
  try {
    planIosTestingAction(input);
  } catch (error) {
    throw new DeviceToolArgumentError(
      `Argument "setting" is not a valid setting: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return input;
}

/** The tap's shape (label or x/y, not both); a mistake there is an argument error. */
function readTap(args: JsonRecord): ReturnType<typeof readTapRequest> {
  const input = {
    ...(args.x !== undefined ? { x: numberArg(args, "x") } : {}),
    ...(args.y !== undefined ? { y: numberArg(args, "y") } : {}),
    ...(args.label !== undefined ? { label: stringArg(args, "label") } : {}),
    ...(args.role !== undefined ? { role: stringArg(args, "role") } : {}),
  };
  try {
    return readTapRequest(input);
  } catch (error) {
    if (error instanceof DeviceUiTargetError) throw new DeviceToolArgumentError(error.message);
    throw error;
  }
}

const jsonContent = (value: unknown): readonly DeviceToolContent[] => [
  { type: "text", text: JSON.stringify(value, null, 2) },
];

/**
 * Run one device tool and return its MCP content. Inputs wait for the screen
 * to settle and return it as evidence (`deviceObservation.ts`). Errors throw.
 * Called by `executeDeviceTool`, inside the manager's agent-activity scope.
 */
export async function runDeviceTool(
  input: DeviceToolCallInput,
): Promise<readonly DeviceToolContent[]> {
  const { manager, threadId, name, args, signal, timing } = input;
  const udid = () => stringArg(args, "udid")!;
  const requireAttached = input.attachment === "require-attached";
  /**
   * "require-attached": only while this thread alone has the device attached.
   * Synchronous, so nothing can detach it between this check and the input
   * that follows it.
   */
  const fence = () => {
    if (!requireAttached) return;
    const refusal = attachmentFenceRefusal(manager, threadId, udid());
    if (refusal !== null) throw new DeviceAttachmentFenceError(refusal);
  };
  /**
   * Checked before every scroll and the final tap of a label tap or scroll, which
   * run as one manager call: an aborted call (Stop, the turn ending, a timeout)
   * sends nothing more, and the fence holds at each step.
   */
  const stepGuard = () => {
    signal?.throwIfAborted();
    fence();
  };
  const surface = async (reason: DeviceOpenPaneReason = "agent-tool") => {
    if (requireAttached) manager.surfaceAttachedDeviceForAgent(threadId, udid(), reason);
    else await manager.surfaceDeviceForAgent(threadId, udid(), reason);
  };
  const observeArg = booleanArg(args, "observe");
  const screenshotArg = booleanArg(args, "screenshot");

  const maxImageBase64Chars = input.maxImageBase64Chars ?? DEVICE_GATEWAY_IMAGE_MAX_BASE64_CHARS;

  const evidence = async (
    observation: DeviceObservation,
    fields: JsonRecord,
  ): Promise<readonly DeviceToolContent[]> => {
    const content = await deviceEvidenceContent(manager, udid(), observation, fields, {
      screenshot: evidenceScreenshotMode(screenshotArg),
      maxImageBase64Chars,
    });
    signal?.throwIfAborted();
    return content;
  };

  /** `observe: false`: the action's fields, plus a screenshot only when asked for. */
  const unobserved = async (fields: JsonRecord): Promise<readonly DeviceToolContent[]> => {
    const content = await deviceActionContent(manager, udid(), fields, {
      screenshot: screenshotArg === true,
      maxImageBase64Chars,
    });
    signal?.throwIfAborted();
    return content;
  };

  /**
   * One input: settle around `action`, return the screen. The device is
   * surfaced the moment the action lands, before any settle, so the user
   * sees a launch while it happens and an input that reached the device is
   * surfaced even when the caller then goes away.
   */
  const observed = async (
    action: () => Promise<void>,
    fields: () => JsonRecord,
    options: {
      readonly settle?: "launch" | "open-url";
      readonly reason?: DeviceOpenPaneReason;
    } = {},
  ): Promise<readonly DeviceToolContent[]> => {
    const act = async () => {
      fence();
      await action();
      await surface(options.reason);
    };
    if (observeArg === false) {
      await act();
      return await unobserved(fields());
    }
    const observation = await observe(manager, udid(), act, {
      signal,
      timing,
      ...(options.settle === undefined
        ? {}
        : {
            timeoutMs: DEVICE_LAUNCH_SETTLE_TIMEOUT_MS,
            ...(options.settle === "launch" ? { awaitApp: "different" } : { awaitChange: true }),
          }),
    });
    return await evidence(observation, fields());
  };

  // Every tool but the list names a device: fenced before anything reaches it,
  // and again right before each input below.
  if (name !== "device_list") fence();
  switch (name) {
    case "device_list":
      return jsonContent(await manager.list({ includeShutdown: args.includeShutdown === true }));
    case "device_boot": {
      const result = await manager.boot(udid());
      if (result.kind === "booted" && !requireAttached) {
        await manager.ensureThreadAttached(threadId, udid()).catch(() => undefined);
      }
      return jsonContent(result);
    }
    case "device_install": {
      const appPath = stringArg(args, "appPath")!;
      fence();
      const result = await manager.install(udid(), appPath);
      await surface("agent-install");
      return jsonContent(result);
    }
    case "device_launch": {
      const bundleId = decodeArg(
        decodeBundleId,
        args.bundleId,
        'Argument "bundleId" must be a non-empty bundle id of at most 256 characters.',
      );
      const launchArguments =
        args.arguments === undefined
          ? undefined
          : decodeArg(
              decodeLaunchArguments,
              args.arguments,
              'Argument "arguments" must be an array of at most 64 strings of at most 1024 characters.',
            );
      let launched: DeviceLaunchAppResult | null = null;
      return observed(
        async () => {
          launched = await manager.launch(udid(), bundleId, launchArguments);
        },
        () => ({ ...launched! }),
        { settle: "launch", reason: "agent-launch" },
      );
    }
    case "device_open_url": {
      const url = stringArg(args, "url")!;
      return observed(
        () => manager.openUrl(udid(), url),
        () => ({ udid: udid(), opened: true }),
        { settle: "open-url" },
      );
    }
    case "device_tap": {
      const request = readTap(args);
      if (request.kind === "point") {
        return observed(
          () => manager.tap(udid(), request.x, request.y),
          () => ({ udid: udid(), x: request.x, y: request.y }),
        );
      }
      // Captured inside the action, so the evidence names what the tap hit
      // and, for a toggle, its state before the tap; the screen shows after.
      let match: DeviceUiTargetMatch | null = null;
      return observed(
        async () => {
          // Fenced, and stopped if aborted, before every scroll and the tap itself.
          match = await manager.tapElement(udid(), request.target, { guard: stepGuard });
        },
        () => {
          const tapped = match!;
          const text = clippedElementText(tapped.node);
          return {
            udid: udid(),
            x: tapped.point.x,
            y: tapped.point.y,
            element: {
              role: tapped.node.role,
              subrole: tapped.node.subrole,
              label: text.label,
              valueBeforeTap: text.value,
            },
          };
        },
      );
    }
    case "device_swipe": {
      const gesture = {
        fromX: numberArg(args, "fromX"),
        fromY: numberArg(args, "fromY"),
        toX: numberArg(args, "toX"),
        toY: numberArg(args, "toY"),
        durationMs:
          boundedInteger(
            args,
            "durationMs",
            DEVICE_SWIPE_DURATION_MIN_MS,
            DEVICE_SWIPE_DURATION_MAX_MS,
          ) ?? 300,
      };
      return observed(
        () => manager.swipe(udid(), gesture),
        () => ({ udid: udid(), ...gesture }),
      );
    }
    case "device_type": {
      const text = decodeArg(
        decodeTypedText,
        args.text,
        `Argument "text" must be a string of at most ${DEVICE_TOOL_BOUNDS.textMaxLength} characters.`,
      );
      return observed(
        () => manager.typeText(udid(), text),
        () => ({ udid: udid(), length: text.length }),
      );
    }
    case "device_press_button": {
      const button = enumArg(args, "button", DEVICE_TOOL_BUTTONS);
      if (button === undefined) {
        throw new DeviceToolArgumentError(
          `Argument "button" must be one of: ${DEVICE_TOOL_BUTTONS.join(", ")}.`,
        );
      }
      return observed(
        () => manager.pressButton(udid(), button),
        () => ({ udid: udid(), button }),
      );
    }
    case "device_screenshot": {
      const shot = await manager.screenshot(udid());
      await surface();
      const inline = await inlineDeviceScreenshot(shot, maxImageBase64Chars);
      if (inline === null) throw new Error("The screenshot is too large for this transport.");
      // width and height stay the capture's own (Android input coordinates are
      // its pixels); a scaled image names its own size and type beside them.
      const { bytesBase64: _bytes, ...metadata } = shot;
      return [
        {
          type: "text",
          text: JSON.stringify(
            inline.scaled
              ? {
                  ...metadata,
                  scaledToFitTransport: {
                    mimeType: inline.image.mimeType,
                    width: inline.width,
                    height: inline.height,
                  },
                }
              : metadata,
            null,
            2,
          ),
        },
        inline.image,
      ];
    }
    case "device_describe_ui": {
      const format = enumArg(args, "format", ["compact", "tree"] as const) ?? "compact";
      const tree = await manager.describeUi(udid());
      await surface();
      if (format === "compact") {
        return [{ type: "text", text: formatUiSnapshot(tree.root) }];
      }
      const text = JSON.stringify(tree, null, 2);
      // Measured as it travels: escaped inside the result's JSON, in UTF-8.
      if (Buffer.byteLength(JSON.stringify(text), "utf8") > UI_TREE_MAX_BYTES) {
        throw new Error('UI tree is too large; use format "compact".');
      }
      return [{ type: "text", text }];
    }
    case "device_scroll_to_element": {
      const target = {
        label: stringArg(args, "label")!,
        ...(args.role !== undefined ? { role: stringArg(args, "role") } : {}),
      };
      const maxScrolls = boundedInteger(
        args,
        "maxSwipes",
        DEVICE_SCROLL_MIN_SWIPES,
        DEVICE_SCROLL_MAX_SWIPES,
      );
      const match = await manager.scrollToElement(udid(), target, { maxScrolls, guard: stepGuard });
      await surface();
      const fields = {
        udid: udid(),
        element: {
          role: match.node.role,
          subrole: match.node.subrole,
          ...clippedElementText(match.node),
          frame: match.node.frame,
        },
        tapPoint: match.point,
      };
      if (observeArg === false) return await unobserved(fields);
      const settled = await waitForSettle(manager, udid(), { signal, timing, treeKnown: true });
      return await evidence({ ...settled, changed: null }, fields);
    }
    case "device_wait": {
      const label = optionalStringArg(args, "label");
      const role = optionalStringArg(args, "role");
      if (role !== undefined && label === undefined) {
        throw new DeviceToolArgumentError('Argument "role" only narrows a label; pass label too.');
      }
      const gone = booleanArg(args, "gone");
      const timeoutMs =
        boundedInteger(args, "timeoutMs", 0, DEVICE_WAIT_MAX_MS) ?? DEVICE_WAIT_DEFAULT_MS;
      if (label === undefined) {
        const settled = await waitForSettle(manager, udid(), {
          signal,
          timing,
          timeoutMs,
        });
        await surface();
        const status =
          settled.settled === null ? "unavailable" : settled.settled ? "ready" : "timeout";
        return await evidence({ ...settled, changed: null }, { udid: udid(), status });
      }
      const outcome = await waitFor(
        manager,
        udid(),
        { label, role },
        { gone, timeoutMs, signal, timing },
      );
      await surface();
      return await evidence(
        {
          // Not measured: the wait ends the moment the element is (or is not)
          // there, without a quiet window. False would read as "still moving".
          settled: null,
          waitedMs: outcome.waitedMs,
          root: outcome.root,
          changed: null,
          settleSignal: "accessibility",
        },
        { udid: udid(), status: outcome.status },
      );
    }
    case "device_logs": {
      const bundleId = stringArg(args, "bundleId")!;
      if (!LOG_BUNDLE_ID.test(bundleId)) {
        throw new DeviceToolArgumentError('Argument "bundleId" must be an app bundle id.');
      }
      const contains = stringArg(args, "contains", false);
      if (contains !== undefined && contains.length > DEVICE_TOOL_BOUNDS.logContainsMaxLength) {
        throw new DeviceToolArgumentError(
          `Argument "contains" must be at most ${DEVICE_TOOL_BOUNDS.logContainsMaxLength} characters.`,
        );
      }
      const query: DeviceLogQuery = {
        bundleId,
        sinceSeconds:
          boundedInteger(args, "sinceSeconds", 1, DEVICE_TOOL_BOUNDS.logMaxSeconds) ??
          LOG_DEFAULT_SECONDS,
        level: enumArg(args, "level", DEVICE_TOOL_LOG_LEVELS) ?? "default",
        limit:
          boundedInteger(args, "limit", 1, DEVICE_TOOL_BOUNDS.logMaxLimit) ?? LOG_DEFAULT_LIMIT,
        ...(contains === undefined || contains.length === 0 ? {} : { contains }),
      };
      return jsonContent(fitLogResult(await manager.readLogs(udid(), query)));
    }
    case "device_configure": {
      const testing = readSetting(udid(), args);
      fence();
      await manager.testing(testing);
      await surface();
      return jsonContent({ udid: udid(), applied: testing.action.type });
    }
  }
}
