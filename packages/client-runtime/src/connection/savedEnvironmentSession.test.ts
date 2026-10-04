import type { AuthSessionState } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { RemoteEnvironmentAuthHttpError } from "./remoteApi.ts";
import {
  checkSavedEnvironmentSession,
  isSavedEnvironmentAwaitingRepair,
  isSavedEnvironmentCredentialRejection,
} from "./savedEnvironmentSession.ts";

const session = (authenticated: boolean) =>
  ({ authenticated, ...(authenticated ? { role: "owner" } : {}) }) as unknown as AuthSessionState;

describe("isSavedEnvironmentCredentialRejection", () => {
  it("treats the node's 401 for an expired or revoked bearer as final", () => {
    expect(
      isSavedEnvironmentCredentialRejection(
        new RemoteEnvironmentAuthHttpError("Unauthorized request.", 401),
      ),
    ).toBe(true);
  });

  it("keeps retrying what pairing again cannot fix", () => {
    // A gateway or proxy in front of the node, not the node's own answer.
    expect(
      isSavedEnvironmentCredentialRejection(new RemoteEnvironmentAuthHttpError("Forbidden", 403)),
    ).toBe(false);
    expect(
      isSavedEnvironmentCredentialRejection(
        new RemoteEnvironmentAuthHttpError("Failed to issue websocket token.", 500),
      ),
    ).toBe(false);
    expect(isSavedEnvironmentCredentialRejection(new Error("fetch failed"))).toBe(false);
  });
});

describe("checkSavedEnvironmentSession", () => {
  it("reads the node's authenticated:false answer as needing a new pairing", async () => {
    await expect(
      checkSavedEnvironmentSession({ fetchSessionState: async () => session(false) }),
    ).resolves.toEqual({ status: "requires-auth" });
  });

  it("returns the session the node still accepts", async () => {
    const accepted = session(true);
    await expect(
      checkSavedEnvironmentSession({ fetchSessionState: async () => accepted }),
    ).resolves.toEqual({ status: "authenticated", session: accepted });
  });

  it("fails into the retry schedule on a 403 from in front of the node", async () => {
    const forbidden = new RemoteEnvironmentAuthHttpError("Forbidden", 403);
    await expect(
      checkSavedEnvironmentSession({
        fetchSessionState: async () => {
          throw forbidden;
        },
      }),
    ).rejects.toBe(forbidden);
  });
});

describe("isSavedEnvironmentAwaitingRepair", () => {
  it("parks only an environment whose credential the node rejected", () => {
    expect(isSavedEnvironmentAwaitingRepair({ authState: "requires-auth" })).toBe(true);
    expect(isSavedEnvironmentAwaitingRepair({ authState: "authenticated" })).toBe(false);
    expect(isSavedEnvironmentAwaitingRepair({ authState: "unknown" })).toBe(false);
    expect(isSavedEnvironmentAwaitingRepair(undefined)).toBe(false);
  });
});
