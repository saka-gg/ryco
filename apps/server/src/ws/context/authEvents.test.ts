import { AuthSessionId } from "@ryco/contracts";
import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";

import { OWNER_BOOTSTRAP_PAIRING_SUBJECT } from "../../auth/Services/AuthControlPlane.ts";
import { isListedAuthAccessChange } from "./authEvents.ts";

const pairingLink = (input: { readonly role: "owner" | "client"; readonly subject: string }) => ({
  id: "pairing-1",
  credential: "secret",
  role: input.role,
  subject: input.subject,
  createdAt: DateTime.fromDateUnsafe(new Date("2026-10-22T09:00:00.000Z")),
  expiresAt: DateTime.fromDateUnsafe(new Date("2026-10-22T09:05:00.000Z")),
});

describe("isListedAuthAccessChange", () => {
  it("streams client and owner links but not the startup owner link", () => {
    expect(
      isListedAuthAccessChange({
        type: "pairingLinkUpserted",
        pairingLink: pairingLink({ role: "client", subject: "one-time-token" }),
      }),
    ).toBe(true);
    expect(
      isListedAuthAccessChange({
        type: "pairingLinkUpserted",
        pairingLink: pairingLink({ role: "owner", subject: "one-time-token" }),
      }),
    ).toBe(true);
    expect(
      isListedAuthAccessChange({
        type: "pairingLinkUpserted",
        pairingLink: pairingLink({ role: "owner", subject: OWNER_BOOTSTRAP_PAIRING_SUBJECT }),
      }),
    ).toBe(false);
  });

  it("streams removals and client changes", () => {
    expect(isListedAuthAccessChange({ type: "pairingLinkRemoved", id: "pairing-1" })).toBe(true);
    expect(
      isListedAuthAccessChange({
        type: "clientRemoved",
        sessionId: AuthSessionId.make("session-1"),
        chainId: AuthSessionId.make("session-1"),
        reason: "revoked",
      }),
    ).toBe(true);
  });
});
