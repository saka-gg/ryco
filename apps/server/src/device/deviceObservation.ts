// Adapted from Synara (MIT) commit 74e0b3654 (#1924) apps/server/src/device/DeviceManager.ts; see THIRD_PARTY_NOTICES.md.
/**
 * What an agent's device action did to the screen.
 *
 * Every input waits for the screen to settle and reports the settled screen,
 * whether it changed, and whether it settled at all, so the agent reads state
 * from the result instead of describing the screen again after every step.
 *
 * Settling uses the accessibility tree, not pixels: reads cost tens of
 * milliseconds, they ignore a blinking caret, and they are what the agent acts
 * on next. A spinner or an endless animation simply reaches the deadline,
 * which is reported rather than hidden. A device without a tree (Android)
 * reports `settled: null` after one short pause instead of polling to the
 * deadline, and its evidence carries a screenshot instead.
 *
 * A failed read alone does not prove there is no tree: an iOS read also fails
 * for a moment while the frontmost app swaps. So a device only counts as
 * having none once its reads have failed for a short grace
 * (`treeGraceMs`), never on the first failure.
 *
 * Pure functions over a narrow reader, so the device manager's control plane
 * stays as it is. Loaded on the first device tool call, never at boot.
 *
 * @module device/deviceObservation
 */
import type { DeviceDescribeUiResult, DeviceScreenshotResult, DeviceUiNode } from "@ryco/contracts";

import { fitScreenshotToBase64Budget } from "../screenshotFit.ts";
import { DeviceBackendError } from "./DeviceBackend.ts";
import { formatUiSnapshot, uiFingerprint } from "./deviceUiSnapshot.ts";
export { formatUiSnapshot } from "./deviceUiSnapshot.ts";
import { DeviceUiTargetError, findTarget, type DeviceUiTarget } from "./uiTreeTargeting.ts";

export interface DeviceObservationReader {
  describeUi(udid: string): Promise<DeviceDescribeUiResult>;
  screenshot(udid: string, options?: { readonly save?: boolean }): Promise<DeviceScreenshotResult>;
}

/**
 * The screen counts as settled once its accessibility fingerprint holds for
 * `quietMs`; the wait gives up at `timeoutMs`. The first read waits
 * `startDelayMs` so the gesture's own effect has begun.
 */
export interface DeviceSettleTiming {
  readonly quietMs: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly startDelayMs: number;
  /**
   * How long an action's effect may take to start. The home gesture, a push
   * after a network call, or a sheet can leave the old screen perfectly still
   * for half a second first, which a bare quiet window reads as "settled,
   * nothing changed". Waiting for the first change before settling costs
   * nothing when the change is immediate, and this much when there is none.
   */
  readonly changeGraceMs: number;
  /** How long a launch may take to bring its app to the front. */
  readonly appChangeTimeoutMs: number;
  /**
   * How long reads may keep failing before a device not yet known to have a
   * tree counts as having none: longer than an iOS app swap leaves the tree
   * unreadable, short enough that a wait on Android is refused quickly.
   */
  readonly treeGraceMs: number;
}

/**
 * How long a launch may take to bring its app to the front. The first launch
 * after an install, right after a cold boot, has been seen past four seconds;
 * the bound only costs time when the app never comes forward at all.
 */
export const DEVICE_APP_CHANGE_TIMEOUT_MS = 10_000;

export const DEVICE_SETTLE_DEFAULTS: DeviceSettleTiming = {
  quietMs: 300,
  timeoutMs: 2_500,
  pollMs: 100,
  startDelayMs: 120,
  changeGraceMs: 1_000,
  appChangeTimeoutMs: DEVICE_APP_CHANGE_TIMEOUT_MS,
  treeGraceMs: 1_000,
};

/** Launching paints a first screen later than a tap changes one. */
export const DEVICE_LAUNCH_SETTLE_TIMEOUT_MS = 6_000;
export const DEVICE_WAIT_DEFAULT_MS = 5_000;
/** Upper bound for an explicit wait; well under Agent Control's 60 s request abort. */
export const DEVICE_WAIT_MAX_MS = 30_000;
/** Synara's inline cap (4 MiB of PNG) as base64 characters, for the provider gateway. */
export const DEVICE_GATEWAY_IMAGE_MAX_BASE64_CHARS = 5_592_408;
/** How often an explicit wait re-reads the tree. */
const DEVICE_WAIT_POLL_MS = 200;

export interface DeviceObservation {
  /**
   * False: still changing at the deadline. Null: not measured, because the
   * device gave no accessibility tree (Android, failed reads) or the call
   * returns the moment an element appears without settling (`device_wait`).
   */
  readonly settled: boolean | null;
  readonly waitedMs: number;
  /** Whether the settled screen differs from the one before the action; null when unknown. */
  readonly changed: boolean | null;
  readonly root: DeviceUiNode | null;
  readonly settleSignal: "accessibility" | "none";
}

export interface DeviceObservationClock {
  now(): number;
  delay(ms: number, signal?: AbortSignal): Promise<void>;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Monotonic, so a wall-clock jump cannot end or stretch a settle window. */
const SYSTEM_CLOCK: DeviceObservationClock = {
  now: () => performance.now(),
  delay: abortableDelay,
};

interface ObservationContext {
  readonly signal?: AbortSignal | undefined;
  readonly timing?: Partial<DeviceSettleTiming> | undefined;
  readonly clock?: DeviceObservationClock | undefined;
}

function resolveContext(options: ObservationContext) {
  return {
    signal: options.signal,
    timing: { ...DEVICE_SETTLE_DEFAULTS, ...options.timing },
    clock: options.clock ?? SYSTEM_CLOCK,
  };
}

type ResolvedContext = ReturnType<typeof resolveContext>;

const readTree = (reader: DeviceObservationReader, udid: string) =>
  reader.describeUi(udid).then(
    (result) => result.root,
    () => null,
  );

export interface DeviceSettleOutcome {
  readonly settled: boolean | null;
  readonly waitedMs: number;
  /** The last tree read, or null when accessibility never answered. */
  readonly root: DeviceUiNode | null;
  readonly settleSignal: "accessibility" | "none";
}

/**
 * Wait until the screen stops changing, or the deadline passes.
 *
 * Reads failing mid-transition (the frontmost app is swapping) count as
 * change rather than as an error: a launch or a dismissal is exactly when the
 * tree is briefly unreadable. On a device not already known to have a tree,
 * reads that keep failing for `treeGraceMs` end the wait with
 * `settleSignal: "none"` instead of polling to the deadline.
 */
export async function waitForSettle(
  reader: DeviceObservationReader,
  udid: string,
  options: ObservationContext & {
    readonly timeoutMs?: number | undefined;
    /** The caller already read a tree from this device, so a failed read is a transition. */
    readonly treeKnown?: boolean | undefined;
  } = {},
): Promise<DeviceSettleOutcome> {
  return await settle(reader, udid, resolveContext(options), options);
}

async function settle(
  reader: DeviceObservationReader,
  udid: string,
  { signal, timing, clock }: ResolvedContext,
  options: {
    readonly timeoutMs?: number | undefined;
    readonly treeKnown?: boolean | undefined;
    /** Overrides `timing.treeGraceMs`. */
    readonly treeGraceMs?: number | undefined;
  },
): Promise<DeviceSettleOutcome> {
  const timeoutMs = options.timeoutMs ?? timing.timeoutMs;
  // Never past the deadline: a short wait on a device without a tree still
  // says so rather than reporting an unsettled screen it never read.
  const treeGraceMs = Math.min(options.treeGraceMs ?? timing.treeGraceMs, timeoutMs);
  const started = clock.now();
  await clock.delay(Math.min(timing.startDelayMs, timeoutMs), signal);
  let root: DeviceUiNode | null = null;
  let fingerprint: string | null = null;
  let stableSince = clock.now();
  let sawTree = options.treeKnown === true;
  while (true) {
    signal?.throwIfAborted();
    const read = await readTree(reader, udid);
    if (read !== null) {
      sawTree = true;
    } else if (!sawTree && clock.now() - started >= treeGraceMs) {
      return { settled: null, waitedMs: clock.now() - started, root: null, settleSignal: "none" };
    }
    const next = read === null ? null : uiFingerprint(read);
    if (read !== null) root = read;
    if (next === null || next !== fingerprint) {
      fingerprint = next;
      stableSince = clock.now();
    } else if (clock.now() - stableSince >= timing.quietMs) {
      return {
        settled: true,
        waitedMs: clock.now() - started,
        root,
        settleSignal: "accessibility",
      };
    }
    if (clock.now() - started >= timeoutMs) {
      return {
        settled: false,
        waitedMs: clock.now() - started,
        root,
        settleSignal: "accessibility",
      };
    }
    await clock.delay(timing.pollMs, signal);
  }
}

/**
 * Run an action and report what it did to the screen: the settled tree and
 * whether it differs from just before. An unchanged screen after a tap is the
 * clearest sign the tap missed, and it costs the agent nothing to see it.
 */
export async function observe(
  reader: DeviceObservationReader,
  udid: string,
  action: () => Promise<void>,
  options: ObservationContext & {
    readonly timeoutMs?: number | undefined;
    /**
     * Wait for an app to come to the front before settling: `"different"` for
     * one other than the app in front before, `"any"` when relaunching the app
     * already in front. A launch reports success well before its app is
     * frontmost, and the old screen or the blank transition holding still in
     * the meantime would read as settled.
     */
    readonly awaitApp?: "different" | "any" | undefined;
    /** Fail the settle (`settled: false`) unless the screen changes within `timeoutMs`. */
    readonly awaitChange?: boolean | undefined;
  } = {},
): Promise<DeviceObservation> {
  const context = resolveContext(options);
  const { signal, timing, clock } = context;
  const beforeRoot = await readTree(reader, udid);
  signal?.throwIfAborted();
  if (beforeRoot === null) {
    // No tree before the action: a device without one (Android), or an iOS
    // read that failed mid-transition. Let the action land, then settle with
    // a grace of one start delay plus one quiet window: a tree that answers
    // by then settles as usual (unknown change), and a device that never
    // answers hands back after that pause instead of polling to the deadline,
    // which would cost every Android action 2.5 s.
    await action();
    signal?.throwIfAborted();
    const acted = clock.now();
    const settled = await settle(reader, udid, context, {
      timeoutMs: options.timeoutMs,
      treeGraceMs: timing.startDelayMs + timing.quietMs,
    });
    return { ...settled, waitedMs: clock.now() - acted, changed: null };
  }
  const before = uiFingerprint(beforeRoot);
  await action();
  signal?.throwIfAborted();
  const acted = clock.now();
  const unsettled = async (changed: boolean | null): Promise<DeviceObservation> => ({
    settled: false,
    waitedMs: clock.now() - acted,
    root: await readTree(reader, udid),
    changed,
    settleSignal: "accessibility",
  });
  if (options.awaitApp !== undefined) {
    const transitioned = await waitForApp(
      reader,
      udid,
      beforeRoot.label,
      before,
      options.awaitApp,
      context,
    );
    if (!transitioned) return await unsettled(null);
  } else {
    const changed = await waitForChange(
      reader,
      udid,
      before,
      context,
      options.awaitChange === true ? (options.timeoutMs ?? timing.changeGraceMs) : undefined,
    );
    if (options.awaitChange === true && !changed) return await unsettled(false);
  }
  const settled = await settle(reader, udid, context, {
    timeoutMs: options.timeoutMs,
    treeKnown: true,
  });
  const after = settled.root === null ? null : uiFingerprint(settled.root);
  return {
    settled: settled.settled,
    root: settled.root,
    settleSignal: "accessibility",
    // From the end of the action, so a slow-starting transition counts.
    waitedMs: clock.now() - acted,
    changed: after === null ? null : before !== after,
  };
}

/** Poll until the screen differs from `baseline`, for at most the change grace. */
async function waitForChange(
  reader: DeviceObservationReader,
  udid: string,
  baseline: string,
  { signal, timing, clock }: ResolvedContext,
  timeoutMs: number = timing.changeGraceMs,
): Promise<boolean> {
  const started = clock.now();
  while (clock.now() - started < timeoutMs) {
    signal?.throwIfAborted();
    const tree = await readTree(reader, udid);
    if (tree !== null && uiFingerprint(tree) !== baseline) return true;
    await clock.delay(timing.pollMs, signal);
  }
  return false;
}

/**
 * Poll until an app is in front (the root carries a name; SpringBoard and the
 * launch transition do not) and, in `"different"` mode, it is not the previous
 * one. Bounded by `appChangeTimeoutMs`: an app that was already in front never
 * changes, and the bound lets that fall through to an unsettled report.
 */
async function waitForApp(
  reader: DeviceObservationReader,
  udid: string,
  previous: string | null,
  baseline: string,
  mode: "different" | "any",
  { signal, timing, clock }: ResolvedContext,
): Promise<boolean> {
  const started = clock.now();
  let transitioned = false;
  while (clock.now() - started < timing.appChangeTimeoutMs) {
    signal?.throwIfAborted();
    const tree = await readTree(reader, udid);
    const label = tree?.label?.trim();
    if (tree === null || !label || uiFingerprint(tree) !== baseline) transitioned = true;
    if (label && (mode === "different" ? label !== previous?.trim() : transitioned)) return true;
    await clock.delay(timing.pollMs, signal);
  }
  return false;
}

export interface DeviceWaitOutcome {
  readonly status: "ready" | "timeout" | "ambiguous";
  readonly waitedMs: number;
  readonly root: DeviceUiNode | null;
}

/**
 * Wait for an element to appear on screen (or, with `gone`, to disappear)
 * without sending any input. Ambiguity proves presence, so it ends a presence
 * wait. Needs the accessibility tree: reads that fail are retried like any
 * other (an iOS read fails briefly while apps swap), and a device that has
 * not answered once within `treeGraceMs` is refused rather than polled to
 * the deadline.
 */
export async function waitFor(
  reader: DeviceObservationReader,
  udid: string,
  target: DeviceUiTarget,
  options: ObservationContext & {
    readonly gone?: boolean | undefined;
    readonly timeoutMs: number;
  },
): Promise<DeviceWaitOutcome> {
  const { signal, timing, clock } = resolveContext(options);
  const started = clock.now();
  const timeoutMs = Math.min(Math.max(0, options.timeoutMs), DEVICE_WAIT_MAX_MS);
  let root: DeviceUiNode | null = null;
  let sawTree = false;
  while (true) {
    signal?.throwIfAborted();
    const read = await readTree(reader, udid);
    if (read !== null) {
      sawTree = true;
    } else if (!sawTree && clock.now() - started >= timing.treeGraceMs) {
      throw new DeviceBackendError(
        "wait needs the accessibility tree, which this device does not provide; take a screenshot instead.",
      );
    }
    if (read !== null) {
      root = read;
      let present = false;
      let ambiguous = false;
      try {
        present = findTarget(read, target).onScreen;
      } catch (error) {
        if (!(error instanceof DeviceUiTargetError)) throw error;
        ambiguous = !error.notFound;
        present = ambiguous;
      }
      if (options.gone === true ? !present : present) {
        return {
          status: ambiguous && options.gone !== true ? "ambiguous" : "ready",
          waitedMs: clock.now() - started,
          root,
        };
      }
    }
    if (clock.now() - started >= timeoutMs) {
      return { status: "timeout", waitedMs: clock.now() - started, root };
    }
    await clock.delay(DEVICE_WAIT_POLL_MS, signal);
  }
}

export type DeviceToolContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: "image/png" | "image/jpeg";
    };

export type DeviceImageContent = Extract<DeviceToolContent, { readonly type: "image" }>;

export interface InlineDeviceScreenshot {
  readonly image: DeviceImageContent;
  /** The attached image's size. */
  readonly width: number;
  readonly height: number;
  /**
   * The capture's own size. It differs from the image's only when the image
   * was scaled to fit, and it is the coordinate space Android input uses, so
   * an agent reading positions off a scaled image needs it.
   */
  readonly capturedWidth: number;
  readonly capturedHeight: number;
  readonly scaled: boolean;
}

/**
 * A captured screenshot as tool content within `maxBase64Chars`: the PNG when
 * it fits, else the shared fitter's JPEG, else null.
 */
export async function inlineDeviceScreenshot(
  shot: DeviceScreenshotResult,
  maxBase64Chars: number,
): Promise<InlineDeviceScreenshot | null> {
  const captured = { capturedWidth: shot.width, capturedHeight: shot.height };
  if (shot.bytesBase64.length <= maxBase64Chars) {
    return {
      image: { type: "image", data: shot.bytesBase64, mimeType: shot.mimeType },
      width: shot.width,
      height: shot.height,
      ...captured,
      scaled: false,
    };
  }
  const fitted = await fitScreenshotToBase64Budget(shot.bytesBase64, maxBase64Chars).catch(
    () => null,
  );
  if (fitted === null) return null;
  return {
    image: { type: "image", data: fitted.data, mimeType: fitted.mimeType },
    width: fitted.width,
    height: fitted.height,
    ...captured,
    scaled: true,
  };
}

/** What happened to a requested screenshot, for the result's JSON. */
interface AttachedScreenshot {
  readonly image: DeviceImageContent | null;
  readonly fields: {
    readonly screenshot: string;
    readonly screenshotPixels?: { readonly width: number; readonly height: number };
  };
}

/**
 * One capture, fitted to the transport. Never throws: a failed or oversized
 * screenshot is reported in `fields.screenshot` instead. `screenshotPixels`
 * is the capture's size whenever an image is attached, so a scaled image
 * still says which coordinates it stands for.
 */
async function attachScreenshot(
  reader: DeviceObservationReader,
  udid: string,
  maxImageBase64Chars: number,
): Promise<AttachedScreenshot> {
  try {
    const fitted = await inlineDeviceScreenshot(
      await reader.screenshot(udid, { save: false }),
      maxImageBase64Chars,
    );
    if (fitted === null) {
      return { image: null, fields: { screenshot: "omitted: too large for this transport" } };
    }
    return {
      image: fitted.image,
      fields: {
        screenshot: fitted.scaled
          ? `attached: scaled from ${fitted.capturedWidth}x${fitted.capturedHeight} to ${fitted.width}x${fitted.height} JPEG to fit this transport`
          : "attached",
        screenshotPixels: { width: fitted.capturedWidth, height: fitted.capturedHeight },
      },
    };
  } catch (error) {
    return {
      image: null,
      fields: {
        screenshot: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

const SKIPPED_SCREENSHOT: AttachedScreenshot = { image: null, fields: { screenshot: "skipped" } };

export interface DeviceEvidenceOptions {
  /** "always": the caller passed screenshot:true. "no-tree": only when the device gave no tree. "never". */
  readonly screenshot: "always" | "no-tree" | "never";
  /** Largest base64 image this transport can carry beside the text blocks. */
  readonly maxImageBase64Chars: number;
}

/** `screenshot: true` → always, `false` → never, absent → only when there is no tree. */
export function evidenceScreenshotMode(
  requested: boolean | undefined,
): DeviceEvidenceOptions["screenshot"] {
  return requested === true ? "always" : requested === false ? "never" : "no-tree";
}

/**
 * The tool result for an observed action: metadata as JSON, then the screen as
 * plain text (the snapshot is line-based, and escaping it into a JSON string
 * would make every line harder to read), then a screenshot when one was asked
 * for or the device gave no tree.
 *
 * The screenshot is one capture taken after the settle decision, fitted to the
 * transport's budget. A failed or oversized screenshot never fails the action:
 * the JSON says what happened to it instead, and `screenshotPixels` gives the
 * capture's size next to an attached image (scaled or not).
 */
export async function deviceEvidenceContent(
  reader: DeviceObservationReader,
  udid: string,
  observation: DeviceObservation,
  fields: Readonly<Record<string, unknown>>,
  options: DeviceEvidenceOptions,
): Promise<DeviceToolContent[]> {
  const wanted =
    options.screenshot === "always" ||
    (options.screenshot === "no-tree" && observation.root === null);
  const { image, fields: screenshot } = wanted
    ? await attachScreenshot(reader, udid, options.maxImageBase64Chars)
    : SKIPPED_SCREENSHOT;
  const root = observation.root;
  const metadata = {
    ...fields,
    settled: observation.settled,
    waitedMs: Math.round(observation.waitedMs),
    screenChanged: observation.changed,
    settleSignal: observation.settleSignal,
    ...(root === null
      ? {}
      : {
          screenPoints: {
            width: Math.round(root.frame.width),
            height: Math.round(root.frame.height),
          },
        }),
    ...screenshot,
  };
  return [
    { type: "text", text: JSON.stringify(metadata, null, 2) },
    ...(root === null ? [] : [{ type: "text" as const, text: formatUiSnapshot(root) }]),
    ...(image === null ? [] : [image]),
  ];
}

/**
 * The result of an action run without observing (`observe: false`): its own
 * fields, plus one screenshot taken straight after it when the caller asked
 * for one. No settle flags: nothing was measured.
 */
export async function deviceActionContent(
  reader: DeviceObservationReader,
  udid: string,
  fields: Readonly<Record<string, unknown>>,
  options: { readonly screenshot: boolean; readonly maxImageBase64Chars: number },
): Promise<DeviceToolContent[]> {
  if (!options.screenshot) return [{ type: "text", text: JSON.stringify(fields, null, 2) }];
  const { image, fields: screenshot } = await attachScreenshot(
    reader,
    udid,
    options.maxImageBase64Chars,
  );
  return [
    { type: "text", text: JSON.stringify({ ...fields, ...screenshot }, null, 2) },
    ...(image === null ? [] : [image]),
  ];
}
