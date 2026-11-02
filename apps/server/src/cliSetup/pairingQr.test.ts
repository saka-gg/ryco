import { expect, it } from "@effect/vitest";

import { formatPairingQrBlock, pairingLinksForBaseUrl } from "./pairingQr.ts";
import { LOOPBACK_ONLY_PAIRING_NOTE } from "../startupAccess.ts";
import { renderTerminalQrCode } from "../terminalQrCode.ts";

it("draws a QR code for a base URL another device can reach", () => {
  const links = pairingLinksForBaseUrl("PAIRCODE", "http://192.168.1.5:3773/");
  expect(links).toEqual({
    connectionString: "http://192.168.1.5:3773",
    pairingUrl: "http://192.168.1.5:3773/pair#token=PAIRCODE",
    qrUrl: "http://192.168.1.5:3773/pair#token=PAIRCODE",
    alternativeLinks: [],
  });
  const block = formatPairingQrBlock({
    links,
    renderQrCode: renderTerminalQrCode,
    footer: ["One-time client link, valid for 5 minutes."],
  });
  expect(block).toMatch(/[█▀▄]/u);
  expect(block).toContain("http://192.168.1.5:3773/pair#token=PAIRCODE");
  expect(block).toContain("One-time client link, valid for 5 minutes.");
});

it("prints the note instead of a QR code for a loopback base URL", () => {
  const links = pairingLinksForBaseUrl("PAIRCODE", "http://localhost:3773");
  expect(links.qrUrl).toBeNull();
  const block = formatPairingQrBlock({
    links,
    renderQrCode: renderTerminalQrCode,
    heading: "Scan with the Ryco app:",
    footer: [],
    indent: "  ",
  });
  expect(block).toContain(`  ${LOOPBACK_ONLY_PAIRING_NOTE}`);
  expect(block).toContain("  http://localhost:3773/pair#token=PAIRCODE");
  expect(block).not.toMatch(/[█▀▄]/u);
});
