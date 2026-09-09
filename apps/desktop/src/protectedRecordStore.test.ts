import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { desktopProtectedRecordExists } from "./protectedRecordStore.ts";

describe("protected session startup hint", () => {
  it("ignores keys from cancelled setup and detects retained sessions without reading secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "ryco-session-hint-"));
    const input = { directory, name: "hub-session-token" };
    try {
      expect(desktopProtectedRecordExists(input)).toBe(false);
      writeFileSync(join(directory, `${"a".repeat(64)}.installation-id.record`), "opaque");
      expect(desktopProtectedRecordExists(input)).toBe(false);
      writeFileSync(join(directory, `invalid.hub-session-token.record`), "opaque");
      expect(desktopProtectedRecordExists(input)).toBe(false);
      writeFileSync(join(directory, `${"b".repeat(64)}.hub-session-token.record`), "opaque");
      expect(desktopProtectedRecordExists(input)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(desktopProtectedRecordExists(input)).toBe(false);
  });
});
