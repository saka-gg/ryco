import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { DESKTOP_WORKSPACE_IPC } from "./desktopWorkspaceChannels.ts";

const source = (name: string) => readFileSync(join(import.meta.dirname, name), "utf8");

describe("Desktop workspace IPC boundary", () => {
  it("exposes only bounded projections, opaque handles, and scoped commands", () => {
    const ipc = source("desktopWorkspaceIpc.ts");
    const preload = source("preload.ts");

    expect(Object.keys(DESKTOP_WORKSPACE_IPC)).toEqual([
      "getState",
      "refreshCatalog",
      "renameDevice",
      "publishSnapshot",
      "retainScope",
      "renewScope",
      "releaseScope",
      "setBackgrounded",
      "purgeCache",
      "beginVerification",
      "cancelVerification",
      "verifyApproval",
      "stateChanged",
      "connectionCommand",
      "prepareTransport",
      "activateTransport",
      "sendTransport",
      "closeTransport",
      "reportConnection",
      "transportEvent",
    ]);
    for (const forbidden of [
      "accessToken",
      "refreshToken",
      "dpopProof",
      "privateKey",
      "agreementSecretKey",
      "epochSecretC2N",
      "epochSecretN2C",
      "exporterSecret",
      "serverConfirmationKey",
    ]) {
      expect(ipc).not.toContain(forbidden);
      expect(preload).not.toContain(forbidden);
    }
  });

  it("keeps relay authorization and native handshake material in main", () => {
    const preload = source("preload.ts");
    const relay = source("desktopWorkspaceRelay.ts");
    expect(relay).toContain("HostedRelayEngine");
    expect(relay).toContain("makeRelayE2eeInitiator");
    expect(preload).not.toContain("issueRelayTicket");
    expect(preload).not.toContain("authorizeRelayUpgrade");
    expect(preload).not.toContain("RelayE2eeInitiatorAttempt");
  });

  it("does not expose the former low-level native handshake through preload", () => {
    const preload = source("preload.ts");
    expect(preload).not.toContain("prepareNativeE2eeAttempt");
    expect(preload).not.toContain("startNativeE2eeHandshake");
    expect(preload).not.toContain("finishNativeE2eeHandshake");
  });
});
