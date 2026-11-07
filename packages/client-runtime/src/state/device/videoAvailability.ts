import type { DeviceDescriptor, ThreadDeviceState } from "@ryco/contracts";

/**
 * The relay frame tunnel version this client speaks
 * (`RELAY_FRAME_TUNNEL_VERSION` of `@ryco/shared/relayFrameTunnel`, repeated
 * so the boot path does not load the codec; a test pins the two together).
 */
export const CLIENT_RELAY_FRAME_TUNNEL_VERSION = 1;

/**
 * Whether a viewer may stream a device's H.264 video (and live input) instead
 * of sampling screenshots: the connection can open a frame source, a hosted one
 * only when the node advertised the relay frame tunnel, and the device
 * streams video (Android only once its backend says scrcpy runs). Decoding
 * support is the platform's to add.
 */
export function deviceVideoStreamAvailable(
  client:
    | {
        readonly openFrameSource?: unknown;
        readonly frameSourceNeedsRelayTunnel?: true;
      }
    | null
    | undefined,
  threadState: Pick<ThreadDeviceState, "relayFrameTunnel"> | null | undefined,
  device: Pick<DeviceDescriptor, "platform" | "preview"> | null | undefined,
): boolean {
  if (!client?.openFrameSource || !device) return false;
  if (
    client.frameSourceNeedsRelayTunnel &&
    (threadState?.relayFrameTunnel ?? 0) < CLIENT_RELAY_FRAME_TUNNEL_VERSION
  ) {
    return false;
  }
  return device.platform !== "android-emulator" || device.preview === "video";
}
