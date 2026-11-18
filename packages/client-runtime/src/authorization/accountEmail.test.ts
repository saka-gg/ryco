import { describe, expect, it } from "vitest";

import { pendingEmailVerification } from "./accountEmail.ts";

const NOW = 1_800_000_000_000;
const verified = { address: "ada@example.test", verified: true } as const;

describe("pendingEmailVerification", () => {
  it("reports a requested change of a verified address as a change", () => {
    expect(
      pendingEmailVerification(
        { email: verified, pendingAddress: "lovelace@example.test", pendingExpiresAt: NOW + 1 },
        NOW,
      ),
    ).toEqual({ address: "lovelace@example.test", expiresAt: NOW + 1, change: true });
  });

  it("reports the never-verified address itself as a first verification", () => {
    expect(
      pendingEmailVerification(
        {
          email: { address: "ada@example.test", verified: false },
          pendingAddress: "ada@example.test",
          pendingExpiresAt: NOW + 1,
        },
        NOW,
      ),
    ).toEqual({ address: "ada@example.test", expiresAt: NOW + 1, change: false });
  });

  it("shows nothing when nothing is pending, the read is unknown, or the mail expired", () => {
    expect(pendingEmailVerification(null, NOW)).toBeNull();
    expect(pendingEmailVerification(undefined, NOW)).toBeNull();
    expect(
      pendingEmailVerification(
        { email: verified, pendingAddress: null, pendingExpiresAt: null },
        NOW,
      ),
    ).toBeNull();
    expect(
      pendingEmailVerification(
        { email: verified, pendingAddress: "lovelace@example.test", pendingExpiresAt: NOW },
        NOW,
      ),
    ).toBeNull();
  });
});
