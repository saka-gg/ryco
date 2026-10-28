import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeTerminalDoctorReporter } from "./doctorReporter.ts";

const drive = (tty: boolean) => {
  const output: Array<string> = [];
  const reporter = makeTerminalDoctorReporter({ tty, write: (text) => output.push(text) });
  Effect.runSync(
    Effect.gen(function* () {
      yield* reporter.phase("Removing superseded history");
      for (let step = 1; step <= 40; step += 1) {
        yield* reporter.progress(`scanned ${step} of 40`, step / 40);
      }
      yield* reporter.note("A warning");
      yield* reporter.phase("Checking the copy");
      yield* reporter.end;
    }),
  );
  return output.join("");
};

describe("doctorReporter", () => {
  it("writes a line per step and one per 10% outside a terminal", () => {
    const lines = drive(false).trimEnd().split("\n");
    expect(lines[0]).toBe("Removing superseded history...");
    expect(
      lines.filter((line) => line.includes("%:")).map((line) => line.trim().split(":")[0]),
    ).toEqual(["10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%", "100%"]);
    expect(lines.slice(-2)).toEqual(["A warning", "Checking the copy..."]);
  });

  it("updates one line in place on a terminal and ends it before the next output", () => {
    const text = drive(true);
    expect(text.split("\r\u001b[2K")).toHaveLength(41);
    expect(text).toContain("Removing superseded history: scanned 40 of 40\nA warning\n");
    expect(text.endsWith("Checking the copy...\n")).toBe(true);
  });
});
