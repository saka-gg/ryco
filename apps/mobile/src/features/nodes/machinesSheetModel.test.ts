import { describe, expect, it } from "vite-plus/test";

import {
  type DirectMachineFacts,
  directMachineConnectionState,
  forgetMachineConfirm,
  type HubMachineFacts,
  ICON_FOOTER,
  machineDetail,
  machineListRow,
  machineSettingsFooter,
  SWITCHED_OFF_SETTINGS_FOOTER,
} from "./machinesSheetModel";

function direct(overrides: Partial<DirectMachineFacts> = {}): DirectMachineFacts {
  return {
    plane: "direct",
    label: "MacBook Pro",
    host: "127.0.0.1:14144",
    transport: "LAN",
    role: "owner",
    connectionState: "connected",
    statusLabel: "Connected",
    statusDetail: null,
    needsRepair: false,
    switchedOff: false,
    selected: false,
    freezeNotice: null,
    ...overrides,
  };
}

function hub(overrides: Partial<HubMachineFacts> = {}): HubMachineFacts {
  return {
    plane: "hub",
    label: "Studio",
    role: "Owner",
    tone: "connected",
    status: "Online",
    revoked: false,
    offline: false,
    offlineSince: null,
    reach: "Hub relay",
    trustDetail: null,
    directNotice: null,
    routeNotice: null,
    freezeNotice: null,
    selected: false,
    primary: "use",
    canRename: true,
    directAccess: null,
    linked: false,
    canOpenAccess: true,
    canOpenSecurity: false,
    ...overrides,
  };
}

const buttons = (facts: DirectMachineFacts | HubMachineFacts, iconEditable = true) =>
  machineDetail(facts, { iconEditable }).actions.map((action) =>
    action.enabled ? action.label : `(${action.label})`,
  );

describe("Machines sheet list rows", () => {
  it("leads a direct machine's detail line with its status, then reach and address", () => {
    expect(machineListRow(direct())).toMatchObject({
      tone: "connected",
      status: "Connected",
      statusConnecting: false,
      detailRest: " · LAN · 127.0.0.1:14144",
      dimmed: false,
    });
  });

  it("marks connecting amber and dims a switched-off machine", () => {
    expect(
      machineListRow(direct({ connectionState: "connecting", statusLabel: "Connecting" })),
    ).toMatchObject({ tone: "connecting", status: "Connecting…", statusConnecting: true });
    expect(
      machineListRow(
        direct({ switchedOff: true, connectionState: "disconnected", statusLabel: "Switched off" }),
      ),
    ).toMatchObject({ tone: "offline", status: "Switched off", dimmed: true });
  });

  it("words a Hub node by presence, reach and role, and says when it went offline", () => {
    expect(machineListRow(hub())).toMatchObject({ status: "Online", detailRest: " · Hub · Owner" });
    expect(
      machineListRow(hub({ offline: true, offlineSince: "since 14:02", tone: "offline" })),
    ).toMatchObject({ status: "Offline since 14:02", detailRest: " · Owner", tone: "offline" });
    expect(machineListRow(hub({ trustDetail: "Not verified" })).status).toBe(
      "Not verified · Online",
    );
  });

  it("says which machine is in use in its accessible name", () => {
    expect(machineListRow(direct({ selected: true })).accessibilityLabel).toBe(
      "MacBook Pro, Connected · LAN · 127.0.0.1:14144, in use on this phone",
    );
  });
});

describe("Machine page: 4 buttons under the header", () => {
  it("direct, connected and in use: In use, Disconnect, Rename, Access", () => {
    expect(buttons(direct({ selected: true }))).toEqual([
      "(In use)",
      "Disconnect",
      "Rename",
      "Access",
    ]);
  });

  it("direct, connected: Use first", () => {
    expect(buttons(direct())).toEqual(["Use", "Disconnect", "Rename", "Access"]);
  });

  it("direct, disconnected or failed: Connect or Retry, no Disconnect", () => {
    expect(
      buttons(direct({ connectionState: "disconnected", statusLabel: "Disconnected" })),
    ).toEqual(["Connect", "(Disconnect)", "Rename", "Access"]);
    expect(buttons(direct({ connectionState: "error", statusLabel: "Connection failed" }))).toEqual(
      ["Retry", "(Disconnect)", "Rename", "Access"],
    );
  });

  it("direct, needs re-pair: Re-pair first, then Retry", () => {
    expect(
      buttons(
        direct({ connectionState: "error", needsRepair: true, statusLabel: "Needs re-pair" }),
      ),
    ).toEqual(["Re-pair", "Retry", "Rename", "Access"]);
  });

  it("direct, switched off: only Switch on, Rename and Access", () => {
    expect(
      buttons(
        direct({ switchedOff: true, connectionState: "disconnected", statusLabel: "Switched off" }),
      ),
    ).toEqual(["Switch on", "(Disconnect)", "Rename", "Access"]);
  });

  it("Hub: Use, direct access when it can be added or removed, Rename for owners, Access", () => {
    expect(buttons(hub())).toEqual(["Use", "(Add direct)", "Rename", "Access"]);
    expect(buttons(hub({ directAccess: "add", canRename: false }))).toEqual([
      "Use",
      "Add direct",
      "(Rename)",
      "Access",
    ]);
    expect(buttons(hub({ directAccess: "remove", linked: true, selected: true }))).toEqual([
      "(In use)",
      "Remove direct",
      "Rename",
      "Access",
    ]);
  });

  it("Hub, not verified: the first button verifies instead of using it", () => {
    expect(buttons(hub({ primary: "verify", trustDetail: "Not verified" }))[0]).toBe("Verify");
    expect(buttons(hub({ primary: null }))[0]).toBe("(Use)");
  });
});

describe("Machine page groups", () => {
  it("direct: connection facts, the Switched on switch, Disconnect, and Forget last", () => {
    const page = machineDetail(direct({ selected: true }), { iconEditable: true });
    expect(page.statusLine).toBe("Connected · LAN · Direct");
    expect(page.connection).toEqual([
      { kind: "value", label: "Status", value: "Connected" },
      { kind: "value", label: "Reach", value: "LAN · Direct" },
      { kind: "value", label: "Address", value: "127.0.0.1:14144" },
      { kind: "value", label: "Pairing", value: "Owner" },
      { kind: "toggle", label: "Switched on", value: true, enabled: true, action: "switch-off" },
      { kind: "action", label: "Disconnect", action: "disconnect" },
    ]);
    expect(page.forget).toBe(true);
    expect(page.security).toBe(false);
    expect(page.iconFooter).toBeNull();
  });

  it("direct, switched off: the switch turns it on and there is nothing to disconnect", () => {
    const page = machineDetail(
      direct({ switchedOff: true, connectionState: "disconnected", statusLabel: "Switched off" }),
      { iconEditable: false },
    );
    expect(page.connection.at(-1)).toEqual({
      kind: "toggle",
      label: "Switched on",
      value: false,
      enabled: true,
      action: "switch-on",
    });
    expect(page.dimmed).toBe(true);
    expect(page.iconFooter).toBe(ICON_FOOTER);
  });

  it("says a switched-off machine's settings wait for it, and drops the role it no longer reports", () => {
    const off = direct({
      switchedOff: true,
      role: null,
      connectionState: "disconnected",
      statusLabel: "Switched off",
    });
    expect(machineSettingsFooter(off, "This machine is no longer paired.")).toBe(
      SWITCHED_OFF_SETTINGS_FOOTER,
    );
    expect(machineSettingsFooter(direct(), null)).toBeNull();
    expect(machineSettingsFooter(hub(), "Read only")).toBe("Read only");
    const labels = machineDetail(off, { iconEditable: false }).connection.map((row) => row.label);
    expect(labels).toEqual(["Status", "Reach", "Address", "Switched on"]);
  });

  it("explains a client pairing's read-only Access", () => {
    expect(machineDetail(direct({ role: "client" }), { iconEditable: false }).accessFooter).toBe(
      "This phone is paired as a client, so Access is read-only.",
    );
  });

  it("Hub: the Direct access switch, disabled with its reason, no Forget, revoke in Access", () => {
    const page = machineDetail(hub(), { iconEditable: false });
    expect(page.statusLine).toBe("Online · Hub relay");
    expect(page.connection.at(-1)).toEqual({
      kind: "toggle",
      label: "Direct access",
      value: false,
      enabled: false,
      action: "add-direct",
    });
    expect(page.connectionFooter).toBe(
      "Direct access can be added while Studio is connected through the Hub.",
    );
    expect(page.forget).toBe(false);
    expect(page.accessFooter).toBe("Revoking this node from your Hub is in Access too.");
    const linked = machineDetail(hub({ linked: true, directAccess: "remove" }), {
      iconEditable: false,
    });
    expect(linked.connectionFooter).toBeNull();
    expect(linked.connection.at(-1)).toMatchObject({
      value: true,
      enabled: true,
      action: "remove-direct",
    });
  });

  it("Hub: the selected node's page leads to its security, notices included", () => {
    const page = machineDetail(
      hub({ selected: true, canOpenSecurity: true, routeNotice: "Can't reach the Hub" }),
      { iconEditable: true },
    );
    expect(page.security).toBe(true);
    expect(page.notices).toEqual(["Can't reach the Hub"]);
  });

  it("asks before forgetting, in the sheet's own words", () => {
    expect(forgetMachineConfirm("MacBook Pro")).toEqual({
      title: "Forget MacBook Pro?",
      message:
        "This removes the saved direct pairing and its local credential. You can pair the machine again later. Switch it off instead to keep the pairing.",
      confirmText: "Forget",
    });
  });
});

describe("a machine paired directly that cannot be reached", () => {
  const SENTENCE = "Can't reach this machine. It may be off, asleep or on another network.";
  // What `deriveConnectionRows` gives the sheet for an unreachable machine: "Offline" and the
  // sentence, both while it failed and while the backoff tries it again.
  const unreachable = (connectionState: "error" | "connecting") =>
    direct({
      connectionState: directMachineConnectionState(connectionState, "unreachable"),
      statusLabel: "Offline",
      statusDetail: SENTENCE,
    });

  it("shows Offline, the plain sentence and Retry in its row and on its page", () => {
    for (const facts of [unreachable("error"), unreachable("connecting")]) {
      const row = machineListRow(facts);
      expect(row).toMatchObject({ tone: "offline", status: "Offline", hint: SENTENCE });
      expect(row.notice).toBeNull();
      expect(row.accessibilityLabel).toContain(SENTENCE);
      const page = machineDetail(facts, { iconEditable: false });
      expect(page.statusLine).toBe("Offline · LAN · Direct");
      expect(page.hint).toBe(SENTENCE);
      expect(page.notices).toEqual([]);
      expect(buttons(facts)).toEqual(["Retry", "(Disconnect)", "Rename", "Access"]);
    }
  });

  it("keeps a retry that is not about reach a plain connect attempt", () => {
    expect(directMachineConnectionState("connecting", "refused")).toBe("connecting");
    expect(directMachineConnectionState("connecting", null)).toBe("connecting");
    expect(directMachineConnectionState("connected", "unreachable")).toBe("connected");
  });

  it("says the sentence in every state the sheet knows, except connected and switched off", () => {
    const states: ReadonlyArray<[Partial<DirectMachineFacts>, boolean]> = [
      [{ connectionState: "connected", statusLabel: "Connected" }, false],
      [{ connectionState: "connecting", statusLabel: "Connecting" }, true],
      [{ connectionState: "disconnected", statusLabel: "Disconnected" }, true],
      [{ connectionState: "error", statusLabel: "Offline" }, true],
      [{ connectionState: "error", statusLabel: "Needs re-pair", needsRepair: true }, true],
      [{ connectionState: "disconnected", statusLabel: "Switched off", switchedOff: true }, false],
    ];
    for (const [state, says] of states) {
      const facts = direct({ ...state, statusDetail: SENTENCE });
      const expected = says ? SENTENCE : null;
      expect(machineListRow(facts).hint, state.statusLabel).toBe(expected);
      expect(machineDetail(facts, { iconEditable: true }).hint, state.statusLabel).toBe(expected);
    }
    for (const [state] of states) {
      const facts = direct({ ...state, statusDetail: null });
      expect(machineListRow(facts).hint).toBeNull();
      expect(machineDetail(facts, { iconEditable: true }).hint).toBeNull();
    }
  });
});
