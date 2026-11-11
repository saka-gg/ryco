import { describe, expect, it } from "vite-plus/test";

import {
  classifySavedEnvironmentFailure,
  describeSavedEnvironmentFailure,
  RemoteEnvironmentUnreachableError,
  SAVED_ENVIRONMENT_FAILURE_MESSAGES,
  savedEnvironmentFailureMessageFor,
} from "./connectFailure.ts";
import { ControlPlaneRequestTimeoutError } from "./fetchWithDeadline.ts";
import { RemoteEnvironmentAuthHttpError } from "./remoteApi.ts";
import { SavedEnvironmentTimeoutError } from "./savedEnvironmentSession.ts";

// What iOS's fetch rejected with on the phone when a saved dev node had stopped.
const IOS_OFFLINE =
  "fetch failed unexpected exception the internet connection appears to be offline at ExpoModulesCore/Promise.swift:65";

describe("saved environment connect failures", () => {
  it("shows an unanswered request as out of reach, without the URL or the platform text", () => {
    const error = new RemoteEnvironmentUnreachableError(
      "http://192.168.68.99:14024/api/auth/session",
      new TypeError(IOS_OFFLINE),
    );
    const failure = describeSavedEnvironmentFailure(error);
    expect(failure.kind).toBe("unreachable");
    expect(failure.message).toBe(SAVED_ENVIRONMENT_FAILURE_MESSAGES.unreachable);
    expect(failure.message).not.toMatch(/http|swift|exception|14024/i);
    // The details stay on the error for logs.
    expect(error.requestUrl).toContain("/api/auth/session");
    expect((error.cause as Error).message).toBe(IOS_OFFLINE);
  });

  it("tells a request whose deadline passed apart from one that never got through", () => {
    const timedOut = new RemoteEnvironmentUnreachableError(
      "http://studio:3773/api/auth/session",
      new ControlPlaneRequestTimeoutError("http://studio:3773/api/auth/session", 10_000),
    );
    expect(classifySavedEnvironmentFailure(timedOut)).toBe("timed-out");
    expect(classifySavedEnvironmentFailure(new SavedEnvironmentTimeoutError("slow"))).toBe(
      "timed-out",
    );
    expect(
      classifySavedEnvironmentFailure(
        new Error("Saved environment env-1 did not connect in time."),
      ),
    ).toBe("timed-out");
  });

  it("sorts what the sockets and the platforms report", () => {
    for (const message of [
      "Unable to connect to the Ryco server WebSocket.",
      "Unable to prepare the Ryco server WebSocket connection.",
      "Network request failed",
      "TypeError: Failed to fetch",
      "Could not connect to the server.",
      "A server with the specified hostname could not be found.",
      "connect ECONNREFUSED 127.0.0.1:14024",
      IOS_OFFLINE,
    ]) {
      expect(classifySavedEnvironmentFailure(new Error(message)), message).toBe("unreachable");
    }
    expect(classifySavedEnvironmentFailure(new Error("Something odd happened."))).toBe("failed");
    expect(describeSavedEnvironmentFailure("weird").message).toBe(
      SAVED_ENVIRONMENT_FAILURE_MESSAGES.failed,
    );
  });

  it("keeps a node's own short refusal and hides a proxy's error page", () => {
    expect(
      describeSavedEnvironmentFailure(
        new RemoteEnvironmentAuthHttpError("This pairing was removed on the machine.", 403),
      ),
    ).toEqual({ kind: "refused", message: "This pairing was removed on the machine." });
    expect(
      describeSavedEnvironmentFailure(
        new RemoteEnvironmentAuthHttpError("<html><body>Bad gateway</body></html>", 502),
      ),
    ).toEqual({ kind: "refused", message: SAVED_ENVIRONMENT_FAILURE_MESSAGES.refused });
  });

  it("names the machine on workspace-wide surfaces", () => {
    expect(savedEnvironmentFailureMessageFor("unreachable", "Mac mini")).toBe(
      "Can't reach Mac mini. It may be off, asleep or on another network.",
    );
    expect(savedEnvironmentFailureMessageFor("failed", " ")).toBe(
      SAVED_ENVIRONMENT_FAILURE_MESSAGES.failed,
    );
  });
});
