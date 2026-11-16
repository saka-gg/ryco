process.env.TZ = "Europe/Berlin";

import { describe, expect, it } from "vite-plus/test";

import { fromDateTimeLocalInputValue, toDateTimeLocalInputValue } from "./dateTimeLocal";

describe("datetime-local field values", () => {
  it("shows an instant as the local wall time the field reads it back as", () => {
    // UTC+1 in winter, UTC+2 in summer.
    expect(toDateTimeLocalInputValue("2026-12-01T12:00:00.000Z")).toBe("2026-12-01T13:00");
    expect(toDateTimeLocalInputValue("2026-07-01T12:00:00.000Z")).toBe("2026-07-01T14:00");
    expect(toDateTimeLocalInputValue("2026-12-31T23:30:00.000Z")).toBe("2027-01-01T00:30");
  });

  it("saves an untouched value back as the same instant", () => {
    for (const iso of [
      "2026-12-01T12:00:00.000Z",
      "2026-07-01T12:00:00.000Z",
      "2026-03-29T00:59:00.000Z",
      "2026-10-25T02:30:00.000Z",
    ]) {
      expect(fromDateTimeLocalInputValue(toDateTimeLocalInputValue(iso))).toBe(iso);
    }
  });
});
