import type { DeviceScreenshotResult, DeviceUdid } from "@ryco/contracts";
import {
  createHostedPreviewSampler,
  type HostedPreviewSampler,
  type HostedPreviewStatus,
} from "@ryco/client-runtime/state/device/previewSampler";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";

export {
  HOSTED_PREVIEW_IDLE_PAUSE_MS,
  createHostedPreviewSampler,
  hostedScreenshotDelayMs,
  hostedScreenshotLoad,
  type HostedPreviewSampler,
  type HostedPreviewStatus,
} from "@ryco/client-runtime/state/device/previewSampler";

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
