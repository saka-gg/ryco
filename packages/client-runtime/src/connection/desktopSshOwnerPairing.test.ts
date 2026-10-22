import { describe, expect, it } from "vite-plus/test";

import {
  desktopSshMutateBlockedReason,
  shouldRepairDesktopSshAsOwner,
  type DesktopSshOwnerRepairInput,
} from "./desktopSshOwnerPairing.ts";

const clientSshConnect: DesktopSshOwnerRepairInput = {
  desktopSsh: true,
  sessionRole: "client",
  bearerIssuedThisConnect: false,
  ownerRepairAttempted: false,
};

describe("shouldRepairDesktopSshAsOwner", () => {
  it("re-pairs a Desktop SSH environment that presents a client bearer", () => {
    expect(shouldRepairDesktopSshAsOwner(clientSshConnect)).toBe(true);
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

  it("re-pairs once: not after a bearer this connect minted, nor after an earlier attempt", () => {
    expect(
      shouldRepairDesktopSshAsOwner({ ...clientSshConnect, bearerIssuedThisConnect: true }),
    ).toBe(false);
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, ownerRepairAttempted: true })).toBe(
      false,
    );
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
