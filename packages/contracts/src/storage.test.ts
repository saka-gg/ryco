import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  DatabaseStorageReport,
  DEFAULT_STORAGE_RETENTION_POLICY,
  StorageRetentionPolicy,
  StorageSnapshot,
} from "./storage.ts";

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

const database: DatabaseStorageReport = {
  fileBytes: 9_981_526_016,
  walBytes: 0,
  pageSize: 4_096,
  pageCount: 2_436_896,
  freePages: 135_732,
  autoVacuum: "none",
  compaction: {
    enabled: true,
    headSequence: 3_400_000,
    compactedThroughSequence: 1_200_000,
    caughtUp: false,
    lastPassCompletedAt: "2026-10-23T12:00:00.000Z",
    removedEvents: 800_000,
    removedBytes: 700_000_000,
    estimatedCompactableBytes: 1_283_333_333,
  },
  reclaimableBytes: 135_732 * 4_096 + 1_283_333_333,
};
const snapshot = {
  scannedAt: "2026-10-23T12:00:00.000Z",
  entries: [],
  truncated: false,
  nextCursor: null,
  history: [],
};

describe("StorageSnapshot database report", () => {
  it("round-trips a report and accepts a snapshot from a node without one", () => {
    const withDatabase = { ...snapshot, database };
    const encoded = Schema.encodeSync(StorageSnapshot)(withDatabase);
    expect(Schema.decodeUnknownSync(StorageSnapshot)(encoded)).toEqual(withDatabase);
    const older = Schema.decodeUnknownSync(StorageSnapshot)(snapshot);
    expect("database" in older).toBe(false);
  });

  it("lets a client that predates the report ignore it", () => {
    const { database: _omitted, ...fields } = StorageSnapshot.fields;
    const PreviousSnapshot = Schema.Struct(fields);
    expect(Schema.decodeUnknownSync(PreviousSnapshot)({ ...snapshot, database })).toEqual(snapshot);
  });

  it("rejects sizes that are not whole non-negative numbers and unknown modes", () => {
    const decode = Schema.decodeUnknownSync(DatabaseStorageReport);
    expect(() => decode({ ...database, freePages: -1 })).toThrow();
    expect(() => decode({ ...database, fileBytes: 1.5 })).toThrow();
    expect(() => decode({ ...database, autoVacuum: "sometimes" })).toThrow();
  });
});
