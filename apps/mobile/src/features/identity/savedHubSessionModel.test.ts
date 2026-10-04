import { describe, expect, it } from "vitest";

import {
  SAVED_HUB_SESSION_NOTE,
  SAVED_HUB_SESSION_REFUSED_NOTE,
  SAVED_HUB_SESSION_REFUSED_TITLE,
  SAVED_HUB_SESSION_TITLE,
  deriveSavedHubSessionView,
  type SavedHubSessionFacts,
} from "./savedHubSessionModel";

const offlineLaunch: SavedHubSessionFacts = {
  accountStatus: "unavailable",
  errorReason: "transport-unavailable",
  retrying: true,
  savedSession: true,
  entryScreen: true,
  signInRequested: false,
};

describe("saved Hub session on the locked identity screen", () => {
  it("waits for the Hub instead of asking for a sign-in after an offline launch", () => {
    expect(deriveSavedHubSessionView(offlineLaunch)).toEqual({
      kind: "saved-session",
      title: SAVED_HUB_SESSION_TITLE,
      detail: "Ryco could not reach the Hub. Check your connection and try again.",
      note: SAVED_HUB_SESSION_NOTE,
      waiting: true,
    });
  });

  it("explains the bounded failure reason, with a fallback when there is none", () => {
    expect(
      deriveSavedHubSessionView({ ...offlineLaunch, errorReason: "request-timeout" }),
    ).toMatchObject({
      kind: "saved-session",
      detail: "The Hub did not respond in time. Check your connection and try again.",
    });
    expect(deriveSavedHubSessionView({ ...offlineLaunch, errorReason: null })).toMatchObject({
      kind: "saved-session",
      detail: "Ryco could not reach your Hub.",
    });
  });

  it("does not promise an automatic retry after a definite Hub answer", () => {
    // A 403 from a WAF or a Hub refusing the account: nothing is scheduled.
    expect(
      deriveSavedHubSessionView({ ...offlineLaunch, errorReason: null, retrying: false }),
    ).toEqual({
      kind: "saved-session",
      title: SAVED_HUB_SESSION_REFUSED_TITLE,
      detail: "The Hub answered, but did not accept this device's saved sign-in right now.",
      note: SAVED_HUB_SESSION_REFUSED_NOTE,
      waiting: false,
    });
    expect(SAVED_HUB_SESSION_REFUSED_NOTE).not.toMatch(/keeps trying/);
  });

  it.each([
    ["no saved session", { savedSession: false }],
    ["the user chose another sign-in", { signInRequested: true }],
    ["a ceremony already in progress", { entryScreen: false }],
    ["a rejected session", { accountStatus: "session-expired" as const }],
    ["a signed-out device", { accountStatus: "signed-out" as const }],
    ["an authenticated account", { accountStatus: "authenticated" as const }],
  ])("shows the sign-in form for %s", (_label, facts) => {
    expect(deriveSavedHubSessionView({ ...offlineLaunch, ...facts })).toEqual({
      kind: "sign-in",
    });
  });
});
