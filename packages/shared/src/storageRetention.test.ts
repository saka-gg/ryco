import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { DEFAULT_SERVER_SETTINGS, StorageRetentionPolicy } from "@ryco/contracts";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  formatStorageSize,
  resolveStorageRetentionPolicy,
  retentionDue,
} from "./storageRetention.ts";

describe("cleanup policy ownership and compatibility", () => {
  it("keeps existing installs non-destructive and preserves unrelated project overrides", () => {
    expect(DEFAULT_SERVER_SETTINGS.storageRetention.automatic).toBe(false);
    const projectPolicy = { automatic: true, completedWorktreeDays: 30, temporaryDataDays: null };
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectStorageRetention: { a: projectPolicy, b: projectPolicy },
    });
    const inherited = applyServerSettingsPatch(settings, { projectStorageRetention: { a: null } });
    expect(resolveStorageRetentionPolicy(inherited, "a")).toEqual(
      DEFAULT_SERVER_SETTINGS.storageRetention,
    );
    expect(resolveStorageRetentionPolicy(inherited, "b")).toEqual(projectPolicy);
  });
  it("requires explicit opt-in and a finite completed retention period", () => {
    const now = Date.parse("2026-09-30T00:00:00Z");
    const completed = "2026-08-01T00:00:00Z";
    expect(retentionDue(DEFAULT_SERVER_SETTINGS.storageRetention, "worktree", completed, now)).toBe(
      false,
    );
    expect(
      retentionDue(
        { automatic: true, completedWorktreeDays: null, temporaryDataDays: 7 },
        "worktree",
        completed,
        now,
      ),
    ).toBe(false);
    expect(
      retentionDue(
        { automatic: true, completedWorktreeDays: 30, temporaryDataDays: null },
        "worktree",
        completed,
        now,
      ),
    ).toBe(true);
    expect(
      retentionDue(
        { automatic: true, completedWorktreeDays: 30, temporaryDataDays: null },
        "worktree",
        "invalid",
        now,
      ),
    ).toBe(false);
    expect(
      Schema.is(StorageRetentionPolicy)({
        automatic: true,
        completedWorktreeDays: 0,
        temporaryDataDays: null,
      }),
    ).toBe(false);
  });
  it("never presents protected or incomplete sizes as an exact zero", () => {
    expect(formatStorageSize(null, "unknown")).toBe("Size unavailable");
    expect(formatStorageSize(0, "bounded")).toBe("At least 0 B");
    expect(formatStorageSize(1024, "complete")).toBe("1.0 KiB");
  });
});
