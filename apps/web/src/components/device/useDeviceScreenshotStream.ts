import type { DeviceScreenshotResult, DeviceUdid } from "@ryco/contracts";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";

import {
  acquireHostedPreviewLease,
  forgetHostedPreviewOwner,
  noteHostedPreviewInteraction,
  readHostedPreviewLeaseHolder,
  subscribeHostedPreviewLease,
  type HostedPreviewLease,
} from "./hostedPreviewLease";
import type { DeviceVideoStatus } from "./useDeviceVideoStream";

const HOSTED_SCREENSHOT_INTERVAL_MS = 750;
const HOSTED_SCREENSHOT_TARGET_BYTES_PER_SECOND = 512 * 1024;
const HOSTED_SCREENSHOT_MAX_INTERVAL_MS = 15_000;
/** A preview without pointer or keyboard interaction for this long stops sampling. */
export const HOSTED_PREVIEW_IDLE_PAUSE_MS = 60_000;

export type HostedPreviewStatus = DeviceVideoStatus | "paused-by-other-preview" | "paused-idle";

/**
 * Backpressure the full-PNG fallback by its actual relay payload size.
 *
 * docs/relay-capacity-assessment-3b.md measured 3,053,100 base64 bytes per
 * phone frame and 5,569,884 per tablet frame. At the old fixed 750ms cadence
 * those were 3.88/7.08 MiB/s and exhausted a 50 MiB channel after 18/10
 * frames. This target spaces the measured frames by about 5.8s/10.6s (at most
 * 0.5 MiB/s), in addition to suspending the loop while the panel or document
 * is hidden and sampling only one preview per tab (see `hostedPreviewLease`).
 */
export function hostedScreenshotDelayMs(base64PayloadBytes: number): number {
  const transferDelay = Math.ceil(
    (Math.max(0, base64PayloadBytes) / HOSTED_SCREENSHOT_TARGET_BYTES_PER_SECOND) * 1_000,
  );
  return Math.min(
    HOSTED_SCREENSHOT_MAX_INTERVAL_MS,
    Math.max(HOSTED_SCREENSHOT_INTERVAL_MS, transferDelay),
  );
}

/**
 * Relay load of the hosted previews visible in one tab. The preview lease lets
 * a single one of them sample, so extra visible previews add no traffic.
 */
export function hostedScreenshotLoad(
  base64PayloadBytes: number,
  visibleStreams: number,
): {
  readonly intervalMs: number;
  readonly bytesPerSecondPerStream: number;
  readonly aggregateBytesPerSecond: number;
} {
  const intervalMs = hostedScreenshotDelayMs(base64PayloadBytes);
  const bytesPerSecondPerStream = Math.ceil((Math.max(0, base64PayloadBytes) * 1_000) / intervalMs);
  return {
    intervalMs,
    bytesPerSecondPerStream,
    aggregateBytesPerSecond: visibleStreams >= 1 ? bytesPerSecondPerStream : 0,
  };
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function decodeBase64BlobPart(value: string): ArrayBuffer {
  const bytes = decodeBase64(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export interface HostedPreviewSampler {
  setPageVisible(visible: boolean): void;
  setPanelVisible(visible: boolean): void;
  /** Resumes an idle-paused hosted preview and makes it the lease holder. */
  noteInteraction(): void;
  dispose(): void;
}

/**
 * The sampling loop and the rules for when it may run. A preview samples while
 * the document and panel are visible. A hosted preview, whose frames cost relay
 * bandwidth, additionally has to hold the tab's lease and have been interacted
 * with within the idle window. Dropping out of any of them stops sampling
 * without disturbing the last painted frame; the owner's status reports why.
 * Previews that are not hosted skip the lease and the idle window.
 *
 * The idle window runs while the preview holds the lease. Idle pausing
 * releases the lease so another visible preview can take over, and the window
 * restarts whenever the preview regains the lease or becomes visible again.
 */
export function createHostedPreviewSampler(input: {
  readonly ownerId: string;
  readonly hosted: boolean;
  readonly screenshot: () => Promise<DeviceScreenshotResult>;
  /** Draws the frame and resolves true unless it was dropped as stale. */
  readonly paint: (shot: DeviceScreenshotResult, isCurrent: () => boolean) => Promise<boolean>;
  readonly onStatus: (status: HostedPreviewStatus) => void;
  readonly onError: (message: string | null) => void;
  readonly pageVisible: boolean;
  readonly panelVisible: boolean;
  readonly idleMs?: number;
}): HostedPreviewSampler {
  const { ownerId, hosted, screenshot, paint, onStatus, onError } = input;
  const idleMs = input.idleMs ?? HOSTED_PREVIEW_IDLE_PAUSE_MS;
  let disposed = false;
  let pageVisible = input.pageVisible;
  let panelVisible = input.panelVisible;
  let idlePaused = false;
  let streamState: "connecting" | "streaming" | "recovering" = "connecting";
  let lease: HostedPreviewLease | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let sampling = false;
  let wasSampleable = false;
  let reportedStatus: HostedPreviewStatus | null = null;
  let applying = false;
  let reapply = false;

  const isVisible = () => pageVisible && panelVisible;
  const wantsLease = () => hosted && isVisible() && !idlePaused;
  const holdsLease = () => lease !== null && readHostedPreviewLeaseHolder() === ownerId;
  const canSample = () => !disposed && isVisible() && (!hosted || (!idlePaused && holdsLease()));

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const clearIdleTimer = () => {
    if (idleTimer === null) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };
  const schedule = (delayMs: number) => {
    clearTimer();
    if (!canSample() || sampling) return;
    timer = setTimeout(() => {
      timer = null;
      void sample();
    }, delayMs);
  };

  // Lease changes call back synchronously, including the ones this function
  // causes by acquiring or releasing, so overlapping passes are folded into a
  // follow-up pass.
  const apply = (interacted = false) => {
    if (disposed) return;
    if (applying) {
      reapply = true;
      return;
    }
    applying = true;
    try {
      let interactedPass = interacted;
      do {
        if (disposed) return;
        reapply = false;
        const wants = wantsLease();
        if (wants && lease === null) lease = acquireHostedPreviewLease(ownerId);
        else if (!wants && lease !== null) {
          lease.release();
          lease = null;
        }
        if (interactedPass && lease !== null) noteHostedPreviewInteraction(ownerId);
        interactedPass = false;
        const holding = wants && holdsLease();
        if (holding && idleTimer === null) {
          idleTimer = setTimeout(() => {
            idleTimer = null;
            idlePaused = true;
            apply();
          }, idleMs);
        } else if (!holding) {
          clearIdleTimer();
        }
        const status: HostedPreviewStatus = idlePaused
          ? "paused-idle"
          : wants && !holdsLease()
            ? "paused-by-other-preview"
            : streamState;
        if (status !== reportedStatus) {
          reportedStatus = status;
          onStatus(status);
        }
        const sampleable = canSample();
        if (sampleable && !wasSampleable) schedule(0);
        else if (!sampleable && wasSampleable) clearTimer();
        wasSampleable = sampleable;
      } while (reapply);
    } finally {
      applying = false;
    }
  };

  const sample = async () => {
    if (!canSample() || sampling) return;
    sampling = true;
    let nextDelay = HOSTED_SCREENSHOT_INTERVAL_MS;
    try {
      const shot = await screenshot();
      nextDelay = hostedScreenshotDelayMs(shot.bytesBase64.length);
      if (!canSample()) return;
      if (await paint(shot, canSample)) {
        streamState = "streaming";
        onError(null);
        apply();
      }
    } catch (sampleError) {
      if (disposed) return;
      streamState = "recovering";
      onError(
        sampleError instanceof Error
          ? sampleError.message
          : "The hosted simulator preview disconnected.",
      );
      apply();
    } finally {
      sampling = false;
      if (canSample()) schedule(nextDelay);
    }
  };

  const unsubscribe = hosted ? subscribeHostedPreviewLease(() => apply()) : () => undefined;
  apply();

  return {
    setPageVisible(visible) {
      if (visible === pageVisible) return;
      pageVisible = visible;
      apply();
    },
    setPanelVisible(visible) {
      if (visible === panelVisible) return;
      panelVisible = visible;
      apply();
    },
    noteInteraction() {
      if (disposed || !hosted) return;
      idlePaused = false;
      clearIdleTimer();
      apply(true);
    },
    dispose() {
      disposed = true;
      clearTimer();
      clearIdleTimer();
      unsubscribe();
      lease = null;
      if (hosted) forgetHostedPreviewOwner(ownerId);
    },
  };
}

/**
 * Screenshot-sampled preview. Over the hosted relay, whose lifecycle-owned
 * byte channel carries no binary video subchannel yet, we sample PNGs over its
 * bounded read RPC. Input and lifecycle calls still share the authoritative
 * relay generation, and direct/saved environments continue to use low-latency
 * H.264 (Android emulators sample screenshots on every connection kind).
 *
 * A `hosted` preview samples only while it holds the tab's lease and is being
 * used: `status` reports `paused-by-other-preview` and `paused-idle` for the
 * paused cases and `noteInteraction` resumes them. Other previews only follow
 * visibility.
 *
 * The sampler lives as long as the device, `enabled` and the availability of
 * `screenshot` do. Its identity is deliberately not a dependency: a caller that
 * passes a fresh function every render would otherwise rebuild the sampler on
 * every frame, restarting pacing, the idle window and the lease ranking.
 */
export function useDeviceScreenshotStream(input: {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly udid: DeviceUdid | null;
  readonly enabled: boolean;
  /** Whether the preview runs over the hosted relay and so shares the tab's lease. */
  readonly hosted: boolean;
  readonly screenshot: ((input: { udid: DeviceUdid }) => Promise<DeviceScreenshotResult>) | null;
}): {
  readonly status: HostedPreviewStatus;
  readonly error: string | null;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
  readonly noteInteraction: () => void;
} {
  const { canvasRef, enabled, hosted, screenshot, udid } = input;
  const ownerId = useId();
  const samplerRef = useRef<HostedPreviewSampler | null>(null);
  const screenshotRef = useRef(screenshot);
  const canScreenshot = screenshot !== null;
  const [status, setStatus] = useState<HostedPreviewStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  // Declared before the sampler effect so each commit publishes the latest
  // function before a sampler can call it.
  useEffect(() => {
    screenshotRef.current = screenshot;
  }, [screenshot]);

  useEffect(() => {
    if (!enabled || !udid || !canScreenshot) {
      setStatus("idle");
      setError(null);
      return;
    }
    const paint = async (shot: DeviceScreenshotResult, isCurrent: () => boolean) => {
      const bitmap = await createImageBitmap(
        new Blob([decodeBase64BlobPart(shot.bytesBase64)], { type: shot.mimeType }),
      );
      try {
        if (!isCurrent()) return false;
        const canvas = canvasRef.current;
        if (!canvas) return false;
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          setDimensions({ width: bitmap.width, height: bitmap.height });
        }
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        return true;
      } finally {
        bitmap.close();
      }
    };

    const canvas = canvasRef.current;
    // With an observer the panel counts as hidden until it reports, so a
    // preview mounted offscreen never samples or contends for the lease.
    const observed = canvas !== null && typeof IntersectionObserver === "function";
    const sampler = createHostedPreviewSampler({
      ownerId,
      hosted,
      screenshot: () => {
        const capture = screenshotRef.current;
        return capture
          ? capture({ udid })
          : Promise.reject(new Error("The simulator preview is unavailable."));
      },
      paint,
      onStatus: setStatus,
      onError: setError,
      pageVisible: document.visibilityState !== "hidden",
      panelVisible: !observed,
    });
    samplerRef.current = sampler;

    const onVisibilityChange = () => sampler.setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    const observer = observed
      ? new IntersectionObserver((entries) =>
          sampler.setPanelVisible(entries.some((entry) => entry.isIntersecting)),
        )
      : null;
    observer?.observe(canvas!);
    return () => {
      samplerRef.current = null;
      sampler.dispose();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [canScreenshot, canvasRef, enabled, hosted, ownerId, udid]);

  const noteInteraction = useCallback(() => samplerRef.current?.noteInteraction(), []);

  return { status, error, dimensions, noteInteraction };
}
