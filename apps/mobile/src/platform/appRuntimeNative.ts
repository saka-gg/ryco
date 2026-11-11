import type { PlatformBackgroundStay } from "@ryco/client-runtime/authorization/hostedBackgroundStay";

/** `modules/ryco-app-runtime/ios/RycoAppRuntimeModule.swift`; absent on Android and older builds. */
export interface RycoAppRuntimeNativeModule {
  /** Starts an iOS background task; 0 when iOS grants none. */
  readonly beginBackgroundStay: (name: string) => number;
  readonly endBackgroundStay: (stayId: number) => void;
  /** Whether iOS took the stay back before it was ended; read before ending it. */
  readonly backgroundStayExpired: (stayId: number) => boolean;
  /** Raw DEFLATE with the relay's cap and end-of-stream rules, off the JavaScript thread. */
  readonly inflateRaw: (body: Uint8Array, maxOutputBytes: number) => Promise<Uint8Array>;
  /** The alternate app icon iOS shows, null for the primary one; absent in older builds. */
  readonly getAppIconName?: () => Promise<string | null>;
  /** Switches the home screen icon; iOS tells the user itself. Absent in older builds. */
  readonly setAppIconName?: (name: string | null) => Promise<void>;
  readonly addListener: (
    event: "onBackgroundStayExpiring",
    listener: (event: { readonly stayId: number }) => void,
  ) => { readonly remove: () => void };
}

let resolved: RycoAppRuntimeNativeModule | null | undefined;

/**
 * The native module, or null where the binary does not have it.
 *
 * Read from the Expo modules host object, where `requireOptionalNativeModule`
 * looks first, rather than through `expo`: the relay socket reaches this, and
 * many Node tests import the relay socket without React Native. The app imports
 * `expo` at startup (index.ts), which installs the host object, long before a
 * relay socket or a background stay exists.
 */
export function rycoAppRuntimeNative(): RycoAppRuntimeNativeModule | null {
  if (resolved !== undefined) return resolved;
  const host = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo;
  const native = host?.modules?.["RycoAppRuntime"] as RycoAppRuntimeNativeModule | undefined;
  // Only a found module is kept: asked before the host object exists, a later call looks again.
  if (native !== undefined) resolved = native;
  return native ?? null;
}

/** Test seam. */
export function setRycoAppRuntimeNativeForTests(
  native: RycoAppRuntimeNativeModule | null | undefined,
): void {
  resolved = native;
}

const BACKGROUND_STAY_NAME = "ryco-hub-connections";

/** An iOS background task as the shared policy's platform stay; null when iOS grants none. */
export function beginNativeBackgroundStay(
  native: Pick<
    RycoAppRuntimeNativeModule,
    "beginBackgroundStay" | "endBackgroundStay" | "backgroundStayExpired" | "addListener"
  >,
  expire: () => void,
): PlatformBackgroundStay | null {
  const stayId = native.beginBackgroundStay(BACKGROUND_STAY_NAME);
  if (stayId === 0) return null;
  const subscription = native.addListener("onBackgroundStayExpiring", (event) => {
    if (event.stayId === stayId) expire();
  });
  let ended = false;
  return {
    // iOS grants about 30 s; the policy ends the stay well before that.
    remainingMs: Number.POSITIVE_INFINITY,
    expiredByPlatform: () => native.backgroundStayExpired(stayId),
    end: () => {
      if (ended) return;
      ended = true;
      subscription.remove();
      native.endBackgroundStay(stayId);
    },
  };
}
