import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_STORAGE_RETENTION_POLICY, StorageRetentionPolicy } from "./storage.ts";

const decodePolicy = Schema.decodeUnknownSync(StorageRetentionPolicy);

describe("StorageRetentionPolicy", () => {
  it("fills fields a sparse settings file omitted with their defaults", () => {
    expect(DEFAULT_STORAGE_RETENTION_POLICY).toEqual({
      automatic: false,
      completedWorktreeDays: null,
      temporaryDataDays: null,
    });
    expect(decodePolicy({})).toEqual(DEFAULT_STORAGE_RETENTION_POLICY);
    expect(decodePolicy({ automatic: true, completedWorktreeDays: 30 })).toEqual({
      automatic: true,
      completedWorktreeDays: 30,
      temporaryDataDays: null,
    });
  });

  it("still rejects out-of-range days and encodes every field", () => {
    expect(() => decodePolicy({ temporaryDataDays: 0 })).toThrow();
    const policy = { automatic: true, completedWorktreeDays: null, temporaryDataDays: 7 };
    expect(Schema.encodeSync(StorageRetentionPolicy)(policy)).toEqual(policy);
  });
});
