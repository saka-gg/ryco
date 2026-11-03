import { describe, expect, it } from "vitest";

import {
  pendingApprovalOffersAcceptForSession,
  pendingApprovalReason,
} from "./approvalPresentation.ts";

describe("pendingApprovalReason", () => {
  it("shows the provider's reason only when it says something new", () => {
    expect(
      pendingApprovalReason({ detail: "Bash: git push", reason: " Pushing needs your OK " }),
    ).toBe("Pushing needs your OK");
    expect(
      pendingApprovalReason({ detail: "Bash: git push", reason: "Bash: git push" }),
    ).toBeNull();
    expect(pendingApprovalReason({ detail: "Bash: git push", reason: "   " })).toBeNull();
    expect(pendingApprovalReason({ detail: "Bash: git push" })).toBeNull();
  });
});

describe("pendingApprovalOffersAcceptForSession", () => {
  it("offers the session grant unless the provider refused it", () => {
    expect(pendingApprovalOffersAcceptForSession({})).toBe(true);
    expect(pendingApprovalOffersAcceptForSession({ acceptForSessionOffered: false })).toBe(false);
  });
});
