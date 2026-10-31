import { AuthSessionId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  ServerClientSessionRecord,
  ServerPairingLinkRecord,
} from "@ryco/client-runtime/connection";
import {
  type AddDeviceCode,
  type AddDeviceOperations,
  codeToRevokeOnNewCode,
  formatCodeCountdown,
  groupPairingCode,
  observeAccess,
  replaceCode,
  resolveAddDeviceView,
  type ShownCode,
  showCode,
} from "./AddDeviceDialog.logic";

const CREATED_AT = "2036-04-07T10:00:00.000Z";
const CREATED_MS = Date.parse(CREATED_AT);
const FIVE_MINUTES_MS = 5 * 60 * 1_000;

function code(overrides: Partial<AddDeviceCode> = {}): AddDeviceCode {
  return {
    id: "link-1",
    credential: "ABCD2345EFGH",
    label: null,
    expiresAt: new Date(CREATED_MS + FIVE_MINUTES_MS).toISOString(),
    ...overrides,
  };
}

function listed(entry: AddDeviceCode): ServerPairingLinkRecord {
  return {
    id: entry.id,
    credential: entry.credential,
    role: "client",
    subject: "one-time-token",
    ...(entry.label === null ? {} : { label: entry.label }),
    createdAt: CREATED_AT,
    expiresAt: entry.expiresAt,
  };
}

function session(
  overrides: Omit<Partial<ServerClientSessionRecord>, "sessionId"> & { readonly sessionId: string },
): ServerClientSessionRecord {
  return {
    subject: "one-time-token",
    role: "client",
    method: "bearer-session-token",
    client: { deviceType: "mobile", os: "iOS" },
    issuedAt: new Date(CREATED_MS + 30_000).toISOString(),
    expiresAt: "2036-05-07T10:00:00.000Z",
    lastConnectedAt: null,
    connected: true,
    current: false,
    ...overrides,
    sessionId: AuthSessionId.make(overrides.sessionId),
  };
}

const owner = session({
  sessionId: "owner",
  role: "owner",
  current: true,
  issuedAt: "2036-04-01T00:00:00.000Z",
  client: { deviceType: "desktop", label: "This Mac" },
});

/** The code as the dialog holds it after the listing showed it. */
function listedShown(entry: AddDeviceCode = code()): ShownCode {
  return observeAccess(showCode(entry), {
    pairingLinks: [listed(entry)],
    clientSessions: [owner],
    nowMs: CREATED_MS,
  });
}

/** Fake operations that record every call: the only reach the dialog has. */
function recordingOperations(options: { readonly failRevoke?: boolean } = {}) {
  const calls: Array<{ readonly name: keyof AddDeviceOperations; readonly arg: string | null }> =
    [];
  let minted = 0;
  const operations: AddDeviceOperations = {
    createCode: async (label) => {
      calls.push({ name: "createCode", arg: label });
      minted += 1;
      return code({ id: `link-${minted + 1}`, label });
    },
    revokeCode: async (id) => {
      calls.push({ name: "revokeCode", arg: id });
      if (options.failRevoke) throw new Error("offline");
    },
  };
  return { operations, calls };
}

describe("resolveAddDeviceView", () => {
  it("shows the minted code with its countdown", async () => {
    const { operations, calls } = recordingOperations();
    const result = await replaceCode({ operations, shown: null, nowMs: CREATED_MS, label: null });

    expect(calls).toEqual([{ name: "createCode", arg: null }]);
    expect(result.kind).toBe("minted");
    if (result.kind !== "minted") return;
    expect(
      resolveAddDeviceView({
        shown: showCode(result.code),
        reachable: true,
        clientSessions: [owner],
        nowMs: CREATED_MS,
      }),
    ).toEqual({ kind: "code", countdown: "5:00" });
  });

  it("turns expired once a tick passes expiresAt", () => {
    const shown = listedShown();
    const input = { shown, reachable: true, clientSessions: [owner] };
    expect(resolveAddDeviceView({ ...input, nowMs: CREATED_MS + FIVE_MINUTES_MS - 1 })).toEqual({
      kind: "code",
      countdown: "0:01",
    });
    expect(resolveAddDeviceView({ ...input, nowMs: CREATED_MS + FIVE_MINUTES_MS })).toEqual({
      kind: "expired",
    });
  });

  it("shows the device as joined when the code left the listing and a new session arrived", () => {
    const phone = session({ sessionId: "phone", client: { deviceType: "mobile", os: "iOS" } });
    const shown = observeAccess(listedShown(), {
      pairingLinks: [],
      clientSessions: [owner, phone],
      nowMs: CREATED_MS,
    });

    expect(shown).toMatchObject({ removed: true, joinedSessionId: "phone" });
    expect(
      resolveAddDeviceView({ shown, reachable: true, clientSessions: [owner, phone], nowMs: 0 }),
    ).toEqual({ kind: "joined", deviceName: "The phone" });
  });

  it("names the joined device by the code's label, and ignores older sessions", () => {
    const labelled = code({ label: "Living room iPad" });
    const older = session({
      sessionId: "older",
      issuedAt: new Date(CREATED_MS - 1).toISOString(),
      client: { deviceType: "tablet", label: "Old iPad" },
    });
    const other = session({ sessionId: "other", client: { deviceType: "desktop" } });
    const ipad = session({
      sessionId: "ipad",
      client: { deviceType: "tablet", label: "Living room iPad" },
    });
    const clientSessions = [owner, older, ipad, other];
    const shown = observeAccess(listedShown(labelled), { pairingLinks: [], clientSessions });

    expect(resolveAddDeviceView({ shown, reachable: true, clientSessions, nowMs: 0 })).toEqual({
      kind: "joined",
      deviceName: "Living room iPad",
    });
  });

  it("shows withdrawn when the code left the listing with no new session", () => {
    const shown = observeAccess(listedShown(), {
      pairingLinks: [],
      clientSessions: [owner],
      nowMs: CREATED_MS,
    });

    expect(
      resolveAddDeviceView({ shown, reachable: true, clientSessions: [owner], nowMs: CREATED_MS }),
    ).toEqual({ kind: "withdrawn" });
  });

  it("shows used when the session the code made was revoked again", () => {
    const phone = session({ sessionId: "phone" });
    const joined = observeAccess(listedShown(), {
      pairingLinks: [],
      clientSessions: [owner, phone],
      nowMs: CREATED_MS,
    });
    const afterRevoke = observeAccess(joined, {
      pairingLinks: [],
      clientSessions: [owner],
      nowMs: CREATED_MS,
    });

    expect(afterRevoke.joinedSessionId).toBe("phone");
    expect(
      resolveAddDeviceView({
        shown: afterRevoke,
        reachable: true,
        clientSessions: [owner],
        nowMs: CREATED_MS,
      }),
    ).toEqual({ kind: "used" });
  });

  it("does not call a code removed before the listing ever showed it", () => {
    // The mint response can arrive before the access stream lists the link.
    const shown = observeAccess(showCode(code()), {
      pairingLinks: [],
      clientSessions: [owner],
      nowMs: CREATED_MS,
    });
    expect(shown.removed).toBe(false);
    expect(
      resolveAddDeviceView({ shown, reachable: true, clientSessions: [owner], nowMs: CREATED_MS }),
    ).toEqual({ kind: "code", countdown: "5:00" });
  });

  it("is unreachable when no endpoint another device can reach exists", () => {
    expect(
      resolveAddDeviceView({ shown: null, reachable: false, clientSessions: [], nowMs: 0 }),
    ).toEqual({ kind: "unreachable" });
  });

  it("returns the same object when the listing brings nothing new", () => {
    const shown = listedShown();
    expect(
      observeAccess(shown, {
        pairingLinks: [listed(shown.code)],
        clientSessions: [owner],
        nowMs: CREATED_MS,
      }),
    ).toBe(shown);
  });
});

describe("New code", () => {
  it("revokes only the code on screen, and only while it is live", async () => {
    const shown = listedShown();
    const live = recordingOperations();
    await replaceCode({ operations: live.operations, shown, nowMs: CREATED_MS, label: null });
    expect(live.calls).toEqual([
      { name: "revokeCode", arg: "link-1" },
      { name: "createCode", arg: null },
    ]);

    const expired = recordingOperations();
    await replaceCode({
      operations: expired.operations,
      shown,
      nowMs: CREATED_MS + FIVE_MINUTES_MS,
      label: null,
    });
    // Not judged by this device's clock: the node may still accept a code this clock calls
    // expired, and its revoke does nothing to an expired one.
    expect(expired.calls).toEqual([
      { name: "revokeCode", arg: "link-1" },
      { name: "createCode", arg: null },
    ]);

    const removed = observeAccess(shown, {
      pairingLinks: [],
      clientSessions: [owner],
      nowMs: CREATED_MS,
    });
    expect(codeToRevokeOnNewCode(removed, CREATED_MS)).toBeNull();
    expect(codeToRevokeOnNewCode(null, CREATED_MS)).toBeNull();
  });

  it("never reads a code that left the list after its expiry as withdrawn or joined", () => {
    const shown = listedShown();
    const afterExpiry = observeAccess(shown, {
      pairingLinks: [],
      clientSessions: [owner],
      nowMs: CREATED_MS + FIVE_MINUTES_MS + 1,
    });
    expect(afterExpiry.removed).toBe(false);
    expect(afterExpiry.joinedSessionId).toBeNull();
  });

  it("keeps the old code and mints nothing when the revoke fails", async () => {
    const { operations, calls } = recordingOperations({ failRevoke: true });
    const result = await replaceCode({
      operations,
      shown: listedShown(),
      nowMs: CREATED_MS,
      label: "Phone",
    });

    expect(result.kind).toBe("revoke-failed");
    expect(calls).toEqual([{ name: "revokeCode", arg: "link-1" }]);
  });

  it("never revokes a session on any path", async () => {
    const { operations, calls } = recordingOperations();
    // The operations the dialog gets have no way to reach sessions.
    expect(Object.keys(operations).toSorted()).toEqual(["createCode", "revokeCode"]);

    const phone = session({ sessionId: "phone" });
    const live = listedShown();
    const joined = observeAccess(live, {
      pairingLinks: [],
      clientSessions: [owner, phone],
      nowMs: CREATED_MS,
    });
    const withdrawn = observeAccess(live, {
      pairingLinks: [],
      clientSessions: [owner],
      nowMs: CREATED_MS,
    });
    for (const shown of [null, live, joined, withdrawn]) {
      for (const nowMs of [CREATED_MS, CREATED_MS + FIVE_MINUTES_MS]) {
        await replaceCode({ operations, shown, nowMs, label: null });
      }
    }

    const revoked = calls.filter((call) => call.name === "revokeCode").map((call) => call.arg);
    // Only the code on screen, at either clock reading: never a session.
    expect(revoked).toEqual(["link-1", "link-1"]);
    expect(revoked).not.toContain("phone");
    expect(revoked).not.toContain("owner");
  });
});

describe("formatting", () => {
  it("counts down in m:ss, rounding up, and stops at the expiry", () => {
    const expiresAt = new Date(CREATED_MS + FIVE_MINUTES_MS).toISOString();
    expect(formatCodeCountdown(expiresAt, CREATED_MS)).toBe("5:00");
    expect(formatCodeCountdown(expiresAt, CREATED_MS + 1_000)).toBe("4:59");
    expect(formatCodeCountdown(expiresAt, CREATED_MS + 1_500)).toBe("4:59");
    expect(formatCodeCountdown(expiresAt, CREATED_MS + FIVE_MINUTES_MS)).toBeNull();
  });

  it("groups the 12-character code in fours", () => {
    expect(groupPairingCode("ABCD2345EFGH")).toEqual(["ABCD", "2345", "EFGH"]);
  });
});
