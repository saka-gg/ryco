import { describe, expect, it } from "vitest";

import {
  doctorCommandFor,
  doctorSuggestion,
  DOCTOR_SUGGESTION_MIN_RECLAIMABLE_BYTES,
} from "./doctorSuggestion.ts";

const home = "/Users/ada/.ryco";
const node = {
  mode: "web" as const,
  baseDir: home,
  dbPath: `${home}/userdata/state.sqlite`,
  defaultBaseDir: home,
  version: "0.1.36",
  platform: "darwin" as const,
};

describe("doctorSuggestion", () => {
  it("recommends the doctor only for a database that never shrinks, from 1 GiB to return", () => {
    const at = (autoVacuum: "none" | "full" | "incremental", reclaimableBytes: number) =>
      doctorSuggestion({ ...node, autoVacuum, reclaimableBytes }).recommended;
    expect(at("none", DOCTOR_SUGGESTION_MIN_RECLAIMABLE_BYTES)).toBe(true);
    expect(at("none", DOCTOR_SUGGESTION_MIN_RECLAIMABLE_BYTES - 1)).toBe(false);
    // FULL returns free pages at every commit, INCREMENTAL online: nothing for the doctor.
    expect(at("full", 5 * DOCTOR_SUGGESTION_MIN_RECLAIMABLE_BYTES)).toBe(false);
    expect(at("incremental", 50 * DOCTOR_SUGGESTION_MIN_RECLAIMABLE_BYTES)).toBe(false);
  });

  it("names the command for a node, for the desktop app, and for another data directory", () => {
    expect(doctorCommandFor(node)).toBe("ryco doctor --apply");
    expect(doctorCommandFor({ ...node, mode: "desktop" })).toBe(
      "npx ryco-cli@0.1.36 doctor --apply",
    );
    expect(
      doctorCommandFor({
        ...node,
        baseDir: "/srv/ryco node",
        dbPath: "/srv/ryco node/userdata/state.sqlite",
      }),
    ).toBe("ryco doctor --apply --base-dir '/srv/ryco node'");
  });

  it("gives development databases no command", () => {
    expect(doctorCommandFor({ ...node, dbPath: `${home}/dev/state.sqlite` })).toBeNull();
    expect(
      doctorSuggestion({
        ...node,
        dbPath: "/tmp/x.sqlite",
        autoVacuum: "none",
        reclaimableBytes: 0,
      }).command,
    ).toBeNull();
  });
});
