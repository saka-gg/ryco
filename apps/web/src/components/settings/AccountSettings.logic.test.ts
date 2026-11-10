import { describe, expect, it } from "vite-plus/test";
import {
  HostedHubApiError,
  PASSKEY_SESSION_REQUIRED_CODE,
  STEP_UP_REQUIRED_CODE,
  type HostedAccountOutcome,
  type HostedAccountRefused,
  type HostedHubPasskey,
} from "@ryco/client-runtime/authorization";

import {
  accountPosture,
  activePasskeys,
  emailIssue,
  formatRecoveryCodesForClipboard,
  inlineErrorMessage,
  isPasskeyRevoked,
  isPasskeySessionRequired,
  isStepUpRefusal,
  isSubmittableTotpCode,
  normalizePasskeyLabel,
  normalizeTotpCode,
  orderPasskeys,
  passkeyBackupSummary,
  passkeyDisplayLabel,
  passwordIssue,
  shouldRetryStepUp,
  stepUpDescription,
  syncedPasskeyCount,
  stepUpTitle,
  STEP_UP_INFERRED_ATTEMPT_LIMIT,
  TOTP_CODE_MAX_LENGTH,
} from "./AccountSettings.logic";

function passkey(overrides: Partial<HostedHubPasskey> = {}): HostedHubPasskey {
  return {
    id: "pkey_aaaaaaaaaaaaaaaaaaaaaa",
    label: "Work laptop",
    createdAt: 1_700_000_000_000,
    lastUsedAt: null,
    backupEligible: null,
    backupState: null,
    revokedAt: null,
    revocationReasonCode: null,
    ...overrides,
  };
}

function refused(overrides: Partial<HostedAccountRefused> = {}): HostedAccountRefused {
  return {
    status: "refused",
    reason: "request-failed",
    errorCode: null,
    wireErrorCode: null,
    inferredErrorCode: false,
    errorMessage: null,
    ...overrides,
  };
}

/** What the runtime hands back when it narrowed a bare `forbidden` on a step-up route. */
function inferredStepUpRefusal(): HostedAccountRefused {
  return refused({
    errorCode: STEP_UP_REQUIRED_CODE,
    wireErrorCode: "forbidden",
    inferredErrorCode: true,
    errorMessage: new HostedHubApiError(STEP_UP_REQUIRED_CODE, 403).message,
  });
}

describe("step-up classification", () => {
  it("branches on the code, not on the message the runtime happens to word", () => {
    // The message is display copy from the runtime's own error constructor and
    // may be reworded at any time; a surface that string-matched it would lose a
    // security branch to a copy edit.
    const reworded = refused({
      errorCode: STEP_UP_REQUIRED_CODE,
      wireErrorCode: "forbidden",
      inferredErrorCode: true,
      errorMessage: "Some entirely different wording.",
    });
    expect(isStepUpRefusal(reworded)).toBe(true);

    const impostor = refused({
      errorCode: "forbidden",
      wireErrorCode: "forbidden",
      errorMessage: new HostedHubApiError(STEP_UP_REQUIRED_CODE, 403).message,
    });
    expect(isStepUpRefusal(impostor), "the step-up message alone must not open a prompt").toBe(
      false,
    );
  });

  it("never mistakes another refusal for a step-up", () => {
    for (const code of [
      "conflict",
      "forbidden",
      "unauthorized",
      "rate_limited",
      "authentication_failed",
      "invalid_response",
      PASSKEY_SESSION_REQUIRED_CODE,
    ]) {
      expect(isStepUpRefusal(refused({ errorCode: code }))).toBe(false);
    }
    expect(isStepUpRefusal(refused())).toBe(false);
  });

  it("never reads a committed outcome as a refusal", () => {
    const committed: HostedAccountOutcome = { status: "committed" };
    expect(isStepUpRefusal(committed)).toBe(false);
  });

  it("recognises the passkey-session gate, which has no step-up out of it", () => {
    expect(isPasskeySessionRequired(PASSKEY_SESSION_REQUIRED_CODE)).toBe(true);
    expect(isPasskeySessionRequired(STEP_UP_REQUIRED_CODE)).toBe(false);
    expect(isPasskeySessionRequired("forbidden")).toBe(false);
    expect(isPasskeySessionRequired(null)).toBe(false);
    expect(isPasskeySessionRequired(undefined)).toBe(false);
  });
});

describe("inferred step-up refusals", () => {
  it("bounds a prompt built on a code the Hub never sent", () => {
    // `step_up_required` is synthesised from a bare `forbidden`. When the 403 was
    // really a role check, a lockout, or a gateway, no code can ever satisfy the
    // prompt — so it must stop asking rather than loop.
    const refusal = inferredStepUpRefusal();
    expect(refusal.inferredErrorCode).toBe(true);
    expect(shouldRetryStepUp(refusal, 1)).toBe(true);
    expect(shouldRetryStepUp(refusal, STEP_UP_INFERRED_ATTEMPT_LIMIT - 1)).toBe(true);
    expect(shouldRetryStepUp(refusal, STEP_UP_INFERRED_ATTEMPT_LIMIT)).toBe(false);
    expect(shouldRetryStepUp(refusal, STEP_UP_INFERRED_ATTEMPT_LIMIT + 1)).toBe(false);
  });

  it("still allows enough attempts for a mistyped or just-expired code", () => {
    // Codes rotate every 30 seconds. Giving up on the first refusal would fail
    // the users the prompt exists for.
    expect(STEP_UP_INFERRED_ATTEMPT_LIMIT).toBeGreaterThan(1);
  });

  it("does not bound a code the Hub actually sent", () => {
    // A wire code is authoritative: it means what it says, and only the user's
    // code is in question, so the prompt can keep asking.
    const authoritative = refused({
      errorCode: STEP_UP_REQUIRED_CODE,
      wireErrorCode: STEP_UP_REQUIRED_CODE,
      inferredErrorCode: false,
    });
    expect(shouldRetryStepUp(authoritative, STEP_UP_INFERRED_ATTEMPT_LIMIT * 10)).toBe(true);
  });
});

describe("inline error suppression", () => {
  const message = new HostedHubApiError(STEP_UP_REQUIRED_CODE, 403).message;

  it("withholds the step-up refusal while the prompt is carrying it", () => {
    expect(inlineErrorMessage(message, STEP_UP_REQUIRED_CODE, true)).toBeNull();
  });

  it("shows the step-up refusal once the prompt is gone, since nothing else would", () => {
    expect(inlineErrorMessage(message, STEP_UP_REQUIRED_CODE, false)).toBe(message);
  });

  it("never hides an unrelated failure, whatever its message says", () => {
    expect(inlineErrorMessage("Hub is temporarily unavailable.", "internal_error", true)).toBe(
      "Hub is temporarily unavailable.",
    );
    // A refusal that never reached the Hub carries no code at all.
    expect(inlineErrorMessage("Another account change is still in progress.", null, true)).toBe(
      "Another account change is still in progress.",
    );
    expect(inlineErrorMessage(message, "forbidden", true)).toBe(message);
    expect(inlineErrorMessage(null, STEP_UP_REQUIRED_CODE, true)).toBeNull();
  });
});

describe("passkey presentation", () => {
  it("reports revoked credentials rather than hiding them, and excludes them from the usable count", () => {
    const revoked = passkey({ id: "pkey_bbbbbbbbbbbbbbbbbbbbbb", revokedAt: 1 });
    expect(isPasskeyRevoked(revoked)).toBe(true);
    expect(activePasskeys([passkey(), revoked])).toHaveLength(1);
  });

  it("distinguishes unlabelled credentials by their public id", () => {
    const a = passkey({ id: "pkey_aaaaaaaaaaaaaaaaaaaaaa", label: null });
    const b = passkey({ id: "pkey_bbbbbbbbbbbbbbbbbbbbbb", label: "   " });
    expect(passkeyDisplayLabel(a)).not.toBe(passkeyDisplayLabel(b));
    expect(passkeyDisplayLabel(passkey({ label: " Work laptop " }))).toBe("Work laptop");
  });

  it("never renders an unreported backup state as 'not backed up'", () => {
    expect(passkeyBackupSummary(passkey())).toBeNull();
    expect(passkeyBackupSummary(passkey({ backupState: true }))).toMatch(/synced/i);
    expect(passkeyBackupSummary(passkey({ backupEligible: true }))).toMatch(/not yet backed up/i);
    expect(passkeyBackupSummary(passkey({ backupEligible: false }))).toMatch(/this device only/i);
  });

  it("omits a blank label rather than sending one the Hub rejects", () => {
    expect(normalizePasskeyLabel("   ")).toBeNull();
    expect(normalizePasskeyLabel("")).toBeNull();
    expect(normalizePasskeyLabel("  Phone  ")).toBe("Phone");
  });
});

describe("TOTP code input", () => {
  it("strips the separators authenticator apps and pastes carry", () => {
    expect(normalizeTotpCode("123 456")).toBe("123456");
    expect(normalizeTotpCode("123-456")).toBe("123456");
    expect(normalizeTotpCode(" 123456\n")).toBe("123456");
  });

  it("stays inside the Hub's bound", () => {
    expect(normalizeTotpCode("1".repeat(64))).toHaveLength(TOTP_CODE_MAX_LENGTH);
  });

  it("refuses to submit a code that cannot be one", () => {
    expect(isSubmittableTotpCode("")).toBe(false);
    expect(isSubmittableTotpCode("12345")).toBe(false);
    expect(isSubmittableTotpCode("abcdef")).toBe(false);
    expect(isSubmittableTotpCode("123456")).toBe(true);
    expect(isSubmittableTotpCode("123 456")).toBe(true);
  });
});

describe("credential input validation", () => {
  it("owns the confirmation match and leaves strength to the Hub", () => {
    expect(passwordIssue("", "")).toMatch(/enter a password/i);
    expect(passwordIssue("correct horse", "")).toMatch(/re-enter/i);
    expect(passwordIssue("correct horse", "correct horsf")).toMatch(/do not match/i);
    expect(passwordIssue("a", "a")).toBeNull();
    expect(passwordIssue("x".repeat(257), "x".repeat(257))).toMatch(/256/);
  });

  it("checks email structurally without second-guessing deliverability", () => {
    expect(emailIssue("")).toMatch(/enter an email/i);
    expect(emailIssue("not-an-email")).toMatch(/valid email/i);
    expect(emailIssue("ada@example.com")).toBeNull();
    expect(emailIssue("  ada@example.com  ")).toBeNull();
    expect(emailIssue("ada+tag@sub.example.co.uk")).toBeNull();
    expect(emailIssue(`${"a".repeat(250)}@example.com`)).toMatch(/254/);
  });
});

describe("recovery-code clipboard form", () => {
  it("is one code per line", () => {
    expect(formatRecoveryCodesForClipboard(["aaa", "bbb"])).toBe("aaa\nbbb");
    expect(formatRecoveryCodesForClipboard([])).toBe("");
  });
});

describe("step-up prompt copy", () => {
  it("names the action being confirmed", () => {
    expect(stepUpTitle("regenerate-recovery-codes")).toMatch(/recovery codes/i);
    expect(stepUpTitle("set-password")).toMatch(/password/i);
  });

  it("does not claim to know whether the first code was wrong or missing", () => {
    const first = stepUpDescription(0, false);
    const retry = stepUpDescription(1, false);
    expect(first).not.toBe(retry);
    expect(first).toMatch(/asked for a code/i);
    expect(retry).toMatch(/not accepted/i);
  });

  it("never asserts how the session was created when the step-up code was inferred", () => {
    // `step_up_required` is synthesised client-side from a bare 403; the Hub
    // never sends it. Saying "this session was not started with a passkey" is
    // therefore a guess rendered as a finding, and it is false whenever the 403
    // came from a role check, a disabled account, or a gateway. This is the one
    // assertion that pins the whole fix.
    for (const attempts of [0, 1, 5]) {
      const copy = stepUpDescription(attempts, true);
      expect(copy).not.toMatch(/not started with a passkey/i);
      expect(copy).not.toMatch(/this session was/i);
    }
  });

  it("distinguishes a refusal the Hub explained from one this client inferred", () => {
    expect(stepUpDescription(0, true)).not.toBe(stepUpDescription(0, false));
    expect(stepUpDescription(1, true)).not.toBe(stepUpDescription(1, false));
    // The inferred cells name the inference as an inference and still say what
    // to try, rather than going silent or repeating a claim they cannot back.
    expect(stepUpDescription(0, true)).toMatch(/without saying why/i);
    expect(stepUpDescription(1, true)).toMatch(/may not be about the code/i);
    expect(stepUpDescription(1, true)).toMatch(/code showing now/i);
  });
});

describe("passkey ordering", () => {
  it("keeps revoked credentials in the list, below the usable ones", () => {
    // Revoked keys are never filtered — the list is the only place a user
    // learns why a device stopped working — but a dead credential between two
    // live ones makes the usable set impossible to count at a glance.
    const ordered = orderPasskeys([
      passkey({ id: "pkey_a", label: "Dead", revokedAt: 2 }),
      passkey({ id: "pkey_b", label: "Live" }),
      passkey({ id: "pkey_c", label: "Also dead", revokedAt: 3 }),
      passkey({ id: "pkey_d", label: "Also live" }),
    ]);
    expect(ordered.map((entry) => entry.label)).toEqual(["Live", "Also live", "Dead", "Also dead"]);
    expect(ordered).toHaveLength(4);
  });

  it("does not mutate the store's array", () => {
    const input = [passkey({ id: "pkey_a", revokedAt: 2 }), passkey({ id: "pkey_b" })];
    orderPasskeys(input);
    expect(input.map((entry) => entry.id)).toEqual(["pkey_a", "pkey_b"]);
  });
});

describe("synced passkey count", () => {
  it("counts only credentials the Hub positively reported as synced", () => {
    expect(
      syncedPasskeyCount([
        passkey({ id: "pkey_a", backupState: true }),
        passkey({ id: "pkey_b", backupState: false }),
        passkey({ id: "pkey_c", backupState: null }),
        // Revoked credentials cannot protect anything, synced or not.
        passkey({ id: "pkey_d", backupState: true, revokedAt: 2 }),
      ]),
    ).toBe(1);
  });

  it("returns zero for a set the Hub said nothing about, which the caller must not render", () => {
    expect(syncedPasskeyCount([passkey({ backupState: null, backupEligible: null })])).toBe(0);
  });
});

describe("account posture", () => {
  it("never scores a list that is loading or could not be refreshed", () => {
    // Warning about a credential set the surface cannot see is worse than
    // silence: the user has no way to tell the warning from a real finding.
    for (const status of ["loading", "stale", "idle"]) {
      expect(accountPosture([], status)).toBeNull();
      expect(accountPosture([passkey()], status)).toBeNull();
    }
  });

  it("escalates only on the one input the client can actually read", () => {
    expect(accountPosture([], "ready")?.variant).toBe("warning");
    expect(accountPosture([passkey()], "ready")?.variant).toBe("info");
    expect(
      accountPosture([passkey({ id: "pkey_a" }), passkey({ id: "pkey_b" })], "ready"),
    ).toBeNull();
  });

  it("treats revoked credentials as absent", () => {
    expect(accountPosture([passkey({ revokedAt: 2 })], "ready")?.variant).toBe("warning");
  });

  it("has no positive state, because a green claim would need facts the client cannot see", () => {
    // Two-factor enrolment, whether a password is set, and whether an address
    // is on file are all unreadable. Silence is the only honest rendering of
    // "nothing is wrong that I can detect".
    const many = [0, 1, 2, 3, 4].map((index) => passkey({ id: `pkey_${String(index)}` }));
    expect(accountPosture(many, "ready")).toBeNull();
  });

  it("names no recovery path this Hub cannot deliver", () => {
    // The same panel, fourteen rows below this alert, says the Hub has no mail
    // transport configured, that verification messages are generated and
    // discarded, and not to rely on email as the way back in. The alert is what
    // a user reads first, at the exact moment they are deciding whether they
    // have a way back into the account, so it may not offer a path that
    // provably does not work.
    for (const passkeys of [[], [passkey()]]) {
      const description = accountPosture(passkeys, "ready")?.description ?? "";
      expect(description.toLowerCase(), "the posture alert offers an email path").not.toContain(
        "email",
      );
      expect(description.toLowerCase(), "the posture alert offers an email path").not.toContain(
        "mail",
      );
    }
  });

  it("labels its action distinctly from the Passkeys section's own control", () => {
    // Two buttons on one page with the same accessible name and the same
    // destination are an ambiguity for voice control and for anyone listing
    // the page's controls.
    expect(accountPosture([], "ready")?.actionLabel).not.toBe("Add passkey");
    expect(accountPosture([passkey()], "ready")?.actionLabel).not.toBe("Add passkey");
    expect(accountPosture([], "ready")?.actionLabel).not.toBe(
      accountPosture([passkey()], "ready")?.actionLabel,
    );
  });
});
