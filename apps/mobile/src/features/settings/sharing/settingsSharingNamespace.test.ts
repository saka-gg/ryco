import { describe, expect, it } from "vite-plus/test";

import { mobileSettingsSharingNamespace } from "./settingsSharingNamespace";

describe("the phone's sharing namespace", () => {
  it("is the signed-in account at its Hub, else the phone's own connections", () => {
    expect(
      mobileSettingsSharingNamespace(
        { accountStatus: "authenticated", account: { id: "acct-1" } },
        "https://hub.example",
      ),
    ).toEqual({ kind: "hosted", hubOrigin: "https://hub.example", accountId: "acct-1" });
    expect(
      mobileSettingsSharingNamespace(
        { accountStatus: "signed-out", account: { id: "acct-1" } },
        "https://hub.example",
      ),
    ).toEqual({ kind: "local" });
    expect(
      mobileSettingsSharingNamespace({ accountStatus: "authenticated", account: null }, undefined),
    ).toEqual({ kind: "local" });
  });
});
