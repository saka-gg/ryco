import { describe, expect, it } from "vitest";

import {
  applyDoctorProgress,
  compactionRecord,
  parseDoctorProgressLine,
  readCompactionOutcome,
  startingState,
} from "./databaseCompaction.ts";

const result = (input: Partial<{ exitCode: number | null; stdout: string; stderr: string }>) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...input,
});

describe("desktop database compaction", () => {
  it("follows the doctor's progress and stops being cancellable at the swap", () => {
    let state = startingState(new Date("2026-11-10T12:00:00.000Z"));
    expect(state.cancellable).toBe(true);
    for (const line of [
      '{"type":"phase","text":"Removing superseded history"}',
      "a log line that is not JSON",
      '{"type":"progress","text":"scanned 5 of 10 events","fraction":0.5}',
    ]) {
      const event = parseDoctorProgressLine(line);
      if (event !== null) state = applyDoctorProgress(state, event);
    }
    expect(state).toMatchObject({
      text: "Removing superseded history",
      detail: "scanned 5 of 10 events",
      fraction: 0.5,
      cancellable: true,
    });
    state = applyDoctorProgress(
      state,
      parseDoctorProgressLine(
        '{"type":"phase","text":"Swapping the compacted copy in","step":"swap"}',
      )!,
    );
    expect(state.cancellable).toBe(false);
    state = applyDoctorProgress(state, { type: "phase", text: "Starting again" });
    expect(state.cancellable).toBe(false);
  });

  it("reads the doctor's result, a cancel and a failure", () => {
    const doctor = {
      inspection: {},
      result: {
        status: "repaired",
        exitCode: 0,
        message: "1.0 GB → 300 MB.",
        before: { fileBytes: 1_000 },
        after: { fileBytes: 300 },
      },
    };
    expect(readCompactionOutcome(result({ stdout: `${JSON.stringify(doctor)}\n` }), false)).toEqual(
      {
        status: "repaired",
        message: "1.0 GB → 300 MB.",
        beforeBytes: 1_000,
        afterBytes: 300,
      },
    );
    expect(readCompactionOutcome(result({ exitCode: null }), true).status).toBe("cancelled");
    expect(
      readCompactionOutcome(
        result({ exitCode: 1, stderr: '{"type":"phase","text":"x"}\nError: disk full\n' }),
        false,
      ),
    ).toMatchObject({ status: "failed", message: "disk full" });
    const refused = { result: { status: "refused", exitCode: 2, message: "Not enough disk." } };
    expect(
      readCompactionOutcome(result({ exitCode: 2, stdout: JSON.stringify(refused) }), false),
    ).toEqual({
      status: "refused",
      message: "Not enough disk.",
      beforeBytes: null,
      afterBytes: null,
    });
  });

  it("writes the record the server reads", () => {
    expect(
      compactionRecord({
        phase: "finished",
        startedAt: "2026-11-10T12:00:00.000Z",
        finishedAt: "2026-11-10T12:01:00.000Z",
        status: "repaired",
        message: "m",
        beforeBytes: 10,
        afterBytes: 4,
        downtimeMs: 60_000,
      }),
    ).toEqual({
      version: 1,
      runner: "desktop",
      startedAt: "2026-11-10T12:00:00.000Z",
      run: {
        runner: "desktop",
        startedAt: "2026-11-10T12:00:00.000Z",
        finishedAt: "2026-11-10T12:01:00.000Z",
        status: "repaired",
        message: "m",
        beforeBytes: 10,
        afterBytes: 4,
        downtimeMs: 60_000,
      },
    });
  });
});
