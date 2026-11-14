import type { EnvironmentId } from "@ryco/contracts";
import { PersistedSavedEnvironmentRecord } from "@ryco/contracts/saved-environment";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeSavedEnvironmentRecords,
  persistedSavedEnvironmentRecordFields,
} from "./savedEnvironmentRecord.ts";

const AT = "2026-10-31T09:00:00.000Z";
const SSH = { alias: "studio", hostname: "studio.local", username: null, port: null };

const BASE = {
  environmentId: "env-studio" as EnvironmentId,
  label: "Studio Mac",
  wsBaseUrl: "ws://studio.local:3773",
  httpBaseUrl: "http://studio.local:3773",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastConnectedAt: null,
};

describe("persistedSavedEnvironmentRecordFields", () => {
  it("keeps when a machine was switched off, so the next launch leaves it off", () => {
    expect(
      persistedSavedEnvironmentRecordFields({ ...BASE, disabledAt: "2026-10-31T09:00:00.000Z" }),
    ).toEqual({ ...BASE, disabledAt: "2026-10-31T09:00:00.000Z" });
  });

  it("writes no switch for a machine that is on", () => {
    const persisted = persistedSavedEnvironmentRecordFields({ ...BASE, disabledAt: undefined });
    expect(persisted).toEqual(BASE);
    expect("disabledAt" in persisted).toBe(false);
  });

  it("drops fields that are not part of the record, such as a credential", () => {
    const withSecret = { ...BASE, bearerToken: "not-stored-here" };
    expect(persistedSavedEnvironmentRecordFields(withSecret)).toEqual(BASE);
  });
});

describe("decodeSavedEnvironmentRecords", () => {
  const record = PersistedSavedEnvironmentRecord;

  it("reads records every earlier shape wrote", () => {
    const stored = [
      // Before machines could be switched off, linked over the Hub, or reached by SSH.
      BASE,
      { ...BASE, environmentId: "env-ssh", desktopSsh: SSH },
      // A Hub link saved before the node identity proof existed.
      {
        ...BASE,
        environmentId: "env-linked",
        hubLink: { hubEnvironmentId: "hub-1", linkedAt: AT },
      },
      {
        ...BASE,
        environmentId: "env-off",
        disabledAt: AT,
        hubLink: { hubEnvironmentId: "hub-2", linkedAt: AT, nodeIdentityPublicKey: "key" },
      },
    ];
    expect(decodeSavedEnvironmentRecords(stored, record)).toEqual(stored);
  });

  it("leaves out an unreadable record and keeps the others", () => {
    const stored = [
      BASE,
      { ...BASE, environmentId: "env-no-url", httpBaseUrl: undefined },
      { ...BASE, environmentId: "" },
      { ...BASE, environmentId: "env-bad-ssh", desktopSsh: { alias: "studio" } },
      "not a record",
      null,
      { ...BASE, environmentId: "env-later" },
    ];
    expect(decodeSavedEnvironmentRecords(stored, record).map((item) => item.environmentId)).toEqual(
      ["env-studio", "env-later"],
    );
  });

  it("drops fields outside the schema it is given, and keeps a store's own", () => {
    const withToken = Schema.Struct({
      ...PersistedSavedEnvironmentRecord.fields,
      bearerToken: Schema.optionalKey(Schema.String),
    });
    const stored = [{ ...BASE, bearerToken: "secret", unknownField: 1 }];
    expect(decodeSavedEnvironmentRecords(stored, record)).toEqual([BASE]);
    expect(decodeSavedEnvironmentRecords(stored, withToken)).toEqual([
      { ...BASE, bearerToken: "secret" },
    ]);
  });

  it("reads anything but an array as no records", () => {
    for (const value of [undefined, null, {}, "[]", { records: [BASE] }]) {
      expect(decodeSavedEnvironmentRecords(value, record)).toEqual([]);
    }
  });
});
