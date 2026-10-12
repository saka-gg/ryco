import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceEnvironmentVariable } from "@ryco/contracts";

import {
  blankEnvironmentDraftRow,
  environmentDraftRowFromVariable,
  parseEnvironmentAssignment,
  reconcileEnvironmentDraftRows,
  resolveEnvironmentDrafts,
  withEnvironmentDraftValue,
} from "./ProviderInstanceEnvironment.logic";

const plain = (name: string, value: string): ProviderInstanceEnvironmentVariable => ({
  name,
  value,
  sensitive: false,
});
const storedSecret = (name: string): ProviderInstanceEnvironmentVariable => ({
  name,
  value: "",
  sensitive: true,
  valueRedacted: true,
});

describe("parseEnvironmentAssignment", () => {
  it.each([
    ["KEY=value", { name: "KEY", value: "value" }],
    ['export KEY="a b"', { name: "KEY", value: "a b" }],
    ["  KEY = 'x'  \n", { name: "KEY", value: "x" }],
    ["KEY=a=b", { name: "KEY", value: "a=b" }],
    ['KEY=""', { name: "KEY", value: "" }],
  ])("splits %j", (text, expected) => {
    expect(parseEnvironmentAssignment(text)).toEqual(expected);
  });

  it.each(["KEY", "=value", "A=1\nB=2", "KEY=", "MY-KEY=1", "dGVzdA==", "dGVzdDE="])(
    "leaves %j to the default paste",
    (text) => {
      expect(parseEnvironmentAssignment(text)).toBeNull();
    },
  );
});

describe("resolveEnvironmentDrafts", () => {
  it("withholds duplicate names from renamed and new rows, falling back to saved versions", () => {
    const first = { ...environmentDraftRowFromVariable(plain("FIRST", "1")), name: "SECOND" };
    const second = environmentDraftRowFromVariable(plain("SECOND", "2"));
    const added = { ...blankEnvironmentDraftRow(), name: "FIRST", value: "new" };

    const resolution = resolveEnvironmentDrafts([added, first, second]);

    expect(resolution.environment).toEqual([plain("FIRST", "1"), plain("SECOND", "2")]);
    expect(resolution.issues.get(first.id)?.message).toBe(
      "Another variable already uses this name.",
    );
    expect(resolution.issues.get(added.id)?.message).toBe(
      "Another variable already uses this name.",
    );
    expect(resolution.rows.find((row) => row.id === added.id)?.saved).toBeUndefined();
  });

  it("trims published names and keeps the typed name of a row with an issue", () => {
    const valid = { ...blankEnvironmentDraftRow(), name: "  BASE_URL  ", value: "x" };
    const invalid = { ...blankEnvironmentDraftRow(), name: " MY KEY " };

    const resolution = resolveEnvironmentDrafts([valid, invalid]);

    expect(resolution.environment).toEqual([{ name: "BASE_URL", value: "x", sensitive: true }]);
    expect(resolution.rows.map((row) => row.name)).toEqual(["BASE_URL", " MY KEY "]);
  });

  it("does not publish or flag a blank row whose Sensitive box was toggled", () => {
    const blank = { ...blankEnvironmentDraftRow(), sensitive: false };
    const edited = { ...environmentDraftRowFromVariable(plain("KEEP", "1")), value: "2" };

    const resolution = resolveEnvironmentDrafts([blank, edited]);

    expect(resolution.environment).toEqual([plain("KEEP", "2")]);
    expect(resolution.issues.size).toBe(0);
  });

  it("keeps a stored secret when its value is cleared", () => {
    const row = withEnvironmentDraftValue(
      withEnvironmentDraftValue(environmentDraftRowFromVariable(storedSecret("TOKEN")), "typed"),
      "",
    );

    expect(resolveEnvironmentDrafts([row]).environment).toEqual([storedSecret("TOKEN")]);
  });
});

describe("reconcileEnvironmentDraftRows", () => {
  it("takes server versions for clean rows and keeps edited and unpublished drafts", () => {
    const clean = environmentDraftRowFromVariable(plain("CLEAN", "1"));
    const edited = { ...environmentDraftRowFromVariable(plain("EDITED", "1")), name: "BAD-NAME" };
    const blank = blankEnvironmentDraftRow();

    const next = reconcileEnvironmentDraftRows(
      [clean, edited, blank],
      [plain("CLEAN", "2"), plain("EDITED", "3"), plain("ADDED", "4")],
    );

    expect(next.map((row) => [row.name, row.value])).toEqual([
      ["CLEAN", "2"],
      ["BAD-NAME", "1"],
      ["", ""],
      ["ADDED", "4"],
    ]);
    expect(next[0]?.id).toBe(clean.id);
    expect(next[1]).toEqual({ ...edited, saved: plain("EDITED", "3") });
    expect(next[2]).toBe(blank);
  });

  it("keeps edits and unconfirmed secrets as new drafts when their variable is gone", () => {
    const edited = { ...environmentDraftRowFromVariable(plain("EDITED", "1")), value: "2" };
    const typedSecret = environmentDraftRowFromVariable({
      name: "TYPED",
      value: "s3cret",
      sensitive: true,
    });
    const unedited = environmentDraftRowFromVariable(plain("UNEDITED", "1"));
    const stored = environmentDraftRowFromVariable(storedSecret("STORED"));

    const next = reconcileEnvironmentDraftRows([edited, typedSecret, unedited, stored], []);

    expect(next).toEqual([
      { ...edited, saved: undefined },
      { ...typedSecret, saved: undefined },
    ]);
  });

  it("drops a pending stored-secret edit once the server no longer holds the secret", () => {
    const renamed = {
      ...environmentDraftRowFromVariable(storedSecret("TOKEN")),
      name: "NEW_TOKEN",
    };

    const [next] = reconcileEnvironmentDraftRows([renamed], [plain("TOKEN", "visible")]);

    expect(next).toMatchObject({ id: renamed.id, name: "TOKEN", value: "visible" });
  });
});
