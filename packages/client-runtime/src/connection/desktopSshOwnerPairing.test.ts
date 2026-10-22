import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_SSH_OWNER_REPAIR_RETRY_MS,
  desktopSshMutateBlockedReason,
  shouldRepairDesktopSshAsOwner,
  type DesktopSshOwnerRepairInput,
} from "./desktopSshOwnerPairing.ts";

const NOW = 1_800_000_000_000;

const clientSshConnect: DesktopSshOwnerRepairInput = {
  desktopSsh: true,
  sessionRole: "client",
  bearerIssuedThisConnect: false,
  lastOutcome: undefined,
  serverVersion: "0.1.30",
  now: NOW,
};

describe("shouldRepairDesktopSshAsOwner", () => {
  it("re-pairs a Desktop SSH environment that presents a client bearer", () => {
    expect(shouldRepairDesktopSshAsOwner(clientSshConnect)).toBe(true);
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, serverVersion: null })).toBe(true);
  });

  it("leaves owner bearers and an unknown role alone", () => {
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, sessionRole: "owner" })).toBe(
      false,
    );
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, sessionRole: undefined })).toBe(
      false,
    );
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, sessionRole: null })).toBe(false);
  });

  it("never re-pairs an environment that is not reached over Desktop SSH", () => {
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, desktopSsh: false })).toBe(false);
  });

  it("never re-pairs a client bearer this connect minted", () => {
    expect(
      shouldRepairDesktopSshAsOwner({ ...clientSshConnect, bearerIssuedThisConnect: true }),
    ).toBe(false);
  });

  it("asks a remote CLI that could not mint owner credentials again only on another Ryco version", () => {
    const unsupported = {
      ...clientSshConnect,
      lastOutcome: { kind: "unsupported", serverVersion: "0.1.30" },
    } as const;
    expect(shouldRepairDesktopSshAsOwner(unsupported)).toBe(false);
    expect(shouldRepairDesktopSshAsOwner({ ...unsupported, now: NOW + 24 * 60 * 60_000 })).toBe(
      false,
    );
    // The node was updated: its CLI may mint owner credentials now.
    expect(shouldRepairDesktopSshAsOwner({ ...unsupported, serverVersion: "0.1.36" })).toBe(true);
    // A version that cannot be read now proves nothing.
    expect(shouldRepairDesktopSshAsOwner({ ...unsupported, serverVersion: null })).toBe(false);
    // Found before the version could be read: the first known one is asked again.
    expect(
      shouldRepairDesktopSshAsOwner({
        ...unsupported,
        lastOutcome: { kind: "unsupported", serverVersion: null },
      }),
    ).toBe(true);
  });

  it("retries a failed re-pair once its retry delay has passed, whatever the version", () => {
    const failed = {
      ...clientSshConnect,
      lastOutcome: { kind: "failed", at: NOW },
    } as const;
    expect(shouldRepairDesktopSshAsOwner(failed)).toBe(false);
    expect(
      shouldRepairDesktopSshAsOwner({
        ...failed,
        now: NOW + DESKTOP_SSH_OWNER_REPAIR_RETRY_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldRepairDesktopSshAsOwner({ ...failed, now: NOW + DESKTOP_SSH_OWNER_REPAIR_RETRY_MS }),
    ).toBe(true);
  });
});

describe("desktopSshMutateBlockedReason", () => {
  it("asks for a Ryco update on a Desktop SSH node still on a client session", () => {
    expect(
      desktopSshMutateBlockedReason({ desktopSsh: true, role: "client", label: "Mac mini" }),
    ).toBe("Update Ryco on Mac mini to copy projects here");
  });

  it("blocks nothing for owner sessions, unknown roles or other saved environments", () => {
    expect(
      desktopSshMutateBlockedReason({ desktopSsh: true, role: "owner", label: "Mac mini" }),
    ).toBeNull();
    expect(
      desktopSshMutateBlockedReason({ desktopSsh: true, role: null, label: "Mac mini" }),
    ).toBeNull();
    expect(
      desktopSshMutateBlockedReason({ desktopSsh: false, role: "client", label: "Mac mini" }),
    ).toBeNull();
  });
});
