import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({
  openURL: vi.fn(async (_url: string) => true),
}));

vi.mock("expo-linking", () => ({ openURL: hoisted.openURL }));

import { openWebLink } from "./openWebLink";

describe("openWebLink", () => {
  beforeEach(() => {
    hoisted.openURL.mockClear();
  });

  it("hands a web link to the system", () => {
    openWebLink("https://example.test/docs");
    expect(hoisted.openURL).toHaveBeenCalledWith("https://example.test/docs");
  });

  it("does nothing for a missing link or any other scheme", () => {
    openWebLink(null);
    openWebLink("tel:+15550100");
    openWebLink("ryco://threads/abc");
    expect(hoisted.openURL).not.toHaveBeenCalled();
  });

  it("swallows a link the system cannot open", async () => {
    hoisted.openURL.mockRejectedValueOnce(new Error("no handler"));
    openWebLink("https://example.test");
    await Promise.resolve();
    expect(hoisted.openURL).toHaveBeenCalledTimes(1);
  });
});
