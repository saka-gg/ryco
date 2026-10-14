import { EnvironmentId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const HUB = EnvironmentId.make("env_hub_m4");
const DIRECT = EnvironmentId.make("env-direct-m4");

let records: Array<Record<string, unknown>> = [];
const issueLinkedDirectAccess = vi.fn();
const addSavedEnvironment = vi.fn(async (_input: unknown) => undefined);
const fetchRemoteEnvironmentDescriptor = vi.fn(async (_input: unknown) => ({
  environmentId: DIRECT,
}));

vi.mock("../environments/runtime", () => ({
  addSavedEnvironment: (input: unknown) => addSavedEnvironment(input),
  connectDesktopWorkspaceEnvironment: async () => ({
    client: { server: { issueLinkedDirectAccess } },
  }),
  listSavedEnvironmentRecords: () => records,
}));
vi.mock("../environments/remote/api", () => ({
  fetchRemoteEnvironmentDescriptor: (input: unknown) => fetchRemoteEnvironmentDescriptor(input),
}));

const { linkDesktopMachineDirectAccess, renewDesktopMachineDirectAccess } =
  await import("./desktopHubLinkedDirectAccess");

const machine = { environmentId: HUB, label: "MacBook Pro M4" };
const issued = {
  kind: "issued",
  environmentId: DIRECT,
  label: "MacBook Pro M4",
  endpoints: [{ httpBaseUrl: "http://192.168.1.20:3773", wsBaseUrl: "ws://192.168.1.20:3773" }],
  credential: "ABCDEFGHJKLM",
  expiresAt: new Date(),
};

describe("Desktop Hub-linked direct access", () => {
  beforeEach(() => {
    records = [];
    issueLinkedDirectAccess.mockReset();
    addSavedEnvironment.mockClear();
  });

  it("asks the machine over the Hub and saves the direct connection with its Hub link", async () => {
    issueLinkedDirectAccess.mockResolvedValue(issued);
    await expect(linkDesktopMachineDirectAccess(machine)).resolves.toBe("linked");
    expect(issueLinkedDirectAccess).toHaveBeenCalledWith({ deviceLabel: "Ryco Desktop" });
    expect(addSavedEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "MacBook Pro M4",
        host: "http://192.168.1.20:3773",
        pairingCode: "ABCDEFGHJKLM",
        hubLink: expect.objectContaining({ hubEnvironmentId: HUB }),
      }),
    );
  });

  it("leaves a machine the user paired by hand alone, and reports one it cannot reach", async () => {
    issueLinkedDirectAccess.mockResolvedValue(issued);
    records = [{ environmentId: DIRECT }];
    await expect(linkDesktopMachineDirectAccess(machine)).resolves.toBe("already-paired");

    records = [];
    issueLinkedDirectAccess.mockResolvedValue({
      kind: "unavailable",
      reason: "no-direct-endpoint",
    });
    await expect(linkDesktopMachineDirectAccess(machine)).resolves.toBe("no-direct-endpoint");
    expect(addSavedEnvironment).not.toHaveBeenCalled();
  });

  it("renews only a link the owner made, and only once it has aged", async () => {
    issueLinkedDirectAccess.mockResolvedValue(issued);
    renewDesktopMachineDirectAccess(machine);
    expect(issueLinkedDirectAccess).not.toHaveBeenCalled();

    records = [
      {
        environmentId: DIRECT,
        hubLink: { hubEnvironmentId: HUB, linkedAt: new Date().toISOString() },
      },
    ];
    renewDesktopMachineDirectAccess(machine);
    expect(issueLinkedDirectAccess).not.toHaveBeenCalled();

    records = [
      {
        environmentId: DIRECT,
        hubLink: {
          hubEnvironmentId: HUB,
          linkedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    ];
    renewDesktopMachineDirectAccess(machine);
    await vi.waitFor(() => expect(addSavedEnvironment).toHaveBeenCalledTimes(1));
  });
});
