import { describe, expect, it } from "vitest";

import {
  SAVED_HUB_SESSION_NOTE,
  SAVED_HUB_SESSION_TITLE,
  deriveSavedHubSessionView,
  type SavedHubSessionFacts,
} from "./savedHubSessionModel";

const offlineLaunch: SavedHubSessionFacts = {
  accountStatus: "unavailable",
  errorReason: "transport-unavailable",
  savedSession: true,
  entryScreen: true,
  signInRequested: false,
};

describe("saved Hub session on the locked identity screen", () => {
  it("waits for the Hub instead of asking for a sign-in after an offline launch", () => {
    expect(deriveSavedHubSessionView(offlineLaunch)).toEqual({
      kind: "reconnecting",
      title: SAVED_HUB_SESSION_TITLE,
      detail: "Ryco could not reach the Hub. Check your connection and try again.",
      note: SAVED_HUB_SESSION_NOTE,
    });
  });

  it("explains the bounded failure reason, with a fallback when there is none", () => {
    expect(
      deriveSavedHubSessionView({ ...offlineLaunch, errorReason: "request-timeout" }),
    ).toMatchObject({
      kind: "reconnecting",
      detail: "The Hub did not respond in time. Check your connection and try again.",
    });
    expect(deriveSavedHubSessionView({ ...offlineLaunch, errorReason: null })).toMatchObject({
      kind: "reconnecting",
      detail: "Ryco could not reach your Hub.",
    });
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
