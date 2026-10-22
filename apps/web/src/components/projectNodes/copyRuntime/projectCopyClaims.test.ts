import { describe, expect, it, vi } from "vite-plus/test";

import { createProjectCopyClaims, createWindowProjectCopyClaims } from "./projectCopyClaims";

const key = () => `test:${crypto.randomUUID()}`;

describe("createProjectCopyClaims", () => {
  it("lets one holder at a time claim a copy, through Web Locks", async () => {
    // Two windows of one origin share these locks.
    const first = createProjectCopyClaims();
    const second = createProjectCopyClaims();
    const copy = key();

    const held = await first.tryClaim(copy);
    expect(held).not.toBeNull();
    expect(await second.tryClaim(copy)).toBeNull();
    expect(await first.tryClaim(copy)).toBeNull();

    held!.release();
    held!.release();
    await vi.waitFor(async () => {
      const next = await second.tryClaim(copy);
      expect(next).not.toBeNull();
      next!.release();
    });
  });

  it("claims again right after letting go in the same window", async () => {
    const claims = createProjectCopyClaims();
    const copy = key();
    const held = await claims.tryClaim(copy);
    held!.release();
    // A retry right after a run ended must not find its own lock still held.
    const again = await claims.tryClaim(copy);
    expect(again).not.toBeNull();
    again!.release();
  });

  it("keeps claims to this window where Web Locks refuse", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const claims = createProjectCopyClaims(async () => {
      throw new DOMException("The request is not allowed.", "SecurityError");
    });
    const copy = key();
    const held = await claims.tryClaim(copy);
    expect(held).not.toBeNull();
    expect(await claims.tryClaim(copy)).toBeNull();
    held!.release();
    expect(await claims.tryClaim(copy)).not.toBeNull();
    warn.mockRestore();
  });

  it("falls back to this window's claims without Web Locks", async () => {
    const claims = createProjectCopyClaims(null, createWindowProjectCopyClaims());
    const copy = key();
    expect(await claims.tryClaim(copy)).not.toBeNull();
    expect(await claims.tryClaim(copy)).toBeNull();
  });
});
