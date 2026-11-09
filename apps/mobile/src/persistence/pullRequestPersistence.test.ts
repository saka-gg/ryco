import type { ChangeRequest, EnvironmentId } from "@ryco/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  createPullRequestReadStore,
  decodePullRequestRead,
  encodePullRequestRead,
  PULL_REQUEST_READ_SCHEMA_VERSION,
} from "./pullRequestPersistence";
import type { SnapshotDb } from "./snapshotDb";

const ENV = "env-1" as EnvironmentId;

const row: ChangeRequest = {
  provider: "github",
  number: 7,
  title: "Fix login",
  url: "https://github.com/acme/app/pull/7",
  baseRefName: "main",
  headRefName: "fix/login",
  state: "open",
  updatedAt: Option.some(DateTime.makeUnsafe(Date.UTC(2026, 10, 8, 12))),
  labels: [{ name: "bug", color: "d73a4a" }],
  additions: 3,
  deletions: 1,
};

function fakeDb() {
  const rows = new Map<string, { schemaVersion: number; payload: string }>();
  const db = {
    loadPullRequestRead: async (environmentId: string, key: string) =>
      rows.get(`${environmentId}|${key}`) ?? null,
    savePullRequestRead: async (input: {
      environmentId: string;
      key: string;
      schemaVersion: number;
      payload: string;
    }) => {
      rows.set(`${input.environmentId}|${input.key}`, {
        schemaVersion: input.schemaVersion,
        payload: input.payload,
      });
    },
  } as unknown as SnapshotDb;
  return { db, rows };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pull request read codec", () => {
  it("round-trips a list with dates and options", () => {
    const payload = encodePullRequestRead("list", [row]);
    expect(
      decodePullRequestRead("list", { schemaVersion: PULL_REQUEST_READ_SCHEMA_VERSION, payload }),
    ).toEqual([row]);
  });

  it("reads another version or a malformed payload as a miss", () => {
    const payload = encodePullRequestRead("list", [row]);
    expect(decodePullRequestRead("list", { schemaVersion: 99, payload })).toBeNull();
    expect(
      decodePullRequestRead("detail", { schemaVersion: PULL_REQUEST_READ_SCHEMA_VERSION, payload }),
    ).toBeNull();
    expect(
      decodePullRequestRead("list", {
        schemaVersion: PULL_REQUEST_READ_SCHEMA_VERSION,
        payload: "not json",
      }),
    ).toBeNull();
  });
});

describe("createPullRequestReadStore", () => {
  it("saves and loads reads by kind while the setting is on", async () => {
    const { db } = fakeDb();
    const store = createPullRequestReadStore({ db, isEnabled: () => true, now: () => 1 });
    store.save("list", ENV, "key", [row]);
    await flush();
    expect(await store.load("list", ENV, "key")).toEqual([row]);
    // The same key under another kind is another read.
    expect(await store.load("activity", ENV, "key")).toBeNull();
  });

  it("neither saves nor shows anything while the setting is off", async () => {
    const { db, rows } = fakeDb();
    let enabled = false;
    const store = createPullRequestReadStore({ db, isEnabled: () => enabled, now: () => 1 });
    store.save("list", ENV, "key", [row]);
    await flush();
    expect(rows.size).toBe(0);
    enabled = true;
    store.save("list", ENV, "key", [row]);
    await flush();
    enabled = false;
    expect(await store.load("list", ENV, "key")).toBeNull();
  });
});
