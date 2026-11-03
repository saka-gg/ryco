import "../../index.css";

import type {
  ServerClientSessionRecord,
  ServerPairingLinkRecord,
} from "@ryco/client-runtime/connection";
import { type AdvertisedEndpoint, AuthSessionId } from "@ryco/contracts";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { useTierOverrideStore } from "../../tierOverrideStore";
import type { AddDeviceCode, AddDeviceOperations } from "./AddDeviceDialog.logic";
import { AddDeviceButton, AddDeviceDialogHost } from "./AddDeviceEntry";

const QR_TITLE = "Pairing link — scan to open on another device";
const FIVE_MINUTES_MS = 5 * 60 * 1_000;

function endpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:3773",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:3773/",
    wsBaseUrl: "ws://192.168.1.42:3773/",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

const LAN = endpoint({});
const TAILSCALE_IP = endpoint({
  id: "tailscale-ip:http://100.84.12.7:3773",
  label: "Tailscale IP",
  provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
  httpBaseUrl: "http://100.84.12.7:3773/",
  wsBaseUrl: "ws://100.84.12.7:3773/",
  reachability: "private-network",
  source: "desktop-addon",
});
const LOOPBACK = endpoint({
  id: "desktop-loopback:3773",
  label: "This machine",
  httpBaseUrl: "http://127.0.0.1:3773/",
  wsBaseUrl: "ws://127.0.0.1:3773/",
  reachability: "loopback",
  isDefault: true,
});

/** Fake operations: records every call in order, mints `CODEnAAAAAAA` codes. */
function fakeOperations() {
  const calls: string[] = [];
  const minted: AddDeviceCode[] = [];
  const createCode = vi.fn(async (label: string | null): Promise<AddDeviceCode> => {
    const next: AddDeviceCode = {
      id: `link-${minted.length + 1}`,
      credential: `CODE${minted.length + 1}AAAAAAA`,
      label,
      expiresAt: new Date(Date.now() + FIVE_MINUTES_MS).toISOString(),
    };
    minted.push(next);
    calls.push(`createCode:${label ?? ""}`);
    return next;
  });
  const revokeCode = vi.fn(async (id: string) => {
    calls.push(`revokeCode:${id}`);
  });
  const operations: AddDeviceOperations = { createCode, revokeCode };
  return { operations, calls, minted, createCode, revokeCode };
}

function Harness(props: {
  readonly operations: AddDeviceOperations;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly pairingLinks?: ReadonlyArray<ServerPairingLinkRecord>;
  readonly clientSessions?: ReadonlyArray<ServerClientSessionRecord>;
  readonly onTurnOnNetworkAccess?: (() => void) | null;
}) {
  // The parent's wiring in ConnectionsSettings: each click is a new opening.
  const [opening, setOpening] = useState(0);
  const [open, setOpen] = useState(false);
  return (
    <>
      <AddDeviceButton
        onClick={() => {
          setOpening((value) => value + 1);
          setOpen(true);
        }}
      />
      <AddDeviceDialogHost
        open={open}
        onOpenChange={setOpen}
        opening={opening}
        operations={props.operations}
        pairingLinks={props.pairingLinks ?? []}
        clientSessions={props.clientSessions ?? []}
        endpoints={props.endpoints}
        defaultEndpointKey={null}
        onTurnOnNetworkAccess={props.onTurnOnNetworkAccess ?? null}
      />
    </>
  );
}

function qrSvg(): SVGSVGElement | null {
  return document.querySelector<SVGSVGElement>(`svg[aria-label="${QR_TITLE}"]`);
}

describe("AddDeviceDialog", () => {
  beforeAll(() => {
    syncDocumentPresentationTier();
  });

  beforeEach(async () => {
    // Desktop and tablet: the tier the dialog is for.
    await page.viewport(1280, 900);
  });

  afterEach(() => {
    vi.useRealTimers();
    useTierOverrideStore.setState({ override: null });
    document.body.innerHTML = "";
  });

  it("loads on the first click and shows a 168 px QR code", async () => {
    const fake = fakeOperations();
    const screen = await render(<Harness operations={fake.operations} endpoints={[LAN]} />);

    await page.getByRole("button", { name: "Add a device" }).click();

    await expect.element(page.getByRole("heading", { name: "Add a device" })).toBeVisible();
    await vi.waitFor(() => expect(qrSvg()).not.toBeNull());
    expect(qrSvg()?.getAttribute("width")).toBe("168");
    expect(qrSvg()?.getAttribute("height")).toBe("168");
    expect(fake.createCode).toHaveBeenCalledTimes(1);
    expect(fake.createCode).toHaveBeenCalledWith(null);
    await screen.unmount();
  });

  it("never pairs through loopback, and lets the owner pick among reachable endpoints", async () => {
    const fake = fakeOperations();
    const screen = await render(
      <Harness operations={fake.operations} endpoints={[LOOPBACK, LAN, TAILSCALE_IP]} />,
    );

    await page.getByRole("button", { name: "Add a device" }).click();
    const via = page.getByRole("radiogroup", { name: "Reach this computer via" });
    await expect.element(via).toBeVisible();
    // Loopback is the node's default, but it is not offered.
    await expect.element(via.getByRole("radio")).toHaveLength(2);
    await expect.element(via.getByRole("radio", { name: /Local network/ })).toBeChecked();

    await page.getByRole("tab", { name: "Computer" }).click();
    await expect.element(page.getByText("http://192.168.1.42:3773", { exact: true })).toBeVisible();
    await via.getByRole("radio", { name: /Tailscale IP/ }).click();
    await expect.element(page.getByText("http://100.84.12.7:3773", { exact: true })).toBeVisible();
    await expect.element(page.getByText("127.0.0.1")).not.toBeInTheDocument();
    await screen.unmount();
  });

  it("counts the code down every second", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = fakeOperations();
    const screen = await render(<Harness operations={fake.operations} endpoints={[LAN]} />);

    await page.getByRole("button", { name: "Add a device" }).click();
    await expect.element(page.getByText("Expires in 5:00")).toBeVisible();

    vi.advanceTimersByTime(1_000);

    await expect.element(page.getByText("Expires in 4:59")).toBeVisible();
    await screen.unmount();
  });

  it("keeps the code when it closes, and mints one code per opening", async () => {
    const fake = fakeOperations();
    const screen = await render(<Harness operations={fake.operations} endpoints={[LAN]} />);

    await page.getByRole("button", { name: "Add a device" }).click();
    await vi.waitFor(() => expect(qrSvg()).not.toBeNull());
    await page.getByRole("button", { name: "Close" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Add a device" }))
      .not.toBeInTheDocument();

    expect(fake.revokeCode).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Add a device" }).click();
    await vi.waitFor(() => expect(fake.createCode).toHaveBeenCalledTimes(2));
    expect(fake.revokeCode).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("revokes the code on screen before minting a new one", async () => {
    const fake = fakeOperations();
    const screen = await render(<Harness operations={fake.operations} endpoints={[LAN]} />);

    await page.getByRole("button", { name: "Add a device" }).click();
    await page.getByRole("tab", { name: "Computer" }).click();
    await expect.element(page.getByText("CODE 1AAA AAAA")).toBeVisible();

    await page.getByRole("button", { name: "New code", exact: true }).click();

    await expect.element(page.getByText("CODE 2AAA AAAA")).toBeVisible();
    expect(fake.calls).toEqual(["createCode:", "revokeCode:link-1", "createCode:"]);
    await screen.unmount();
  });

  it("tells the owner when only this computer can reach Ryco, and mints nothing", async () => {
    const fake = fakeOperations();
    const onTurnOnNetworkAccess = vi.fn();
    const screen = await render(
      <Harness
        operations={fake.operations}
        endpoints={[LOOPBACK]}
        onTurnOnNetworkAccess={onTurnOnNetworkAccess}
      />,
    );

    await page.getByRole("button", { name: "Add a device" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Only this computer can reach Ryco now" }))
      .toBeVisible();
    expect(qrSvg()).toBeNull();

    await page.getByRole("button", { name: "Turn on network access" }).click();

    // It only opens the parent's confirmation; access is never turned on here.
    expect(onTurnOnNetworkAccess).toHaveBeenCalledTimes(1);
    expect(fake.createCode).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("shows the device that joined with the code", async () => {
    const fake = fakeOperations();
    const screen = await render(<Harness operations={fake.operations} endpoints={[LAN]} />);
    await page.getByRole("button", { name: "Add a device" }).click();
    await vi.waitFor(() => expect(fake.minted).toHaveLength(1));
    const shown = fake.minted[0]!;
    const createdAt = new Date().toISOString();

    await screen.rerender(
      <Harness
        operations={fake.operations}
        endpoints={[LAN]}
        pairingLinks={[
          {
            id: shown.id,
            credential: shown.credential,
            role: "client",
            subject: "one-time-token",
            createdAt,
            expiresAt: shown.expiresAt,
          },
        ]}
      />,
    );
    await screen.rerender(
      <Harness
        operations={fake.operations}
        endpoints={[LAN]}
        pairingLinks={[]}
        clientSessions={[
          {
            sessionId: AuthSessionId.make("session-phone"),
            subject: "one-time-token",
            role: "client",
            method: "bearer-session-token",
            client: { deviceType: "mobile", os: "iOS" },
            issuedAt: new Date(Date.parse(createdAt) + 1_000).toISOString(),
            expiresAt: "2036-05-07T00:00:00.000Z",
            lastConnectedAt: null,
            connected: true,
            current: false,
          },
        ]}
      />,
    );

    await expect
      .element(page.getByRole("heading", { name: "The phone is connected" }))
      .toBeVisible();
    expect(fake.revokeCode).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("offers no entry button on the phone tier", async () => {
    await page.viewport(390, 844);
    const fake = fakeOperations();
    const screen = await render(<Harness operations={fake.operations} endpoints={[LAN]} />);

    await expect.element(page.getByText("Add a device")).not.toBeInTheDocument();
    await screen.unmount();

    await page.viewport(1280, 900);
    const desktop = await render(<Harness operations={fake.operations} endpoints={[LAN]} />);
    await expect.element(page.getByRole("button", { name: "Add a device" })).toBeVisible();
    await desktop.unmount();
  });
});
